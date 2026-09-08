import { Client } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterEach, describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  forgeRunWorkflow,
  bootstrap,
  BootstrapInputSchema,
  ForgeRunResultSchema,
} from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../../..');
const WORKFLOWS_PATH = resolve(
  PROJECT_ROOT,
  'libs/temporal-runtime/dist/lib/workflows/forge-run.js',
);

describe('temporal-runtime workflow bootstrap', () => {
  it('starts ForgeRunWorkflow and returns compact result', async () => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'temporal-runtime-test-bootstrap',
      workflowsPath: WORKFLOWS_PATH,
      activities: { bootstrap },
    });

    const runId = `run-bootstrap-${Date.now()}`;
    const client = new Client({ connection: environment.client.connection });

    const workerPromise = worker.run();
    try {
      const handle = await client.workflow.start(forgeRunWorkflow, {
        taskQueue: 'temporal-runtime-test-bootstrap',
        args: [{ runId }],
        workflowId: `workflow-${runId}`,
      });

      const result = await handle.result();
      expect(result).toEqual({ runId, status: 'completed' });
    } finally {
      worker.shutdown();
      await workerPromise;
      await environment.teardown();
    }
  });
});

describe('temporal-runtime worker lifecycle', () => {
  it('creates worker, runs, and shuts down gracefully', async () => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'temporal-runtime-test-lifecycle',
      workflowsPath: WORKFLOWS_PATH,
      activities: { bootstrap },
    });

    const workerPromise = worker.run();

    worker.shutdown();
    await workerPromise;

    expect(worker.getState()).toBe('STOPPED');
    await environment.teardown();
  });
});

describe('temporal-runtime payload boundary', () => {
  it('BootstrapInputSchema accepts only compact IDs', () => {
    const result = BootstrapInputSchema.safeParse({ runId: 'run-123' });
    expect(result.success).toBe(true);
  });

  it('BootstrapInputSchema rejects empty runId', () => {
    expect(BootstrapInputSchema.safeParse({ runId: '' }).success).toBe(false);
  });

  it('BootstrapInputSchema rejects missing runId', () => {
    expect(BootstrapInputSchema.safeParse({}).success).toBe(false);
  });

  it('ForgeRunResultSchema accepts only compact status enum', () => {
    expect(ForgeRunResultSchema.safeParse({ runId: 'r1', status: 'completed' }).success).toBe(
      true,
    );
    expect(ForgeRunResultSchema.safeParse({ runId: 'r1', status: 'failed' }).success).toBe(true);
    expect(ForgeRunResultSchema.safeParse({ runId: 'r1', status: 'unknown' }).success).toBe(
      false,
    );
  });
});
