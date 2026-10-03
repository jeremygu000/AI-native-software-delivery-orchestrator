import { getModels, type Api, type Model } from '@mariozechner/pi-ai';

/** Explicit deployment descriptor for a live model absent from the pinned SDK catalogue. */
export const resolveSubscriptionModel = (provider: string, id: string): Model<Api> | undefined => {
  if (provider !== 'github-copilot' && provider !== 'openai-codex') {
    return undefined;
  }
  if (id === 'gpt-6.1-sol') {
    // Copilot's live catalogue advertises 272k prompt tokens and Responses/tool support.
    // Keep the same conservative application budget for Codex; this is not a quota estimate.
    return {
      id,
      name: 'GPT-6.1 Sol',
      provider,
      api: provider === 'github-copilot' ? 'openai-responses' : 'openai-codex-responses',
      baseUrl:
        provider === 'github-copilot'
          ? 'https://api.individual.githubcopilot.com'
          : 'https://chatgpt.com/backend-api',
      ...(provider === 'github-copilot'
        ? {
            headers: {
              'User-Agent': 'GitHubCopilotChat/0.35.0',
              'Editor-Version': 'vscode/1.107.0',
              'Editor-Plugin-Version': 'copilot-chat/0.35.0',
              'Copilot-Integration-Id': 'vscode-chat'
            }
          }
        : {}),
      reasoning: true,
      input: ['text'],
      contextWindow: 272_000,
      maxTokens: 4096,
      // Subscription billing is not represented by API price estimates.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    };
  }
  return getModels(provider).find((model) => model.id === id);
};
