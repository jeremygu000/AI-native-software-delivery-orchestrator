
import type {
  OrchestrationPersistence,
  PersistedAgentExecutionAttempt,
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

  async reevaluate(runId: string): Promise<readonly ForgeRunAuthorization[]> {
    const recovered = await this.#requireRun(runId);
    if (recovered.run.state !== 'ACTIVE') {
      return [];
    }

    const persistedDecisions = recovered.decisions;
    const inputSnapshot =
      persistedDecisions.length === 0
        ? initialSnapshot(recovered)
        : this.#currentSnapshot(recovered);
    const event: SchedulerEvent =
      persistedDecisions.length === 0
        ? { type: 'run-started' }
        : { type: 'runtime-reconciliation-recovered' };
    const decision = this.#scheduler.reevaluate(
      event,
      inputSnapshot,
      recovered.tasks,
      [
        ...recovered.hardConflicts,
        ...recovered.conflicts.flatMap((record) =>
          record.conflict.severity === 'hard' ? [record.conflict] : []
        )
      ],
      [
        ...recovered.riskConflicts,
        ...recovered.conflicts.flatMap((record) =>
          record.conflict.severity === 'hard' ? [] : [record.conflict]
        )
      ],
      recovered.scheduleOptions
    );
    const sequence = persistedDecisions.length + 1;
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

  async applyEvent(
    runId: string,
    event: Extract<SchedulerEvent, { readonly taskId: string }>
  ): Promise<void> {
    const recovered = await this.#requireRun(runId);
    const inputSnapshot = this.#currentSnapshot(recovered);
    const decision = this.#scheduler.reevaluate(
      event,
      inputSnapshot,
      recovered.tasks,
      [
        ...recovered.hardConflicts,
        ...recovered.conflicts.flatMap((record) =>
          record.conflict.severity === 'hard' ? [record.conflict] : []
        )
      ],
      [
        ...recovered.riskConflicts,
        ...recovered.conflicts.flatMap((record) =>
          record.conflict.severity === 'hard' ? [] : [record.conflict]
        )
      ],
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
    await this.#persistence.persistDispatch({ reevaluation, attempts: [] });
  }

  async persistCompletedRepairReview(request: {
    readonly runId: string;
    readonly taskId: string;
    readonly parentReviewIteration: number;
    readonly subject: TaskCodeReviewSubject;
    readonly review: TaskCodeReview;
  }): Promise<PersistedTaskCodeReview> {
    const reviews = await this.#persistence.recoverReviews(request.runId);
    const latestIteration = reviews
      .filter((review: PersistedTaskCodeReview) => review.taskId === request.taskId)
      .reduce(
        (iteration: number, review: PersistedTaskCodeReview) =>
          Math.max(iteration, review.iteration),
        0
      );
    const nextIteration = Math.max(latestIteration + 1, request.parentReviewIteration + 1);
    const record: PersistedTaskCodeReview = {
      runId: request.runId,
      taskId: request.taskId,
      iteration: nextIteration,
      subject: request.subject,
      review: request.review
    };
    await this.#persistence.persistReview(record);
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

  async #requireRun(runId: string): Promise<RecoveredRun> {
    const recovered = await this.#persistence.recoverRun(runId);
    if (recovered === undefined) {
      throw new ForgeRunProgressionError(`Missing durable progression authority: ${runId}`);
    }
    return recovered;
  }
}
