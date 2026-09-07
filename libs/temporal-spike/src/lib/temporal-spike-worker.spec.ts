import { describe, expect, it } from 'vitest';
import { createTemporalSpikeWorkerOptions } from './temporal-spike-worker.js';
import { createStubTemporalSpikeScenarioService } from './stub-scenario-service.js';

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
      const service = createStubTemporalSpikeScenarioService();
      const options = createTemporalSpikeWorkerOptions({
        taskQueue: 'test-queue',
        workflowsPath: '/path/to/workflows.js',
        service
      });
      expect(options.activities).toBeDefined();
    });

    it('returns worker options with stub activities when service is not provided', () => {
      const options = createTemporalSpikeWorkerOptions({
        taskQueue: 'test-queue',
        workflowsPath: '/path/to/workflows.js'
      });
      expect(options.activities).toBeDefined();
      expect(typeof options.activities!.runBuildReviewRepairIntegrate).toBe('function');
    });

    it('activities use stub service when no service is provided', async () => {
      const options = createTemporalSpikeWorkerOptions({
        taskQueue: 'test-queue',
        workflowsPath: '/path/to/workflows.js'
      });
      const result = await options.activities!.runBuildReviewRepairIntegrate({ runId: 'run-1' });
      expect(result.builderAttemptId).toBe('stub-builder-attempt-id');
    });

    it('activities delegate to provided service', async () => {
      const expectedResult = {
        builderAttemptId: 'builder-2',
        verificationEvidenceId: 'verification-2',
        reviewSubjectRef: {
          builderAttemptId: 'builder-2',
          outputAttemptId: 'output-2',
          workspaceId: 'workspace-2'
        }
      };
      const options = createTemporalSpikeWorkerOptions({
        taskQueue: 'test-queue',
        workflowsPath: '/path/to/workflows.js',
        service: {
          executeBuilder: async () => ({
            builderAttemptId: 'builder-2',
            workspaceId: 'workspace-2',
            impactPrediction: []
          }),
          evaluateBuilderOutput: async () => ({
            verificationEvidenceId: 'verification-2',
            reviewSubjectRef: {
              builderAttemptId: 'builder-2',
              outputAttemptId: 'output-2',
              workspaceId: 'workspace-2'
            },
            recommendation: 'accept' as const
          }),
          executeRepair: async () => ({
            repairAttemptId: 'repair-2',
            verificationEvidenceId: 'verification-2',
            reviewSubjectRef: {
              builderAttemptId: 'builder-2',
              outputAttemptId: 'output-2',
              workspaceId: 'workspace-2'
            },
            recommendation: 'accept' as const
          }),
          integrateAcceptedOutput: async () => ({ integrationStatus: 'integrated' as const }),
          runBuildReviewRepairIntegrate: async () => expectedResult,
          executeBlockedRepairResume: async () => ({
            repairAttemptId: 'repair-2',
            verificationEvidenceId: 'verification-2'
          })
        }
      });
      const result = await options.activities!.runBuildReviewRepairIntegrate({ runId: 'run-2' });
      expect(result).toEqual(expectedResult);
    });
  });
});
