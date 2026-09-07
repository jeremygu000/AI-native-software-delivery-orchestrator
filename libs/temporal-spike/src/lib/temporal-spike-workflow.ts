import { proxyActivities } from '@temporalio/workflow';

import type { TemporalSpikeActivity } from './temporal-spike-activities.js';

const activities = proxyActivities<TemporalSpikeActivity>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 1 }
});

/**
 * M2 control flow only. Forge authority evidence remains in the authority store, never workflow history.
 *
 * Scenario A (build-review-repair-integrate):
 *   -> ExecuteBuilder Activity
 *   -> EvaluateBuilderOutput Activity
 *   -> if recommendation == repair -> ExecuteRepair Activity
 *   -> if final recommendation == accept -> IntegrateAcceptedOutput Activity
 *
 * Scenario B (blocked-repair-restart-resume):
 *   -> durable wait/signal
 *   -> ExecuteRepair Activity for the existing blocked repair ID
 */
export const runTemporalSpikeWorkflow = async (request: {
  readonly runId: string;
  readonly scenario: 'build-review-repair-integrate' | 'blocked-repair-restart-resume';
  readonly blockedRepairAttemptId?: string;
}): Promise<{ readonly runId: string; readonly scenario: string }> => {
  if (request.scenario === 'build-review-repair-integrate') {
    await activities.runBuildReviewRepairIntegrate({ runId: request.runId });
  } else if (request.scenario === 'blocked-repair-restart-resume') {
    if (request.blockedRepairAttemptId === undefined) {
      throw new Error(
        'blockedRepairAttemptId is required for blocked-repair-restart-resume scenario'
      );
    }
    await activities.executeBlockedRepairResume({
      runId: request.runId,
      repairAttemptId: request.blockedRepairAttemptId
    });
  }
  return request;
};
