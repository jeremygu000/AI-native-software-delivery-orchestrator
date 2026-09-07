import type {
  AgentExecutionAttempt,
  PersistedTaskCodeReview,
  RepositorySnapshotProvider,
  TaskCodeReview,
  TaskCodeReviewSubject,
  TaskCodeReviewSubjectProvider,
  TaskContract,
  TaskImpact,
  TaskRepairAttempt,
  TaskVerificationEvidence,
  TaskVerificationEvidenceStore
} from '@ai-native-software-delivery-orchestrator/domain';
import type { RepositoryGraph } from '@ai-native-software-delivery-orchestrator/domain';

import { TaskOutputAdmissionCoordinator } from './task-output-admission-coordinator.js';
import { TaskCodeReviewCollector } from './task-code-review-collector.js';
import { TaskRepairCoordinator } from './task-repair-coordinator.js';

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
  readonly repairAttempt?: TaskRepairAttempt;
}

export class ForgeBuilderOutputEvaluationService {
  readonly #coordinator: TaskOutputAdmissionCoordinator;
  readonly #repairs?: TaskRepairCoordinator;

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
    readonly repairs?: TaskRepairCoordinator;
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
    this.#repairs = options.repairs;
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

    if (review.recommendation === 'repair' && this.#repairs !== undefined) {
      const repairAttempt = await this.#repairs.prepare({
        runId: request.runId,
        taskId: request.task.id,
        agentId: request.builderAttempt.agentId,
        workspaceId: request.workspace.id,
        reviewIteration: 1,
        review,
        subject
      });

      return {
        verification,
        subject,
        review,
        recommendation: review.recommendation,
        repairAttempt
      };
    }

    return {
      verification,
      subject,
      review,
      recommendation: review.recommendation
    };
  }
}
