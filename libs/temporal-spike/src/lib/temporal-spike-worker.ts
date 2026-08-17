import { NativeConnection, type WorkerOptions, Worker } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';

import { createTemporalSpikeActivities } from './temporal-spike-activities.js';
import type { TemporalSpikeConfiguration } from './temporal-spike-driver.js';

/** Creates, but does not run, an isolated M2 Temporal worker. */
export const createTemporalSpikeWorker = async (configuration: TemporalSpikeConfiguration) => {
  const connection = await NativeConnection.connect({ address: configuration.address });
  return Worker.create({
    connection,
    namespace: configuration.namespace,
    taskQueue: configuration.taskQueue,
    workflowsPath: fileURLToPath(new URL('./temporal-spike-workflow.js', import.meta.url)),
    activities: createTemporalSpikeActivities()
  });
};

export const createTemporalSpikeWorkerOptions = (request: {
  readonly taskQueue: string;
  readonly workflowsPath: string;
}): WorkerOptions => ({
  taskQueue: request.taskQueue,
  workflowsPath: request.workflowsPath,
  activities: createTemporalSpikeActivities()
});
