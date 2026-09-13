import {
  taskVerificationEvidenceFingerprint,
  type AgentExecutionAttempt,
  type PersistedTaskCodeReview,
  type TaskCodeReview,
  type TaskCodeReviewSubject,
  type TaskRepairAttempt,
  type TaskVerificationEvidence
} from '@ai-native-software-delivery-orchestrator/domain';
import type { DurableExecutionScenarioService } from '@ai-native-software-delivery-orchestrator/orchestration-runtime';
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

export const createForgeScenarioService = (
  deps: ForgeScenarioServiceDeps
): DurableExecutionScenarioService => {
  const { fixture, runId, taskId, attemptId, agentId } = deps;
  const { persistence } = fixture;

  const workspaceId = `workspace-${runId}`;
  let builderAttemptId: string | undefined;
  let repairIteration = 0;
  let reviewIteration = 0;
  let currentRepairLineage:
    | { parentReviewIteration: number; parentReviewSubject: TaskCodeReviewSubject }
    | undefined;

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
        scheduleOptions: { maxConcurrency: 1 },
        taskBindings: [
          {
            runId,
            taskId,
            agentId,
            leasePlan: {
              taskId,
              predictedResources: [{ type: 'project', projectId: 'project-test' }],
              source: 'manual'
            },
            workspace: {
              id: workspaceId,
              runId,
              taskId,
              integrationRepositoryPath: '/tmp/test-integration',
              workspacePath: '/tmp/test-workspace',
              branchName: `orchestrator/${runId}/${taskId}`,
              baseRef: 'main',
              integrationRef: 'main'
            }
          }
        ]
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

    async evaluateBuilderOutput(_request) {
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
      currentRepairLineage = {
        parentReviewIteration: reviewIteration,
        parentReviewSubject: reviewSubject
      };

      const repairAttempt: TaskRepairAttempt = {
        id: repairAttemptId,
        runId,
        taskId,
        agentId: `repair-agent-${repairIteration}`,
        workspaceId,
        parentReviewIteration: reviewIteration,
        parentReviewSubject: reviewSubject,
        repairIteration,
        state: 'PREPARING',
        revision: 3
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

      const completedRepair: TaskRepairAttempt = {
        id: request.repairAttemptId,
        runId,
        taskId,
        agentId: `repair-agent-${repairIteration}`,
        workspaceId,
        parentReviewIteration: currentRepairLineage!.parentReviewIteration,
        parentReviewSubject: currentRepairLineage!.parentReviewSubject,
        repairIteration,
        state: 'COMPLETED',
        revision: 4,
        startedAt: new Date(),
        completedAt: new Date()
      };

      await persistence.persistRepairAttempt({ runId, attempt: completedRepair });

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

    async integrateAcceptedOutput(request) {
      await persistence.persistIntegration(
        runId,
        'integrated',
        request.reviewSubjectRef.outputAttemptId
      );
      return {
        integrationStatus: 'integrated' as const
      };
    },

    async executeBlockedRepairResume(request) {
      const dispatchId = `dispatch-resume-${makeId()}`;

      const resumeResult = await persistence.resumeRepairAttempt({
        runId,
        attemptId: request.repairAttemptId,
        expectedRevision: 1,
        dispatch: {
          taskId,
          dispatchId,
          authorizedAt: new Date().toISOString()
        }
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

        reviewIteration++;
        const review: TaskCodeReview = {
          recommendation: 'accept',
          summary: 'Blocked repair resumed and verified',
          findings: []
        };
        const reviewSubject: TaskCodeReviewSubject = {
          builderAttemptId: resumeResult.attempt.parentReviewSubject.builderAttemptId,
          outputAttemptId: request.repairAttemptId,
          workspaceId,
          workspaceRevision: 3,
          workspaceChangeFingerprint: FINGERPRINT_BASE,
          impactFingerprint: FINGERPRINT_BASE,
          verificationFingerprint: FINGERPRINT_BASE
        };
        await persistence.persistReview({
          runId,
          taskId,
          iteration: reviewIteration,
          subject: reviewSubject,
          review
        });

        const completedRepair: TaskRepairAttempt = {
          id: request.repairAttemptId,
          runId,
          taskId,
          agentId: `repair-agent-blocked`,
          workspaceId,
          parentReviewIteration: resumeResult.attempt.parentReviewIteration,
          parentReviewSubject: resumeResult.attempt.parentReviewSubject,
          repairIteration: resumeResult.attempt.repairIteration,
          state: 'COMPLETED',
          revision: resumeResult.attempt.revision + 1,
          startedAt: resumeResult.attempt.startedAt,
          completedAt: new Date()
        };
        await persistence.persistRepairAttempt({ runId, attempt: completedRepair });

        await persistence.persistIntegration(runId, 'integrated', request.repairAttemptId);

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
    },

    async setupBlockedRepair(request) {
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
        scheduleOptions: { maxConcurrency: 1 },
        taskBindings: [
          {
            runId,
            taskId,
            agentId,
            leasePlan: {
              taskId,
              predictedResources: [{ type: 'project', projectId: 'project-test' }],
              source: 'manual'
            },
            workspace: {
              id: workspaceId,
              runId,
              taskId,
              integrationRepositoryPath: '/tmp/test-integration',
              workspacePath: '/tmp/test-workspace',
              branchName: `orchestrator/${runId}/${taskId}`,
              baseRef: 'main',
              integrationRef: 'main'
            }
          }
        ]
      });

      const blockedRepair: TaskRepairAttempt = {
        id: request.repairAttemptId,
        runId,
        taskId,
        agentId: `repair-agent-blocked`,
        workspaceId,
        parentReviewIteration: 1,
        parentReviewSubject: {
          builderAttemptId: request.builderAttemptId,
          outputAttemptId: request.builderAttemptId,
          workspaceId,
          workspaceRevision: 1,
          workspaceChangeFingerprint: FINGERPRINT_BASE,
          impactFingerprint: FINGERPRINT_BASE,
          verificationFingerprint: FINGERPRINT_BASE
        },
        repairIteration: 1,
        state: 'BLOCKED',
        revision: 1,
        startedAt: new Date(),
        blocker: { type: 'lease', leaseId: request.blockerLeaseId }
      };

      await persistence.persistRepairAttempt({ runId, attempt: blockedRepair });

      const builderAttempt: AgentExecutionAttempt = {
        id: request.builderAttemptId,
        runId,
        taskId,
        agentId: `builder-agent-${runId}`,
        workspaceId,
        leasePlanFingerprint: FINGERPRINT_BASE,
        state: 'COMPLETED',
        revision: 2,
        startedAt: new Date(),
        completedAt: new Date()
      };

      await persistence.persistAttempt({ runId, attempt: builderAttempt });

      const verificationPayload: Omit<TaskVerificationEvidence, 'fingerprint'> = {
        id: `verification-builder-${makeId()}`,
        runId,
        taskId,
        attemptId: request.builderAttemptId,
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

      reviewIteration++;
      const reviewSubject: TaskCodeReviewSubject = {
        builderAttemptId: request.builderAttemptId,
        outputAttemptId: request.builderAttemptId,
        workspaceId,
        workspaceRevision: 1,
        workspaceChangeFingerprint: FINGERPRINT_BASE,
        impactFingerprint: FINGERPRINT_BASE,
        verificationFingerprint: FINGERPRINT_BASE
      };
      const review: TaskCodeReview = {
        recommendation: 'repair',
        summary: 'Builder output needs repair',
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
      await persistence.persistReview({
        runId,
        taskId,
        iteration: reviewIteration,
        subject: reviewSubject,
        review
      });

      const lease = {
        id: request.blockerLeaseId,
        runId,
        agentId: `lease-agent-${request.blockerLeaseId}`,
        taskId,
        resource: { type: 'project' as const, projectId: 'test-project' },
        mode: 'exclusive' as const,
        version: 1,
        state: 'ACTIVE' as const,
        acquiredAt: new Date(),
        lastHeartbeatAt: new Date()
      };

      await persistence.persistLease({ runId, lease });
    }
  };
};
