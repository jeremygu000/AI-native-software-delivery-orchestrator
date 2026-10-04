import { NativeConnection, Worker, type WorkerOptions } from '@temporalio/worker';
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
    /** Deployment-owned tracing plugins; disabled by default. */
    plugins?: WorkerOptions['plugins'];
    onStartup?: (stage: 'connecting' | 'bundling' | 'created') => void;
  }
): Promise<TemporalWorkerHandle> {
  options?.onStartup?.('connecting');
  const connection = await NativeConnection.connect({
    address: new URL(config.serverUrl).host
  });

  if (options?.forgeActivities === undefined) {
    throw new Error('createTemporalWorker requires forgeActivities for the Scenario A workflow');
  }

  options?.onStartup?.('bundling');
  const worker = await Worker.create({
    connection,
    namespace: config.namespace,
    taskQueue: config.taskQueue,
    workflowsPath: options?.workflowsPath ?? getWorkflowsPath(),
    activities: options.forgeActivities,
    ...(options.plugins === undefined ? {} : { plugins: options.plugins })
  });
  options?.onStartup?.('created');

  let shutdownRequested = false;

  return {
    worker,
    async run() {
      await worker.run();
    },
    async shutdown() {
      if (shutdownRequested) {
        return;
      }
      shutdownRequested = true;
      worker.shutdown();
    }
  };
}
