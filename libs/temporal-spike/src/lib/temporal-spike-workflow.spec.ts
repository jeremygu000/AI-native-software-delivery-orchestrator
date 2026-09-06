import { Client } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

import { createTemporalSpikeActivities } from './temporal-spike-activities.js';
import { runTemporalSpikeWorkflow } from './temporal-spike-workflow.js';

const environments: { readonly environment: TestWorkflowEnvironment; readonly worker: Worker }[] =
  [];

afterEach(async () => {
  await Promise.all(
    environments.splice(0).map(async ({ environment, worker }) => {
      if (worker.getState() !== 'STOPPED') {
        worker.shutdown();
      }
      await environment.teardown();
    })
  );
});

describe('Temporal spike workflow', () => {
  it('executes deterministic workflow control flow through a real Temporal activity boundary', async () => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'temporal-spike-test',
      workflowsPath: fileURLToPath(new URL('./temporal-spike-workflow.ts', import.meta.url)),
      activities: createTemporalSpikeActivities({
        runBuildReviewRepairIntegrate: async () => ({
          builderAttemptId: 'builder-1',
          finalRepairAttemptId: 'repair-1',
          verificationEvidenceId: 'verification-1',
          reviewEvidenceId: 'review-1'
        })
      })
    });
    environments.push({ environment, worker });
    const client = new Client({ connection: environment.client.connection });
    const result = await worker.runUntil(
      client.workflow.execute(runTemporalSpikeWorkflow, {
        taskQueue: 'temporal-spike-test',
        workflowId: 'forge-run:run-1',
        args: [{ runId: 'run-1', scenario: 'build-review-repair-integrate' }]
      })
    );
    expect(result).toEqual({ runId: 'run-1', scenario: 'build-review-repair-integrate' });
  }, 15_000);

  it('returns immediately for blocked-repair-restart-resume scenario without calling activities', async () => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    let activityCalled = false;
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'temporal-spike-test-blocked',
      workflowsPath: fileURLToPath(new URL('./temporal-spike-workflow.ts', import.meta.url)),
      activities: createTemporalSpikeActivities({
        runBuildReviewRepairIntegrate: async () => {
          activityCalled = true;
          return {
            builderAttemptId: 'builder-1',
            finalRepairAttemptId: 'repair-1',
            verificationEvidenceId: 'verification-1',
            reviewEvidenceId: 'review-1'
          };
        }
      })
    });
    environments.push({ environment, worker });
    const client = new Client({ connection: environment.client.connection });
    const result = await worker.runUntil(
      client.workflow.execute(runTemporalSpikeWorkflow, {
        taskQueue: 'temporal-spike-test-blocked',
        workflowId: 'forge-run:run-blocked',
        args: [{ runId: 'run-blocked', scenario: 'blocked-repair-restart-resume' }]
      })
    );
    expect(result).toEqual({ runId: 'run-blocked', scenario: 'blocked-repair-restart-resume' });
    expect(activityCalled).toBe(false);
  }, 15_000);
});
