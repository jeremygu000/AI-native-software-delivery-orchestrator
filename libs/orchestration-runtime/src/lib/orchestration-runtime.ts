import {
  canonicalTaskLeaseResources,
  taskDecisionsWithTransitions,
  taskLeasePlanSchema
} from '@ai-native-software-delivery-orchestrator/domain';
import type {
  AgentRunner,
  AgentExecutionAttempt,
  CreatePersistedRunRequest,
  OrchestrationPersistence,
  PersistedReevaluation,
  RecoveredRun,
  Scheduler,
  SchedulerEvent,
  SchedulerSnapshot,
  SchedulerTaskDecision,
  TaskContract,
  TaskVerifier,
  TaskLeasePlan,
  WriteLease,
  WorkspaceManager,
  WriteGuard
} from '@ai-native-software-delivery-orchestrator/domain';

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface RuntimeTaskBinding {
  readonly taskId: string;
  readonly agentId: string;
  readonly leasePlan: TaskLeasePlan;
  readonly workspace: Parameters<WorkspaceManager['create']>[0];
}

export interface StartRuntimeRunRequest extends CreatePersistedRunRequest {
  readonly taskBindings: readonly RuntimeTaskBinding[];
}

export interface RecoveredRuntimeRun {
  readonly run: RecoveredRun['run'];
  readonly snapshot: SchedulerSnapshot;
  readonly workspaces: RecoveredRun['workspaces'];
  readonly leases: RecoveredRun['leases'];
  readonly attempts: RecoveredRun['attempts'];
}

export class OrchestrationRuntimeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrchestrationRuntimeInputError';
  }
}

export class OrchestrationRuntime {
  readonly #scheduler: Scheduler;
  readonly #persistence: OrchestrationPersistence;
  readonly #workspaceManager: WorkspaceManager;
  readonly #writeGuard: WriteGuard;
  readonly #agentRunner: AgentRunner;
  readonly #verifier: TaskVerifier;
  readonly #now: () => Date;
  readonly #createAttemptId: () => string;
  #nextAttemptNumber = 1;

  constructor(options: {
    readonly scheduler: Scheduler;
    readonly persistence: OrchestrationPersistence;
    readonly workspaceManager: WorkspaceManager;
    readonly writeGuard: WriteGuard;
    readonly agentRunner: AgentRunner;
    readonly verifier: TaskVerifier;
    readonly now?: () => Date;
    readonly createAttemptId?: () => string;
  }) {
    this.#scheduler = options.scheduler;
    this.#persistence = options.persistence;
    this.#workspaceManager = options.workspaceManager;
    this.#writeGuard = options.writeGuard;
    this.#agentRunner = options.agentRunner;
    this.#verifier = options.verifier;
    this.#now = options.now ?? (() => new Date());
    this.#createAttemptId =
      options.createAttemptId ?? (() => `attempt-${this.#nextAttemptNumber++}`);
  }

  async startRun(request: StartRuntimeRunRequest): Promise<RecoveredRuntimeRun> {
    const bindings = this.#bindingsByTask(request);
    if (request.scheduleOptions.maxConcurrency !== 1) {
      throw new OrchestrationRuntimeInputError(
        'The local orchestration runtime currently requires maxConcurrency of 1'
      );
    }
    await this.#persistence.createRun(request);
    const state = {
      request,
      bindings,
      tasksById: new Map(request.tasks.map((task) => [task.id, task])),
      attemptsByTask: new Map<string, AgentExecutionAttempt>(),
      snapshot: {
        taskStates: request.tasks.map((task) => ({ taskId: task.id, state: 'PENDING' as const })),
        runtimeBlocks: []
      },
      nextSequence: 1,
      pendingTaskIds: [] as string[]
    };
    await this.#recordEvent(state, { type: 'run-started' });
    await this.#drain(state);
    return this.#recoveredState(state.snapshot, request.run.id);
  }

