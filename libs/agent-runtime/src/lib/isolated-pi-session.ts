import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { stdin, stdout } from 'node:process';
import { PiCodingAgentGateway, type PiSessionGateway, type PiToolResult } from './pi-gateway.js';
import { AuthStorage, ModelRegistry, createAgentSession } from '@mariozechner/pi-coding-agent';
import { createAssistantMessageEventStream, type Context } from '@mariozechner/pi-ai';
import { isolatedPiModel, parseIsolatedAssistant } from './pi-model-proxy.js';
import {
  parsePiToolCall,
  piSessionFrameLimit,
  protocolObject,
  protocolText
} from './pi-session-protocol.js';

/** Image entrypoint adapter. The deployment supplies its explicit approved-model
 * PiCodingAgentGateway; model/auth configuration is not accepted from task input.
 * Protocol stdout must not be shared with provider diagnostics (use stderr).
 */
export const runIsolatedPiSession = async (
  gateway: PiSessionGateway | undefined,
  streams: { readonly input: Readable; readonly output: Writable } = {
    input: stdin,
    output: stdout
  }
): Promise<void> => {
  const lines = createInterface({ input: streams.input, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  const receive = async (): Promise<Record<string, unknown>> => {
    const next = await iterator.next();
    if (next.done || Buffer.byteLength(next.value) > piSessionFrameLimit) {
      throw new Error('Isolated Pi broker closed or exceeded its frame limit');
    }
    return protocolObject(JSON.parse(next.value));
  };
  const send = (message: unknown) => {
    const frame = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(frame) > piSessionFrameLimit) {
      throw new Error('Isolated Pi request exceeds its frame limit');
    }
    streams.output.write(frame);
  };
  let requestId = 0;
  let exchange = Promise.resolve();
  const request = async (type: 'tool' | 'model', value: unknown) => {
    let response: Record<string, unknown> | undefined;
    const pending = exchange.then(async () => {
      const id = String(++requestId);
      send({ type, id, ...(type === 'tool' ? { call: value } : { context: value }) });
      const result = await receive();
      if (result.type !== `${type}-result` || result.id !== id) {
        throw new Error('Isolated Pi response identity differs');
      }
      response = result;
    });
    exchange = pending;
    await pending;
    if (response === undefined) {
      throw new Error('Missing isolated Pi response');
    }
    return response;
  };
  const modelGateway = () =>
    new PiCodingAgentGateway(
      async (options) => {
        const authStorage = AuthStorage.inMemory();
        // Public local routing marker, not a provider credential. No file/env auth lookup.
        authStorage.setRuntimeApiKey(isolatedPiModel.provider, 'forge-broker-routing-marker');
        options.settingsManager?.setCompactionEnabled(false);
        options.settingsManager?.setRetryEnabled(false);
        const { session } = await createAgentSession({
          ...options,
          model: isolatedPiModel,
          authStorage,
          modelRegistry: ModelRegistry.inMemory(authStorage)
        });
        session.agent.streamFn = (_model, context: Context) => {
          const stream = createAssistantMessageEventStream();
          void request('model', context)
            .then((response) => {
              const message = parseIsolatedAssistant(response.message);
              stream.push({ type: 'start', partial: message });
              if (
                message.stopReason !== 'stop' &&
                message.stopReason !== 'length' &&
                message.stopReason !== 'toolUse'
              ) {
                throw new Error('Invalid host model result');
              }
              stream.push({ type: 'done', reason: message.stopReason, message });
              stream.end(message);
            })
            .catch(() => {
              const message = {
                role: 'assistant' as const,
                api: isolatedPiModel.api,
                provider: isolatedPiModel.provider,
                model: isolatedPiModel.id,
                content: [],
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
                },
                stopReason: 'error' as const,
                errorMessage: 'Host model broker failed',
                timestamp: Date.now()
              };
              stream.push({ type: 'error', reason: 'error', error: message });
              stream.end(message);
            });
          return stream;
        };
        return {
          session: {
            sessionId: session.sessionId,
            setActiveToolsByName: (names) => session.setActiveToolsByName(names),
            prompt: async (prompt) => {
              await session.prompt(prompt);
              const last = session.agent.state.messages.at(-1);
              if (
                last?.role === 'assistant' &&
                (last.stopReason === 'error' || last.stopReason === 'aborted')
              ) {
                throw new Error('Host-proxied Pi inference did not complete');
              }
            },
            abort: () => session.abort()
          }
        };
      },
      { model: isolatedPiModel }
    );
  try {
    const start = await receive();
    if (start.type !== 'start' || !Array.isArray(start.tools)) {
      throw new Error('Invalid isolated Pi start request');
    }
    const tools = start.tools.map((name: unknown) => {
      // Validate names through the same closed tool union without task code.
      switch (name) {
        case 'forge_read':
        case 'forge_list':
        case 'forge_find':
        case 'forge_edit':
        case 'forge_write':
        case 'forge_command':
          return name;
        default:
          throw new Error('Unknown isolated Pi tool');
      }
    });
    const session = await (gateway ?? modelGateway()).start({
      cwd: '/tmp',
      prompt: protocolText(start.prompt),
      tools,
      onStarted: async (sessionId) => {
        send({ type: 'started', sessionId });
        if ((await receive()).type !== 'started-ack') {
          throw new Error('Isolated Pi session was not durably acknowledged');
        }
      },
      executeTool: async (call): Promise<PiToolResult> => {
        // SDK tool parallelism is serialized over the single broker channel.
        let result: PiToolResult | undefined;
        {
          const response = await request('tool', parsePiToolCall(call));
          const value = protocolObject(response.result);
          if (
            typeof value.content !== 'string' ||
            (value.isError !== undefined && typeof value.isError !== 'boolean')
          ) {
            throw new Error('Invalid isolated Pi tool result');
          }
          result = {
            content: value.content,
            ...(value.isError === undefined ? {} : { isError: value.isError })
          };
        }
        if (result === undefined) {
          throw new Error('Missing isolated Pi tool result');
        }
        return result;
      }
    });
    await exchange;
    send({ type: 'completed', sessionId: session.sessionId });
  } finally {
    lines.close();
  }
};
