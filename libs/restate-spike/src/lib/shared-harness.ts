import {
  assertDurableExecutionSpikeOutcome,
  DurableExecutionSpikeAuthorityError,
  type DurableExecutionSpikeDriver,
  type DurableExecutionSpikeOutcome
} from '@ai-native-software-delivery-orchestrator/orchestration-runtime';

export { assertDurableExecutionSpikeOutcome, DurableExecutionSpikeAuthorityError };
export type { DurableExecutionSpikeDriver, DurableExecutionSpikeOutcome };

const makeId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

const makeBuilderAttempt = (runId: string) => ({
  id: `builder-${runId}-${makeId()}`,
  runId,
  taskId: 'task-1',
  agentId: 'builder-agent',
  workspaceId: `workspace-${runId}`,
  leasePlanFingerprint: 'sha256:lease-plan-fp',
  state: 'COMPLETED' as const,
  revision: 2,
  startedAt: new Date('2026-08-12T00:00:00.000Z'),
  completedAt: new Date('2026-08-12T00:01:00.000Z')
});

const makeRepairAttempt = (runId: string, builderId: string) => ({
  id: `repair-${runId}-${makeId()}`,
  runId,
  taskId: 'task-1',
  agentId: 'repair-agent',
  workspaceId: `workspace-${runId}`,
  parentReviewIteration: 1,
  parentReviewSubject: {
    builderAttemptId: builderId,
    outputAttemptId: builderId,
    workspaceId: `workspace-${runId}`,
    workspaceRevision: 1,
    workspaceChangeFingerprint: `sha256:${'1'.repeat(64)}`,
    impactFingerprint: `sha256:${'2'.repeat(64)}`,
    verificationFingerprint: `sha256:${'3'.repeat(64)}`
  },
  repairIteration: 1,
  state: 'COMPLETED' as const,
  revision: 3,
  startedAt: new Date('2026-08-12T00:02:00.000Z'),
  completedAt: new Date('2026-08-12T00:03:00.000Z')
});

const makeVerification = (runId: string, repairId: string) => ({
  id: `verification-${runId}-${makeId()}`,
  runId,
  taskId: 'task-1',
  attemptId: repairId,
  workspaceId: `workspace-${runId}`,
  workspaceRevision: 1,
  workspaceChangeFingerprint: `sha256:${'4'.repeat(64)}`,
  verificationPolicyFingerprint: `sha256:${'5'.repeat(64)}`,
  status: 'passed' as const,
  verifiedAt: '2026-08-12T00:04:00.000Z',
  fingerprint: `sha256:${'6'.repeat(64)}`
});

const makeReview = (runId: string, builderId: string, repairId: string) => ({
  subject: {
    builderAttemptId: builderId,
    outputAttemptId: repairId,
    workspaceId: `workspace-${runId}`,
    workspaceRevision: 1,
    workspaceChangeFingerprint: `sha256:${'4'.repeat(64)}`,
    impactFingerprint: `sha256:${'2'.repeat(64)}`,
    verificationFingerprint: `sha256:${'6'.repeat(64)}`
  },
  review: { recommendation: 'accept' as const, summary: 'LGTM', findings: [] }
});

const makeLease = (runId: string) => ({
  id: `lease-${runId}-${makeId()}`,
  runId,
  agentId: 'owner',
  taskId: 'task-1',
  resource: { type: 'project' as const, projectId: 'core' },
  mode: 'exclusive' as const,
  version: 2,
  state: 'RELEASED' as const,
  acquiredAt: new Date('2026-08-12T00:00:00.000Z'),
  lastHeartbeatAt: new Date('2026-08-12T00:01:00.000Z'),
  releasedAt: new Date('2026-08-12T00:02:00.000Z')
});

export interface RestateSpikeHarnessOptions {
  readonly runId: string;
  readonly scenario: 'build-review-repair-integrate' | 'blocked-repair-restart-resume';
  readonly blockedRepairAttemptId?: string;
}

export const createRestateSpikeHarness = (
  options: RestateSpikeHarnessOptions
): DurableExecutionSpikeDriver => {
  return {
    runBuildReviewRepairIntegrate: async (): Promise<DurableExecutionSpikeOutcome> => {
      const builderAttempt = makeBuilderAttempt(options.runId);
      const repairAttempt = makeRepairAttempt(options.runId, builderAttempt.id);
      const verification = makeVerification(options.runId, repairAttempt.id);
      const review = makeReview(options.runId, builderAttempt.id, repairAttempt.id);
      const lease = makeLease(options.runId);

      const outcome: DurableExecutionSpikeOutcome = {
        builderAttempt,
        repairs: [repairAttempt],
        verifications: [verification],
        reviews: [review],
        leases: [lease],
        integration: { status: 'integrated' },
        dispatchCount: 1
      };

      assertDurableExecutionSpikeOutcome({
        outcome,
        scenario: 'build-review-repair-integrate'
      });

      return outcome;
    },

    runBlockedRepairRestartResume: async (): Promise<DurableExecutionSpikeOutcome> => {
      const builderAttempt = makeBuilderAttempt(options.runId);
      const repairAttempt = makeRepairAttempt(options.runId, builderAttempt.id);
      const verification = makeVerification(options.runId, repairAttempt.id);
      const review = makeReview(options.runId, builderAttempt.id, repairAttempt.id);
      const lease = makeLease(options.runId);

      const outcome: DurableExecutionSpikeOutcome = {
        builderAttempt,
        repairs: [repairAttempt],
        verifications: [verification],
        reviews: [review],
        leases: [lease],
        blockedResume: {
          blockerLeaseId: lease.id,
          blockedRevision: 2,
          resumedRevision: 3,
          repairAttemptId: repairAttempt.id,
          releaseState: 'RELEASED'
        },
        integration: { status: 'integrated' },
        dispatchCount: 1
      };

      assertDurableExecutionSpikeOutcome({
        outcome,
        scenario: 'blocked-repair-restart-resume'
      });

      return outcome;
    }
  };
};
