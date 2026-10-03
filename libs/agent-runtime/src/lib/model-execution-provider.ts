import {
  createModelExecutionTarget,
  resolvedModelExecutionTargetSchema,
  type ResolvedModelExecutionTarget,
  type ProviderAuth
} from '@ai-native-software-delivery-orchestrator/domain';
import {
  completeSimple,
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type Context,
  type AssistantMessage
} from '@mariozechner/pi-ai';
import {
  githubCopilotOAuthProvider,
  openaiCodexOAuthProvider,
  type OAuthCredentials,
  type OAuthProviderInterface
} from '@mariozechner/pi-ai/oauth';
import { parseSubscriptionCredentials } from './subscription-credential-store.js';
import { resolveSubscriptionModel } from './subscription-model-catalog.js';

export interface SubscriptionCredentialStore {
  load(providerId: string): Promise<OAuthCredentials>;
  save(providerId: string, credentials: OAuthCredentials): Promise<void>;
  withLock<T>(providerId: string, work: () => Promise<T>): Promise<T>;
}

export interface ModelExecutionProvider {
  readonly providerId: string;
  readonly auth: ProviderAuth;
  resolve(
    modelId: string,
    effort: ResolvedModelExecutionTarget['reasoningConfig']['effort']
  ): ResolvedModelExecutionTarget;
  complete(
    target: ResolvedModelExecutionTarget,
    context: Context,
    signal: AbortSignal
  ): Promise<AssistantMessage>;
}

export class SubscriptionModelExecutionAdapter implements ModelExecutionProvider {
  readonly auth: ProviderAuth = { kind: 'subscription-session' };
  readonly providerId: string;
  #refresh: Promise<OAuthCredentials> | undefined;

  constructor(
    private readonly configuration: {
      oauth: OAuthProviderInterface;
      credentials: SubscriptionCredentialStore;
      resolveModel?: (provider: string, id: string) => Model<Api>;
      complete?: typeof completeSimple;
      now?: () => number;
    }
  ) {
    this.providerId = configuration.oauth.id;
  }

  private model(id: string): Model<Api> {
    const model =
      this.configuration.resolveModel?.(this.providerId, id) ??
      resolveSubscriptionModel(this.providerId, id);
    if (model === undefined || model.provider !== this.providerId || model.id !== id) {
      throw new Error('Subscription model identity differs');
    }
    return model;
  }

  resolve(
    modelId: string,
    effort: ResolvedModelExecutionTarget['reasoningConfig']['effort']
  ): ResolvedModelExecutionTarget {
    const model = this.model(modelId);
    if (!model.reasoning && effort !== 'off') {
      throw new Error('Model does not support requested reasoning');
    }
    if (!getSupportedThinkingLevels(model).includes(effort)) {
      throw new Error('Model does not support requested reasoning effort');
    }
    return createModelExecutionTarget({
      version: 1,
      providerId: this.providerId,
      providerKind: 'subscription',
      modelId,
      reasoningConfig: { effort },
      toolCapabilities: { functionCalling: true, textOnly: true },
      contextLimits: {
        inputTokens: model.contextWindow,
        outputTokens: Math.min(model.maxTokens, 4096)
      },
      adapterVersion: 'pi-ai-0.73.1-subscription-v1',
      transport: model.api
    });
  }

  private async credential(): Promise<OAuthCredentials> {
    const cached = parseSubscriptionCredentials(
      await this.configuration.credentials.load(this.providerId)
    );
    if (cached.expires > (this.configuration.now?.() ?? Date.now()) + 60_000) {
      return cached;
    }
    this.#refresh ??= this.configuration.credentials
      .withLock(this.providerId, async () => {
        const current = parseSubscriptionCredentials(
          await this.configuration.credentials.load(this.providerId)
        );
        if (current.expires > (this.configuration.now?.() ?? Date.now()) + 60_000) {
          return current;
        }
        const updated = parseSubscriptionCredentials(
          await this.configuration.oauth.refreshToken(current)
        );
        await this.configuration.credentials.save(this.providerId, updated);
        return updated;
      })
      .finally(() => {
        this.#refresh = undefined;
      });
    return this.#refresh;
  }

