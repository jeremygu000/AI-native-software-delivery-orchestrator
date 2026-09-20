import type {
  BootstrapInput,
  BootstrapResult
} from '@ai-native-software-delivery-orchestrator/forge-runtime-contracts';

export async function bootstrap(input: BootstrapInput): Promise<BootstrapResult> {
  return { runId: input.runId, status: 'bootstrapped' };
}
