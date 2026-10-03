import { describe, expect, it, vi } from 'vitest';
import {
  createModelExecutionTarget,
  resolvedModelExecutionTargetSchema
} from '@ai-native-software-delivery-orchestrator/domain';
import { type AssistantMessage, type Model } from '@mariozechner/pi-ai';
import type { OAuthCredentials, OAuthProviderInterface } from '@mariozechner/pi-ai/oauth';
import {
  SubscriptionModelExecutionAdapter,
  GitHubCopilotExecutionAdapter,
  CodexSubscriptionExecutionAdapter,
  ApiModelExecutionAdapter,
  type SubscriptionCredentialStore
} from './model-execution-provider.js';
import { resolveSubscriptionModel } from './subscription-model-catalog.js';

const model = (provider: string, id = 'test'): Model<'openai-completions'> => ({
  api: 'openai-completions',
  provider,
  id,
  name: id,
  baseUrl: 'https://deployment.invalid',
  reasoning: true,
  input: ['text'],
  contextWindow: 32768,
  maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
});
const reply = (provider: string): AssistantMessage => ({
  role: 'assistant',
  api: 'openai-completions',
  provider,
  model: 'test',
  content: [{ type: 'text', text: 'done' }],
  stopReason: 'stop',
  timestamp: 1,
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  }
});
const credentials = (): SubscriptionCredentialStore => {
  let value: OAuthCredentials = {
    access: 'private-access',
    refresh: 'private-refresh',
    expires: Date.now() + 600_000
  };
  return {
    load: async () => value,
    save: async (_id, updated) => {
      value = updated;
    },
    withLock: async (_id, work) => work()
  };
};

