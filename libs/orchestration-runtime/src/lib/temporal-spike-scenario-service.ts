import type {
  AgentExecutionAttempt,
  TaskContract,
  TaskImpact,
  TaskWorkspace,
  PersistedTaskWorkspace,
  PersistedAgentExecutionAttempt,
  PersistedTaskImpact
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

export const createTemporalSpikeScenarioService = (
  dependencies: TemporalSpikeScenarioServiceDependencies
): TemporalSpikeScenarioService => ({
  executeBuilder: async (request) => {
    const recovered = await dependencies.recoverRun(request.runId);
    if (!recovered) {
      throw new Error(`Run not found: ${request.runId}`);
    }

    const task = recoverTask(recovered, request.taskId);
    const impact = recoverImpact(recovered, request.taskId);
    void task;
    void ALWAYS_EMPTY_FINGERPRINT;

    return {
      builderAttemptId: request.attemptId,
      workspaceId: `ws-${request.attemptId}`,
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
    void attempt;
    void task;

    return {
      verificationEvidenceId: createId(),
      reviewSubjectRef: {
        builderAttemptId: request.builderAttemptId,
        outputAttemptId: createId(),
        workspaceId: request.workspaceId
      },
      recommendation: 'accept' as const
    };
  },

  executeRepair: async (request) => {
    const recovered = await dependencies.recoverRun(request.runId);
    if (!recovered) {
      throw new Error(`Run not found: ${request.runId}`);
    }

    const workspace = recoverWorkspace(recovered, request.workspaceId);
    const attempt = recoverAttempt(recovered, request.builderAttemptId);
    void workspace;
    void attempt;

    return {
      repairAttemptId: request.repairAttemptId,
      verificationEvidenceId: createId(),
      reviewSubjectRef: {
        builderAttemptId: request.builderAttemptId,
        outputAttemptId: createId(),
        workspaceId: request.workspaceId
      },
      recommendation: 'accept' as const
    };
  },

  integrateAcceptedOutput: async (request) => {
    const recovered = await dependencies.recoverRun(request.runId);
    if (!recovered) {
      throw new Error(`Run not found: ${request.runId}`);
    }

    const workspace = recoverWorkspace(recovered, request.workspaceId);
    void workspace;

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
});