  async recoverRun(runId: string): Promise<RecoveredRuntimeRun | undefined> {
    const recovered = await this.#persistence.recoverRun(runId);
    if (recovered === undefined) {
      return undefined;
    }
    if (recovered.decisions.length === 0) {
      return {
        run: recovered.run,
        snapshot: {
          taskStates: recovered.tasks.map((task) => ({ taskId: task.id, state: 'PENDING' })),
          runtimeBlocks: []
        },
        workspaces: recovered.workspaces,
        leases: recovered.leases,
        attempts: recovered.attempts
      };
    }
    const decision = recovered.decisions.at(-1)!;
    const event = recovered.events.find(
      (candidate) => candidate.sequence === decision.sequence
    )?.event;
    if (event === undefined) {
      throw new OrchestrationRuntimeInputError(
        `Missing runtime event for persisted decision: ${runId}/${decision.sequence}`
      );
    }
    const snapshot = this.#applyEventBlockers(
      this.#applyTransitions(decision.inputSnapshot, decision.decision.taskDecisions),
      event
    );
    const unresolvedAttempts = recovered.attempts.filter(
      ({ attempt }) => attempt.state === 'STARTING' || attempt.state === 'RUNNING'
    );
    for (const { attempt } of unresolvedAttempts) {
      await this.#persistence.persistAttempt({
        runId,
        attempt: {
          ...attempt,
          state: 'UNKNOWN',
          revision: attempt.revision + 1,
          failure: {
            type: 'unknown-outcome',
            detail: 'Process restarted during external agent execution.'
          }
        }
      });
    }
    const current =
      unresolvedAttempts.length === 0 ? recovered : await this.#persistence.recoverRun(runId);
    if (current === undefined) {
      throw new OrchestrationRuntimeInputError(`Run disappeared during recovery: ${runId}`);
    }
    return {
      run: current.run,
      snapshot,
      workspaces: current.workspaces,
      leases: current.leases,
      attempts: current.attempts
    };
  }

  #bindingsByTask(request: StartRuntimeRunRequest): ReadonlyMap<string, RuntimeTaskBinding> {
    const taskIds = new Set(request.tasks.map((task) => task.id));
    const bindings = new Map<string, RuntimeTaskBinding>();
    for (const binding of request.taskBindings) {
      if (!taskIds.has(binding.taskId)) {
        throw new OrchestrationRuntimeInputError(`Unknown task binding: ${binding.taskId}`);
      }
      if (bindings.has(binding.taskId)) {
        throw new OrchestrationRuntimeInputError(`Duplicate task binding: ${binding.taskId}`);
      }
      if (
        binding.workspace.runId !== request.run.id ||
        binding.workspace.taskId !== binding.taskId
      ) {
        throw new OrchestrationRuntimeInputError(
          `Workspace binding must match run and task: ${binding.taskId}`
        );
      }
      if (binding.leasePlan.taskId !== binding.taskId) {
        throw new OrchestrationRuntimeInputError(`Lease plan must match task: ${binding.taskId}`);
      }
      taskLeasePlanSchema.parse(binding.leasePlan);
      bindings.set(binding.taskId, binding);
    }
    for (const taskId of taskIds) {
      if (!bindings.has(taskId)) {
        throw new OrchestrationRuntimeInputError(`Missing task binding: ${taskId}`);
      }
    }
    return bindings;
  }

  async #drain(state: RuntimeState): Promise<void> {
    while (state.pendingTaskIds.length > 0) {
      const taskId = state.pendingTaskIds.shift();
      if (taskId === undefined || this.#stateFor(state.snapshot, taskId) !== 'RUNNING') {
        continue;
      }
      await this.#runTask(state, taskId);
    }
  }

  async #runTask(state: RuntimeState, taskId: string): Promise<void> {
    const binding = state.bindings.get(taskId)!;
    const task = state.tasksById.get(taskId);
    if (task === undefined) {
      throw new OrchestrationRuntimeInputError(`Unknown runtime task: ${taskId}`);
    }
    const preparing = state.attemptsByTask.get(taskId);
    if (preparing === undefined) {
      throw new OrchestrationRuntimeInputError(`Missing execution attempt: ${taskId}`);
    }
    const workspace = await this.#workspaceManager.create(binding.workspace);
    await this.#persistence.persistWorkspace({ runId: state.request.run.id, workspace });
    const acquisition = await this.#acquireLeasePlan(state, binding.leasePlan, binding.agentId);
    if (acquisition.status === 'blocked') {
      for (const lease of acquisition.rolledBackLeases) {
        await this.#persistence.persistLease({ runId: state.request.run.id, lease });
      }
      const leaseId = acquisition.leaseId;
      if (leaseId === undefined) {
        throw new OrchestrationRuntimeInputError(`Lease block is missing an owner: ${taskId}`);
      }
      await this.#recordEvent(state, {
        type: 'lease-blocked',
        taskId,
        leaseId
      });
      return;
    }
    const starting: AgentExecutionAttempt = {
      ...preparing,
      state: 'STARTING',
      revision: preparing.revision + 1,
      startedAt: this.#now()
    };
    state.attemptsByTask.set(taskId, starting);
    await this.#persistence.persistAttempt({ runId: state.request.run.id, attempt: starting });
    let executionEstablished = false;
    const agentResult = await this.#agentRunner.run({
      attempt: starting,
      runId: state.request.run.id,
      taskId,
      task,
      workspace,
      instructions: task.goal,
      onStarted: async ({ sessionRef }) => {
        if (executionEstablished) {
          throw new OrchestrationRuntimeInputError(`Agent execution started twice: ${taskId}`);
        }
        executionEstablished = true;
        await this.#persistAttempt(state, taskId, { state: 'RUNNING', sessionRef });
      }
    });
    if (agentResult.status === 'failed') {
      await this.#persistAttempt(state, taskId, {
        state: 'FAILED',
        completedAt: this.#now(),
        failure: { type: 'execution-failed', detail: agentResult.detail }
      });
      this.#setState(state, taskId, 'FAILED');
      await this.#recordEvent(state, { type: 'task-failed', taskId, state: 'FAILED' });
    } else {
      if (!executionEstablished) {
        throw new OrchestrationRuntimeInputError(`Agent execution did not establish: ${taskId}`);
      }
      await this.#persistAttempt(state, taskId, {
        state: 'COMPLETED',
        completedAt: this.#now(),
        sessionRef: agentResult.sessionRef
      });
      this.#setState(state, taskId, 'VERIFYING');
      await this.#recordEvent(state, { type: 'agent-completed', taskId, state: 'VERIFYING' });
    }
    const released = await this.#releaseLeasePlan(acquisition.leases);
    if (released.status !== 'released') {
      for (const lease of released.leases) {
        await this.#persistence.persistLease({ runId: state.request.run.id, lease });
      }
      await this.#recordEvent(state, {
        type: 'lease-release-failed',
        taskId,
        leaseId: released.leaseId
      });
      await this.#persistence.updateRunState(state.request.run.id, 'FAILED');
      throw new OrchestrationRuntimeInputError(
        `Lease release failed for task ${taskId}: ${released.status}`
      );
    }
    for (const lease of released.leases) {
      await this.#persistence.persistLease({ runId: state.request.run.id, lease });
      await this.#recordEvent(state, { type: 'lease-released', taskId, leaseId: lease.id });
    }
    if (agentResult.status === 'failed') {
      return;
    }
    const verification = await this.#verifier.verify({
      runId: state.request.run.id,
      task,
      workspace
    });
    if (verification.status === 'failed') {
      this.#setState(state, taskId, 'FAILED');
      await this.#recordEvent(state, { type: 'task-failed', taskId, state: 'FAILED' });
      return;
    }
    this.#setState(state, taskId, 'INTEGRATING');
    await this.#recordEvent(state, {
      type: 'verification-completed',
      taskId,
      state: 'INTEGRATING'
    });
    const integration = await this.#workspaceManager.integrate(workspace);
    await this.#persistence.persistWorkspace({
      runId: state.request.run.id,
      workspace: integration.workspace
    });
    if (integration.status === 'blocked') {
      return;
    }
    this.#setState(state, taskId, 'COMPLETED');
    await this.#recordEvent(state, { type: 'workspace-integrated', taskId, state: 'COMPLETED' });
  }

  async #recordEvent(state: RuntimeState, event: SchedulerEvent): Promise<void> {
    const inputSnapshot = state.snapshot;
    const decision = this.#scheduler.reevaluate(
      event,
      inputSnapshot,
      state.request.tasks,
      state.request.hardConflicts,
      state.request.riskConflicts,
      state.request.scheduleOptions
    );
    const sequence = state.nextSequence++;
    const reevaluation: PersistedReevaluation = {
      event: {
        runId: state.request.run.id,
        sequence,
        occurredAt: this.#now().toISOString(),
        event
      },
      transitions: taskDecisionsWithTransitions(decision.taskDecisions).map((taskDecision) => ({
        runId: state.request.run.id,
        sequence,
        taskId: taskDecision.taskId,
        fromState: taskDecision.fromState,
        toState: taskDecision.toState
      })),
      decision: { runId: state.request.run.id, sequence, inputSnapshot, decision }
    };
    const attempts = decision.taskDecisions
      .filter((taskDecision) => taskDecision.action === 'start')
      .map((taskDecision) => {
        const binding = state.bindings.get(taskDecision.taskId);
        if (binding === undefined) {
          throw new OrchestrationRuntimeInputError(`Missing task binding: ${taskDecision.taskId}`);
        }
        const attempt: AgentExecutionAttempt = {
          id: this.#createAttemptId(),
          runId: state.request.run.id,
          taskId: taskDecision.taskId,
          agentId: binding.agentId,
          workspaceId: binding.workspace.id,
          state: 'PREPARING',
          revision: 1
        };
        state.attemptsByTask.set(taskDecision.taskId, attempt);
        return { runId: state.request.run.id, attempt };
      });
    await this.#persistence.persistDispatch({ reevaluation, attempts });
    state.snapshot = this.#applyEventBlockers(
      this.#applyTransitions(inputSnapshot, decision.taskDecisions),
      event
    );
    state.pendingTaskIds.push(
      ...decision.taskDecisions
        .filter((taskDecision) => taskDecision.action === 'start')
        .map((taskDecision) => taskDecision.taskId)
        .toSorted(compareIds)
    );
  }

  async #recoveredState(snapshot: SchedulerSnapshot, runId: string): Promise<RecoveredRuntimeRun> {
    const recovered = await this.#persistence.recoverRun(runId);
    if (recovered === undefined) {
      throw new OrchestrationRuntimeInputError(`Run disappeared during execution: ${runId}`);
    }
    return {
      run: recovered.run,
      snapshot,
      workspaces: recovered.workspaces,
      leases: recovered.leases,
      attempts: recovered.attempts
    };
  }

  async #persistAttempt(
    state: RuntimeState,
    taskId: string,
    update: Omit<
      AgentExecutionAttempt,
      'id' | 'runId' | 'taskId' | 'agentId' | 'workspaceId' | 'revision'
    >
  ): Promise<void> {
    const current = state.attemptsByTask.get(taskId);
    if (current === undefined) {
      throw new OrchestrationRuntimeInputError(`Missing execution attempt: ${taskId}`);
    }
    const attempt: AgentExecutionAttempt = {
      ...current,
      ...update,
      revision: current.revision + 1
    };
    state.attemptsByTask.set(taskId, attempt);
    await this.#persistence.persistAttempt({ runId: state.request.run.id, attempt });
  }

  async #acquireLeasePlan(
    state: RuntimeState,
    plan: TaskLeasePlan,
    agentId: string
  ): Promise<
    | { readonly status: 'granted'; readonly leases: readonly WriteLease[] }
    | {
        readonly status: 'blocked';
        readonly leaseId?: string;
        readonly rolledBackLeases: readonly WriteLease[];
      }
  > {
    const leases: WriteLease[] = [];
    for (const resource of canonicalTaskLeaseResources(plan.predictedResources)) {
      const acquired = await this.#writeGuard.acquire({
        runId: state.request.run.id,
        agentId,
        taskId: plan.taskId,
        resource,
        mode: 'exclusive'
      });
      if (acquired.status === 'granted') {
        leases.push(acquired.lease);
        await this.#persistence.persistLease({
          runId: state.request.run.id,
          lease: acquired.lease
        });
        continue;
      }
      const rollback = await this.#releaseLeasePlan(leases);
      if (rollback.status !== 'released') {
        for (const lease of rollback.leases) {
          await this.#persistence.persistLease({ runId: state.request.run.id, lease });
        }
        await this.#recordEvent(state, {
          type: 'lease-release-failed',
          taskId: plan.taskId,
          leaseId: rollback.leaseId
        });
        await this.#persistence.updateRunState(state.request.run.id, 'FAILED');
        throw new OrchestrationRuntimeInputError(
          `Lease rollback failed for task ${plan.taskId}: ${rollback.status}`
        );
      }
      return {
        status: 'blocked',
        leaseId: acquired.conflictingLeaseIds[0],
        rolledBackLeases: rollback.leases
      };
    }
    return { status: 'granted', leases };
  }

  async #releaseLeasePlan(leases: readonly WriteLease[]): Promise<
    | { readonly status: 'released'; readonly leases: readonly WriteLease[] }
    | {
        readonly status: 'not-found' | 'version-conflict';
        readonly leaseId: string;
        readonly leases: readonly WriteLease[];
      }
  > {
    const released: WriteLease[] = [];
    for (const lease of leases.toReversed()) {
      const result = await this.#writeGuard.release({
        leaseId: lease.id,
        expectedVersion: lease.version
      });
      if (result.status !== 'released') {
        return { status: result.status, leaseId: lease.id, leases: released };
      }
      released.push(result.lease);
    }
    return { status: 'released', leases: released };
  }

  #applyTransitions(
    snapshot: SchedulerSnapshot,
    taskDecisions: readonly SchedulerTaskDecision[]
  ): SchedulerSnapshot {
    const states = new Map(
      snapshot.taskStates.map((taskState) => [taskState.taskId, taskState.state])
    );
    for (const taskDecision of taskDecisions) {
      if ('toState' in taskDecision) {
        states.set(taskDecision.taskId, taskDecision.toState);
      }
    }
    return {
      taskStates: [...states]
        .map(([taskId, state]) => ({ taskId, state }))
        .toSorted((a, b) => compareIds(a.taskId, b.taskId)),
      runtimeBlocks: snapshot.runtimeBlocks
    };
  }

  #applyEventBlockers(snapshot: SchedulerSnapshot, event: SchedulerEvent): SchedulerSnapshot {
    if (event.type === 'lease-blocked') {
      return {
        ...snapshot,
        runtimeBlocks: [
          ...snapshot.runtimeBlocks.filter((entry) => entry.taskId !== event.taskId),
          { taskId: event.taskId, blockers: [{ type: 'lease', leaseId: event.leaseId }] }
        ]
      };
    }
    if (event.type === 'lease-released' || event.type === 'lease-stale') {
      return {
        ...snapshot,
        runtimeBlocks: snapshot.runtimeBlocks
          .map((entry) => ({
            taskId: entry.taskId,
            blockers: entry.blockers.filter(
              (blocker) => blocker.type !== 'lease' || blocker.leaseId !== event.leaseId
            )
          }))
          .filter((entry) => entry.blockers.length > 0)
      };
    }
    return snapshot;
  }

  #setState(
    state: RuntimeState,
    taskId: string,
    taskState: SchedulerSnapshot['taskStates'][number]['state']
  ): void {
    state.snapshot = {
      ...state.snapshot,
      taskStates: state.snapshot.taskStates.map((entry) =>
        entry.taskId === taskId ? { ...entry, state: taskState } : entry
      )
    };
  }

  #stateFor(
    snapshot: SchedulerSnapshot,
    taskId: string
  ): SchedulerSnapshot['taskStates'][number]['state'] {
    const state = snapshot.taskStates.find((entry) => entry.taskId === taskId)?.state;
    if (state === undefined) {
      throw new OrchestrationRuntimeInputError(`Unknown runtime task: ${taskId}`);
    }
    return state;
  }
}

