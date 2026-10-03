import type { ResolvedModelExecutionTarget } from '@ai-native-software-delivery-orchestrator/domain';
import type { Model, Api } from '@mariozechner/pi-ai';
import {
  GitHubCopilotExecutionAdapter,
  CodexSubscriptionExecutionAdapter,
  type ModelExecutionProvider
} from './model-execution-provider.js';
import { FileSubscriptionCredentialStore } from './subscription-credential-store.js';

export const isSubscriptionProvider = (provider: string): boolean =>
  ['github-copilot', 'openai-codex'].includes(provider);
export interface ResolvedSubscriptionExecution {
  readonly provider: ModelExecutionProvider;
  readonly target: ResolvedModelExecutionTarget;
}
export const resolveSubscriptionExecution = (
  model: Model<Api>,
  environment: NodeJS.ProcessEnv = process.env
): ResolvedSubscriptionExecution | undefined => {
  if (!isSubscriptionProvider(model.provider)) {
    return undefined;
  }
  const directory = environment.FORGE_SUBSCRIPTION_AUTH_DIRECTORY;
  if (directory === undefined) {
    throw new Error('Subscription provider requires FORGE_SUBSCRIPTION_AUTH_DIRECTORY');
  }
  const store = new FileSubscriptionCredentialStore(directory);
  const provider =
    model.provider === 'github-copilot'
      ? new GitHubCopilotExecutionAdapter(store)
      : new CodexSubscriptionExecutionAdapter(store);
  const effort = environment.FORGE_MODEL_REASONING_EFFORT ?? (model.reasoning ? 'high' : 'off');
  if (
    effort !== 'off' &&
    effort !== 'minimal' &&
    effort !== 'low' &&
    effort !== 'medium' &&
    effort !== 'high' &&
    effort !== 'xhigh'
  ) {
    throw new Error('Unsupported model reasoning effort');
  }
  return { provider, target: provider.resolve(model.id, effort) };
};
