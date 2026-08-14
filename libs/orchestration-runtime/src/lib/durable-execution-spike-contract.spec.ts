import { describe, expect, it } from 'vitest';

import {
  assertDurableExecutionSpikeOutcome,
  DurableExecutionSpikeAuthorityError,
  type DurableExecutionSpikeOutcome
} from './durable-execution-spike-contract.js';

const outcome = (): DurableExecutionSpikeOutcome => ({
  builderAttempt: {
    id: 'builder-1',
    runId: 'run-1',
    taskId: 'task-1',
    agentId: 'builder',
    workspaceId: 'workspace-1',
    leasePlanFingerprint: 'lease-plan',
    state: 'COMPLETED',
    revision: 2,
    startedAt: new Date('2026-08-12T00:00:00.000Z'),
    completedAt: new Date('2026-08-12T00:01:00.000Z')
  },
  repairs: [
    {
      id: 'repair-1',
      runId: 'run-1',
      taskId: 'task-1',
      agentId: 'repair',
      workspaceId: 'workspace-1',
      parentReviewIteration: 1,
      parentReviewSubject: {
        builderAttemptId: 'builder-1',
        outputAttemptId: 'builder-1',
        workspaceId: 'workspace-1',
        workspaceRevision: 1,
        workspaceChangeFingerprint: `sha256:${'1'.repeat(64)}`,
        impactFingerprint: `sha256:${'2'.repeat(64)}`,
        verificationFingerprint: `sha256:${'3'.repeat(64)}`
      },
      repairIteration: 1,
      state: 'COMPLETED',
      revision: 3,
      startedAt: new Date('2026-08-12T00:02:00.000Z'),
      completedAt: new Date('2026-08-12T00:03:00.000Z')
    }
  ],
  verifications: [
    {
      id: 'verification-1',
      runId: 'run-1',
      taskId: 'task-1',
      attemptId: 'repair-1',
      workspaceId: 'workspace-1',
      workspaceRevision: 1,
      workspaceChangeFingerprint: `sha256:${'4'.repeat(64)}`,
      verificationPolicyFingerprint: `sha256:${'5'.repeat(64)}`,
      status: 'passed',
      verifiedAt: '2026-08-12T00:04:00.000Z',
      fingerprint: `sha256:${'6'.repeat(64)}`
    }
  ],
  reviews: [
    {
      subject: {
        builderAttemptId: 'builder-1',
        outputAttemptId: 'repair-1',
        workspaceId: 'workspace-1',
        workspaceRevision: 1,
        workspaceChangeFingerprint: `sha256:${'4'.repeat(64)}`,
        impactFingerprint: `sha256:${'2'.repeat(64)}`,
        verificationFingerprint: `sha256:${'6'.repeat(64)}`
      },
      review: { recommendation: 'accept', summary: 'Accepted.', findings: [] }
    }
  ],
  leases: [
    {
      id: 'lease-1',
      runId: 'run-1',
      agentId: 'owner',
      taskId: 'owner-task',
      resource: { type: 'project', projectId: 'core' },
      mode: 'exclusive',
      version: 2,
      state: 'RELEASED',
      acquiredAt: new Date('2026-08-12T00:00:00.000Z'),
      lastHeartbeatAt: new Date('2026-08-12T00:01:00.000Z'),
      releasedAt: new Date('2026-08-12T00:02:00.000Z')
    }
  ],
  runtimeConflicts: [],
  blockedResume: {
    blockerLeaseId: 'lease-1',
    blockedRevision: 2,
    resumedRevision: 3,
    repairAttemptId: 'repair-1',
    releaseState: 'RELEASED'
  },
  integration: { status: 'integrated' },
  dispatchCount: 1
});

describe('durable execution spike authority harness', () => {
  it('accepts an integrated repair-resume authority outcome', () => {
    expect(() =>
      assertDurableExecutionSpikeOutcome({ outcome: outcome(), expectBlockedResume: true })
    ).not.toThrow();
  });

  it('rejects missing exact outcome evidence, duplicate dispatch, and stale output authority', () => {
    expect(() =>
      assertDurableExecutionSpikeOutcome({
        outcome: { ...outcome(), reviews: [], dispatchCount: 2 },
        expectBlockedResume: true
      })
    ).toThrow(DurableExecutionSpikeAuthorityError);
    expect(() =>
      assertDurableExecutionSpikeOutcome({
        outcome: { ...outcome(), integration: { status: 'blocked' } },
        expectBlockedResume: false
      })
    ).toThrow('must integrate');
    expect(() =>
      assertDurableExecutionSpikeOutcome({
        outcome: {
          ...outcome(),
          reviews: [
            {
              ...outcome().reviews[0],
              subject: { ...outcome().reviews[0].subject, outputAttemptId: 'builder-1' }
            }
          ]
        },
        expectBlockedResume: true
      })
    ).toThrow('must bind the resumed repair output');
  });
});
