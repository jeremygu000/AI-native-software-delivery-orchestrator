import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';
import { runIsolatedPiSession } from './isolated-pi-session.js';
import { parsePiToolCall } from './pi-session-protocol.js';
import type { AssistantMessage } from '@mariozechner/pi-ai';

const modelReply = (tool: boolean): AssistantMessage => ({
  role: 'assistant',
  api: 'openai-completions',
  provider: 'forge-host-proxy',
  model: 'approved-host-model',
  content: tool
    ? [
        {
          type: 'toolCall',
          id: 'call-1',
          name: 'forge_write',
          arguments: { path: 'value.txt', content: 'model edit' }
        }
      ]
    : [{ type: 'text', text: 'Done' }],
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  },
  stopReason: tool ? 'toolUse' : 'stop',
  timestamp: Date.now()
});

describe('isolated Pi image adapter', () => {
  it('runs a real Pi SDK session using host model replies and brokered writes', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const broker = createInterface({ input: output });
    const events: string[] = [];
    let models = 0;
    broker.on('line', (line) => {
      const message = JSON.parse(line);
      events.push(message.type);
      if (message.type === 'started') {
        input.write('{"type":"started-ack"}\n');
      }
      if (message.type === 'model') {
        models++;
        expect(message.context.tools.map((tool: { name: string }) => tool.name)).toEqual([
          'forge_write'
        ]);
        expect(JSON.stringify(message)).not.toContain('apiKey');
        input.write(
          `${JSON.stringify({ type: 'model-result', id: message.id, message: modelReply(models === 1) })}\n`
        );
      }
      if (message.type === 'tool') {
        expect(message.call).toEqual({
          name: 'forge_write',
          path: 'value.txt',
          content: 'model edit'
        });
        input.write(
          `${JSON.stringify({ type: 'tool-result', id: message.id, result: { content: 'Written' } })}\n`
        );
      }
    });
    input.write('{"type":"start","prompt":"Edit through Forge","tools":["forge_write"]}\n');
    try {
      await runIsolatedPiSession(undefined, { input, output });
      expect(events).toEqual(['started', 'model', 'tool', 'model', 'completed']);
    } finally {
      broker.close();
      input.destroy();
      output.destroy();
    }
  });
  it('waits for durable acknowledgement and serializes concurrent tool exchanges', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const events: string[] = [];
    const broker = createInterface({ input: output });
    broker.on('line', (line) => {
      const message = JSON.parse(line);
      events.push(message.type);
      if (message.type === 'started') {
        input.write(`${JSON.stringify({ type: 'started-ack' })}\n`);
      } else if (message.type === 'tool') {
        input.write(
          `${JSON.stringify({ type: 'tool-result', id: message.id, result: { content: message.call.path, isError: false } })}\n`
        );
      }
    });
    input.write(
      `${JSON.stringify({ type: 'start', prompt: 'Approved', tools: ['forge_read'] })}\n`
    );
    try {
      await runIsolatedPiSession(
        {
          start: async (request) => {
            expect(request.cwd).toBe('/tmp');
            expect(request.prompt).toBe('Approved');
            await request.onStarted('session');
            events.push('prompt');
            expect(
              await Promise.all([
                request.executeTool({ name: 'forge_read', path: 'a' }),
                request.executeTool({ name: 'forge_read', path: 'b' })
              ])
            ).toEqual([
              { content: 'a', isError: false },
              { content: 'b', isError: false }
            ]);
            return { sessionId: 'session' };
          }
        },
        { input, output }
      );
      expect(events).toEqual(['started', 'prompt', 'tool', 'tool', 'completed']);
    } finally {
      broker.close();
      input.destroy();
      output.destroy();
    }
  });

  it.each([
    { type: 'start', prompt: 'x', tools: ['bash'] },
    { type: 'start', prompt: '', tools: ['forge_read'] },
    { type: 'other', prompt: 'x', tools: [] }
  ])('rejects unapproved start input before creating a session', async (message) => {
    const input = new PassThrough();
    const output = new PassThrough();
    input.end(`${JSON.stringify(message)}\n`);
    try {
      await expect(
        runIsolatedPiSession(
          {
            start: async () => {
              throw new Error('must not launch');
            }
          },
          { input, output }
        )
      ).rejects.not.toThrow('must not launch');
    } finally {
      input.destroy();
      output.destroy();
    }
  });

  it('rejects a forged durable acknowledgement before executing prompt tools', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    input.end(
      `${JSON.stringify({ type: 'start', prompt: 'x', tools: [] })}\n${JSON.stringify({ type: 'wrong' })}\n`
    );
    try {
      await expect(
        runIsolatedPiSession(
          {
            start: async (request) => {
              await request.onStarted('session');
              throw new Error('must not prompt');
            }
          },
          { input, output }
        )
      ).rejects.toThrow('not durably acknowledged');
    } finally {
      input.destroy();
      output.destroy();
    }
  });

  it('accepts only the closed Forge tool union with correctly typed arguments', () => {
    expect(parsePiToolCall({ name: 'forge_list' })).toEqual({ name: 'forge_list' });
    expect(parsePiToolCall({ name: 'forge_find', path: 'a', text: 'x' }).name).toBe('forge_find');
    expect(
      parsePiToolCall({ name: 'forge_edit', path: 'a', expected: 'x', replacement: '' }).name
    ).toBe('forge_edit');
    expect(parsePiToolCall({ name: 'forge_write', path: 'a', content: '' }).name).toBe(
      'forge_write'
    );
    expect(parsePiToolCall({ name: 'forge_command', commandId: 'check' }).name).toBe(
      'forge_command'
    );
    for (const value of [
      null,
      [],
      { name: 'bash' },
      { name: 'forge_read', path: '' },
      { name: 'forge_write', path: 'a', content: 1 },
      { name: 'forge_edit', path: 'a', expected: 'x', replacement: false }
    ]) {
      expect(() => parsePiToolCall(value)).toThrow();
    }
  });
});
