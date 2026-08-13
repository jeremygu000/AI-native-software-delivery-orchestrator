import type {
  PersistedTaskCodeReview,
  TaskCodeReviewSubject
} from '@ai-native-software-delivery-orchestrator/domain';

const sameSubject = (left: TaskCodeReviewSubject, right: TaskCodeReviewSubject): boolean =>
  left.builderAttemptId === right.builderAttemptId &&
  left.workspaceId === right.workspaceId &&
  left.workspaceRevision === right.workspaceRevision &&
  left.workspaceChangeFingerprint === right.workspaceChangeFingerprint &&
  left.impactFingerprint === right.impactFingerprint &&
  left.verificationFingerprint === right.verificationFingerprint;

export class TaskReviewIntegrationAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskReviewIntegrationAdmissionError';
  }
}

/** Grants integration admission only to the exact output accepted by a durable review. */
export const assertTaskReviewIntegrationAdmission = (request: {
  readonly taskId: string;
  readonly subject: TaskCodeReviewSubject;
  readonly reviews: readonly PersistedTaskCodeReview[];
}): void => {
  const accepted = request.reviews.some(
    (record) =>
      record.taskId === request.taskId &&
      record.review.recommendation === 'accept' &&
      record.subject !== undefined &&
      sameSubject(record.subject, request.subject)
  );
  if (!accepted) {
    throw new TaskReviewIntegrationAdmissionError(
      `No accepted review matches the current task output: ${request.taskId}`
    );
  }
};
