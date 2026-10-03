import { describe, expect, it, vi } from 'vitest';
import { type AssistantMessage } from '@mariozechner/pi-ai';
import { createModelExecutionTarget } from '@ai-native-software-delivery-orchestrator/domain';
import { ApprovedPiHostModelProxy, isolatedPiModel } from './pi-model-proxy.js';
import { modelExecutionStream } from './model-execution-stream.js';
import type { ResolvedSubscriptionExecution } from './model-execution-deployment.js';

const target = createModelExecutionTarget({
  version: 1,
  providerId: 'openai-codex',
  providerKind: 'subscription',
  modelId: 'test',
  reasoningConfig: { effort: 'high' },
  toolCapabilities: { functionCalling: true, textOnly: true },
  contextLimits: { inputTokens: 32768, outputTokens: 4096 },
  adapterVersion: 'test',
  transport: 'openai-codex-responses'
});
const message: AssistantMessage = {
  role: 'assistant',
  api: 'openai-codex-responses',
  provider: 'openai-codex',
  model: 'test',
  timestamp: 1,
  content: [{ type: 'text', text: 'done', textSignature: 'host-only-responses-continuation' }],
  stopReason: 'stop',
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  }
};
const execution = (
  complete: ResolvedSubscriptionExecution['provider']['complete']
): ResolvedSubscriptionExecution => ({
  target,
  provider: {
    providerId: target.providerId,
    auth: { kind: 'subscription-session' },
    resolve: () => target,
    complete
  }
});

describe('Unified execution in SDK and isolated broker', () => {
  it('retains provider continuation signatures only in host memory across tool turns', async () => {
    const complete = vi.fn(async (_target, context) => {
      if (context.messages.length !== 0) {
        expect(context.messages[0]).toEqual(message);
      }
      return message;
    });
    const proxy = new ApprovedPiHostModelProxy({
      model: { ...isolatedPiModel, provider: target.providerId, id: target.modelId },
      execution: execution(complete)
    });
    const signal = new AbortController().signal;
    const isolated = await proxy.complete({ messages: [], tools: [] }, [], signal);
    expect(JSON.stringify(isolated)).not.toContain('host-only-responses-continuation');
    await proxy.complete({ messages: [isolated], tools: [] }, [], signal);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(
      () => new ApprovedPiHostModelProxy({ model: isolatedPiModel, execution: execution(complete) })
    ).toThrow('differ');
  });
  it('uses the same execution contract for planning SDK completion and sanitizes failures', async () => {
    const signal = new AbortController().signal;
    const stream = modelExecutionStream(
      execution(async (_target, _context, passedSignal) => {
        expect(passedSignal).toBe(signal);
        return message;
      })
    )(isolatedPiModel, { messages: [] }, { signal });
    expect(await stream.result()).toEqual(message);
    const failed = modelExecutionStream(
      execution(async () => {
        throw new Error('private-refresh-token');
      })
    )(isolatedPiModel, { messages: [] });
    expect(await failed.result()).toMatchObject({
      stopReason: 'error',
      errorMessage: 'Approved model execution failed'
    });
    const abort = new AbortController();
    abort.abort();
    const cancelled = modelExecutionStream(
      execution(async () => {
        throw new Error('provider body');
      })
    )(isolatedPiModel, { messages: [] }, { signal: abort.signal });
    expect(await cancelled.result()).toMatchObject({ stopReason: 'aborted' });
    const providerError = modelExecutionStream(
      execution(async () => ({
        ...message,
        stopReason: 'error',
        errorMessage: 'sanitized provider error'
      }))
    )(isolatedPiModel, { messages: [] });
    expect(await providerError.result()).toMatchObject({ stopReason: 'error' });
  });
});
