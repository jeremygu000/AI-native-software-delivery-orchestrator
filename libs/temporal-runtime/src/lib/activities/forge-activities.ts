import type {
  ReevaluateRunInput,
  ReevaluateRunResult,
  ExecuteBuilderInput,
  ExecuteBuilderResult,
  EvaluateBuilderOutputInput,
  EvaluateBuilderOutputResult,
  ExecuteRepairInput,
  ExecuteRepairResult,
  IntegrateAcceptedOutputInput,
  IntegrateAcceptedOutputResult,
} from '../contracts.js';

/**
 * The set of Temporal activity functions for a Scenario A Forge run.
 *
 * Implement this interface in the Worker process — each method receives
 * compact IDs from the workflow, resolves full domain objects via
 * persistence, calls the corresponding Forge service, and returns
 * compact IDs back to the workflow.
 *
 * Pass an implementation to createTemporalWorker via `forgeActivities`.
 */
export type ForgeActivities = {
  reevaluateRun(input: ReevaluateRunInput): Promise<ReevaluateRunResult>;
  executeBuilder(input: ExecuteBuilderInput): Promise<ExecuteBuilderResult>;
  evaluateBuilderOutput(
    input: EvaluateBuilderOutputInput,
  ): Promise<EvaluateBuilderOutputResult>;
  executeRepair(input: ExecuteRepairInput): Promise<ExecuteRepairResult>;
  integrateAcceptedOutput(
    input: IntegrateAcceptedOutputInput,
  ): Promise<IntegrateAcceptedOutputResult>;
};
