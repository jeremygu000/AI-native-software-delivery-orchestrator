import { Client, Connection } from '@temporalio/client';
import type { TemporalConfig } from './config.js';

export interface TemporalClientHandle {
  readonly client: Client;
  readonly connection: Connection;
  close(): Promise<void>;
}

export async function createTemporalClient(
  config: TemporalConfig,
): Promise<TemporalClientHandle> {
  const connection = await Connection.connect({
    address: new URL(config.serverUrl).host,
    connectTimeout: config.connectTimeoutMs,
  });

  const client = new Client({
    connection,
    namespace: config.namespace,
  });

  return {
    client,
    connection,
    async close() {
      await connection.close();
    },
  };
}
