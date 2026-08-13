import {
  parseTaskCodeReview,
  type TaskCodeReviewer,
  type TaskCodeReviewRequest,
  type TaskCodeReviewStore
} from '@ai-native-software-delivery-orchestrator/domain';

/** Collects untrusted review evidence without granting repair or integration authority. */
export class TaskCodeReviewCollector {
  readonly #reviewer: TaskCodeReviewer;
  readonly #store: TaskCodeReviewStore;

  constructor(options: {
    readonly reviewer: TaskCodeReviewer;
    readonly store: TaskCodeReviewStore;
  }) {
    this.#reviewer = options.reviewer;
    this.#store = options.store;
  }

  async collect(request: TaskCodeReviewRequest) {
    const review = parseTaskCodeReview(await this.#reviewer.review(request));
    await this.#store.persistReview({
      runId: request.runId,
      taskId: request.task.id,
      iteration: request.iteration,
      review
    });
    return review;
  }
}
