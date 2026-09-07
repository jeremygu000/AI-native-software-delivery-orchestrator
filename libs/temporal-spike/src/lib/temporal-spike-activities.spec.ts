import { describe, expect, it } from 'vitest';
import {
  createTemporalSpikeActivities,
  type TemporalSpikeScenarioService
} from './temporal-spike-activities.js';
import { createStubTemporalSpikeScenarioService } from './stub-scenario-service.js';

describe('TemporalSpikeActivity', () => {
  describe('createTemporalSpikeActivities', () => {
    it('returns an activity that delegates to the provided service', async () => {
      const expectedResult = {
        builderAttemptId: 'builder-1',
        finalRepairAttemptId: 'repair-1',
        verificationEvidenceId: 'verification-1',
        reviewSubjectRef: {
          builderAttemptId: 'builder-1',
          outputAttemptId: 'output-1',
          workspaceId: 'workspace-1'
        }
      };
      const service: TemporalSpikeScenarioService = {
        executeBuilder: async () => ({
          builderAttemptId: 'builder-1',
          workspaceId: 'workspace-1',
          impactPrediction: []
        }),
        evaluateBuilderOutput: async () => ({
          verificationEvidenceId: 'verification-1',
          reviewSubjectRef: {
            builderAttemptId: 'builder-1',
            outputAttemptId: 'output-1',
            workspaceId: 'workspace-1'
          },
          recommendation: 'accept' as const
        }),
        executeRepair: async () => ({
          repairAttemptId: 'repair-1',
          verificationEvidenceId: 'verification-1',
          reviewSubjectRef: {
            builderAttemptId: 'builder-1',
            outputAttemptId: 'output-1',
            workspaceId: 'workspace-1'
          },
          recommendation: 'accept' as const
        }),
        integrateAcceptedOutput: async () => ({ integrationStatus: 'integrated' as const }),
        runBuildReviewRepairIntegrate: async () => expectedResult,
        executeBlockedRepairResume: async () => ({
          repairAttemptId: 'repair-1',
          verificationEvidenceId: 'verification-1'
        })
      };
      const activity = createTemporalSpikeActivities(service);
      const result = await activity.runBuildReviewRepairIntegrate({ runId: 'run-1' });
      expect(result).toEqual(expectedResult);
    });

    it('uses stub service when no service is provided', async () => {
      const activity = createTemporalSpikeActivities(createStubTemporalSpikeScenarioService());
      const result = await activity.runBuildReviewRepairIntegrate({ runId: 'run-1' });
      expect(result.builderAttemptId).toBe('stub-builder-attempt-id');
    });

    it('returns an activity object with correct shape', () => {
      const service = createStubTemporalSpikeScenarioService();
      const activity = createTemporalSpikeActivities(service);
      expect(activity).toHaveProperty('executeBuilder');
      expect(activity).toHaveProperty('evaluateBuilderOutput');
      expect(activity).toHaveProperty('executeRepair');
      expect(activity).toHaveProperty('integrateAcceptedOutput');
      expect(activity).toHaveProperty('runBuildReviewRepairIntegrate');
      expect(activity).toHaveProperty('executeBlockedRepairResume');
    });

    it('forwards the runId to the service', async () => {
      let receivedRunId: string | undefined;
      const service: TemporalSpikeScenarioService = {
        executeBuilder: async () => ({
          builderAttemptId: 'builder-1',
          workspaceId: 'workspace-1',
          impactPrediction: []
        }),
        evaluateBuilderOutput: async () => ({
          verificationEvidenceId: 'verification-1',
          reviewSubjectRef: {
            builderAttemptId: 'builder-1',
            outputAttemptId: 'output-1',
            workspaceId: 'workspace-1'
          },
          recommendation: 'accept' as const
        }),
        executeRepair: async () => ({
          repairAttemptId: 'repair-1',
          verificationEvidenceId: 'verification-1',
          reviewSubjectRef: {
            builderAttemptId: 'builder-1',
            outputAttemptId: 'output-1',
            workspaceId: 'workspace-1'
          },
          recommendation: 'accept' as const
        }),
        integrateAcceptedOutput: async () => ({ integrationStatus: 'integrated' as const }),
        runBuildReviewRepairIntegrate: async (request) => {
          receivedRunId = request.runId;
          return {
            builderAttemptId: 'builder-1',
            verificationEvidenceId: 'verification-1',
            reviewSubjectRef: {
              builderAttemptId: 'builder-1',
              outputAttemptId: 'output-1',
              workspaceId: 'workspace-1'
            }
          };
        },
        executeBlockedRepairResume: async () => ({
          repairAttemptId: 'repair-1',
          verificationEvidenceId: 'verification-1'
        })
      };
      const activity = createTemporalSpikeActivities(service);
      await activity.runBuildReviewRepairIntegrate({ runId: 'test-run-id' });
      expect(receivedRunId).toBe('test-run-id');
    });
  });
});
