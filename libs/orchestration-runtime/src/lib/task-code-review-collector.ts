import {
  assertTaskCodeReviewFindingEvidence,
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
    if (request.verificationResult?.status === 'failed' && review.recommendation === 'accept') {
      throw new Error('A failed verification gate cannot receive an accepted review');
    }
    assertTaskCodeReviewFindingEvidence(review, request.repository);
    await this.#store.persistReview({
      runId: request.runId,
      taskId: request.task.id,
      iteration: request.iteration,
      subject: request.subject,
      review
    });
    return review;
  }
}
