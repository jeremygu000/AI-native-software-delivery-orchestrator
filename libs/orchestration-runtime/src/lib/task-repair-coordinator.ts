import type {
  TaskCodeReview,
  TaskCodeReviewSubject,
  TaskRepairAttempt,
  TaskRepairAttemptStore
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
  readonly #store: TaskRepairAttemptStore;
  readonly #maxRepairs: number;
  readonly #now: () => Date;
  readonly #createId: () => string;

  constructor(options: {
    readonly store: TaskRepairAttemptStore;
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
    const previous = await this.#store.recoverRepairAttempts(request.runId);
    const taskAttempts = previous.filter(({ attempt }) => attempt.taskId === request.taskId);
    if (taskAttempts.length >= this.#maxRepairs) {
      throw new TaskRepairBudgetError(`Repair budget exhausted for task: ${request.taskId}`);
    }
    const repairIteration = taskAttempts.length + 1;
    const attempt: TaskRepairAttempt = {
      id: this.#createId(),
      runId: request.runId,
      taskId: request.taskId,
      agentId: request.agentId,
      workspaceId: request.workspaceId,
      parentReviewIteration: request.reviewIteration,
      parentReviewSubject: request.subject,
      repairIteration,
      state: 'PREPARING',
      revision: 1
    };
    await this.#store.persistRepairAttempt({ runId: request.runId, attempt });
    return attempt;
  }

  async markStarted(attempt: TaskRepairAttempt, sessionRef?: TaskRepairAttempt['sessionRef']) {
    const started: TaskRepairAttempt = {
      ...attempt,
      state: 'RUNNING',
      revision: attempt.revision + 1,
      startedAt: this.#now(),
      ...(sessionRef === undefined ? {} : { sessionRef })
    };
    await this.#store.persistRepairAttempt({ runId: started.runId, attempt: started });
    return started;
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
