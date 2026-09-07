import type {
  AgentExecutionAttempt,
  PersistedTaskCodeReview,
  RepositorySnapshotProvider,
  TaskCodeReview,
  TaskCodeReviewSubject,
  TaskCodeReviewSubjectProvider,
  TaskContract,
  TaskImpact,
  TaskVerificationEvidence,
  TaskVerificationEvidenceStore
} from '@ai-native-software-delivery-orchestrator/domain';
import type { RepositoryGraph } from '@ai-native-software-delivery-orchestrator/domain';

import { TaskOutputAdmissionCoordinator } from './task-output-admission-coordinator.js';
import { TaskCodeReviewCollector } from './task-code-review-collector.js';

export class ForgeBuilderOutputEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForgeBuilderOutputEvaluationError';
  }
}

export interface ForgeBuilderOutputEvaluationResult {
  readonly verification: TaskVerificationEvidence;
  readonly subject: TaskCodeReviewSubject;
  readonly review: TaskCodeReview;
  readonly recommendation: 'accept' | 'repair' | 'reject';
}

export class ForgeBuilderOutputEvaluationService {
  readonly #coordinator: TaskOutputAdmissionCoordinator;

  constructor(options: {
    readonly snapshots: RepositorySnapshotProvider;
    readonly subjects: TaskCodeReviewSubjectProvider;
    readonly reviews: TaskCodeReviewCollector;
    readonly reviewStore: {
      persistReview(review: PersistedTaskCodeReview): Promise<void>;
      recoverReviews(runId: string): Promise<readonly PersistedTaskCodeReview[]>;
    };
    readonly verificationEvidence: TaskVerificationEvidenceStore;
    readonly createVerificationEvidence: (request: {
      readonly id: string;
      readonly attempt: AgentExecutionAttempt;
      readonly workspace: import('@ai-native-software-delivery-orchestrator/domain').TaskWorkspace;
      readonly snapshot: Awaited<ReturnType<RepositorySnapshotProvider['capture']>>;
      readonly verificationPolicyFingerprint: string;
      readonly verifiedAt: Date;
    }) => TaskVerificationEvidence;
    readonly createEvidenceId: () => string;
    readonly now?: () => Date;
  }) {
    this.#coordinator = new TaskOutputAdmissionCoordinator({
      snapshots: options.snapshots,
      subjects: options.subjects,
      reviews: options.reviews,
      reviewStore: options.reviewStore,
      verificationEvidence: options.verificationEvidence,
      createVerificationEvidence: options.createVerificationEvidence,
      createEvidenceId: options.createEvidenceId,
      now: options.now
    });
  }

  async evaluate(request: {
    readonly runId: string;
    readonly task: TaskContract;
    readonly builderAttempt: AgentExecutionAttempt;
    readonly workspace: import('@ai-native-software-delivery-orchestrator/domain').TaskWorkspace;
    readonly impact: TaskImpact;
    readonly verificationPolicyFingerprint: string;
    readonly repository: Pick<RepositoryGraph, 'files' | 'symbols'>;
  }): Promise<ForgeBuilderOutputEvaluationResult> {
    const { subject, review, verification } = await this.#coordinator.reviewBuilder({
      runId: request.runId,
      task: request.task,
      builderAttempt: request.builderAttempt,
      workspace: request.workspace,
      impact: request.impact,
      verificationPolicyFingerprint: request.verificationPolicyFingerprint,
      repository: request.repository
    });

    return {
      verification,
      subject,
      review,
      recommendation: review.recommendation
    };
  }
}
