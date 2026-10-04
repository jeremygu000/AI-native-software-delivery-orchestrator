import type { ResolvedModelExecutionTarget } from '@ai-native-software-delivery-orchestrator/domain';
import type { Model, Api } from '@mariozechner/pi-ai';
import {
  ApiModelExecutionAdapter,
  GitHubCopilotExecutionAdapter,
  CodexSubscriptionExecutionAdapter,
  type ModelExecutionProvider
} from './model-execution-provider.js';
import { AuthStorage, ModelRegistry } from '@mariozechner/pi-coding-agent';
import { PiCodeReviewModelResolver } from './pi-task-code-reviewer.js';
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

/** Validated first-class deployment profiles; UI metadata stays beside provider resolution. */
export const forgeModelProfiles = [
  {
    provider: 'github-copilot',
    displayName: 'GitHub Copilot',
    model: 'gpt-6.1-sol',
    reasoningEffort: 'medium',
    authMode: 'subscription'
  },
  {
    provider: 'openai-codex',
    displayName: 'OpenAI Codex',
    model: 'gpt-6.1-sol',
    reasoningEffort: 'medium',
    authMode: 'subscription'
  },
  {
    provider: 'deepseek',
    displayName: 'DeepSeek',
    model: 'deepseek-flash',
    reasoningEffort: 'high',
    authMode: 'api-key'
  }
] as const;

export type ForgeModelSelection = {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort: ResolvedModelExecutionTarget['reasoningConfig']['effort'];
};

/** Uses the pinned catalogue only, with no editor, CLI or SDK filesystem auth discovery. */
export const createForgeModelResolver = (): PiCodeReviewModelResolver =>
  new PiCodeReviewModelResolver(ModelRegistry.inMemory(AuthStorage.inMemory()));

export const resolveForgeModelSelection = (
  selection: ForgeModelSelection,
  environment: NodeJS.ProcessEnv = process.env
): ResolvedModelExecutionTarget => {
  const model = createForgeModelResolver().resolve({
    provider: selection.provider,
    id: selection.model
  });
  if (model === undefined) {
    throw new Error('Selected model is unavailable');
  }
  const execution = resolveSubscriptionExecution(model, {
    ...environment,
    FORGE_MODEL_REASONING_EFFORT: selection.reasoningEffort
  });
  if (execution !== undefined) {
    return execution.target;
  }
  // The existing DeepSeek planner/worker transport is validated at high only.
  if (model.provider !== 'deepseek' || selection.reasoningEffort !== 'high') {
    throw new Error('Selected API execution profile is not validated');
  }
  return new ApiModelExecutionAdapter({
    model,
    credential: async () => environment.FORGE_MODEL_API_KEY ?? ''
  }).resolve(model.id, selection.reasoningEffort);
};

export const inspectForgeModelAuthentication = async (
  provider: string,
  environment: NodeJS.ProcessEnv = process.env
): Promise<'ready' | 'not-configured' | 'invalid'> => {
  const profile = forgeModelProfiles.find((candidate) => candidate.provider === provider);
  if (profile === undefined) {
    throw new Error('Unsupported Forge model provider');
  }
  if (profile.authMode === 'api-key') {
    return (environment.FORGE_MODEL_API_KEY ?? '').trim().length > 0 ? 'ready' : 'not-configured';
  }
  const directory = environment.FORGE_SUBSCRIPTION_AUTH_DIRECTORY;
  if (directory === undefined) {
    return 'not-configured';
  }
  try {
    await new FileSubscriptionCredentialStore(directory).hasCredentials(provider);
    return 'ready';
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
      ? 'not-configured'
      : 'invalid';
  }
};
