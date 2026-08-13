import type {
  TaskCodeReview,
  TaskCodeReviewSubject,
  TaskRepairAttempt,
  TaskRepairAdmissionStore,
  TaskRepairResumeStore
} from '@ai-native-software-delivery-orchestrator/domain';

export class TaskRepairBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskRepairBudgetError';
  }
}

export class TaskRepairAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskRepairAdmissionError';
  }
}

export class TaskRepairCoordinator {
  readonly #store: TaskRepairAdmissionStore & TaskRepairResumeStore;
  readonly #maxRepairs: number;
  readonly #now: () => Date;
  readonly #createId: () => string;

  constructor(options: {
    readonly store: TaskRepairAdmissionStore & TaskRepairResumeStore;
    readonly maxRepairs: number;
    readonly now?: () => Date;
    readonly createId: () => string;
  }) {
    if (!Number.isInteger(options.maxRepairs) || options.maxRepairs < 1) {
      throw new TaskRepairBudgetError('Repair budget must be a positive integer');
    }
    this.#store = options.store;
    this.#maxRepairs = options.maxRepairs;
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId;
  }

  async prepare(request: {
    readonly runId: string;
    readonly taskId: string;
    readonly agentId: string;
    readonly workspaceId: string;
    readonly reviewIteration: number;
    readonly review: TaskCodeReview;
    readonly subject: TaskCodeReviewSubject;
  }): Promise<TaskRepairAttempt> {
    if (request.review.recommendation !== 'repair') {
      throw new TaskRepairAdmissionError(
        'Only a repair recommendation may create a repair attempt'
      );
    }
    const attempt: TaskRepairAttempt = {
      id: this.#createId(),
      runId: request.runId,
      taskId: request.taskId,
      agentId: request.agentId,
      workspaceId: request.workspaceId,
      parentReviewIteration: request.reviewIteration,
      parentReviewSubject: request.subject,
      repairIteration: 1,
      state: 'PREPARING',
      revision: 1
    };
    try {
      return await this.#store.admitRepairAttempt({ attempt, maxRepairs: this.#maxRepairs });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Repair budget exhausted')) {
        throw new TaskRepairBudgetError(error.message);
      }
      throw error;
    }
  }

  async markStarting(attempt: TaskRepairAttempt) {
    const starting: TaskRepairAttempt = {
      ...attempt,
      state: 'STARTING',
      revision: attempt.revision + 1,
      startedAt: this.#now()
    };
    await this.#store.persistRepairAttempt({ runId: starting.runId, attempt: starting });
    return starting;
  }

  async markStarted(attempt: TaskRepairAttempt, sessionRef?: TaskRepairAttempt['sessionRef']) {
    const started: TaskRepairAttempt = {
      ...attempt,
      state: 'RUNNING',
      revision: attempt.revision + 1,
      ...(sessionRef === undefined ? {} : { sessionRef })
    };
    await this.#store.persistRepairAttempt({ runId: started.runId, attempt: started });
    return started;
  }

  async markUnknown(attempt: TaskRepairAttempt, detail: string) {
    const unknown: TaskRepairAttempt = {
      ...attempt,
      state: 'UNKNOWN',
      revision: attempt.revision + 1,
      completedAt: this.#now(),
      failure: { type: 'unknown-outcome', detail }
    };
    await this.#store.persistRepairAttempt({ runId: unknown.runId, attempt: unknown });
    return unknown;
  }

  async markBlocked(attempt: TaskRepairAttempt, leaseId: string) {
    const blocked: TaskRepairAttempt = {
      ...attempt,
      state: 'BLOCKED',
      revision: attempt.revision + 1,
      blocker: { type: 'lease', leaseId }
    };
    await this.#store.persistRepairAttempt({ runId: blocked.runId, attempt: blocked });
    return blocked;
  }

  async resume(attempt: TaskRepairAttempt) {
    const result = await this.#store.resumeRepairAttempt({
      runId: attempt.runId,
      attemptId: attempt.id,
      expectedRevision: attempt.revision
    });
    if (result.status === 'resumed') {
      return result.attempt;
    }
    throw new TaskRepairAdmissionError(`Repair attempt cannot resume: ${result.status}`);
  }

  async complete(attempt: TaskRepairAttempt) {
    const completed: TaskRepairAttempt = {
      ...attempt,
      state: 'COMPLETED',
      revision: attempt.revision + 1,
      completedAt: this.#now()
    };
    await this.#store.persistRepairAttempt({ runId: completed.runId, attempt: completed });
    return completed;
  }

  async fail(attempt: TaskRepairAttempt, detail: string) {
    const failed: TaskRepairAttempt = {
      ...attempt,
      state: 'FAILED',
      revision: attempt.revision + 1,
      completedAt: this.#now(),
      failure: { type: 'execution-failed', detail }
    };
    await this.#store.persistRepairAttempt({ runId: failed.runId, attempt: failed });
    return failed;
  }
}
