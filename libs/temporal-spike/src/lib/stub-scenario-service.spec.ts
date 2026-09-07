import { describe, expect, it } from 'vitest';
import { createStubTemporalSpikeScenarioService } from './stub-scenario-service.js';

describe('TemporalSpikeScenarioService', () => {
  describe('createStubTemporalSpikeScenarioService', () => {
    it('returns a service that returns stubbed identifiers', async () => {
      const service = createStubTemporalSpikeScenarioService();
      const result = await service.runBuildReviewRepairIntegrate({ runId: 'run-1' });
      expect(result.builderAttemptId).toBe('stub-builder-attempt-id');
      expect(result.finalRepairAttemptId).toBe('stub-repair-attempt-id');
      expect(result.verificationEvidenceId).toBe('stub-verification-id');
      expect(result.reviewSubjectRef.builderAttemptId).toBe('stub-builder-attempt-id');
    });

    it('service returns consistent stub values across multiple calls', async () => {
      const service = createStubTemporalSpikeScenarioService();
      const result1 = await service.runBuildReviewRepairIntegrate({ runId: 'run-1' });
      const result2 = await service.runBuildReviewRepairIntegrate({ runId: 'run-2' });
      expect(result1.builderAttemptId).toBe(result2.builderAttemptId);
    });

    it('service ignores runId parameter in stub implementation', async () => {
      const service = createStubTemporalSpikeScenarioService();
      const result = await service.runBuildReviewRepairIntegrate({ runId: 'any-run-id' });
      expect(result.builderAttemptId).toBeTruthy();
    });

    it('executeBlockedRepairResume returns stubbed identifiers using repairAttemptId', async () => {
      const service = createStubTemporalSpikeScenarioService();
      const result = await service.executeBlockedRepairResume({
        runId: 'run-1',
        repairAttemptId: 'blocked-repair-1'
      });
      expect(result.repairAttemptId).toBe('blocked-repair-1');
      expect(result.verificationEvidenceId).toBe('stub-resume-verification-id');
    });

    it('executeBlockedRepairResume passes through the repairAttemptId parameter', async () => {
      const service = createStubTemporalSpikeScenarioService();
      const result = await service.executeBlockedRepairResume({
        runId: 'run-1',
        repairAttemptId: 'my-repair-id'
      });
      expect(result.repairAttemptId).toBe('my-repair-id');
    });

    it('executeBuilder returns stubbed builder execution result', async () => {
      const service = createStubTemporalSpikeScenarioService();
      const result = await service.executeBuilder({
        runId: 'run-1',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        agentId: 'agent-1'
      });
      expect(result.builderAttemptId).toBe('stub-builder-attempt-id');
      expect(result.workspaceId).toBe('stub-workspace-id');
      expect(result.impactPrediction).toEqual([]);
    });

    it('evaluateBuilderOutput returns stubbed evaluation result with accept recommendation', async () => {
      const service = createStubTemporalSpikeScenarioService();
      const result = await service.evaluateBuilderOutput({
        runId: 'run-1',
        builderAttemptId: 'builder-1',
        workspaceId: 'workspace-1',
        verificationPolicyFingerprint: 'fp-1'
      });
      expect(result.verificationEvidenceId).toBe('stub-verification-id');
      expect(result.recommendation).toBe('accept');
      expect(result.reviewSubjectRef.workspaceId).toBe('stub-workspace-id');
    });

    it('integrateAcceptedOutput returns stubbed integration result', async () => {
      const service = createStubTemporalSpikeScenarioService();
      const result = await service.integrateAcceptedOutput({
        runId: 'run-1',
        taskId: 'task-1',
        workspaceId: 'workspace-1',
        reviewSubjectRef: {
          builderAttemptId: 'builder-1',
          outputAttemptId: 'output-1',
          workspaceId: 'workspace-1'
        }
      });
      expect(result.integrationStatus).toBe('integrated');
    });
  });
});
