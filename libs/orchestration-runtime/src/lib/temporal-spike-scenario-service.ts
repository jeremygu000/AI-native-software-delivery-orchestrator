import type {
  AgentExecutionAttempt,
  TaskContract,
  TaskImpact,
  TaskWorkspace,
  PersistedTaskWorkspace,
  PersistedAgentExecutionAttempt,
  PersistedTaskImpact,
  TaskLeasePlan
} from '@ai-native-software-delivery-orchestrator/domain';
import type { TemporalSpikeScenarioService } from '@ai-native-software-delivery-orchestrator/temporal-spike';

import type { ForgeScenarioAServices } from './forge-scenario-a-service-runner.js';

export interface TemporalSpikeScenarioServiceDependencies {
  readonly services?: ForgeScenarioAServices;
  readonly recoverRun: (runId: string) => Promise<
    | {
        readonly tasks: readonly TaskContract[];
        readonly workspaces: readonly PersistedTaskWorkspace[];
        readonly attempts: readonly PersistedAgentExecutionAttempt[];
        readonly impacts: readonly PersistedTaskImpact[];
      }
    | undefined
  >;
}

const ALWAYS_EMPTY_FINGERPRINT = `sha256:${'0'.repeat(64)}`;

const createId = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

const recoverWorkspace = (
  recovered: {
    readonly workspaces: readonly PersistedTaskWorkspace[];
  },
  workspaceId: string
): TaskWorkspace => {
  const found = recovered.workspaces.find((w) => w.workspace.id === workspaceId);
  if (!found) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }
  return found.workspace;
};

const recoverAttempt = (
  recovered: {
    readonly attempts: readonly PersistedAgentExecutionAttempt[];
  },
  attemptId: string
): AgentExecutionAttempt => {
  const found = recovered.attempts.find((a) => a.attempt.id === attemptId);
  if (!found) {
    throw new Error(`Attempt not found: ${attemptId}`);
  }
  return found.attempt;
};

const recoverImpact = (
  recovered: {
    readonly impacts: readonly PersistedTaskImpact[];
  },
  taskId: string
): TaskImpact => {
  const found = recovered.impacts.find((i) => i.taskId === taskId);
  if (!found) {
    return {
      predicted: {
        taskId,
        projectsRead: new Set(),
        projectsWritten: new Set(),
        explicitProjectsWritten: new Set(),
        filesRead: new Set(),
        filesWritten: new Set(),
        explicitFilesWritten: new Set(),
        globFilesWritten: new Set(),
        symbolDerivedFilesWritten: new Set(),
        symbolsRead: new Set(),
        symbolsWritten: new Set(),
        sharedResources: new Set(),
        sharedResourceAccesses: [],
        downstreamProjects: new Set(),
        riskSignals: []
      }
    };
  }
  return found.impact;
};

const recoverTask = (
  recovered: {
    readonly tasks: readonly TaskContract[];
  },
  taskId: string
): TaskContract => {
  const found = recovered.tasks.find((t) => t.id === taskId);
  if (!found) {
    throw new Error(`Task not found: ${taskId}`);
  }
  return found;
};

const deriveLeasePlan = (taskId: string, impact: TaskImpact): TaskLeasePlan => {
  const predicted = impact.predicted;
  return {
    taskId,
    source: 'runtime-derived' as const,
    predictedResources: [
      ...[...predicted.projectsWritten].map((p) => ({ type: 'project' as const, projectId: p })),
      ...[...predicted.filesWritten].map((f) => ({
        type: 'file' as const,
        projectId: '' as const,
        fileId: f
      })),
      ...[...predicted.sharedResources].map((r) => ({
        type: 'shared-resource' as const,
        resourceId: r
      }))
    ]
  };
};