interface RuntimeState {
  readonly request: StartRuntimeRunRequest;
  readonly bindings: ReadonlyMap<string, RuntimeTaskBinding>;
  readonly tasksById: ReadonlyMap<string, TaskContract>;
  readonly attemptsByTask: Map<string, AgentExecutionAttempt>;
  snapshot: SchedulerSnapshot;
  nextSequence: number;
  readonly pendingTaskIds: string[];
}

export class FakeAgentRunner implements AgentRunner {
  readonly #results: ReadonlyMap<
    string,
    Extract<Awaited<ReturnType<AgentRunner['run']>>, { readonly status: 'failed' }>
  >;

  constructor(failures: ReadonlyMap<string, string> = new Map()) {
    this.#results = new Map(
      [...failures].map(([taskId, detail]) => [taskId, { status: 'failed' as const, detail }])
    );
  }

  async run(
    request: Parameters<AgentRunner['run']>[0]
  ): Promise<Awaited<ReturnType<AgentRunner['run']>>> {
    await request.onStarted({});
    return this.#results.get(request.task.id) ?? { status: 'completed' };
  }
}

export class FakeTaskVerifier implements TaskVerifier {
  readonly #results: ReadonlyMap<
    string,
    Extract<Awaited<ReturnType<TaskVerifier['verify']>>, { readonly status: 'failed' }>
  >;

  constructor(failures: ReadonlyMap<string, string> = new Map()) {
    this.#results = new Map(
      [...failures].map(([taskId, detail]) => [taskId, { status: 'failed' as const, detail }])
    );
  }

  async verify(
    request: Parameters<TaskVerifier['verify']>[0]
  ): Promise<Awaited<ReturnType<TaskVerifier['verify']>>> {
    return this.#results.get(request.task.id) ?? { status: 'passed' };
  }
}
