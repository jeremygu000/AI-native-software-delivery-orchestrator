import type { DurableExecutionScenarioService } from '@ai-native-software-delivery-orchestrator/orchestration-runtime';

export const createStubTemporalSpikeScenarioService = (): DurableExecutionScenarioService => ({
  executeBuilder: async () => ({
    builderAttemptId: 'stub-builder-attempt-id',
    workspaceId: 'stub-workspace-id',
    impactPrediction: []
  }),
  evaluateBuilderOutput: async () => ({
    verificationEvidenceId: 'stub-verification-id',
    reviewSubjectRef: {
      builderAttemptId: 'stub-builder-attempt-id',
      outputAttemptId: 'stub-output-attempt-id',
      workspaceId: 'stub-workspace-id'
    },
    recommendation: 'accept' as const
  }),
  executeRepair: async () => ({
    repairAttemptId: 'stub-repair-attempt-id',
    verificationEvidenceId: 'stub-repair-verification-id',
    reviewSubjectRef: {
      builderAttemptId: 'stub-builder-attempt-id',
      outputAttemptId: 'stub-output-attempt-id',
      workspaceId: 'stub-workspace-id'
    },
    recommendation: 'accept' as const
  }),
  integrateAcceptedOutput: async () => ({
    integrationStatus: 'integrated' as const
  }),
  executeBlockedRepairResume: async (request) => ({
    repairAttemptId: request.repairAttemptId,
    verificationEvidenceId: 'stub-resume-verification-id',
    state: 'completed' as const
  }),
  setupBlockedRepair: async () => {}
});