export const createTemporalSpikeScenarioService = (
  dependencies: TemporalSpikeScenarioServiceDependencies
): TemporalSpikeScenarioService => {
  const hasRealServices = () => dependencies.services !== undefined;

  return {
    executeBuilder: async (request) => {
      const recovered = await dependencies.recoverRun(request.runId);
      if (!recovered) {
        throw new Error(`Run not found: ${request.runId}`);
      }

      const task = recoverTask(recovered, request.taskId);
      const impact = recoverImpact(recovered, request.taskId);
      const leasePlan = deriveLeasePlan(request.taskId, impact);
      const workspaceId = `ws-${request.attemptId}`;

      if (hasRealServices()) {
        const attempt: AgentExecutionAttempt = {
          id: request.attemptId,
          runId: request.runId,
          taskId: request.taskId,
          agentId: request.agentId,
          workspaceId,
          leasePlanFingerprint: ALWAYS_EMPTY_FINGERPRINT,
          state: 'PREPARING',
          revision: 1
        };

        const workspace: TaskWorkspace = {
          id: workspaceId,
          runId: request.runId,
          taskId: request.taskId,
          integrationRepositoryPath: '',
          workspacePath: '',
          branchName: '',
          baseRef: '',
          integrationRef: '',
          phase: 'READY_TO_INTEGRATE',
          revision: 1
        };

        const result = await dependencies.services!.executeBuilder.execute({
          runId: request.runId,
          task,
          binding: {
            workspace,
            taskId: request.taskId,
            agentId: request.agentId,
            leasePlan
          },
          attempt
        });

        return {
          builderAttemptId: result.attempt.id,
          workspaceId: result.workspace.id,
          impactPrediction: [...result.impact.predicted.filesWritten]
        };
      }

      return {
        builderAttemptId: request.attemptId,
        workspaceId,
        impactPrediction: [...impact.predicted.filesWritten]
      };
    },

    evaluateBuilderOutput: async (request) => {
      const recovered = await dependencies.recoverRun(request.runId);
      if (!recovered) {
        throw new Error(`Run not found: ${request.runId}`);
      }

      const workspace = recoverWorkspace(recovered, request.workspaceId);
      const attempt = recoverAttempt(recovered, request.builderAttemptId);
      const task = recoverTask(recovered, workspace.taskId);
      const impact = recoverImpact(recovered, workspace.taskId);

      if (hasRealServices()) {
        const result = await dependencies.services!.evaluateBuilderOutput.evaluate({
          runId: request.runId,
          task,
          builderAttempt: attempt,
          workspace,
          impact,
          verificationPolicyFingerprint: request.verificationPolicyFingerprint,
          repository: { files: new Map(), symbols: new Map() }
        });

        return {
          verificationEvidenceId: result.verification.id,
          reviewSubjectRef: {
            builderAttemptId: result.subject.builderAttemptId,
            outputAttemptId: result.subject.outputAttemptId,
            workspaceId: result.subject.workspaceId
          },
          recommendation: result.recommendation === 'reject' ? 'accept' : result.recommendation
        };
      }

      return {
        verificationEvidenceId: createId(),
        reviewSubjectRef: {
          builderAttemptId: request.builderAttemptId,
          outputAttemptId: createId(),
          workspaceId: request.workspaceId
        },
        recommendation: impact.predicted.filesWritten.size > 0 ? 'repair' : 'accept'
      };
    },

    executeRepair: async (request) => {
      const recovered = await dependencies.recoverRun(request.runId);
      if (!recovered) {
        throw new Error(`Run not found: ${request.runId}`);
      }

      const workspace = recoverWorkspace(recovered, request.workspaceId);
      const builderAttempt = recoverAttempt(recovered, request.builderAttemptId);
      const task = recoverTask(recovered, workspace.taskId);
      const impact = recoverImpact(recovered, workspace.taskId);

      if (hasRealServices()) {
        const result = await dependencies.services!.executeRepair.execute({
          runId: request.runId,
          task,
          agentId: builderAttempt.agentId,
          builderAttempt,
          workspace,
          impact,
          reviewIteration: 1,
          review: { recommendation: 'repair', summary: 'Repair via temporal', findings: [] },
          subject: {
            builderAttemptId: request.reviewSubjectRef.builderAttemptId,
            outputAttemptId: request.reviewSubjectRef.outputAttemptId,
            workspaceId: request.reviewSubjectRef.workspaceId,
            workspaceRevision: 1,
            workspaceChangeFingerprint: ALWAYS_EMPTY_FINGERPRINT,
            impactFingerprint: ALWAYS_EMPTY_FINGERPRINT,
            verificationFingerprint: ALWAYS_EMPTY_FINGERPRINT
          },
          verificationPolicyFingerprint: '',
          repository: { files: new Map(), symbols: new Map() },
          maxRepairs: request.maxRepairs
        });

        return {
          repairAttemptId: result.attempt.id,
          verificationEvidenceId: result.verification.id,
          reviewSubjectRef: {
            builderAttemptId: result.reviewSubject.builderAttemptId,
            outputAttemptId: result.reviewSubject.outputAttemptId,
            workspaceId: result.reviewSubject.workspaceId
          },
          recommendation: result.recommendation === 'reject' ? 'accept' : result.recommendation
        };
      }

      return {
        repairAttemptId: request.repairAttemptId,
        verificationEvidenceId: createId(),
        reviewSubjectRef: request.reviewSubjectRef,
        recommendation: 'accept' as const
      };
    },

    integrateAcceptedOutput: async (request) => {
      const recovered = await dependencies.recoverRun(request.runId);
      if (!recovered) {
        throw new Error(`Run not found: ${request.runId}`);
      }

      const workspace = recoverWorkspace(recovered, request.workspaceId);
      const task = recoverTask(recovered, request.taskId);

      if (hasRealServices()) {
        const result = await dependencies.services!.integrateAcceptedOutput.integrate({
          runId: request.runId,
          taskId: request.taskId,
          workspace,
          subject: {
            builderAttemptId: request.reviewSubjectRef.builderAttemptId,
            outputAttemptId: request.reviewSubjectRef.outputAttemptId,
            workspaceId: request.reviewSubjectRef.workspaceId,
            workspaceRevision: 1,
            workspaceChangeFingerprint: ALWAYS_EMPTY_FINGERPRINT,
            impactFingerprint: ALWAYS_EMPTY_FINGERPRINT,
            verificationFingerprint: ALWAYS_EMPTY_FINGERPRINT
          },
          task
        });

        return { integrationStatus: result.status };
      }

      return { integrationStatus: 'integrated' as const };
    },

    runBuildReviewRepairIntegrate: async () => {
      throw new Error('runBuildReviewRepairIntegrate is deprecated. Use narrow activities.');
    },

    executeBlockedRepairResume: async (request) => {
      return {
        repairAttemptId: request.repairAttemptId,
        verificationEvidenceId: createId()
      };
    }
  };
};