describe('Subscription model execution', () => {
  it.each(['github-copilot', 'openai-codex'])(
    'resolves the explicit GPT-6.1 Sol medium profile independently for %s',
    (provider) => {
      const adapter =
        provider === 'github-copilot'
          ? new GitHubCopilotExecutionAdapter(credentials())
          : new CodexSubscriptionExecutionAdapter(credentials());
      const target = adapter.resolve('gpt-6.1-sol', 'medium');
      const descriptor = resolveSubscriptionModel(provider, 'gpt-6.1-sol');
      expect(descriptor?.id).toBe('gpt-6.1-sol');
      expect(descriptor?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(descriptor?.baseUrl).toBe(
        provider === 'github-copilot'
          ? 'https://api.individual.githubcopilot.com'
          : 'https://chatgpt.com/backend-api'
      );
      if (provider === 'github-copilot') {
        expect(descriptor?.headers?.['Copilot-Integration-Id']).toBe('vscode-chat');
      }
      expect(target).toMatchObject({
        providerId: provider,
        modelId: 'gpt-6.1-sol',
        reasoningConfig: { effort: 'medium' },
        transport: provider === 'github-copilot' ? 'openai-responses' : 'openai-codex-responses',
        contextLimits: { inputTokens: 272000, outputTokens: 4096 }
      });
      expect(target.executionProfileFingerprint).not.toBe(
        adapter.resolve('gpt-6.1-sol', 'high').executionProfileFingerprint
      );
    }
  );
  it('keeps API and local execution behind the same profile contract without subscription coupling', async () => {
    const api = new ApiModelExecutionAdapter({
      model: model('deepseek'),
      credential: async () => 'host-api-key',
      complete: async (_model, _context, options) => {
        expect(options?.apiKey).toBe('host-api-key');
        return reply('deepseek');
      }
    });
    expect(api.auth.kind).toBe('api-key');
    await api.complete(api.resolve('test', 'high'), { messages: [] }, new AbortController().signal);
    const local = new ApiModelExecutionAdapter({
      model: model('ollama'),
      local: true,
      complete: async (_model, _context, options) => {
        expect(options?.apiKey).toBe('forge-local-no-credential');
        return reply('ollama');
      }
    });
    expect(local.resolve('test', 'off').providerKind).toBe('local');
    await local.complete(
      local.resolve('test', 'off'),
      { messages: [] },
      new AbortController().signal
    );
    expect(() => new ApiModelExecutionAdapter({ model: model('deepseek') })).toThrow('credential');
    expect(() => api.resolve('other', 'off')).toThrow('differs');
    const broken = new ApiModelExecutionAdapter({
      model: model('openai'),
      credential: async () => {
        throw new Error('secret');
      }
    });
    await expect(
      broken.complete(broken.resolve('test', 'off'), { messages: [] }, new AbortController().signal)
    ).rejects.toThrow('API model execution failed');
  });
  it.each(['github-copilot', 'openai-codex'])(
    'uses the independent %s adapter with host-only OAuth credentials',
    async (id) => {
      const store = credentials();
      const complete = vi.fn(async (selected, _context, options) => {
        expect(selected.provider).toBe(id);
        expect(options.apiKey).toBe('private-access');
        expect(options.reasoning).toBe('high');
        expect(options.transport).toBe('sse');
        return reply(id);
      });
      const adapter =
        id === 'github-copilot'
          ? new GitHubCopilotExecutionAdapter(store, { resolveModel: model, complete })
          : new CodexSubscriptionExecutionAdapter(store, { resolveModel: model, complete });
      const target = adapter.resolve('test', 'high');
      expect(target.providerKind).toBe('subscription');
      expect(JSON.stringify(target)).not.toMatch(/private-access|private-refresh|apiKey|accountId/);
      await adapter.complete(target, { messages: [] }, new AbortController().signal);
      expect(complete).toHaveBeenCalledOnce();
      await expect(
        adapter.complete(
          { ...target, providerId: 'other' },
          { messages: [] },
          new AbortController().signal
        )
      ).rejects.toThrow('fingerprint differs');
    }
  );

  it('single-flights refresh and persists rotated credentials before any inference', async () => {
    const store = credentials();
    await store.save('test', { access: 'expired', refresh: 'refresh', expires: 1 });
    const refresh = vi.fn(async () => ({
      access: 'rotated',
      refresh: 'next-refresh',
      expires: Date.now() + 600_000
    }));
    const oauth: OAuthProviderInterface = {
      id: 'test',
      name: 'test',
      login: async () => {
        throw new Error('never login during execution');
      },
      refreshToken: refresh,
      getApiKey: (record) => record.access
    };
    const adapter = new SubscriptionModelExecutionAdapter({
      oauth,
      credentials: store,
      resolveModel: model,
      complete: async (_model, _context, options) => {
        expect(options?.apiKey).toBe('rotated');
        expect((await store.load('test')).access).toBe('rotated');
        return reply('test');
      }
    });
    const target = adapter.resolve('test', 'high');
    await Promise.all([
      adapter.complete(target, { messages: [] }, new AbortController().signal),
      adapter.complete(target, { messages: [] }, new AbortController().signal)
    ]);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('rejects tampered profiles, unsupported reasoning, aborts and sanitized refresh failures', async () => {
    const store = credentials();
    await store.save('test', { access: 'expired', refresh: 'private-refresh', expires: 1 });
    const oauth: OAuthProviderInterface = {
      id: 'test',
      name: 'test',
      login: async () => {
        throw new Error('unused');
      },
      refreshToken: async () => {
        throw new Error('private-refresh leaked upstream');
      },
      getApiKey: (record) => record.access
    };
    const adapter = new SubscriptionModelExecutionAdapter({
      oauth,
      credentials: store,
      resolveModel: model
    });
    const target = adapter.resolve('test', 'high');
    expect(() =>
      resolvedModelExecutionTargetSchema.parse({ ...target, modelId: 'changed' })
    ).toThrow();
    await expect(
      adapter.complete(target, { messages: [] }, new AbortController().signal)
    ).rejects.toThrow('Subscription model execution failed');
    const abort = new AbortController();
    abort.abort();
    await expect(adapter.complete(target, { messages: [] }, abort.signal)).rejects.toThrow(
      'aborted'
    );
    const noReasoning = new SubscriptionModelExecutionAdapter({
      oauth,
      credentials: store,
      resolveModel: (provider, id) => ({ ...model(provider, id), reasoning: false })
    });
    expect(() => noReasoning.resolve('test', 'high')).toThrow('reasoning');
    const { executionProfileFingerprint: _fingerprint, ...profile } = target;
    const direct = createModelExecutionTarget({ ...profile, providerKind: 'direct-api' });
    expect(direct.executionProfileFingerprint).not.toBe(target.executionProfileFingerprint);
  });
});
