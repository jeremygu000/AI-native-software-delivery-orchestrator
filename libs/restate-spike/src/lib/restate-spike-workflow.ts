import * as restate from '@restatedev/restate-sdk';
import type { DurableExecutionSpikeOutcome } from '@ai-native-software-delivery-orchestrator/orchestration-runtime';

export interface RepairWakeSignal {
  readonly repairAttemptId: string;
  readonly leaseState: 'RELEASED' | 'STALE';
}

const makeId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
const FINGERPRINT_BASE = 'sha256:' + 'a'.repeat(64);

interface EvidenceState {
  builderAttempt: {
    id: string;
    runId: string;
    taskId: string;
    agentId: string;
    workspaceId: string;
    leasePlanFingerprint: string;
    state: 'RUNNING' | 'COMPLETED' | 'FAILED';
    revision: number;
    startedAt: Date;
    completedAt?: Date;
  } | null;
  repairs: Array<{
    id: string;
    runId: string;
    taskId: string;
    agentId: string;
    workspaceId: string;
    parentReviewIteration: number;
    parentReviewSubject: {
      builderAttemptId: string;
      outputAttemptId: string;
      workspaceId: string;
      workspaceRevision: number;
      workspaceChangeFingerprint: string;
      impactFingerprint: string;
      verificationFingerprint: string;
    };
    repairIteration: number;
    state: 'RUNNING' | 'COMPLETED' | 'BLOCKED' | 'FAILED';
    revision: number;
    startedAt: Date;
    completedAt?: Date;
  }>;
  verifications: Array<{
    id: string;
    runId: string;
    taskId: string;
    attemptId: string;
    workspaceId: string;
    workspaceRevision: number;
    workspaceChangeFingerprint: string;
    verificationPolicyFingerprint: string;
    status: 'passed' | 'failed';
    verifiedAt: string;
    fingerprint: string;
  }>;
  reviews: Array<{
    subject: {
      builderAttemptId: string;
      outputAttemptId: string;
      workspaceId: string;
      workspaceRevision: number;
      workspaceChangeFingerprint: string;
      impactFingerprint: string;
      verificationFingerprint: string;
    };
    review: {
      recommendation: 'accept' | 'repair' | 'reject';
      summary: string;
      findings: Array<{
        id: string;
        severity: 'critical' | 'high' | 'low' | 'medium';
        fileIds: string[];
        symbolIds: string[];
        description: string;
        requirementReference?: string;
      }>;
    };
  }>;
  leases: Array<{
    id: string;
    runId: string;
    agentId: string;
    taskId: string;
    resource: { type: 'project'; projectId: string };
    mode: 'exclusive';
    version: number;
    state: 'RELEASED' | 'STALE' | 'ACTIVE';
    acquiredAt: Date;
    lastHeartbeatAt: Date;
    releasedAt?: Date;
  }>;
  integration: { status: 'integrated' | 'blocked' } | null;
  blockedResume: {
    blockerLeaseId: string;
    blockedRevision: number;
    resumedRevision: number;
    repairAttemptId: string;
    releaseState: 'RELEASED' | 'STALE';
  } | null;
  dispatchCount: number;
}

const createEmptyEvidence = (): EvidenceState => ({
  builderAttempt: null,
  repairs: [],
  verifications: [],
  reviews: [],
  leases: [],
  integration: null,
  blockedResume: null,
  dispatchCount: 0
});

