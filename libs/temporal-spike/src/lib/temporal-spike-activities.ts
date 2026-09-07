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
   * Executes one authorized builder attempt (Seam 1).
   */
  executeBuilder(request: {
    readonly runId: string;
    readonly taskId: string;
    readonly attemptId: string;
    readonly agentId: string;
  }): Promise<{
    readonly builderAttemptId: string;
    readonly workspaceId: string;
    readonly impactPrediction: readonly string[];
  }>;

  /**
   * Evaluates builder output - verifies and reviews (Seam 2).
   */
  evaluateBuilderOutput(request: {
    readonly runId: string;
    readonly builderAttemptId: string;
    readonly workspaceId: string;
    readonly verificationPolicyFingerprint: string;
  }): Promise<{
    readonly verificationEvidenceId: string;
    readonly reviewSubjectRef: {
      readonly builderAttemptId: string;
      readonly outputAttemptId: string;
      readonly workspaceId: string;
    };
    readonly recommendation: 'accept' | 'repair';
  }>;

  /**
   * Executes one repair attempt (Seam 3), only called if evaluation recommends 'repair'.
   */
  executeRepair(request: {
    readonly runId: string;
    readonly repairAttemptId: string;
    readonly builderAttemptId: string;
    readonly workspaceId: string;
    readonly reviewSubjectRef: {
      readonly builderAttemptId: string;
      readonly outputAttemptId: string;
      readonly workspaceId: string;
    };
    readonly maxRepairs: number;
  }): Promise<{
    readonly repairAttemptId: string;
    readonly verificationEvidenceId: string;
    readonly reviewSubjectRef: {
      readonly builderAttemptId: string;
      readonly outputAttemptId: string;
      readonly workspaceId: string;
    };
    readonly recommendation: 'accept' | 'repair';
  }>;

  /**
   * Integrates accepted output into the repository (Seam 4).
   */
  integrateAcceptedOutput(request: {
    readonly runId: string;
    readonly taskId: string;
    readonly workspaceId: string;
    readonly reviewSubjectRef: {
      readonly builderAttemptId: string;
      readonly outputAttemptId: string;
      readonly workspaceId: string;
    };
  }): Promise<{
    readonly integrationStatus: 'integrated' | 'blocked';
  }>;

  /**
   * Executes Scenario A: Build -> Verify -> Review repair -> Repair -> Verify -> Review accept -> Integrate
   *
   * @deprecated Use the four narrow activities (executeBuilder, evaluateBuilderOutput,
   *            executeRepair, integrateAcceptedOutput) for proper durable continuation.
   */
  runBuildReviewRepairIntegrate(request: { readonly runId: string }): Promise<{
    readonly builderAttemptId: string;
    readonly finalRepairAttemptId?: string;
    readonly verificationEvidenceId: string;
    readonly reviewSubjectRef: {
      readonly builderAttemptId: string;
      readonly outputAttemptId: string;
      readonly workspaceId: string;
    };
  }>;

  /**
   * Executes Scenario B: Resume a previously blocked repair attempt.
   */
  executeBlockedRepairResume(request: {
    readonly runId: string;
    readonly repairAttemptId: string;
  }): Promise<{
    readonly repairAttemptId: string;
    readonly verificationEvidenceId: string;
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
  executeBuilder(request: {
    readonly runId: string;
    readonly taskId: string;
    readonly attemptId: string;
    readonly agentId: string;
  }): Promise<{
    readonly builderAttemptId: string;
    readonly workspaceId: string;
    readonly impactPrediction: readonly string[];
  }>;

  evaluateBuilderOutput(request: {
    readonly runId: string;
    readonly builderAttemptId: string;
    readonly workspaceId: string;
    readonly verificationPolicyFingerprint: string;
  }): Promise<{
    readonly verificationEvidenceId: string;
    readonly reviewSubjectRef: {
      readonly builderAttemptId: string;
      readonly outputAttemptId: string;
      readonly workspaceId: string;
    };
    readonly recommendation: 'accept' | 'repair';
  }>;

  executeRepair(request: {
    readonly runId: string;
    readonly repairAttemptId: string;
    readonly builderAttemptId: string;
    readonly workspaceId: string;
    readonly reviewSubjectRef: {
      readonly builderAttemptId: string;
      readonly outputAttemptId: string;
      readonly workspaceId: string;
    };
    readonly maxRepairs: number;
  }): Promise<{
    readonly repairAttemptId: string;
    readonly verificationEvidenceId: string;
    readonly reviewSubjectRef: {
      readonly builderAttemptId: string;
      readonly outputAttemptId: string;
      readonly workspaceId: string;
    };
    readonly recommendation: 'accept' | 'repair';
  }>;

  integrateAcceptedOutput(request: {
    readonly runId: string;
    readonly taskId: string;
    readonly workspaceId: string;
    readonly reviewSubjectRef: {
      readonly builderAttemptId: string;
      readonly outputAttemptId: string;
      readonly workspaceId: string;
    };
  }): Promise<{
    readonly integrationStatus: 'integrated' | 'blocked';
  }>;

  runBuildReviewRepairIntegrate(request: { readonly runId: string }): Promise<{
    readonly builderAttemptId: string;
    readonly finalRepairAttemptId?: string;
    readonly verificationEvidenceId: string;
    readonly reviewSubjectRef: {
      readonly builderAttemptId: string;
      readonly outputAttemptId: string;
      readonly workspaceId: string;
    };
  }>;

  executeBlockedRepairResume(request: {
    readonly runId: string;
    readonly repairAttemptId: string;
  }): Promise<{
    readonly repairAttemptId: string;
    readonly verificationEvidenceId: string;
  }>;
}

export const createTemporalSpikeActivities = (
  service: TemporalSpikeScenarioService
): TemporalSpikeActivity => ({
  executeBuilder: (request) => service.executeBuilder(request),
  evaluateBuilderOutput: (request) => service.evaluateBuilderOutput(request),
  executeRepair: (request) => service.executeRepair(request),
  integrateAcceptedOutput: (request) => service.integrateAcceptedOutput(request),
  runBuildReviewRepairIntegrate: (request) => service.runBuildReviewRepairIntegrate(request),
  executeBlockedRepairResume: (request) => service.executeBlockedRepairResume(request)
});
