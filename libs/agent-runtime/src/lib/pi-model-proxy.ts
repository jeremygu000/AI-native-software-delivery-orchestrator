import {
  completeSimple,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type Api
} from '@mariozechner/pi-ai';
import { createControlledPiTools, type PiToolCall } from './pi-gateway.js';
import { protocolObject, protocolText } from './pi-session-protocol.js';

/** Public routing identity only. It contains no provider endpoint or credential. */
export const isolatedPiModel: Model<'openai-completions'> = {
  api: 'openai-completions',
  provider: 'forge-host-proxy',
  id: 'approved-host-model',
  name: 'Approved host model',
  baseUrl: 'http://invalid.invalid',
  reasoning: false,
  input: ['text'],
  contextWindow: 32768,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
};

const number = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('Invalid isolated model numeric field');
  }
  return value;
};
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) {
    throw new Error('Invalid isolated model content');
  }
  return value;
};
const textContent = (value: unknown) => {
  const item = protocolObject(value);
  if (item.type !== 'text' || typeof item.text !== 'string') {
    throw new Error('Isolated model supports text content only');
  }
  return { type: 'text' as const, text: item.text };
};
export const parseIsolatedAssistant = (value: unknown): AssistantMessage => {
  const item = protocolObject(value);
  if (
    item.role !== 'assistant' ||
    !['stop', 'length', 'toolUse'].includes(String(item.stopReason))
  ) {
    throw new Error('Invalid isolated model response');
  }
  const stopReason = item.stopReason;
  if (stopReason !== 'stop' && stopReason !== 'length' && stopReason !== 'toolUse') {
    throw new Error('Invalid isolated model stop reason');
  }
  const usage = protocolObject(item.usage);
  const cost = protocolObject(usage.cost);
  return {
    role: 'assistant',
    api: isolatedPiModel.api,
    provider: isolatedPiModel.provider,
    model: isolatedPiModel.id,
    timestamp: number(item.timestamp),
    stopReason,
    content: array(item.content).map((entry) => {
      const content = protocolObject(entry);
      if (content.type === 'toolCall') {
        return {
          type: 'toolCall' as const,
          id: protocolText(content.id),
          name: protocolText(content.name),
          arguments: protocolObject(content.arguments)
        };
      }
      if (content.type === 'thinking' && typeof content.thinking === 'string') {
        return { type: 'thinking' as const, thinking: content.thinking };
      }
      return textContent(content);
    }),
    usage: {
      input: number(usage.input),
      output: number(usage.output),
      cacheRead: number(usage.cacheRead),
      cacheWrite: number(usage.cacheWrite),
      totalTokens: number(usage.totalTokens),
      cost: {
        input: number(cost.input),
        output: number(cost.output),
        cacheRead: number(cost.cacheRead),
        cacheWrite: number(cost.cacheWrite),
        total: number(cost.total)
      }
    }
  };
};

const parseMessage = (value: unknown): Message => {
  const item = protocolObject(value);
  if (item.role === 'assistant') {
    return parseIsolatedAssistant(item);
  }
  if (item.role === 'user') {
    return {
      role: 'user',
      timestamp: number(item.timestamp),
      content:
        typeof item.content === 'string' ? item.content : array(item.content).map(textContent)
    };
  }
  if (item.role === 'toolResult' && typeof item.isError === 'boolean') {
    return {
      role: 'toolResult',
      toolCallId: protocolText(item.toolCallId),
      toolName: protocolText(item.toolName),
      isError: item.isError,
      timestamp: number(item.timestamp),
      content: array(item.content).map(textContent)
    };
  }
  throw new Error('Invalid isolated model message');
};

export interface PiHostModelProxy {
  complete(
    context: unknown,
    tools: readonly PiToolCall['name'][],
    signal: AbortSignal
  ): Promise<AssistantMessage>;
}

/** Deployment configuration fixes the model, credential and budgets. The container
 * supplies conversation content, never a URL, key, header, provider or options. */
export class ApprovedPiHostModelProxy implements PiHostModelProxy {
  constructor(
    private readonly configuration: {
      readonly model: Model<Api>;
      readonly apiKey: string;
      readonly maxTokens?: number;
      readonly complete?: typeof completeSimple;
    }
  ) {
    if (configuration.apiKey.length === 0) {
      throw new Error('Approved host model requires a credential');
    }
  }

  async complete(
    value: unknown,
    enabled: readonly PiToolCall['name'][],
    signal: AbortSignal
  ): Promise<AssistantMessage> {
    const item = protocolObject(value);
    if (
      Object.keys(item).some((key) => !['systemPrompt', 'messages', 'tools'].includes(key)) ||
      (item.systemPrompt !== undefined && typeof item.systemPrompt !== 'string')
    ) {
      throw new Error('Isolated model context cannot select provider options');
    }
    const names = array(item.tools ?? []).map((tool) => protocolText(protocolObject(tool).name));
    if (
      new Set(names).size !== names.length ||
      names.some((name) => !enabled.some((allowed) => allowed === name))
    ) {
      throw new Error('Isolated model requested an unapproved tool');
    }
    const context: Context = {
      ...(item.systemPrompt === undefined ? {} : { systemPrompt: item.systemPrompt }),
      messages: array(item.messages)
        .map(parseMessage)
        .map((message) =>
          message.role === 'assistant'
            ? {
                ...message,
                api: this.configuration.model.api,
                provider: this.configuration.model.provider,
                model: this.configuration.model.id
              }
            : message
        ),
      tools: createControlledPiTools(async () => {
        throw new Error('Model inference cannot execute a tool');
      })
        .filter((tool) => names.includes(tool.name))
        .map(({ name, description, parameters }) => ({ name, description, parameters }))
    };
    const response = await (this.configuration.complete ?? completeSimple)(
      this.configuration.model,
      context,
      {
        apiKey: this.configuration.apiKey,
        signal,
        maxTokens: this.configuration.maxTokens ?? 4096,
        maxRetries: 0,
        timeoutMs: 60_000
      }
    );
    // Never forward provider diagnostics/error bodies or credential-bearing metadata.
    return parseIsolatedAssistant(response);
  }
}
