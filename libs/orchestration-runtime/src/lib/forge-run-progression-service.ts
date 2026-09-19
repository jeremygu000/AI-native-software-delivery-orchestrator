
import type {
  OrchestrationPersistence,
  PersistedAgentExecutionAttempt,
  PersistedDispatch,
  PersistedReevaluation,
  PersistedTaskCodeReview,
  PersistedTaskExecutionBinding,
  RecoveredRun,
  Scheduler,
  SchedulerEvent,
  SchedulerSnapshot,
  SchedulerTaskDecision,
  TaskCodeReview,
  TaskCodeReviewStore,
  TaskCodeReviewSubject,
  TaskState
} from '@ai-native-software-delivery-orchestrator/domain';
import {
  agentCommandPolicyFingerprint,
  defaultAgentCommandTrustedPath,
  taskLeasePlanFingerprint
} from '@ai-native-software-delivery-orchestrator/domain';
import { DeterministicScheduler } from '@ai-native-software-delivery-orchestrator/scheduler';

export type ForgeRunProgressionPersistence = OrchestrationPersistence & TaskCodeReviewStore;

export interface ForgeRunAuthorization {
  readonly taskId: string;
  readonly attemptId: string;
}

export interface ForgeRunProgressionContext {
  readonly run: RecoveredRun['run'];
  readonly snapshot: SchedulerSnapshot;
  readonly tasks: RecoveredRun['tasks'];
  readonly bindings: readonly PersistedTaskExecutionBinding[];
  readonly attempts: readonly PersistedAgentExecutionAttempt[];
  readonly reviews: readonly PersistedTaskCodeReview[];
}

export class ForgeRunProgressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForgeRunProgressionError';
  }
}

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const terminalStates = new Set<TaskState>(['COMPLETED', 'FAILED', 'CANCELLED']);

const initialSnapshot = (run: RecoveredRun): SchedulerSnapshot => ({
  taskStates: run.tasks.map((task) => ({ taskId: task.id, state: 'PENDING' })),
  runtimeBlocks: []
});

const applyTransitions = (
  snapshot: SchedulerSnapshot,
  taskDecisions: readonly SchedulerTaskDecision[]
): SchedulerSnapshot => {
  const states = new Map(snapshot.taskStates.map((entry) => [entry.taskId, entry.state]));
  for (const taskDecision of taskDecisions) {
    if ('toState' in taskDecision) {
      states.set(taskDecision.taskId, taskDecision.toState);
    }
  }
  return {
    taskStates: [...states]
      .map(([taskId, state]) => ({ taskId, state }))
      .toSorted((left, right) => compareIds(left.taskId, right.taskId)),
    runtimeBlocks: snapshot.runtimeBlocks
  };
};

const applyEventBlockers = (
  snapshot: SchedulerSnapshot,
  event: SchedulerEvent
): SchedulerSnapshot => {
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
};

/**
 * State-bearing scheduler events (agent-completed / verification-completed /
 * workspace-integrated / task-completed / task-failed) require the input snapshot to
 * already carry the event's target state, because the production runtime persists the
 * state transition before asking the scheduler to reevaluate. We therefore project the
 * current snapshot onto the event state before handing it to the scheduler.
 */
const projectEventState = (snapshot: SchedulerSnapshot, event: SchedulerEvent): SchedulerSnapshot => {
  if (!('taskId' in event) || !('state' in event)) {
    return snapshot;
  }
  const taskStates = snapshot.taskStates.map((entry) =>
    entry.taskId === event.taskId ? { taskId: entry.taskId, state: event.state } : entry
  );
  return { taskStates, runtimeBlocks: snapshot.runtimeBlocks };
};