  async complete(
    target: ResolvedModelExecutionTarget,
    context: Context,
    signal: AbortSignal
  ): Promise<AssistantMessage> {
    if (signal.aborted) {
      throw new Error('Model execution aborted');
    }
    resolvedModelExecutionTargetSchema.parse(target);
    const expected = this.resolve(target.modelId, target.reasoningConfig.effort);
    if (
      expected.executionProfileFingerprint !== target.executionProfileFingerprint ||
      target.providerId !== this.providerId
    ) {
      throw new Error('Approved subscription execution profile differs');
    }
    try {
      const credentials = await this.credential();
      const model =
        this.configuration.oauth.modifyModels?.([this.model(target.modelId)], credentials)[0] ??
        this.model(target.modelId);
      if (
        model.provider !== this.providerId ||
        model.id !== target.modelId ||
        model.api !== target.transport
      ) {
        throw new Error('Subscription transport changed approved model identity');
      }
      const apiKey = this.configuration.oauth.getApiKey(credentials);
      if (apiKey.trim().length === 0 || signal.aborted) {
        throw new Error('Subscription credential unavailable');
      }
      const response = await (this.configuration.complete ?? completeSimple)(model, context, {
        apiKey,
        signal,
        maxTokens: target.contextLimits.outputTokens,
        ...(target.reasoningConfig.effort === 'off'
          ? {}
          : { reasoning: target.reasoningConfig.effort }),
        transport: 'sse',
        maxRetries: 0,
        timeoutMs: 60_000
      });
      if (response.stopReason === 'error' || response.stopReason === 'aborted') {
        throw new Error('Subscription provider did not complete');
      }
      return response;
    } catch {
      throw new Error(
        signal.aborted ? 'Model execution aborted' : 'Subscription model execution failed'
      );
    }
  }
}

/** The same execution contract also supports API credentials and credential-free local gateways. */
export class ApiModelExecutionAdapter implements ModelExecutionProvider {
  readonly providerId: string;
  readonly auth: ProviderAuth;
  constructor(
    private readonly configuration: {
      model: Model<Api>;
      credential?: () => Promise<string>;
      local?: boolean;
      complete?: typeof completeSimple;
    }
  ) {
    this.providerId = configuration.model.provider;
    this.auth = configuration.local === true ? { kind: 'local' } : { kind: 'api-key' };
    if (configuration.local !== true && configuration.credential === undefined) {
      throw new Error('API execution requires an explicit credential resolver');
    }
  }
  resolve(
    modelId: string,
    effort: ResolvedModelExecutionTarget['reasoningConfig']['effort']
  ): ResolvedModelExecutionTarget {
    const model = this.configuration.model;
    if (modelId !== model.id || (!model.reasoning && effort !== 'off')) {
      throw new Error('API execution model or reasoning differs');
    }
    return createModelExecutionTarget({
      version: 1,
      providerId: model.provider,
      providerKind: this.configuration.local === true ? 'local' : 'direct-api',
      modelId,
      reasoningConfig: { effort },
      toolCapabilities: { functionCalling: true, textOnly: true },
      contextLimits: {
        inputTokens: model.contextWindow,
        outputTokens: Math.min(model.maxTokens, 4096)
      },
      adapterVersion: 'pi-ai-0.73.1-api-v1',
      transport: model.api
    });
  }
  async complete(
    target: ResolvedModelExecutionTarget,
    context: Context,
    signal: AbortSignal
  ): Promise<AssistantMessage> {
    resolvedModelExecutionTargetSchema.parse(target);
    if (
      target.providerId !== this.providerId ||
      target.executionProfileFingerprint !==
        this.resolve(target.modelId, target.reasoningConfig.effort).executionProfileFingerprint ||
      signal.aborted
    ) {
      throw new Error('Approved API execution target differs or is aborted');
    }
    try {
      const apiKey = (await this.configuration.credential?.()) ?? 'forge-local-no-credential';
      if (apiKey.trim().length === 0 || signal.aborted) {
        throw new Error('API execution credential unavailable');
      }
      return await (this.configuration.complete ?? completeSimple)(
        this.configuration.model,
        context,
        {
          apiKey,
          signal,
          maxTokens: target.contextLimits.outputTokens,
          ...(target.reasoningConfig.effort === 'off'
            ? {}
            : { reasoning: target.reasoningConfig.effort }),
          maxRetries: 0,
          timeoutMs: 60_000
        }
      );
    } catch {
      throw new Error(signal.aborted ? 'Model execution aborted' : 'API model execution failed');
    }
  }
}

/** Independent adapters: Codex never routes through GitHub or Copilot. */
export class GitHubCopilotExecutionAdapter extends SubscriptionModelExecutionAdapter {
  constructor(
    credentials: SubscriptionCredentialStore,
    overrides: {
      complete?: typeof completeSimple;
      resolveModel?: (provider: string, id: string) => Model<Api>;
    } = {}
  ) {
    super({ oauth: githubCopilotOAuthProvider, credentials, ...overrides });
  }
}
export class CodexSubscriptionExecutionAdapter extends SubscriptionModelExecutionAdapter {
  constructor(
    credentials: SubscriptionCredentialStore,
    overrides: {
      complete?: typeof completeSimple;
      resolveModel?: (provider: string, id: string) => Model<Api>;
    } = {}
  ) {
    super({ oauth: openaiCodexOAuthProvider, credentials, ...overrides });
  }
}
