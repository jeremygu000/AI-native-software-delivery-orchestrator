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
      expect(result.reviewEvidenceId).toBe('stub-review-id');
    });

    it('service returns consistent stub values across multiple calls', async () => {
      const service = createStubTemporalSpikeScenarioService();
      const result1 = await service.runBuildReviewRepairIntegrate({ runId: 'run-1' });
      const result2 = await service.runBuildReviewRepairIntegrate({ runId: 'run-2' });
      expect(result1).toEqual(result2);
    });

    it('service ignores runId parameter in stub implementation', async () => {
      const service = createStubTemporalSpikeScenarioService();
      const result = await service.runBuildReviewRepairIntegrate({ runId: 'any-run-id' });
      expect(result.builderAttemptId).toBeTruthy();
    });
  });
});
