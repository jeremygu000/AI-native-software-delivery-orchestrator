import {
  taskVerificationEvidenceFingerprint,
  type AgentExecutionAttempt,
  type PersistedTaskCodeReview,
  type TaskCodeReview,
  type TaskCodeReviewSubject,
  type TaskRepairAttempt,
  type TaskVerificationEvidence
} from '@ai-native-software-delivery-orchestrator/domain';
import type {
  DurableExecutionScenarioService
} from '@ai-native-software-delivery-orchestrator/orchestration-runtime';
import type { SqliteSpikeFixture } from './sqlite-outcome-collector.js';

const FINGERPRINT_BASE = 'sha256:' + 'a'.repeat(64);
const makeId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

export interface ForgeScenarioServiceDeps {
  readonly fixture: SqliteSpikeFixture;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly agentId: string;
}

export const createForgeScenarioService = (deps: ForgeScenarioServiceDeps): DurableExecutionScenarioService => {
  const { fixture, runId, taskId, attemptId, agentId } = deps;
  const { persistence } = fixture;

  const workspaceId = `workspace-${runId}`;
  let builderAttemptId: string | undefined;
  let repairIteration = 0;
  let reviewIteration = 0;

  return {
    async executeBuilder(_request) {
      builderAttemptId = `builder-${runId}-${attemptId}`;

      await persistence.createRun({
        run: {
          id: runId,
          repositoryId: 'test-repo',
          state: 'ACTIVE',
          createdAt: new Date().toISOString(),
          authority: {
            artifactId: 'test-artifact',
            artifactRevision: 1,
            approvalId: 'test-approval',
            planFingerprint: FINGERPRINT_BASE,
            approvalFingerprint: FINGERPRINT_BASE,
            claimFingerprint: FINGERPRINT_BASE,
            executionFingerprint: FINGERPRINT_BASE,
            repositoryRoot: '/tmp/test',
            baseCommit: 'a'.repeat(40),
            workingTreeFingerprint: FINGERPRINT_BASE,
            repositoryFactsFingerprint: FINGERPRINT_BASE,
            sharedResourcePolicyFingerprint: FINGERPRINT_BASE,
            verificationPolicyFingerprint: FINGERPRINT_BASE,
            codeReviewPolicyFingerprint: FINGERPRINT_BASE
          }
        },
        tasks: [
          {
            id: taskId,
            title: 'Test task',
            goal: 'Execute test build',
            dependencies: [],
            expectedReads: [],
            expectedWrites: [],
            sharedResources: [],
            verification: []
          }
        ],
        hardConflicts: [],
        riskConflicts: [],
        scheduleOptions: { maxConcurrency: 1 }
      });

      const builderAttempt: AgentExecutionAttempt = {
        id: builderAttemptId,
        runId,
        taskId,
        agentId,
        workspaceId,
        leasePlanFingerprint: FINGERPRINT_BASE,
        state: 'COMPLETED',
        revision: 2,
        startedAt: new Date(),
        completedAt: new Date()
      };

      await persistence.persistAttempt({ runId, attempt: builderAttempt });

      return {
        builderAttemptId,
        workspaceId,
        impactPrediction: []
      };
    },

    async evaluateBuilderOutput(request) {
      reviewIteration++;
      const verificationId = `verification-${makeId()}`;
      const outputAttemptId = `output-${builderAttemptId}`;

      const verificationPayload: Omit<TaskVerificationEvidence, 'fingerprint'> = {
        id: verificationId,
        runId,
        taskId,
        attemptId: builderAttemptId!,
        workspaceId,
        workspaceRevision: 1,
        workspaceChangeFingerprint: FINGERPRINT_BASE,
        verificationPolicyFingerprint: FINGERPRINT_BASE,
        status: 'passed',
        verifiedAt: new Date().toISOString()
      };
      const verification: TaskVerificationEvidence = {
        ...verificationPayload,
        fingerprint: taskVerificationEvidenceFingerprint(verificationPayload)
      };

      await persistence.persistVerificationEvidence(verification);

      const review: TaskCodeReview = {
        recommendation: 'repair',
        summary: 'Issues found, repair needed',
        findings: [
          {
            id: `finding-${makeId()}`,
            severity: 'medium',
            fileIds: ['test-file.ts'],
            symbolIds: [],
            description: 'Fix required'
          }
        ]
      };

      const reviewSubject: TaskCodeReviewSubject = {
        builderAttemptId: builderAttemptId!,
        outputAttemptId,
        workspaceId,
        workspaceRevision: 1,
        workspaceChangeFingerprint: FINGERPRINT_BASE,
        impactFingerprint: FINGERPRINT_BASE,
        verificationFingerprint: FINGERPRINT_BASE
      };

      const persistedReview: PersistedTaskCodeReview = {
        runId,
        taskId,
        iteration: reviewIteration,
        subject: reviewSubject,
        review
      };

      await persistence.persistReview(persistedReview);

      repairIteration++;
      const repairAttemptId = `repair-${runId}-${repairIteration}`;

      const repairAttempt: TaskRepairAttempt = {
        id: repairAttemptId,
        runId,
        taskId,
        agentId: `repair-agent-${repairIteration}`,
        workspaceId,
        parentReviewIteration: reviewIteration,
        parentReviewSubject: reviewSubject,
        repairIteration,
        state: 'COMPLETED',
        revision: 3,
        startedAt: new Date(),
        completedAt: new Date()
      };

      await persistence.persistRepairAttempt({ runId, attempt: repairAttempt });

      return {
        verificationEvidenceId: verificationId,
        reviewSubjectRef: {
          builderAttemptId: builderAttemptId!,
          outputAttemptId,
          workspaceId
        },
        recommendation: 'repair' as const,
        repairAttemptId
      };
    },

    async executeRepair(request) {
      reviewIteration++;
      const verificationId = `verification-repair-${makeId()}`;
      const outputAttemptId = request.repairAttemptId;

      const verificationPayload: Omit<TaskVerificationEvidence, 'fingerprint'> = {
        id: verificationId,
        runId,
        taskId,
        attemptId: outputAttemptId,
        workspaceId,
        workspaceRevision: 2,
        workspaceChangeFingerprint: FINGERPRINT_BASE,
        verificationPolicyFingerprint: FINGERPRINT_BASE,
        status: 'passed',
        verifiedAt: new Date().toISOString()
      };
      const verification: TaskVerificationEvidence = {
        ...verificationPayload,
        fingerprint: taskVerificationEvidenceFingerprint(verificationPayload)
      };

      await persistence.persistVerificationEvidence(verification);

      const review: TaskCodeReview = {
        recommendation: 'accept',
        summary: 'LGTM',
        findings: []
      };

      const reviewSubject: TaskCodeReviewSubject = {
        builderAttemptId: builderAttemptId!,
        outputAttemptId,
        workspaceId,
        workspaceRevision: 2,
        workspaceChangeFingerprint: FINGERPRINT_BASE,
        impactFingerprint: FINGERPRINT_BASE,
        verificationFingerprint: FINGERPRINT_BASE
      };

      const persistedReview: PersistedTaskCodeReview = {
        runId,
        taskId,
        iteration: reviewIteration,
        subject: reviewSubject,
        review
      };

      await persistence.persistReview(persistedReview);

      return {
        repairAttemptId: request.repairAttemptId,
        verificationEvidenceId: verificationId,
        reviewSubjectRef: {
          builderAttemptId: builderAttemptId!,
          outputAttemptId,
          workspaceId
        },
        recommendation: 'accept' as const
      };
    },

    async integrateAcceptedOutput(_request) {
      return {
        integrationStatus: 'integrated' as const
      };
    },

    async executeBlockedRepairResume(request) {
      const resumeResult = await persistence.resumeRepairAttempt({
        runId,
        attemptId: request.repairAttemptId,
        expectedRevision: 1
      });

      if (resumeResult.status === 'resumed') {
        const verificationId = `verification-resume-${makeId()}`;

        const verificationPayload: Omit<TaskVerificationEvidence, 'fingerprint'> = {
          id: verificationId,
          runId,
          taskId,
          attemptId: request.repairAttemptId,
          workspaceId,
          workspaceRevision: 3,
          workspaceChangeFingerprint: FINGERPRINT_BASE,
          verificationPolicyFingerprint: FINGERPRINT_BASE,
          status: 'passed',
          verifiedAt: new Date().toISOString()
        };
        const verification: TaskVerificationEvidence = {
          ...verificationPayload,
          fingerprint: taskVerificationEvidenceFingerprint(verificationPayload)
        };

        await persistence.persistVerificationEvidence(verification);

        return {
          repairAttemptId: request.repairAttemptId,
          verificationEvidenceId: verificationId,
          state: 'completed' as const
        };
      }

      return {
        repairAttemptId: request.repairAttemptId,
        verificationEvidenceId: `verification-unknown-${makeId()}`,
        state: 'unknown' as const
      };
    }
  };
};
