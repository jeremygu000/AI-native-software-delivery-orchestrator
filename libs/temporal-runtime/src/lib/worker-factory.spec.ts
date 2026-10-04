import type { ForgeActivities } from '@ai-native-software-delivery-orchestrator/forge-runtime-contracts';
import { describe, expect, it, vi } from 'vitest';

import { resolveTemporalConfig } from './config.js';
import { createTemporalWorker, getWorkflowsPath } from './worker-factory.js';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(async () => ({ id: 'connection' })),
  create: vi.fn(async () => ({ run: vi.fn(async () => {}), shutdown: vi.fn() }))
}));

vi.mock('@temporalio/worker', () => ({
  NativeConnection: { connect: mocks.connect },
  Worker: { create: mocks.create }
}));

const activities: ForgeActivities = {
  async reevaluateRun() {
    throw new Error('not invoked');
  },
  async executeBuilder() {
    throw new Error('not invoked');
  },
  async evaluateBuilderOutput() {
    throw new Error('not invoked');
  },
  async admitRepair() {
    throw new Error('not invoked');
  },
  async executeRepair() {
    throw new Error('not invoked');
  },
  async integrateAcceptedOutput() {
    throw new Error('not invoked');
  },
  async finalizeRunState() {
    throw new Error('not invoked');
  },
  async resumeBlockedRepair() {
    throw new Error('not invoked');
  }
};

describe('createTemporalWorker', () => {
  it('requires activities and refuses to create a worker without them', async () => {
    mocks.create.mockClear();
    await expect(createTemporalWorker(resolveTemporalConfig())).rejects.toThrow(
      'requires forgeActivities'
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('passes explicit workflow and activity configuration and shuts down once', async () => {
    mocks.create.mockClear();
    const config = resolveTemporalConfig({ serverUrl: 'http://localhost:7233' });
    const startup: string[] = [];
    const handle = await createTemporalWorker(config, {
      onStartup: (stage) => startup.push(stage),
      workflowsPath: '/workspace/workflow.js',
      forgeActivities: activities
    });
    expect(startup).toEqual(['connecting', 'bundling', 'created']);

    expect(mocks.connect).toHaveBeenCalledWith({ address: 'localhost:7233' });
    expect(mocks.create).toHaveBeenCalledWith({
      connection: { id: 'connection' },
      namespace: config.namespace,
      taskQueue: config.taskQueue,
      workflowsPath: '/workspace/workflow.js',
      activities
    });
    await handle.run();
    await handle.shutdown();
    await handle.shutdown();
    const worker = await mocks.create.mock.results.at(-1)?.value;
    expect(worker?.run).toHaveBeenCalledOnce();
    expect(worker?.shutdown).toHaveBeenCalledOnce();
  });

  it('resolves its default workflow path from the module instead of the process cwd', async () => {
    mocks.create.mockClear();
    await createTemporalWorker(resolveTemporalConfig(), { forgeActivities: activities });
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ workflowsPath: getWorkflowsPath() })
    );
    expect(getWorkflowsPath()).toMatch(/workflows\/forge-run\.js$/);
  });
});
