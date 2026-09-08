import { proxyActivities } from '@temporalio/workflow';
import type { BootstrapInput, ForgeRunResult } from '../contracts.js';

const { bootstrap } = proxyActivities<{
  bootstrap(input: BootstrapInput): Promise<{ runId: string; status: 'bootstrapped' }>;
}>({ startToCloseTimeout: '30 seconds' });

export async function forgeRunWorkflow(input: BootstrapInput): Promise<ForgeRunResult> {
  const result = await bootstrap(input);
  return { runId: result.runId, status: 'completed' };
}
