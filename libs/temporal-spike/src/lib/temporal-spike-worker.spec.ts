import { describe, expect, it } from 'vitest';
import { createTemporalSpikeWorkerOptions } from './temporal-spike-worker.js';

describe('TemporalSpikeWorker', () => {
  describe('createTemporalSpikeWorkerOptions', () => {
    it('returns worker options with correct task queue', () => {
      const options = createTemporalSpikeWorkerOptions({
        taskQueue: 'test-queue',
        workflowsPath: '/path/to/workflows.js'
      });
      expect(options.taskQueue).toBe('test-queue');
    });

    it('returns worker options with workflows path', () => {
      const options = createTemporalSpikeWorkerOptions({
        taskQueue: 'test-queue',
        workflowsPath: '/path/to/workflows.js'
      });
      expect(options.workflowsPath).toBe('/path/to/workflows.js');
    });

    it('returns worker options with activities when service is provided', () => {
      const service = {
        runBuildReviewRepairIntegrate: async () => ({
          builderAttemptId: 'builder-1',
          finalRepairAttemptId: 'repair-1',
          verificationEvidenceId: 'verification-1',
          reviewEvidenceId: 'review-1'
        })
      };
      const options = createTemporalSpikeWorkerOptions({
        taskQueue: 'test-queue',
        workflowsPath: '/path/to/workflows.js',
        service
      });
      expect(options.activities).toBeDefined();
    });

    it('returns worker options with activities wrapping stub when service is not provided', () => {
      const options = createTemporalSpikeWorkerOptions({
        taskQueue: 'test-queue',
        workflowsPath: '/path/to/workflows.js'
      });
      expect(options.activities).toBeDefined();
      expect(typeof options.activities!.runBuildReviewRepairIntegrate).toBe('function');
    });

    it('activities throw when called without service configuration', async () => {
      const options = createTemporalSpikeWorkerOptions({
        taskQueue: 'test-queue',
        workflowsPath: '/path/to/workflows.js'
      });
      await expect(
        options.activities!.runBuildReviewRepairIntegrate({ runId: 'run-1' })
      ).rejects.toThrow('Temporal spike scenario service is not configured');
    });

    it('activities delegate to provided service', async () => {
      const expectedResult = {
        builderAttemptId: 'builder-2',
        finalRepairAttemptId: 'repair-2',
        verificationEvidenceId: 'verification-2',
        reviewEvidenceId: 'review-2'
      };
      const options = createTemporalSpikeWorkerOptions({
        taskQueue: 'test-queue',
        workflowsPath: '/path/to/workflows.js',
        service: {
          runBuildReviewRepairIntegrate: async () => expectedResult
        }
      });
      const result = await options.activities!.runBuildReviewRepairIntegrate({ runId: 'run-2' });
      expect(result).toEqual(expectedResult);
    });
  });
});
