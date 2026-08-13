import type {
  AgentExecutionAttempt,
  RepositorySnapshot,
  TaskVerificationEvidence,
  TaskWorkspace
} from '@ai-native-software-delivery-orchestrator/domain';
import { taskVerificationEvidenceFingerprint } from '@ai-native-software-delivery-orchestrator/domain';

export class TaskVerificationEvidenceFactoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskVerificationEvidenceFactoryError';
  }
}

export class TaskVerificationEvidenceFactory {
  create(request: {
    readonly id: string;
    readonly attempt: AgentExecutionAttempt;
    readonly workspace: TaskWorkspace;
    readonly snapshot: RepositorySnapshot;
    readonly verificationPolicyFingerprint: string;
    readonly verifiedAt: Date;
  }): TaskVerificationEvidence {
    if (request.attempt.state !== 'COMPLETED') {
      throw new TaskVerificationEvidenceFactoryError(
        'Verification evidence requires a completed attempt'
      );
    }
    if (
      request.attempt.runId !== request.workspace.runId ||
      request.attempt.taskId !== request.workspace.taskId ||
      request.attempt.workspaceId !== request.workspace.id
    ) {
      throw new TaskVerificationEvidenceFactoryError(
        'Verification evidence attempt does not match task workspace identity'
      );
    }
    if (request.snapshot.repositoryRoot !== request.workspace.workspacePath) {
      throw new TaskVerificationEvidenceFactoryError(
        'Verification evidence snapshot must be captured from the task workspace path'
      );
    }
    const payload = {
      id: request.id,
      runId: request.attempt.runId,
      taskId: request.attempt.taskId,
      attemptId: request.attempt.id,
      workspaceId: request.workspace.id,
      workspaceRevision: request.workspace.revision,
      workspaceChangeFingerprint: request.snapshot.workingTreeFingerprint,
      verificationPolicyFingerprint: request.verificationPolicyFingerprint,
      status: 'passed' as const,
      verifiedAt: request.verifiedAt.toISOString()
    };
    return { ...payload, fingerprint: taskVerificationEvidenceFingerprint(payload) };
  }
}
