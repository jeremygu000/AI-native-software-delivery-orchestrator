import type {
  ReevaluateRunInput,
  ReevaluateRunResult,
  ExecuteBuilderInput,
  ExecuteBuilderResult,
  EvaluateBuilderOutputInput,
  EvaluateBuilderOutputResult,
  AdmitRepairInput,
  AdmitRepairResult,
  ExecuteRepairInput,
  ExecuteRepairResult,
  IntegrateAcceptedOutputInput,
  IntegrateAcceptedOutputResult,
  FinalizeRunStateInput,
  FinalizeRunStateResult,
  FinalizeRunCancellationInput,
  FinalizeRunCancellationResult,
  ResumeBlockedRepairInput,
  ResumeBlockedRepairResult,
  ResumeBlockedIntegrationInput,
  ResumeBlockedIntegrationResult
} from './contracts.js';

/**
 * The provider-neutral Forge execution operations for a run.
 *
 * A durable-runtime adapter invokes these operations using compact,
 * serializable contracts. Implementations resolve full domain objects via
 * persistence, call the corresponding Forge service, and return compact IDs
 * to the adapter.
 */
export type ForgeActivities = {
  reevaluateRun(input: ReevaluateRunInput): Promise<ReevaluateRunResult>;
  executeBuilder(input: ExecuteBuilderInput): Promise<ExecuteBuilderResult>;
  evaluateBuilderOutput(input: EvaluateBuilderOutputInput): Promise<EvaluateBuilderOutputResult>;
  admitRepair(input: AdmitRepairInput): Promise<AdmitRepairResult>;
  executeRepair(input: ExecuteRepairInput): Promise<ExecuteRepairResult>;
  integrateAcceptedOutput(
    input: IntegrateAcceptedOutputInput
  ): Promise<IntegrateAcceptedOutputResult>;
  finalizeRunState(input: FinalizeRunStateInput): Promise<FinalizeRunStateResult>;
  finalizeRunCancellation?(
    input: FinalizeRunCancellationInput
  ): Promise<FinalizeRunCancellationResult>;
  resumeBlockedRepair(input: ResumeBlockedRepairInput): Promise<ResumeBlockedRepairResult>;
};

/** Additive continuation port so existing provider adapters remain compatible. */
export type BlockedIntegrationContinuationActivities = {
  resumeBlockedIntegration(
    input: ResumeBlockedIntegrationInput
  ): Promise<ResumeBlockedIntegrationResult>;
};
