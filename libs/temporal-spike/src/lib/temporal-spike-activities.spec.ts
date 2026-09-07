import { describe, expect, it } from 'vitest';
import { createTemporalSpikeActivities } from './temporal-spike-activities.js';
import { createStubTemporalSpikeScenarioService } from './stub-scenario-service.js';
import type { DurableExecutionScenarioService } from '@ai-native-software-delivery-orchestrator/orchestration-runtime';

describe('TemporalSpikeActivity', () => {
  describe('createTemporalSpikeActivities', () => {
    it('returns an activity that delegates executeBuilder to the provided service', async () => {
      const service: DurableExecutionScenarioService = {
        executeBuilder: async () => ({
          builderAttemptId: 'builder-1',
          workspaceId: 'workspace-1',
          impactPrediction: ['impact-1']
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
        executeBlockedRepairResume: async () => ({
          repairAttemptId: 'repair-1',
          verificationEvidenceId: 'verification-1',
          state: 'completed' as const
        })
      };
      const activity = createTemporalSpikeActivities(service);
      const result = await activity.executeBuilder({
        runId: 'run-1',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        agentId: 'agent-1'
      });
      expect(result.builderAttemptId).toBe('builder-1');
      expect(result.workspaceId).toBe('workspace-1');
      expect(result.impactPrediction).toEqual(['impact-1']);
    });

    it('uses stub service when no custom service is provided', async () => {
      const activity = createTemporalSpikeActivities(createStubTemporalSpikeScenarioService());
      const result = await activity.executeBuilder({
        runId: 'run-1',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        agentId: 'agent-1'
      });
      expect(result.builderAttemptId).toBe('stub-builder-attempt-id');
    });

    it('returns an activity object with correct shape', () => {
      const service = createStubTemporalSpikeScenarioService();
      const activity = createTemporalSpikeActivities(service);
      expect(activity).toHaveProperty('executeBuilder');
      expect(activity).toHaveProperty('evaluateBuilderOutput');
      expect(activity).toHaveProperty('executeRepair');
      expect(activity).toHaveProperty('integrateAcceptedOutput');
      expect(activity).toHaveProperty('executeBlockedRepairResume');
    });

    it('forwards the runId to the service for executeBuilder', async () => {
      let receivedRunId: string | undefined;
      const service: DurableExecutionScenarioService = {
        executeBuilder: async (request) => {
          receivedRunId = request.runId;
          return {
            builderAttemptId: 'builder-1',
            workspaceId: 'workspace-1',
            impactPrediction: []
          };
        },
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
        executeBlockedRepairResume: async () => ({
          repairAttemptId: 'repair-1',
          verificationEvidenceId: 'verification-1',
          state: 'completed' as const
        })
      };
      const activity = createTemporalSpikeActivities(service);
      await activity.executeBuilder({
        runId: 'test-run-id',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        agentId: 'agent-1'
      });
      expect(receivedRunId).toBe('test-run-id');
    });
  });
});
