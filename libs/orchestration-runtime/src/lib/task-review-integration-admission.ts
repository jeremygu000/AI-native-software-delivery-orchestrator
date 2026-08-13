import type {
  PersistedTaskCodeReview,
  TaskCodeReviewSubject
} from '@ai-native-software-delivery-orchestrator/domain';

export const sameTaskCodeReviewSubject = (
  left: TaskCodeReviewSubject,
  right: TaskCodeReviewSubject
): boolean =>
  left.builderAttemptId === right.builderAttemptId &&
  left.outputAttemptId === right.outputAttemptId &&
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
      sameTaskCodeReviewSubject(record.subject, request.subject)
  );
  if (!accepted) {
    throw new TaskReviewIntegrationAdmissionError(
      `No accepted review matches the current task output: ${request.taskId}`
    );
  }
};

/** Confirms that the durable repair recommendation exactly authorized this repair lineage. */
export const assertTaskReviewRepairAdmission = (request: {
  readonly taskId: string;
  readonly iteration: number;
  readonly subject: TaskCodeReviewSubject;
  readonly reviews: readonly PersistedTaskCodeReview[];
}): void => {
  const admitted = request.reviews.some(
    (record) =>
      record.taskId === request.taskId &&
      record.iteration === request.iteration &&
      record.review.recommendation === 'repair' &&
      record.subject !== undefined &&
      sameTaskCodeReviewSubject(record.subject, request.subject)
  );
  if (!admitted) {
    throw new TaskReviewIntegrationAdmissionError(
      `No repair review matches the current task output: ${request.taskId}`
    );
  }
};
