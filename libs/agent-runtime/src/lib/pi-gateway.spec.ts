import { describe, expect, it, vi } from 'vitest';

import {
  createControlledPiTools,
  PiCodingAgentGateway,
  type PiSessionFactory
} from './pi-gateway.js';

const executePiToolDefinition = <T>(
  tool: {
    execute: (
      id: string,
      params: T,
      signal: AbortSignal | undefined,
      onUpdate: undefined,
      context: never
    ) => unknown;
  },
  id: string,
  params: T
) => tool.execute(id, params, undefined, undefined, undefined!);

describe('PiCodingAgentGateway', () => {
  it('maps each controlled Pi tool to the provider-neutral tool call', async () => {
    const executeTool = vi.fn(async (call) => ({ content: JSON.stringify(call) }));
    const [read, list, find, edit, write] = createControlledPiTools(executeTool);

    await expect(executePiToolDefinition(read, 'tool-1', { path: 'value.txt' })).resolves.toEqual({
      content: [{ type: 'text', text: '{"name":"forge_read","path":"value.txt"}' }],
      details: {}
    });
    await expect(executePiToolDefinition(list, 'tool-2', {})).resolves.toEqual({
      content: [{ type: 'text', text: '{"name":"forge_list"}' }],
      details: {}
    });
    await expect(
      executePiToolDefinition(find, 'tool-3', { path: 'value.txt', text: 'before' })
    ).resolves.toEqual({
      content: [{ type: 'text', text: '{"name":"forge_find","path":"value.txt","text":"before"}' }],
      details: {}
    });
    await expect(
      executePiToolDefinition(edit, 'tool-4', {
        path: 'value.txt',
        expected: 'before',
        replacement: 'after'
      })
    ).resolves.toEqual({
      content: [
        {
          type: 'text',
          text: '{"name":"forge_edit","path":"value.txt","expected":"before","replacement":"after"}'
        }
      ],
      details: {}
    });
    await expect(
      executePiToolDefinition(write, 'tool-5', { path: 'value.txt', content: 'after' })
    ).resolves.toEqual({
      content: [
        { type: 'text', text: '{"name":"forge_write","path":"value.txt","content":"after"}' }
      ],
      details: {}
    });
    expect(executeTool).toHaveBeenNthCalledWith(1, { name: 'forge_read', path: 'value.txt' });
    expect(executeTool).toHaveBeenNthCalledWith(2, { name: 'forge_list' });
    expect(executeTool).toHaveBeenNthCalledWith(3, {
      name: 'forge_find',
      path: 'value.txt',
      text: 'before'
    });
    expect(executeTool).toHaveBeenNthCalledWith(4, {
      name: 'forge_edit',
      path: 'value.txt',
      expected: 'before',
      replacement: 'after'
    });
    expect(executeTool).toHaveBeenNthCalledWith(5, {
      name: 'forge_write',
      path: 'value.txt',
      content: 'after'
    });
  });

  it('preserves controlled tool errors for Pi', async () => {
    const [read] = createControlledPiTools(async () => ({
      content: 'Blocked by policy',
      isError: true
    }));

    await expect(executePiToolDefinition(read, 'tool-1', { path: 'value.txt' })).resolves.toEqual({
      content: [{ type: 'text', text: 'Blocked by policy' }],
      details: {},
      isError: true
    });
  });

  it('disables built-ins and establishes the session before prompting', async () => {
    const activeTools = vi.fn();
    const prompt = vi.fn(async () => {});
    let options: Parameters<PiSessionFactory>[0] | undefined;
    const createSession: PiSessionFactory = async (receivedOptions) => {
      options = receivedOptions;
      return { session: { sessionId: 'pi-session-1', setActiveToolsByName: activeTools, prompt } };
    };
    const started: string[] = [];
    const gateway = new PiCodingAgentGateway(createSession);

    await expect(
      gateway.start({
        cwd: '/workspace',
        prompt: 'Change value',
        tools: ['forge_read', 'forge_list', 'forge_find', 'forge_edit', 'forge_write'],
        executeTool: async () => ({ content: 'unused' }),
        onStarted: async (sessionId) => {
          started.push(sessionId);
        }
      })
    ).resolves.toEqual({ sessionId: 'pi-session-1' });

    expect(options).toMatchObject({
      cwd: '/workspace',
      noTools: 'all',
      customTools: expect.arrayContaining([
        expect.objectContaining({ name: 'forge_read' }),
        expect.objectContaining({ name: 'forge_edit' }),
        expect.objectContaining({ name: 'forge_write' })
      ])
    });
    expect(started).toEqual(['pi-session-1']);
    expect(activeTools).toHaveBeenCalledWith([
      'forge_read',
      'forge_list',
      'forge_find',
      'forge_edit',
      'forge_write'
    ]);
    expect(prompt).toHaveBeenCalledWith('Change value');
  });

  it('does not prompt when durable session establishment rejects', async () => {
    const activeTools = vi.fn();
    const prompt = vi.fn(async () => {});
    const createSession: PiSessionFactory = async () => ({
      session: { sessionId: 'pi-session-1', setActiveToolsByName: activeTools, prompt }
    });
    const gateway = new PiCodingAgentGateway(createSession);

    await expect(
      gateway.start({
        cwd: '/workspace',
        prompt: 'Change value',
        tools: ['forge_read'],
        executeTool: async () => ({ content: 'unused' }),
        onStarted: async () => {
          throw new Error('Attempt persistence failed.');
        }
      })
    ).rejects.toThrow('Attempt persistence failed.');
    expect(prompt).not.toHaveBeenCalled();
  });
});
