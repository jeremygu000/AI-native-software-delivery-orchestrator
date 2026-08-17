import { proxyActivities } from '@temporalio/workflow';

import type { TemporalSpikeActivity } from './temporal-spike-activities.js';

const activities = proxyActivities<TemporalSpikeActivity>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 1 }
});

/**
 * M2 control flow only. Forge authority evidence remains in the authority store, never workflow history.
 */
export const runTemporalSpikeWorkflow = async (request: {
  readonly runId: string;
  readonly scenario: 'build-review-repair-integrate' | 'blocked-repair-restart-resume';
}): Promise<{ readonly runId: string; readonly scenario: string }> => {
  if (request.scenario === 'build-review-repair-integrate') {
    await activities.runBuildReviewRepairIntegrate({ runId: request.runId });
  }
  return request;
};
