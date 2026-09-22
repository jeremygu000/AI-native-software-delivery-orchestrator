import type { DurableExecutionSpikeOutcome } from '@ai-native-software-delivery-orchestrator/orchestration-runtime/legacy';

export interface BuilderAttemptEvidence {
  readonly id: string;
  readonly runId: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly workspaceId: string;
  readonly leasePlanFingerprint: string;
  readonly state: 'RUNNING' | 'COMPLETED' | 'FAILED';
  readonly revision: number;
  readonly startedAt: Date;
  readonly completedAt?: Date;
}

export interface RepairAttemptEvidence {
  readonly id: string;
  readonly runId: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly workspaceId: string;
  readonly parentReviewIteration: number;
  readonly parentReviewSubject: {
    readonly builderAttemptId: string;
    readonly outputAttemptId: string;
    readonly workspaceId: string;
    readonly workspaceRevision: number;
    readonly workspaceChangeFingerprint: string;
    readonly impactFingerprint: string;
    readonly verificationFingerprint: string;
  };
  readonly repairIteration: number;
  readonly state: 'RUNNING' | 'COMPLETED' | 'BLOCKED' | 'FAILED';
  readonly revision: number;
  readonly startedAt: Date;
  readonly completedAt?: Date;
}

export type VerificationEvidence = DurableExecutionSpikeOutcome['verifications'][number];

export type ReviewEvidence = DurableExecutionSpikeOutcome['reviews'][number];

export interface LeaseEvidence {
  readonly id: string;
  readonly runId: string;
  readonly agentId: string;
  readonly taskId: string;
  readonly resource: { readonly type: 'project'; readonly projectId: string };
  readonly mode: 'exclusive';
  readonly version: number;
  readonly state: 'RELEASED' | 'STALE' | 'ACTIVE';
  readonly acquiredAt: Date;
  readonly lastHeartbeatAt: Date;
  readonly releasedAt?: Date;
}

export interface IntegrationEvidence {
  readonly status: 'integrated' | 'blocked';
  readonly outputAttemptId?: string;
}

export interface BlockedResumeEvidence {
  readonly blockerLeaseId: string;
  readonly blockedRevision: number;
  readonly resumedRevision: number;
  readonly repairAttemptId: string;
  readonly releaseState: 'RELEASED' | 'STALE';
}

export interface EvidenceStore {
  getBuilderAttempt(runId: string): BuilderAttemptEvidence | undefined;
  getRepairAttempts(runId: string): readonly RepairAttemptEvidence[];
  getVerifications(runId: string): readonly VerificationEvidence[];
  getReviews(runId: string): readonly ReviewEvidence[];
  getLeases(runId: string): readonly LeaseEvidence[];
  getIntegration(runId: string): IntegrationEvidence | undefined;
  getBlockedResume(runId: string): BlockedResumeEvidence | undefined;
}

export const collectDurableExecutionOutcome = (
  runId: string,
  evidenceStore: EvidenceStore
): DurableExecutionSpikeOutcome => {
  const builderAttempt = evidenceStore.getBuilderAttempt(runId);
  const repairs = evidenceStore.getRepairAttempts(runId);
  const verifications = evidenceStore.getVerifications(runId);
  const reviews = evidenceStore.getReviews(runId);
  const leases = evidenceStore.getLeases(runId);
  const integration = evidenceStore.getIntegration(runId);
  const blockedResume = evidenceStore.getBlockedResume(runId);

  if (!builderAttempt) {
    throw new Error(`No builder attempt found for runId: ${runId}`);
  }

  let dispatchCount = 0;
  if (builderAttempt.state === 'COMPLETED') {
    dispatchCount++;
  }
  dispatchCount += repairs.filter((r) => r.state === 'COMPLETED').length;

  return {
    builderAttempt,
    repairs,
    verifications,
    reviews,
    leases,
    integration: integration ?? { status: 'blocked' },
    blockedResume,
    dispatchCount
  };
};
