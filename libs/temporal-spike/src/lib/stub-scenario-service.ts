import type { TemporalSpikeScenarioService } from './temporal-spike-activities.js';

export const createStubTemporalSpikeScenarioService = (): TemporalSpikeScenarioService => ({
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
  runBuildReviewRepairIntegrate: async () => ({
    builderAttemptId: 'stub-builder-attempt-id',
    finalRepairAttemptId: 'stub-repair-attempt-id',
    verificationEvidenceId: 'stub-verification-id',
    reviewSubjectRef: {
      builderAttemptId: 'stub-builder-attempt-id',
      outputAttemptId: 'stub-output-attempt-id',
      workspaceId: 'stub-workspace-id'
    }
  }),
  executeBlockedRepairResume: async (request) => ({
    repairAttemptId: request.repairAttemptId,
    verificationEvidenceId: 'stub-resume-verification-id'
  })
});
