import { describe, expect, it } from 'vitest';
import {
  forgeRunWorkflowId,
  requestForgeRunCancellation,
  type TemporalCancellationClientFactory
} from './client.js';

describe('Temporal operational client', () => {
  it('uses the stable Forge workflow identity', () => {
    expect(forgeRunWorkflowId('run-1')).toBe('forge-run:run-1');
  });

  it('cancels the Forge workflow and closes the client', async () => {
    const calls: string[] = [];
    const createClient: TemporalCancellationClientFactory = async (config) => {
      expect(config.namespace).toBe('forge');
      return {
        client: {
          workflow: {
            getHandle(workflowId) {
              calls.push(`handle:${workflowId}`);
              return {
                async cancel() {
                  calls.push('cancel');
                }
              };
            }
          }
        },
        async close() {
          calls.push('close');
        }
      };
    };

    await requestForgeRunCancellation(
      {
        namespace: 'forge',
        taskQueue: 'forge-run',
        serverUrl: 'http://localhost:7233',
        connectTimeoutMs: 10_000,
        workerShutdownTimeoutMs: 30_000
      },
      'run-1',
      createClient
    );

    expect(calls).toEqual(['handle:forge-run:run-1', 'cancel', 'close']);
  });
});
