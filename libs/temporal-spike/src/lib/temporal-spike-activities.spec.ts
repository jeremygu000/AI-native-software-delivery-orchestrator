import { describe, expect, it } from 'vitest';
import {
  createTemporalSpikeActivities,
  type TemporalSpikeScenarioService
} from './temporal-spike-activities.js';

describe('TemporalSpikeActivity', () => {
  describe('createTemporalSpikeActivities', () => {
    it('returns an activity that delegates to the provided service', async () => {
      const expectedResult = {
        builderAttemptId: 'builder-1',
        finalRepairAttemptId: 'repair-1',
        verificationEvidenceId: 'verification-1',
        reviewEvidenceId: 'review-1'
      };
      const service: TemporalSpikeScenarioService = {
        runBuildReviewRepairIntegrate: async () => expectedResult
      };
      const activity = createTemporalSpikeActivities(service);
      const result = await activity.runBuildReviewRepairIntegrate({ runId: 'run-1' });
      expect(result).toEqual(expectedResult);
    });

    it('throws when service is not configured', async () => {
      const activity = createTemporalSpikeActivities();
      await expect(activity.runBuildReviewRepairIntegrate({ runId: 'run-1' })).rejects.toThrow(
        'Temporal spike scenario service is not configured'
      );
    });

    it('returns an activity object with correct shape', () => {
      const service: TemporalSpikeScenarioService = {
        runBuildReviewRepairIntegrate: async () => ({
          builderAttemptId: 'builder-1',
          finalRepairAttemptId: 'repair-1',
          verificationEvidenceId: 'verification-1',
          reviewEvidenceId: 'review-1'
        })
      };
      const activity = createTemporalSpikeActivities(service);
      expect(activity).toHaveProperty('runBuildReviewRepairIntegrate');
      expect(typeof activity.runBuildReviewRepairIntegrate).toBe('function');
    });

    it('forwards the runId to the service', async () => {
      let receivedRunId: string | undefined;
      const service: TemporalSpikeScenarioService = {
        runBuildReviewRepairIntegrate: async (request) => {
          receivedRunId = request.runId;
          return {
            builderAttemptId: 'builder-1',
            finalRepairAttemptId: 'repair-1',
            verificationEvidenceId: 'verification-1',
            reviewEvidenceId: 'review-1'
          };
        }
      };
      const activity = createTemporalSpikeActivities(service);
      await activity.runBuildReviewRepairIntegrate({ runId: 'test-run-id' });
      expect(receivedRunId).toBe('test-run-id');
    });
  });
});
