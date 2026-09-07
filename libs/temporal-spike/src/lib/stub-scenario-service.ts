import type { TemporalSpikeScenarioService } from './temporal-spike-activities.js';

export const createStubTemporalSpikeScenarioService = (): TemporalSpikeScenarioService => ({
  runBuildReviewRepairIntegrate: async () => ({
    builderAttemptId: 'stub-builder-attempt-id',
    finalRepairAttemptId: 'stub-repair-attempt-id',
    verificationEvidenceId: 'stub-verification-id',
    reviewEvidenceId: 'stub-review-id'
  }),
  executeBlockedRepairResume: async (request) => ({
    repairAttemptId: request.repairAttemptId,
    verificationEvidenceId: 'stub-resume-verification-id',
    reviewEvidenceId: 'stub-resume-review-id'
  })
});
