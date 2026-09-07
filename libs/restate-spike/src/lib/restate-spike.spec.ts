import { describe, expect, it } from 'vitest';

import { restateSpikeActivities, restateSpikeWorkflow, createRestateSpikeDriver } from './index.js';

const mockRecoverAttempts = async () => [
  {
    attempt: {
      id: 'attempt-1',
      state: 'COMPLETED' as const,
      taskId: 'task-1',
      runId: 'run-1',
      index: 1,
      createdAt: 0,
      updatedAt: 0,
      agentId: 'agent-1',
      workspaceId: 'workspace-1',
      impact: { filesWritten: [], filesRead: [] }
    }
  }
];

const mockRecoverRepairs = async () => [];
const mockRecoverVerifications = async () => [];
const mockRecoverReviews = async () => [];
const mockRecoverLeases = async () => [];

describe('Restate spike', () => {
  describe('restateSpikeActivities', () => {
    it('is a properly defined Restate service', () => {
      expect(restateSpikeActivities).toBeDefined();
      expect(restateSpikeActivities.name).toBe('restate-spike-activities');
      expect(restateSpikeActivities.handlers).toBeDefined();
    });

    it('has all required handler methods', () => {
      const handlers = restateSpikeActivities.handlers;
      expect(handlers.executeBuilder).toBeDefined();
      expect(handlers.evaluateBuilderOutput).toBeDefined();
      expect(handlers.executeRepair).toBeDefined();
      expect(handlers.integrateAcceptedOutput).toBeDefined();
      expect(handlers.executeBlockedRepairResume).toBeDefined();
    });
  });

  describe('restateSpikeWorkflow', () => {
    it('is a properly defined Restate workflow', () => {
      expect(restateSpikeWorkflow).toBeDefined();
      expect(restateSpikeWorkflow.name).toBe('restate-spike-workflow');
      expect(restateSpikeWorkflow.handlers).toBeDefined();
    });

    it('has the run handler', () => {
      expect(restateSpikeWorkflow.handlers.run).toBeDefined();
    });
  });

  describe('createRestateSpikeDriver', () => {
    it('creates a driver for build-review-repair-integrate scenario', () => {
      const driver = createRestateSpikeDriver({
        runId: 'run-1',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        agentId: 'agent-1',
        scenario: 'build-review-repair-integrate',
        recoverAttempts: mockRecoverAttempts,
        recoverRepairs: mockRecoverRepairs,
        recoverVerifications: mockRecoverVerifications,
        recoverReviews: mockRecoverReviews,
        recoverLeases: mockRecoverLeases,
        dispatchCount: 1
      });

      expect(driver.runBuildReviewRepairIntegrate).toBeDefined();
      expect(driver.runBlockedRepairRestartResume).toBeDefined();
    });

    it('creates a driver for blocked-repair-restart-resume scenario', () => {
      const driver = createRestateSpikeDriver({
        runId: 'run-1',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        agentId: 'agent-1',
        blockedRepairAttemptId: 'repair-1',
        scenario: 'blocked-repair-restart-resume',
        recoverAttempts: mockRecoverAttempts,
        recoverRepairs: mockRecoverRepairs,
        recoverVerifications: mockRecoverVerifications,
        recoverReviews: mockRecoverReviews,
        recoverLeases: mockRecoverLeases,
        dispatchCount: 1,
        blockedResume: {
          repairAttemptId: 'repair-1',
          verificationEvidenceId: 'verification-1',
          state: 'completed'
        }
      });

      expect(driver.runBuildReviewRepairIntegrate).toBeDefined();
      expect(driver.runBlockedRepairRestartResume).toBeDefined();
    });

    it('runBuildReviewRepairIntegrate returns outcome with builder attempt', async () => {
      const driver = createRestateSpikeDriver({
        runId: 'run-1',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        agentId: 'agent-1',
        scenario: 'build-review-repair-integrate',
        recoverAttempts: mockRecoverAttempts,
        recoverRepairs: mockRecoverRepairs,
        recoverVerifications: mockRecoverVerifications,
        recoverReviews: mockRecoverReviews,
        recoverLeases: mockRecoverLeases,
        dispatchCount: 1
      });

      const outcome = await driver.runBuildReviewRepairIntegrate();
      expect(outcome.builderAttempt).toBeDefined();
      expect(outcome.integration).toBeDefined();
      expect(outcome.integration.status).toBe('integrated');
    });
  });
});
