import { describe, expect, it } from 'vitest';

import {
  TaskVerificationEvidenceFactory,
  TaskVerificationEvidenceFactoryError
} from './task-verification-evidence-factory.js';

const request = (workspaceFingerprint: string, policyFingerprint: string) => ({
  id: 'verification-1',
  attempt: {
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
  snapshot: {
    repositoryId: `sha256:${'a'.repeat(64)}`,
    repositoryRoot: '/workspace',
    baseCommit: 'b'.repeat(40),
    workingTreeFingerprint: workspaceFingerprint,
    dirty: true
  },
  verificationPolicyFingerprint: policyFingerprint,
  verifiedAt: new Date('2026-08-13T00:02:00.000Z')
});

describe('TaskVerificationEvidenceFactory', () => {
  it('binds passed verification to exact attempt, worktree bytes, policy, and time', () => {
    const factory = new TaskVerificationEvidenceFactory();
    const first = factory.create(request(`sha256:${'1'.repeat(64)}`, `sha256:${'2'.repeat(64)}`));
    const same = factory.create(request(`sha256:${'1'.repeat(64)}`, `sha256:${'2'.repeat(64)}`));
    const changed = factory.create(request(`sha256:${'3'.repeat(64)}`, `sha256:${'2'.repeat(64)}`));

    expect(first).toEqual(same);
    expect(first.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(changed.fingerprint).not.toBe(first.fingerprint);
    expect(first.status).toBe('passed');
  });

  it('fails closed when attempt and workspace or snapshot identities do not agree', () => {
    const factory = new TaskVerificationEvidenceFactory();
    const base = request(`sha256:${'1'.repeat(64)}`, `sha256:${'2'.repeat(64)}`);
    expect(() =>
      factory.create({ ...base, attempt: { ...base.attempt, workspaceId: 'other-workspace' } })
    ).toThrow(TaskVerificationEvidenceFactoryError);
    expect(() =>
      factory.create({
        ...base,
        snapshot: { ...base.snapshot, repositoryRoot: '/other-workspace' }
      })
    ).toThrow(TaskVerificationEvidenceFactoryError);
    expect(() =>
      factory.create({ ...base, attempt: { ...base.attempt, state: 'RUNNING' } })
    ).toThrow(TaskVerificationEvidenceFactoryError);
  });
});
