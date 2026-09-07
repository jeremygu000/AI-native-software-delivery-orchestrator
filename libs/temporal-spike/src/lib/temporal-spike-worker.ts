import { NativeConnection, type WorkerOptions, Worker } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';

import { createTemporalSpikeActivities } from './temporal-spike-activities.js';
import { createStubTemporalSpikeScenarioService } from './stub-scenario-service.js';
import type { TemporalSpikeConfiguration } from './temporal-spike-driver.js';
import type { DurableExecutionScenarioService } from '@ai-native-software-delivery-orchestrator/orchestration-runtime';

export const createTemporalSpikeWorker = async (
  configuration: TemporalSpikeConfiguration,
  service?: DurableExecutionScenarioService
) => {
  const connection = await NativeConnection.connect({ address: configuration.address });
  return Worker.create({
    connection,
    namespace: configuration.namespace,
    taskQueue: configuration.taskQueue,
    workflowsPath: fileURLToPath(new URL('./temporal-spike-workflow.js', import.meta.url)),
    activities: createTemporalSpikeActivities(service ?? createStubTemporalSpikeScenarioService())
  });
};

export const createTemporalSpikeWorkerOptions = (request: {
  readonly taskQueue: string;
  readonly workflowsPath: string;
  readonly service?: DurableExecutionScenarioService;
}): WorkerOptions => ({
  taskQueue: request.taskQueue,
  workflowsPath: request.workflowsPath,
  activities: createTemporalSpikeActivities(
    request.service ?? createStubTemporalSpikeScenarioService()
  )
});
