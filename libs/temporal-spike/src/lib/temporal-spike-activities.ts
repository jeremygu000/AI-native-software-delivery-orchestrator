/** Side-effect adapter surface for the M2 spike. It intentionally contains identifiers only. */
export interface TemporalSpikeActivity {
  runBuildReviewRepairIntegrate(request: { readonly runId: string }): Promise<{
    readonly builderAttemptId: string;
    readonly finalRepairAttemptId: string;
    readonly verificationEvidenceId: string;
    readonly reviewEvidenceId: string;
  }>;
}

export interface TemporalSpikeScenarioService {
  runBuildReviewRepairIntegrate(request: { readonly runId: string }): Promise<{
    readonly builderAttemptId: string;
    readonly finalRepairAttemptId: string;
    readonly verificationEvidenceId: string;
    readonly reviewEvidenceId: string;
  }>;
}

export const createTemporalSpikeActivities = (
  service: TemporalSpikeScenarioService = {
    runBuildReviewRepairIntegrate: async () => {
      throw new Error('Temporal spike scenario service is not configured');
    }
  }
): TemporalSpikeActivity => ({
  runBuildReviewRepairIntegrate: (request) => service.runBuildReviewRepairIntegrate(request)
});
