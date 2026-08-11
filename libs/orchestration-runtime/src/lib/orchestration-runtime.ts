import type {
  AgentRunner,
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
  WritableResource,
  WorkspaceManager,
  WriteGuard
} from '@ai-native-software-delivery-orchestrator/domain';
import { taskDecisionsWithTransitions } from '@ai-native-software-delivery-orchestrator/domain';

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface RuntimeTaskBinding {
  readonly taskId: string;
  readonly agentId: string;
  readonly resource: WritableResource;
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

  constructor(options: {
    readonly scheduler: Scheduler;
    readonly persistence: OrchestrationPersistence;
    readonly workspaceManager: WorkspaceManager;
    readonly writeGuard: WriteGuard;
    readonly agentRunner: AgentRunner;
    readonly verifier: TaskVerifier;
    readonly now?: () => Date;
  }) {
    this.#scheduler = options.scheduler;
    this.#persistence = options.persistence;
    this.#workspaceManager = options.workspaceManager;
    this.#writeGuard = options.writeGuard;
    this.#agentRunner = options.agentRunner;
    this.#verifier = options.verifier;
    this.#now = options.now ?? (() => new Date());
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
        leases: recovered.leases
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
    return {
      run: recovered.run,
      snapshot,
      workspaces: recovered.workspaces,
      leases: recovered.leases
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
    const workspace = await this.#workspaceManager.create(binding.workspace);
    await this.#persistence.persistWorkspace({ runId: state.request.run.id, workspace });
    const acquired = await this.#writeGuard.acquire({
      runId: state.request.run.id,
      agentId: binding.agentId,
      taskId,
      resource: binding.resource,
      mode: 'exclusive'
    });
    if (acquired.status === 'blocked') {
      const leaseId = acquired.conflictingLeaseIds[0];
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
    await this.#persistence.persistLease({ runId: state.request.run.id, lease: acquired.lease });
    const agentResult = await this.#agentRunner.run({
      runId: state.request.run.id,
      task,
      workspace
    });
    if (agentResult.status === 'failed') {
      this.#setState(state, taskId, 'FAILED');
      await this.#recordEvent(state, { type: 'task-failed', taskId, state: 'FAILED' });
    } else {
      this.#setState(state, taskId, 'VERIFYING');
      await this.#recordEvent(state, { type: 'agent-completed', taskId, state: 'VERIFYING' });
    }
    const released = await this.#writeGuard.release({
      leaseId: acquired.lease.id,
      expectedVersion: acquired.lease.version
    });
    if (released.status !== 'released') {
      await this.#recordEvent(state, {
        type: 'lease-release-failed',
        taskId,
        leaseId: acquired.lease.id
      });
      await this.#persistence.updateRunState(state.request.run.id, 'FAILED');
      throw new OrchestrationRuntimeInputError(
        `Lease release failed for task ${taskId}: ${released.status}`
      );
    }
    await this.#persistence.persistLease({ runId: state.request.run.id, lease: released.lease });
    await this.#recordEvent(state, { type: 'lease-released', taskId, leaseId: released.lease.id });
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
    await this.#persistence.persistReevaluation(reevaluation);
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
      leases: recovered.leases
    };
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
