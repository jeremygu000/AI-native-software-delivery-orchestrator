import type { BootstrapInput, BootstrapResult } from '../contracts.js';

export async function bootstrap(input: BootstrapInput): Promise<BootstrapResult> {
  return { runId: input.runId, status: 'bootstrapped' };
}
