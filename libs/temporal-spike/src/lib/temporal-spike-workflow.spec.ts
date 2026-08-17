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
      activities: createTemporalSpikeActivities()
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
});
