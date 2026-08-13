import { createHash } from 'node:crypto';

import type {
  TaskCodeReviewSubjectProvider,
  TaskImpact
} from '@ai-native-software-delivery-orchestrator/domain';
import type { AgentExecutionAttempt } from '@ai-native-software-delivery-orchestrator/domain';
import type { RepositorySnapshot } from '@ai-native-software-delivery-orchestrator/domain';
import type { TaskWorkspace } from '@ai-native-software-delivery-orchestrator/domain';

const canonicalize = (value: unknown): unknown => {
  if (value instanceof Set) {
    return [...value].toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
};

const fingerprint = (value: unknown): string =>
  `sha256:${createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex')}`;

export class SnapshotTaskCodeReviewSubjectProvider implements TaskCodeReviewSubjectProvider {
  createSubject(request: {
    readonly builderAttempt: AgentExecutionAttempt;
    readonly workspace: TaskWorkspace;
    readonly impact: TaskImpact;
    readonly workspaceSnapshot: RepositorySnapshot;
    readonly verificationFingerprint: string;
  }) {
    return {
      builderAttemptId: request.builderAttempt.id,
      workspaceId: request.workspace.id,
      workspaceRevision: request.workspace.revision,
      workspaceChangeFingerprint: request.workspaceSnapshot.workingTreeFingerprint,
      impactFingerprint: fingerprint(request.impact),
      verificationFingerprint: request.verificationFingerprint
    };
  }
}
