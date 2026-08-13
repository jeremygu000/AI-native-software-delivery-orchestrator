import type {
  AgentExecutionAttempt,
  RepositorySnapshotProvider,
  TaskCodeReviewSubjectProvider,
  TaskCodeReviewStore,
  TaskContract,
  TaskImpact,
  TaskVerificationEvidence,
  TaskVerificationEvidenceStore,
  TaskWorkspace
} from '@ai-native-software-delivery-orchestrator/domain';
import {
  assertTaskReviewIntegrationAdmission,
  assertTaskReviewRepairAdmission
} from './task-review-integration-admission.js';
import { TaskCodeReviewCollector } from './task-code-review-collector.js';

type CreateVerificationEvidence = (request: {
  readonly id: string;
  readonly attempt: AgentExecutionAttempt;
  readonly workspace: TaskWorkspace;
  readonly snapshot: Awaited<ReturnType<RepositorySnapshotProvider['capture']>>;
  readonly verificationPolicyFingerprint: string;
  readonly verifiedAt: Date;
}) => TaskVerificationEvidence;

export class TaskOutputAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskOutputAdmissionError';
  }
}

/** Persists review evidence and grants integration only to the exact accepted output. */
export class TaskOutputAdmissionCoordinator {
  readonly #snapshots: RepositorySnapshotProvider;
  readonly #subjects: TaskCodeReviewSubjectProvider;
  readonly #reviews: TaskCodeReviewCollector;
  readonly #reviewStore: TaskCodeReviewStore;
  readonly #verificationEvidence: TaskVerificationEvidenceStore;
  readonly #createVerificationEvidence: CreateVerificationEvidence;
  readonly #createEvidenceId: () => string;
  readonly #now: () => Date;

  constructor(options: {
    readonly snapshots: RepositorySnapshotProvider;
    readonly subjects: TaskCodeReviewSubjectProvider;
    readonly reviews: TaskCodeReviewCollector;
    readonly reviewStore: TaskCodeReviewStore;
    readonly verificationEvidence: TaskVerificationEvidenceStore;
    readonly createVerificationEvidence: CreateVerificationEvidence;
    readonly createEvidenceId: () => string;
    readonly now?: () => Date;
  }) {
    this.#snapshots = options.snapshots;
    this.#subjects = options.subjects;
    this.#reviews = options.reviews;
    this.#reviewStore = options.reviewStore;
    this.#verificationEvidence = options.verificationEvidence;
    this.#createVerificationEvidence = options.createVerificationEvidence;
    this.#createEvidenceId = options.createEvidenceId;
    this.#now = options.now ?? (() => new Date());
  }

  async reviewBuilder(request: {
    readonly runId: string;
    readonly task: TaskContract;
    readonly builderAttempt: AgentExecutionAttempt;
    readonly workspace: TaskWorkspace;
    readonly impact: TaskImpact;
    readonly verificationPolicyFingerprint: string;
    readonly repository: Parameters<TaskCodeReviewCollector['collect']>[0]['repository'];
  }) {
    const snapshot = await this.#snapshots.capture({
      repositoryPath: request.workspace.workspacePath
    });
    const verification = this.#createVerificationEvidence({
      id: this.#createEvidenceId(),
      attempt: request.builderAttempt,
      // Git resolves worktree roots physically (for example /private/var on macOS).
      workspace: { ...request.workspace, workspacePath: snapshot.repositoryRoot },
      snapshot,
      verificationPolicyFingerprint: request.verificationPolicyFingerprint,
      verifiedAt: this.#now()
    });
    await this.#verificationEvidence.persistVerificationEvidence(verification);
    const subject = this.#subjects.createSubject({
      builderAttempt: request.builderAttempt,
      outputAttemptId: request.builderAttempt.id,
      workspace: request.workspace,
      impact: request.impact,
      workspaceSnapshot: snapshot,
      verificationFingerprint: verification.fingerprint
    });
    const review = await this.#reviews.collect({
      runId: request.runId,
      task: request.task,
      workspace: request.workspace,
      impact: request.impact,
      builderAttempt: request.builderAttempt,
      subject,
      repository: request.repository,
      iteration: 1
    });
    return { subject, review, verification };
  }

  async assertIntegrationAdmission(request: {
    readonly runId: string;
    readonly taskId: string;
    readonly subject: Parameters<typeof assertTaskReviewIntegrationAdmission>[0]['subject'];
  }): Promise<void> {
    assertTaskReviewIntegrationAdmission({
      taskId: request.taskId,
      subject: request.subject,
      reviews: await this.#reviewStore.recoverReviews(request.runId)
    });
  }

  async assertCurrentIntegrationAdmission(request: {
    readonly runId: string;
    readonly taskId: string;
    readonly workspace: TaskWorkspace;
    readonly subject: Parameters<typeof assertTaskReviewIntegrationAdmission>[0]['subject'];
  }): Promise<void> {
    const snapshot = await this.#snapshots.capture({
      repositoryPath: request.workspace.workspacePath
    });
    if (
      request.workspace.id !== request.subject.workspaceId ||
      request.workspace.revision !== request.subject.workspaceRevision ||
      snapshot.workingTreeFingerprint !== request.subject.workspaceChangeFingerprint
    ) {
      throw new TaskOutputAdmissionError(`Task output changed after review: ${request.taskId}`);
    }
    assertTaskReviewIntegrationAdmission({
      taskId: request.taskId,
      subject: request.subject,
      reviews: await this.#reviewStore.recoverReviews(request.runId)
    });
  }

  async assertRepairAdmission(request: {
    readonly runId: string;
    readonly taskId: string;
    readonly iteration: number;
    readonly subject: Parameters<typeof assertTaskReviewIntegrationAdmission>[0]['subject'];
  }): Promise<void> {
    assertTaskReviewRepairAdmission({
      taskId: request.taskId,
      iteration: request.iteration,
      subject: request.subject,
      reviews: await this.#reviewStore.recoverReviews(request.runId)
    });
  }
}
