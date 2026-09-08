import { NativeConnection, Worker } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import type { TemporalConfig } from './config.js';
import type { ForgeActivities } from './activities/forge-activities.js';

export interface TemporalWorkerHandle {
  readonly worker: Worker;
  run(): Promise<void>;
  shutdown(): Promise<void>;
}

export function getWorkflowsPath(): string {
  return fileURLToPath(new URL('./workflows/forge-run.js', import.meta.url));
}

export async function createTemporalWorker(
  config: TemporalConfig,
  options?: {
    workflowsPath?: string;
    /** Forge Scenario A activities implementation. */
    forgeActivities?: ForgeActivities;
  },
): Promise<TemporalWorkerHandle> {
  const connection = await NativeConnection.connect({
    address: new URL(config.serverUrl).host,
  });

  if (options?.forgeActivities === undefined) {
    throw new Error('createTemporalWorker requires forgeActivities for the Scenario A workflow');
  }

  const worker = await Worker.create({
    connection,
    namespace: config.namespace,
    taskQueue: config.taskQueue,
    workflowsPath: options?.workflowsPath ?? getWorkflowsPath(),
    activities: options.forgeActivities,
  });

  let shutdownRequested = false;

  return {
    worker,
    async run() {
      await worker.run();
    },
    async shutdown() {
      if (shutdownRequested) return;
      shutdownRequested = true;
      await worker.shutdown();
    },
  };
}
