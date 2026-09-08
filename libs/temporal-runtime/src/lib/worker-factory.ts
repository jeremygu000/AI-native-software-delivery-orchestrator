import { NativeConnection, Worker } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import type { TemporalConfig } from './config.js';

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
  options?: { workflowsPath?: string; activities?: Record<string, (...args: unknown[]) => Promise<unknown>> },
): Promise<TemporalWorkerHandle> {
  const connection = await NativeConnection.connect({
    address: new URL(config.serverUrl).host,
  });

  const { bootstrap } = await import('./activities/index.js');
  const activities = options?.activities ?? { bootstrap };

  const worker = await Worker.create({
    connection,
    namespace: config.namespace,
    taskQueue: config.taskQueue,
    workflowsPath: options?.workflowsPath ?? getWorkflowsPath(),
    activities,
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
      worker.shutdown();
    },
  };
}