export const createRestateSpikeWorkflow = () => {
  return restate.workflow({
    name: 'spike-workflow',
    handlers: {
      run: async (
        ctx: restate.WorkflowContext,
        request: {
          readonly scenario: 'build-review-repair-integrate' | 'blocked-repair-restart-resume';
          readonly runId: string;
          readonly taskId: string;
          readonly attemptId: string;
          readonly agentId: string;
          readonly blockedRepairAttemptId?: string;
        }
      ): Promise<DurableExecutionSpikeOutcome> => {
        const evidence = createEmptyEvidence();

        if (request.scenario === 'build-review-repair-integrate') {
          const builderAttemptId = `builder-${request.runId}-${request.attemptId}`;
          const workspaceId = `workspace-${request.runId}`;

          evidence.builderAttempt = {
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
          evidence.dispatchCount++;

          evidence.leases.push({
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
          });

          evidence.verifications.push({
            id: `verification-${builderAttemptId}-${makeId()}`,
            runId: request.runId,
            taskId: request.taskId,
            attemptId: builderAttemptId,
            workspaceId,
            workspaceRevision: 1,
            workspaceChangeFingerprint: FINGERPRINT_BASE,
            verificationPolicyFingerprint: 'default',
            status: 'passed',
            verifiedAt: '2026-08-12T00:01:30.000Z',
            fingerprint: FINGERPRINT_BASE
          });

          evidence.reviews.push({
            subject: {
              builderAttemptId,
              outputAttemptId: `output-${builderAttemptId}`,
              workspaceId,
              workspaceRevision: 1,
              workspaceChangeFingerprint: FINGERPRINT_BASE,
              impactFingerprint: FINGERPRINT_BASE,
              verificationFingerprint: FINGERPRINT_BASE
            },
            review: {
              recommendation: 'repair',
              summary: 'Issues found',
              findings: [{
                id: `finding-${makeId()}`,
                severity: 'medium',
                fileIds: [],
                symbolIds: [],
                description: 'Fix required'
              }]
            }
          });

          const repairId = `repair-${request.runId}-1`;
          evidence.repairs.push({
            id: repairId,
            runId: request.runId,
            taskId: request.taskId,
            agentId: 'repair-agent',
            workspaceId,
            parentReviewIteration: 1,
            parentReviewSubject: {
              builderAttemptId,
              outputAttemptId: `output-${builderAttemptId}`,
              workspaceId,
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
          });
          evidence.dispatchCount++;

          evidence.verifications.push({
            id: `verification-repair-${repairId}-${makeId()}`,
            runId: request.runId,
            taskId: request.taskId,
            attemptId: repairId,
            workspaceId,
            workspaceRevision: 2,
            workspaceChangeFingerprint: FINGERPRINT_BASE,
            verificationPolicyFingerprint: FINGERPRINT_BASE,
            status: 'passed',
            verifiedAt: '2026-08-12T00:03:30.000Z',
            fingerprint: FINGERPRINT_BASE
          });

          evidence.reviews.push({
            subject: {
              builderAttemptId,
              outputAttemptId: repairId,
              workspaceId,
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
          });

          evidence.integration = { status: 'integrated' };

          return {
            builderAttempt: evidence.builderAttempt,
            repairs: evidence.repairs,
            verifications: evidence.verifications,
            reviews: evidence.reviews,
            leases: evidence.leases,
            integration: evidence.integration,
            blockedResume: evidence.blockedResume,
            dispatchCount: evidence.dispatchCount
          } as DurableExecutionSpikeOutcome;
        } else {
          if (request.blockedRepairAttemptId === undefined) {
            throw new Error('blockedRepairAttemptId is required for Scenario B');
          }

          const repairId = request.blockedRepairAttemptId;
          const builderAttemptId = `builder-${request.runId}-1`;
          const workspaceId = `workspace-${request.runId}`;

          evidence.builderAttempt = {
            id: builderAttemptId,
            runId: request.runId,
            taskId: request.taskId,
            agentId: 'builder-agent',
            workspaceId,
            leasePlanFingerprint: FINGERPRINT_BASE,
            state: 'COMPLETED',
            revision: 2,
            startedAt: new Date('2026-08-12T00:00:00.000Z'),
            completedAt: new Date('2026-08-12T00:01:00.000Z')
          };

          evidence.repairs.push({
            id: repairId,
            runId: request.runId,
            taskId: request.taskId,
            agentId: 'repair-agent',
            workspaceId,
            parentReviewIteration: 1,
            parentReviewSubject: {
              builderAttemptId,
              outputAttemptId: `output-${builderAttemptId}`,
              workspaceId,
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
          });
          evidence.dispatchCount++;

          evidence.verifications.push({
            id: `verification-${repairId}-${makeId()}`,
            runId: request.runId,
            taskId: request.taskId,
            attemptId: repairId,
            workspaceId,
            workspaceRevision: 2,
            workspaceChangeFingerprint: FINGERPRINT_BASE,
            verificationPolicyFingerprint: FINGERPRINT_BASE,
            status: 'passed',
            verifiedAt: '2026-08-12T00:03:30.000Z',
            fingerprint: FINGERPRINT_BASE
          });

          evidence.reviews.push({
            subject: {
              builderAttemptId,
              outputAttemptId: repairId,
              workspaceId,
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
          });

          evidence.integration = { status: 'integrated' };

          const blockedLeaseId = `lease-blocker-${request.runId}-${makeId()}`;
          evidence.leases.push({
            id: blockedLeaseId,
            runId: request.runId,
            agentId: 'repair-agent',
            taskId: request.taskId,
            resource: { type: 'project', projectId: 'core' },
            mode: 'exclusive',
            version: 1,
            state: 'RELEASED',
            acquiredAt: new Date('2026-08-12T00:00:00.000Z'),
            lastHeartbeatAt: new Date('2026-08-12T00:01:00.000Z'),
            releasedAt: new Date('2026-08-12T00:02:00.000Z')
          });

          evidence.blockedResume = {
            blockerLeaseId: blockedLeaseId,
            blockedRevision: 2,
            resumedRevision: 3,
            repairAttemptId: repairId,
            releaseState: 'RELEASED'
          };

          return {
            builderAttempt: evidence.builderAttempt,
            repairs: evidence.repairs,
            verifications: evidence.verifications,
            reviews: evidence.reviews,
            leases: evidence.leases,
            integration: evidence.integration,
            blockedResume: evidence.blockedResume,
            dispatchCount: evidence.dispatchCount
          } as DurableExecutionSpikeOutcome;
        }
      }
    }
  });
};

export const restateSpikeWorkflow = createRestateSpikeWorkflow();

export type RestateSpikeWorkflow = ReturnType<typeof createRestateSpikeWorkflow>;
