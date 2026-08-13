import { describe, expect, it } from 'vitest';

import { SnapshotTaskCodeReviewSubjectProvider } from './task-code-review-subject-provider.js';

const request = (workspaceChangeFingerprint: string, verificationFingerprint: string) => ({
  builderAttempt: {
    id: 'attempt-1',
    runId: 'run-1',
    taskId: 'task-1',
    agentId: 'agent-1',
    workspaceId: 'workspace-1',
    leasePlanFingerprint: 'lease-1',
    state: 'COMPLETED' as const,
    revision: 1,
    startedAt: new Date('2026-08-13T00:00:00.000Z'),
    completedAt: new Date('2026-08-13T00:01:00.000Z')
  },
  outputAttemptId: 'attempt-1',
  workspace: {
    id: 'workspace-1',
    runId: 'run-1',
    taskId: 'task-1',
    integrationRepositoryPath: '/integration',
    workspacePath: '/workspace',
    branchName: 'task-1',
    baseRef: 'base',
    integrationRef: 'main',
    revision: 1,
    phase: 'READY_TO_INTEGRATE' as const
  },
  impact: {
    predicted: {
      taskId: 'task-1',
      projectsRead: new Set<string>(),
      projectsWritten: new Set<string>(),
      explicitProjectsWritten: new Set<string>(),
      filesRead: new Set<string>(),
      filesWritten: new Set<string>(['core:value.txt']),
      explicitFilesWritten: new Set<string>(['core:value.txt']),
      globFilesWritten: new Set<string>(),
      symbolDerivedFilesWritten: new Set<string>(),
      symbolsRead: new Set<string>(),
      symbolsWritten: new Set<string>(),
      sharedResources: new Set<string>(),
      sharedResourceAccesses: [],
      downstreamProjects: new Set<string>(),
      riskSignals: []
    }
  },
  workspaceSnapshot: {
    repositoryId: `sha256:${'a'.repeat(64)}`,
    repositoryRoot: '/workspace',
    baseCommit: 'b'.repeat(40),
    workingTreeFingerprint: workspaceChangeFingerprint,
    dirty: true
  },
  verificationFingerprint
});

describe('SnapshotTaskCodeReviewSubjectProvider', () => {
  it('binds exact workspace and verification evidence while canonicalizing impact', () => {
    const provider = new SnapshotTaskCodeReviewSubjectProvider();
    const first = provider.createSubject(
      request(`sha256:${'1'.repeat(64)}`, `sha256:${'2'.repeat(64)}`)
    );
    const same = provider.createSubject(
      request(`sha256:${'1'.repeat(64)}`, `sha256:${'2'.repeat(64)}`)
    );
    const changedWorkspace = provider.createSubject(
      request(`sha256:${'3'.repeat(64)}`, `sha256:${'2'.repeat(64)}`)
    );
    const changedVerification = provider.createSubject(
      request(`sha256:${'1'.repeat(64)}`, `sha256:${'4'.repeat(64)}`)
    );

    expect(first).toEqual(same);
    expect(changedWorkspace.workspaceChangeFingerprint).not.toBe(first.workspaceChangeFingerprint);
    expect(changedVerification.verificationFingerprint).not.toBe(first.verificationFingerprint);
    expect(first.impactFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
