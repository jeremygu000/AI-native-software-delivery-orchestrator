import { Client, Connection } from '@temporalio/client';
import type { TemporalConfig } from './config.js';

export interface TemporalClientHandle {
  readonly client: Client;
  readonly connection: Connection;
  close(): Promise<void>;
}

export const forgeRunWorkflowId = (runId: string): string => `forge-run:${runId}`;

export interface TemporalCancellationClientHandle {
  readonly client: {
    readonly workflow: {
      getHandle(workflowId: string): { cancel(): Promise<unknown> };
    };
  };
  close(): Promise<void>;
}

export type TemporalCancellationClientFactory = (
  config: TemporalConfig
) => Promise<TemporalCancellationClientHandle>;

export interface TemporalLaunchClientHandle {
  readonly client: {
    readonly workflow: {
      start(
        workflowType: string,
        options: {
          readonly workflowId: string;
          readonly taskQueue: string;
          readonly args: readonly [{ readonly runId: string }];
          readonly workflowIdConflictPolicy: 'USE_EXISTING';
        }
      ): Promise<{ readonly workflowId: string; readonly firstExecutionRunId: string }>;
    };
  };
  close(): Promise<void>;
}

export type TemporalLaunchClientFactory = (
  config: TemporalConfig
) => Promise<TemporalLaunchClientHandle>;

export interface ForgeRunLaunchHandle {
  readonly workflowId: string;
  readonly workflowRunId: string;
}

export async function startForgeRun(
  config: TemporalConfig,
  runId: string,
  createClient: TemporalLaunchClientFactory = createTemporalClient
): Promise<ForgeRunLaunchHandle> {
  const handle = await createClient(config);
  try {
    const workflow = await handle.client.workflow.start('forgeRunWorkflow', {
      workflowId: forgeRunWorkflowId(runId),
      taskQueue: config.taskQueue,
      args: [{ runId }],
      workflowIdConflictPolicy: 'USE_EXISTING'
    });
    return { workflowId: workflow.workflowId, workflowRunId: workflow.firstExecutionRunId };
  } finally {
    await handle.close();
  }
}

export async function requestForgeRunCancellation(
  config: TemporalConfig,
  runId: string,
  createClient: TemporalCancellationClientFactory = createTemporalClient
): Promise<void> {
  const handle = await createClient(config);
  try {
    await handle.client.workflow.getHandle(forgeRunWorkflowId(runId)).cancel();
  } finally {
    await handle.close();
  }
}

export async function createTemporalClient(config: TemporalConfig): Promise<TemporalClientHandle> {
  const connection = await Connection.connect({
    address: new URL(config.serverUrl).host,
    connectTimeout: config.connectTimeoutMs
  });

  const client = new Client({
    connection,
    namespace: config.namespace
  });

  return {
    client,
    connection,
    async close() {
      await connection.close();
    }
  };
}
