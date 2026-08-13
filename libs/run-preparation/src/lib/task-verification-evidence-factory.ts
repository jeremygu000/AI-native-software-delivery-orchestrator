import { createHash } from 'node:crypto';

import type {
  AgentExecutionAttempt,
  RepositorySnapshot,
  TaskVerificationEvidence,
  TaskWorkspace
} from '@ai-native-software-delivery-orchestrator/domain';

const digest = (value: unknown): string =>
  `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

export class TaskVerificationEvidenceFactory {
  create(request: {
    readonly id: string;
    readonly attempt: AgentExecutionAttempt;
    readonly workspace: TaskWorkspace;
    readonly snapshot: RepositorySnapshot;
    readonly verificationPolicyFingerprint: string;
    readonly verifiedAt: Date;
  }): TaskVerificationEvidence {
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
    return { ...payload, fingerprint: digest(payload) };
  }
}
