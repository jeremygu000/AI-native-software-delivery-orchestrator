import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { stdin, stdout } from 'node:process';
import type { PiSessionGateway, PiToolResult } from './pi-gateway.js';
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
  gateway: PiSessionGateway,
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
    const session = await gateway.start({
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
        const pending = exchange.then(async () => {
          const id = String(++requestId);
          send({ type: 'tool', id, call: parsePiToolCall(call) });
          const response = await receive();
          if (response.type !== 'tool-result' || response.id !== id) {
            throw new Error('Isolated Pi tool response identity differs');
          }
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
        });
        exchange = pending;
        await pending;
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
