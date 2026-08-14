import type {
  TaskCodeReview,
  TaskCodeReviewSubject,
  TaskRepairAttempt,
  TaskVerificationEvidence
} from '@ai-native-software-delivery-orchestrator/domain';

/**
 * Candidate durable-execution substrates must produce these Forge authority outcomes.
 * The contract intentionally excludes framework workflow history and API types.
 */
export interface DurableExecutionSpikeContract {
  runBuildReviewRepairIntegrate(): Promise<{
    readonly verification: TaskVerificationEvidence;
    readonly review: TaskCodeReview;
    readonly reviewSubject: TaskCodeReviewSubject;
  }>;
  runBlockedRepairRestartResume(): Promise<{
    readonly repair: TaskRepairAttempt;
    readonly review: TaskCodeReview;
    readonly reviewSubject: TaskCodeReviewSubject;
  }>;
}
