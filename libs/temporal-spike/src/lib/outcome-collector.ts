import type { DurableExecutionSpikeOutcome } from '@ai-native-software-delivery-orchestrator/orchestration-runtime';

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

export interface VerificationEvidence {
  readonly id: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly workspaceId: string;
  readonly workspaceRevision: number;
  readonly workspaceChangeFingerprint: string;
  readonly verificationPolicyFingerprint: string;
  readonly status: 'passed' | 'failed';
  readonly verifiedAt: string;
  readonly fingerprint: string;
}

export interface ReviewEvidence {
  readonly subject: {
    readonly builderAttemptId: string;
    readonly outputAttemptId: string;
    readonly workspaceId: string;
    readonly workspaceRevision: number;
    readonly workspaceChangeFingerprint: string;
    readonly impactFingerprint: string;
    readonly verificationFingerprint: string;
  };
  readonly review: {
    readonly recommendation: 'accept' | 'repair' | 'reject';
    readonly summary: string;
    readonly findings: Array<{
      readonly id: string;
      readonly severity: 'critical' | 'high' | 'low' | 'medium';
      readonly fileIds: readonly string[];
      readonly symbolIds: readonly string[];
      readonly description: string;
      readonly requirementReference?: string;
    }>;
  };
}

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
  if (builderAttempt.state === 'COMPLETED') dispatchCount++;
  dispatchCount += repairs.filter((r) => r.state === 'COMPLETED').length;

  return {
    builderAttempt: builderAttempt as DurableExecutionSpikeOutcome['builderAttempt'],
    repairs: repairs as DurableExecutionSpikeOutcome['repairs'],
    verifications: verifications as DurableExecutionSpikeOutcome['verifications'],
    reviews: reviews as DurableExecutionSpikeOutcome['reviews'],
    leases: leases as DurableExecutionSpikeOutcome['leases'],
    integration: integration ?? { status: 'blocked' },
    blockedResume: blockedResume as DurableExecutionSpikeOutcome['blockedResume'],
    dispatchCount
  };
};
