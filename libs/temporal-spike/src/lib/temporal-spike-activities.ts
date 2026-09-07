/**
 * Side-effect adapter surface for the M2 spike.
 *
 * This interface defines the Temporal activity boundary between the workflow and Forge services.
 * It intentionally contains identifiers only - actual Forge authority evidence remains in the
 * authority store (SQLite) and is never stored in workflow history.
 *
 * Architecture:
 * - Workflow: Pure control flow, calls activities, stores only IDs in history
 * - Activities: Delegate to TemporalSpikeScenarioService which composes Forge services
 * - Forge services: Execute actual builder/repair logic, persist evidence to SQLite
 *
 * @see TemporalSpikeScenarioService for the service composition interface
 */
export interface TemporalSpikeActivity {
  /**
   * Executes Scenario A: Build -> Verify -> Review repair -> Repair -> Verify -> Review accept -> Integrate
   *
   * This activity runs one complete build-review-repair-integrate cycle through
   * the four Scenario A seams:
   * 1. ExecuteBuilder - runs one authorized builder attempt
   * 2. EvaluateBuilderOutput - verifies and reviews builder output
   * 3. ExecuteRepair - admits and executes one repair attempt (if recommended)
   * 4. IntegrateAcceptedOutput - commits and integrates accepted output
   */
  runBuildReviewRepairIntegrate(request: { readonly runId: string }): Promise<{
    readonly builderAttemptId: string;
    readonly finalRepairAttemptId: string;
    readonly verificationEvidenceId: string;
    readonly reviewEvidenceId: string;
  }>;

  /**
   * Executes Scenario B: Resume a previously blocked repair attempt.
   *
   * This activity resumes a repair that was previously blocked due to a conflicting lease.
   * The repair attempt ID is preserved from the original blocked repair, allowing the
   * durable execution substrate to signal when the blocking lease is released.
   */
  executeBlockedRepairResume(request: {
    readonly runId: string;
    readonly repairAttemptId: string;
  }): Promise<{
    readonly repairAttemptId: string;
    readonly verificationEvidenceId: string;
    readonly reviewEvidenceId: string;
  }>;
}

/**
 * Service composition interface for the Temporal spike.
 *
 * Implementations of this interface compose the actual Forge services to execute
 * the build-review-repair-integrate scenarios. The implementation is decoupled from
 * the Temporal activity boundary, allowing for testing and different runtime options.
 *
 * @see TemporalSpikeActivity for the Temporal activity adapter
 */
export interface TemporalSpikeScenarioService {
  runBuildReviewRepairIntegrate(request: { readonly runId: string }): Promise<{
    readonly builderAttemptId: string;
    readonly finalRepairAttemptId: string;
    readonly verificationEvidenceId: string;
    readonly reviewEvidenceId: string;
  }>;
  executeBlockedRepairResume(request: {
    readonly runId: string;
    readonly repairAttemptId: string;
  }): Promise<{
    readonly repairAttemptId: string;
    readonly verificationEvidenceId: string;
    readonly reviewEvidenceId: string;
  }>;
}

export const createTemporalSpikeActivities = (
  service: TemporalSpikeScenarioService = {
    runBuildReviewRepairIntegrate: async () => {
      throw new Error('Temporal spike scenario service is not configured');
    },
    executeBlockedRepairResume: async () => {
      throw new Error('Temporal spike scenario service is not configured');
    }
  }
): TemporalSpikeActivity => ({
  runBuildReviewRepairIntegrate: (request) => service.runBuildReviewRepairIntegrate(request),
  executeBlockedRepairResume: (request) => service.executeBlockedRepairResume(request)
});
