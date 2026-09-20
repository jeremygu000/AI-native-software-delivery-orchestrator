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