const sameEvent = (left: SchedulerEvent, right: SchedulerEvent): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export class ForgeRunProgressionService {
  readonly #persistence: ForgeRunProgressionPersistence;
  readonly #scheduler: Scheduler;
  readonly #createAttemptId: () => string;
  readonly #now: () => Date;

  constructor(options: {
    readonly persistence: ForgeRunProgressionPersistence;
    readonly scheduler?: Scheduler;
    readonly createAttemptId?: () => string;
    readonly now?: () => Date;
  }) {
    this.#persistence = options.persistence;
    this.#scheduler = options.scheduler ?? new DeterministicScheduler();
    this.#createAttemptId =
      options.createAttemptId ??
      (() => `attempt:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`);
    this.#now = options.now ?? (() => new Date());
  }

  async recoverContext(runId: string): Promise<ForgeRunProgressionContext> {
    const recovered = await this.#requireRun(runId);
    return {
      run: recovered.run,
      snapshot: this.#currentSnapshot(recovered),
      tasks: recovered.tasks,
      bindings: recovered.taskBindings,
      attempts: recovered.attempts,
      reviews: await this.#persistence.recoverReviews(runId)
    };
  }

  /**
   * Advances the run by one lifecycle event. This is the single authoritative write path
   * used both for the initial run dispatch and for subsequent task lifecycle events.
   *
   * Idempotency: if a dispatch for the exact same scheduler event has already been
   * persisted, the previously persisted PREPARING attempts are returned instead of
   * creating a new sequence. Temporal activity retries after a lost response therefore
   * observe the same durable authorizations.
   */
  async advance(
    runId: string,
    event: SchedulerEvent
  ): Promise<readonly ForgeRunAuthorization[]> {
    const recovered = await this.#requireRun(runId);

    const existing = await this.#findExistingDispatch(recovered, event);
    if (existing !== undefined) {
      return existing;
    }

    if (recovered.run.state !== 'ACTIVE' && event.type !== 'run-started') {
      return [];
    }

    const inputSnapshot = projectEventState(this.#currentSnapshot(recovered), event);
    const decision = this.#scheduler.reevaluate(
      event,
      inputSnapshot,
      recovered.tasks,
      this.#hardConflicts(recovered),
      this.#riskConflicts(recovered),
      recovered.scheduleOptions
    );
    const sequence = recovered.decisions.length + 1;
    const reevaluation: PersistedReevaluation = {
      event: {
        runId,
        sequence,
        occurredAt: this.#now().toISOString(),
        event
      },
      transitions: decision.taskDecisions.flatMap((taskDecision) =>
        'toState' in taskDecision
          ? [
              {
                runId,
                sequence,
                taskId: taskDecision.taskId,
                fromState: taskDecision.fromState,
                toState: taskDecision.toState
              }
            ]
          : []
      ),
      decision: {
        runId,
        sequence,
        inputSnapshot,
        decision
      }
    };
    const attempts = decision.taskDecisions
      .filter((taskDecision) => taskDecision.action === 'start')
      .map((taskDecision) => {
        const binding = recovered.taskBindings.find(
          (candidate) => candidate.taskId === taskDecision.taskId
        );
        if (binding === undefined) {
          throw new ForgeRunProgressionError(
            `Missing task binding for authorized task: ${runId}/${taskDecision.taskId}`
          );
        }
        return {
          runId,
          attempt: {
            id: this.#createAttemptId(),
            runId,
            taskId: taskDecision.taskId,
            agentId: binding.agentId,
            workspaceId: binding.workspace.id,
            leasePlanFingerprint: taskLeasePlanFingerprint(binding.leasePlan),
            commandPolicyFingerprint: agentCommandPolicyFingerprint(binding.commandPolicy),
            trustedCommandPath: binding.trustedCommandPath ?? defaultAgentCommandTrustedPath,
            state: 'PREPARING',
            revision: 1
          }
        } satisfies PersistedAgentExecutionAttempt;
      });
    await this.#persistence.persistDispatch({ reevaluation, attempts });
    return attempts.map(({ attempt }) => ({ taskId: attempt.taskId, attemptId: attempt.id }));
  }

  async reevaluate(runId: string): Promise<readonly ForgeRunAuthorization[]> {
    const recovered = await this.#requireRun(runId);
    if (recovered.run.state !== 'ACTIVE') {
      return [];
    }
    const event: SchedulerEvent =
      recovered.decisions.length === 0
        ? { type: 'run-started' }
        : { type: 'runtime-reconciliation-recovered' };
    return this.advance(runId, event);
  }

  async finalize(runId: string): Promise<'completed' | 'failed'> {
    const recovered = await this.#requireRun(runId);
    const snapshot = this.#currentSnapshot(recovered);
    const states = snapshot.taskStates.map((taskState) => taskState.state);
    if (states.some((taskState) => taskState === 'FAILED')) {
      await this.#persistence.updateRunState(runId, 'FAILED');
      return 'failed';
    }
    if (states.every((taskState) => terminalStates.has(taskState))) {
      await this.#persistence.updateRunState(runId, 'COMPLETED');
      return 'completed';
    }
    throw new ForgeRunProgressionError(`Run is not terminal: ${runId}`);
  }

  /**
   * Recovers the persisted repair review produced at parentIteration + 1 and verifies it
   * matches the execution result exactly. The repair execution coordinator persists this
   * review itself; the worker must never synthesize a new iteration from it.
   */
  async recoverCompletedRepairReview(request: {
    readonly runId: string;
    readonly taskId: string;
    readonly parentReviewIteration: number;
    readonly subject: TaskCodeReviewSubject;
    readonly review: TaskCodeReview;
  }): Promise<PersistedTaskCodeReview> {
    const reviews = await this.#persistence.recoverReviews(request.runId);
    const expectedIteration = request.parentReviewIteration + 1;
    const record = reviews.find(
      (candidate) => candidate.taskId === request.taskId && candidate.iteration === expectedIteration
    );
    if (record === undefined) {
      throw new ForgeRunProgressionError(
        `Missing persisted repair review: ${request.runId}/${request.taskId}#${expectedIteration}`
      );
    }
    if (
      record.subject === undefined ||
      record.subject.builderAttemptId !== request.subject.builderAttemptId ||
      record.subject.outputAttemptId !== request.subject.outputAttemptId ||
      record.subject.workspaceId !== request.subject.workspaceId
    ) {
      throw new ForgeRunProgressionError(
        `Persisted repair review subject mismatch: ${request.runId}/${request.taskId}#${expectedIteration}`
      );
    }
    if (
      record.review.recommendation !== request.review.recommendation ||
      record.review.summary !== request.review.summary
    ) {
      throw new ForgeRunProgressionError(
        `Persisted repair review mismatch: ${request.runId}/${request.taskId}#${expectedIteration}`
      );
    }
    return record;
  }

  #currentSnapshot(run: RecoveredRun): SchedulerSnapshot {
    const latestDecision = run.decisions.at(-1);
    if (latestDecision === undefined) {
      return initialSnapshot(run);
    }
    const event = run.events.find((candidate) => candidate.sequence === latestDecision.sequence)?.event;
    if (event === undefined) {
      throw new ForgeRunProgressionError(
        `Missing runtime event for persisted decision: ${run.run.id}/${latestDecision.sequence}`
      );
    }
    return applyEventBlockers(
      applyTransitions(latestDecision.inputSnapshot, latestDecision.decision.taskDecisions),
      event
    );
  }

  /**
   * Finds a previously persisted dispatch for the exact same scheduler event and returns
   * the PREPARING attempts atomically persisted with it, in scheduler decision order.
   */
  async #findExistingDispatch(
    recovered: RecoveredRun,
    event: SchedulerEvent
  ): Promise<readonly ForgeRunAuthorization[] | undefined> {
    const dispatches = await this.#persistence.recoverDispatches(recovered.run.id);
    const match = dispatches.find((dispatch) => sameEvent(dispatch.reevaluation.event.event, event));
    if (match === undefined) {
      return undefined;
    }
    return match.reevaluation.decision.decision.taskDecisions
      .filter((taskDecision) => taskDecision.action === 'start')
      .map((taskDecision) => {
        const attempt = match.attempts.find(
          (candidate) => candidate.attempt.taskId === taskDecision.taskId
        );
        if (attempt === undefined) {
          throw new ForgeRunProgressionError(
            `Persisted dispatch is missing its PREPARING attempt: ${recovered.run.id}/${taskDecision.taskId}`
          );
        }
        return { taskId: taskDecision.taskId, attemptId: attempt.attempt.id };
      });
  }

  #hardConflicts(recovered: RecoveredRun) {
    return [
      ...recovered.hardConflicts,
      ...recovered.conflicts.flatMap((record) =>
        record.conflict.severity === 'hard' ? [record.conflict] : []
      )
    ];
  }

  #riskConflicts(recovered: RecoveredRun) {
    return [
      ...recovered.riskConflicts,
      ...recovered.conflicts.flatMap((record) =>
        record.conflict.severity === 'hard' ? [] : [record.conflict]
      )
    ];
  }

  async #requireRun(runId: string): Promise<RecoveredRun> {
    const recovered = await this.#persistence.recoverRun(runId);
    if (recovered === undefined) {
      throw new ForgeRunProgressionError(`Missing durable progression authority: ${runId}`);
    }
    return recovered;
  }
}

export type { PersistedDispatch };
