import type {
  BuilderAttemptEvidence,
  RepairAttemptEvidence,
  VerificationEvidence,
  ReviewEvidence,
  LeaseEvidence,
  IntegrationEvidence
} from './outcome-collector.js';
import type { InMemoryEvidenceStore } from './in-memory-evidence-store.js';

export interface MockActivityContext {
  evidenceStore: InMemoryEvidenceStore;
  runId: string;
}

const makeId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

const FINGERPRINT_BASE = 'sha256:' + 'a'.repeat(64);

const makeFindings = () => [
  {
    id: `finding-${makeId()}`,
    severity: 'medium' as const,
    fileIds: [] as readonly string[],
    symbolIds: [] as readonly string[],
    description: 'Review finding'
  }
];

export const createMockActivities = (ctx: MockActivityContext) => ({
  executeBuilder: async (request: {
    readonly runId: string;
    readonly taskId: string;
    readonly attemptId: string;
    readonly agentId: string;
  }): Promise<{
    readonly builderAttemptId: string;
    readonly workspaceId: string;
    readonly impactPrediction: readonly string[];
  }> => {
    const builderAttemptId = `builder-${request.runId}-${request.attemptId}`;
    const workspaceId = `workspace-${request.runId}`;

    const builderAttempt: BuilderAttemptEvidence = {
      id: builderAttemptId,
      runId: request.runId,
      taskId: request.taskId,
      agentId: request.agentId,
      workspaceId,
      leasePlanFingerprint: FINGERPRINT_BASE,
      state: 'COMPLETED',
      revision: 2,
      startedAt: new Date('2026-08-12T00:00:00.000Z'),
      completedAt: new Date('2026-08-12T00:01:00.000Z')
    };
    ctx.evidenceStore.setBuilderAttempt(builderAttempt);

    const lease: LeaseEvidence = {
      id: `lease-${request.runId}-${makeId()}`,
      runId: request.runId,
      agentId: request.agentId,
      taskId: request.taskId,
      resource: { type: 'project', projectId: 'core' },
      mode: 'exclusive',
      version: 1,
      state: 'RELEASED',
      acquiredAt: new Date('2026-08-12T00:00:00.000Z'),
      lastHeartbeatAt: new Date('2026-08-12T00:01:00.000Z'),
      releasedAt: new Date('2026-08-12T00:02:00.000Z')
    };
    ctx.evidenceStore.addLease(lease);

    return {
      builderAttemptId,
      workspaceId,
      impactPrediction: []
    };
  },

  evaluateBuilderOutput: async (request: {
    readonly runId: string;
    readonly builderAttemptId: string;
    readonly workspaceId: string;
    readonly verificationPolicyFingerprint: string;
  }): Promise<{
    readonly verificationEvidenceId: string;
    readonly reviewSubjectRef: {
      readonly builderAttemptId: string;
      readonly outputAttemptId: string;
      readonly workspaceId: string;
    };
    readonly recommendation: 'accept' | 'repair' | 'reject';
    readonly repairAttemptId?: string;
  }> => {
    const verificationId = `verification-${request.builderAttemptId}-${makeId()}`;

    const verification: VerificationEvidence = {
      id: verificationId,
      runId: request.runId,
      taskId: 'task-1',
      attemptId: request.builderAttemptId,
      workspaceId: request.workspaceId,
      workspaceRevision: 1,
      workspaceChangeFingerprint: FINGERPRINT_BASE,
      verificationPolicyFingerprint: request.verificationPolicyFingerprint,
      status: 'passed',
      verifiedAt: '2026-08-12T00:01:30.000Z',
      fingerprint: FINGERPRINT_BASE
    };
    ctx.evidenceStore.addVerification(verification);

    const reviewSubjectRef = {
      builderAttemptId: request.builderAttemptId,
      outputAttemptId: `output-${request.builderAttemptId}`,
      workspaceId: request.workspaceId
    };

    const review: ReviewEvidence = {
      subject: {
        ...reviewSubjectRef,
        workspaceRevision: 1,
        workspaceChangeFingerprint: FINGERPRINT_BASE,
        impactFingerprint: FINGERPRINT_BASE,
        verificationFingerprint: FINGERPRINT_BASE
      },
      review: {
        recommendation: 'repair',
        summary: 'Issues found, repair needed',
        findings: makeFindings()
      }
    };
    ctx.evidenceStore.addReview(review);

    const repairAttemptId = `repair-${request.runId}-1`;

    return {
      verificationEvidenceId: verificationId,
      reviewSubjectRef,
      recommendation: 'repair',
      repairAttemptId
    };
  },

  executeRepair: async (request: {
    readonly runId: string;
    readonly repairAttemptId: string;
    readonly builderAttemptId: string;
    readonly workspaceId: string;
    readonly reviewSubjectRef: {
      readonly builderAttemptId: string;
      readonly outputAttemptId: string;
      readonly workspaceId: string;
    };
    readonly maxRepairs: number;
  }): Promise<{
    readonly repairAttemptId: string;
    readonly verificationEvidenceId: string;
    readonly reviewSubjectRef: {
      readonly builderAttemptId: string;
      readonly outputAttemptId: string;
      readonly workspaceId: string;
    };
    readonly recommendation: 'accept' | 'repair' | 'reject';
  }> => {
    const verificationId = `verification-repair-${request.repairAttemptId}-${makeId()}`;

    const repairAttempt: RepairAttemptEvidence = {
      id: request.repairAttemptId,
      runId: request.runId,
      taskId: 'task-1',
      agentId: 'repair-agent',
      workspaceId: request.workspaceId,
      parentReviewIteration: 1,
      parentReviewSubject: {
        builderAttemptId: request.builderAttemptId,
        outputAttemptId: request.reviewSubjectRef.outputAttemptId,
        workspaceId: request.workspaceId,
        workspaceRevision: 1,
        workspaceChangeFingerprint: FINGERPRINT_BASE,
        impactFingerprint: FINGERPRINT_BASE,
        verificationFingerprint: FINGERPRINT_BASE
      },
      repairIteration: 1,
      state: 'COMPLETED',
      revision: 3,
      startedAt: new Date('2026-08-12T00:02:00.000Z'),
      completedAt: new Date('2026-08-12T00:03:00.000Z')
    };
    ctx.evidenceStore.addRepairAttempt(repairAttempt);

    const verification: VerificationEvidence = {
      id: verificationId,
      runId: request.runId,
      taskId: 'task-1',
      attemptId: request.repairAttemptId,
      workspaceId: request.workspaceId,
      workspaceRevision: 2,
      workspaceChangeFingerprint: FINGERPRINT_BASE,
      verificationPolicyFingerprint: FINGERPRINT_BASE,
      status: 'passed',
      verifiedAt: '2026-08-12T00:03:30.000Z',
      fingerprint: FINGERPRINT_BASE
    };
    ctx.evidenceStore.addVerification(verification);

    const review: ReviewEvidence = {
      subject: {
        builderAttemptId: request.builderAttemptId,
        outputAttemptId: request.repairAttemptId,
        workspaceId: request.workspaceId,
        workspaceRevision: 2,
        workspaceChangeFingerprint: FINGERPRINT_BASE,
        impactFingerprint: FINGERPRINT_BASE,
        verificationFingerprint: FINGERPRINT_BASE
      },
      review: {
        recommendation: 'accept',
        summary: 'LGTM',
        findings: []
      }
    };
    ctx.evidenceStore.addReview(review);

    return {
      repairAttemptId: request.repairAttemptId,
      verificationEvidenceId: verificationId,
      reviewSubjectRef: {
        builderAttemptId: request.builderAttemptId,
        outputAttemptId: request.repairAttemptId,
        workspaceId: request.workspaceId
      },
      recommendation: 'accept'
    };
  },

  integrateAcceptedOutput: async (request: {
    readonly runId: string;
    readonly taskId: string;
    readonly workspaceId: string;
    readonly reviewSubjectRef: {
      readonly builderAttemptId: string;
      readonly outputAttemptId: string;
      readonly workspaceId: string;
    };
  }): Promise<{
    readonly integrationStatus: 'integrated' | 'blocked';
  }> => {
    const integration: IntegrationEvidence = { status: 'integrated' };
    ctx.evidenceStore.setIntegration(integration);
    return { integrationStatus: 'integrated' };
  },

  runBuildReviewRepairIntegrate: async (request: {
    readonly runId: string;
  }): Promise<{
    readonly builderAttemptId: string;
    readonly finalRepairAttemptId?: string;
    readonly verificationEvidenceId: string;
    readonly reviewSubjectRef: {
      readonly builderAttemptId: string;
      readonly outputAttemptId: string;
      readonly workspaceId: string;
    };
  }> => {
    return {
      builderAttemptId: `builder-${request.runId}-1`,
      finalRepairAttemptId: `repair-${request.runId}-1`,
      verificationEvidenceId: `verification-${request.runId}-1`,
      reviewSubjectRef: {
        builderAttemptId: `builder-${request.runId}-1`,
        outputAttemptId: `output-${request.runId}-1`,
        workspaceId: `workspace-${request.runId}`
      }
    };
  },

  executeBlockedRepairResume: async (request: {
    readonly runId: string;
    readonly repairAttemptId: string;
    readonly leaseState: 'RELEASED' | 'STALE';
  }): Promise<{
    readonly repairAttemptId: string;
    readonly verificationEvidenceId: string;
    readonly state: 'completed' | 'blocked' | 'unknown';
  }> => {
    const repairId = request.repairAttemptId;

    if (!ctx.evidenceStore.getBuilderAttempt(request.runId)) {
      const builderAttempt: BuilderAttemptEvidence = {
        id: `builder-${request.runId}-1`,
        runId: request.runId,
        taskId: 'task-1',
        agentId: 'builder-agent',
        workspaceId: `workspace-${request.runId}`,
        leasePlanFingerprint: FINGERPRINT_BASE,
        state: 'COMPLETED',
        revision: 2,
        startedAt: new Date('2026-08-12T00:00:00.000Z'),
        completedAt: new Date('2026-08-12T00:01:00.000Z')
      };
      ctx.evidenceStore.setBuilderAttempt(builderAttempt);
    }

    const repairAttempt: RepairAttemptEvidence = {
      id: repairId,
      runId: request.runId,
      taskId: 'task-1',
      agentId: 'repair-agent',
      workspaceId: `workspace-${request.runId}`,
      parentReviewIteration: 1,
      parentReviewSubject: {
        builderAttemptId: `builder-${request.runId}-1`,
        outputAttemptId: `output-${request.runId}-1`,
        workspaceId: `workspace-${request.runId}`,
        workspaceRevision: 1,
        workspaceChangeFingerprint: FINGERPRINT_BASE,
        impactFingerprint: FINGERPRINT_BASE,
        verificationFingerprint: FINGERPRINT_BASE
      },
      repairIteration: 1,
      state: 'COMPLETED',
      revision: 3,
      startedAt: new Date('2026-08-12T00:02:00.000Z'),
      completedAt: new Date('2026-08-12T00:03:00.000Z')
    };
    ctx.evidenceStore.addRepairAttempt(repairAttempt);

    const verificationId = `verification-${repairId}-${makeId()}`;

    const verification: VerificationEvidence = {
      id: verificationId,
      runId: request.runId,
      taskId: 'task-1',
      attemptId: repairId,
      workspaceId: `workspace-${request.runId}`,
      workspaceRevision: 2,
      workspaceChangeFingerprint: FINGERPRINT_BASE,
      verificationPolicyFingerprint: FINGERPRINT_BASE,
      status: 'passed',
      verifiedAt: '2026-08-12T00:03:30.000Z',
      fingerprint: FINGERPRINT_BASE
    };
    ctx.evidenceStore.addVerification(verification);

    const review: ReviewEvidence = {
      subject: {
        builderAttemptId: `builder-${request.runId}-1`,
        outputAttemptId: repairId,
        workspaceId: `workspace-${request.runId}`,
        workspaceRevision: 2,
        workspaceChangeFingerprint: FINGERPRINT_BASE,
        impactFingerprint: FINGERPRINT_BASE,
        verificationFingerprint: FINGERPRINT_BASE
      },
      review: {
        recommendation: 'accept',
        summary: 'LGTM',
        findings: []
      }
    };
    ctx.evidenceStore.addReview(review);

    const integration: IntegrationEvidence = { status: 'integrated' };
    ctx.evidenceStore.setIntegration(integration);

    const blockedLease: LeaseEvidence = {
      id: `lease-blocker-${request.runId}-${makeId()}`,
      runId: request.runId,
      agentId: 'repair-agent',
      taskId: 'task-1',
      resource: { type: 'project', projectId: 'core' },
      mode: 'exclusive',
      version: 1,
      state: request.leaseState,
      acquiredAt: new Date('2026-08-12T00:00:00.000Z'),
      lastHeartbeatAt: new Date('2026-08-12T00:01:00.000Z'),
      releasedAt:
        request.leaseState === 'RELEASED' ? new Date('2026-08-12T00:02:00.000Z') : undefined
    };
    ctx.evidenceStore.addLease(blockedLease);

    ctx.evidenceStore.setBlockedResume({
      blockerLeaseId: blockedLease.id,
      blockedRevision: 2,
      resumedRevision: 3,
      repairAttemptId: repairId,
      releaseState: request.leaseState
    });

    return {
      repairAttemptId: repairId,
      verificationEvidenceId: verificationId,
      state: 'completed'
    };
  }
});
