import { createAssistantMessageEventStream, type StreamFunction } from '@mariozechner/pi-ai';
import type { ResolvedSubscriptionExecution } from './model-execution-deployment.js';

/** Adapts the host execution contract to the SDK without opening any tool executor. */
export const modelExecutionStream =
  (execution: ResolvedSubscriptionExecution): StreamFunction =>
  (_model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const signal = options?.signal ?? new AbortController().signal;
    void execution.provider
      .complete(execution.target, context, signal)
      .then((message) => {
        if (message.stopReason === 'error' || message.stopReason === 'aborted') {
          stream.push({ type: 'error', reason: message.stopReason, error: message });
        } else {
          stream.push({ type: 'done', reason: message.stopReason, message });
        }
        stream.end(message);
      })
      .catch(() => {
        const message = {
          role: 'assistant' as const,
          api: execution.target.transport,
          provider: execution.target.providerId,
          model: execution.target.modelId,
          content: [],
          timestamp: Date.now(),
          stopReason: signal.aborted ? ('aborted' as const) : ('error' as const),
          errorMessage: 'Approved model execution failed',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          }
        };
        stream.push({ type: 'error', reason: message.stopReason, error: message });
        stream.end(message);
      });
    return stream;
  };
