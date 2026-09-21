import { describe, expect, it, vi } from 'vitest';

import {
  createControlledPiTools,
  PiCodingAgentGateway,
  PiSessionCancellationConfirmedError,
  type PiSessionModel,
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
    const [read, list, find, edit, write, command] = createControlledPiTools(executeTool);

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
    await expect(
      executePiToolDefinition(command, 'tool-6', { commandId: 'check-types' })
    ).resolves.toEqual({
      content: [{ type: 'text', text: '{"name":"forge_command","commandId":"check-types"}' }],
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
    expect(executeTool).toHaveBeenNthCalledWith(6, {
      name: 'forge_command',
      commandId: 'check-types'
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
    const abort = vi.fn(async () => {});
    let options: Parameters<PiSessionFactory>[0] | undefined;
    const createSession: PiSessionFactory = async (receivedOptions) => {
      options = receivedOptions;
      return {
        session: { sessionId: 'pi-session-1', setActiveToolsByName: activeTools, prompt, abort }
      };
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
      noTools: 'builtin',
      tools: ['forge_read', 'forge_list', 'forge_find', 'forge_edit', 'forge_write'],
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

  it('binds an explicitly approved model to the coding session', async () => {
    const model: PiSessionModel = {
      provider: 'openai',
      id: 'gpt-4.1',
      name: 'GPT-4.1',
      api: 'openai-completions',
      baseUrl: 'https://api.openai.com/v1',
      reasoning: false,
      input: ['text'],
      contextWindow: 1,
      maxTokens: 1,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    };
    const createSession = vi.fn(async () => ({
      session: {
        sessionId: 'pi-session-1',
        setActiveToolsByName: () => undefined,
        prompt: async () => undefined,
        abort: async () => undefined
      }
    }));

    await new PiCodingAgentGateway(createSession, { model }).start({
      cwd: '/workspace',
      prompt: 'Change value',
      tools: ['forge_read'],
      executeTool: async () => ({ content: 'unused' }),
      onStarted: async () => undefined
    });

    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ model }));
  });

  it('does not prompt when durable session establishment rejects', async () => {
    const activeTools = vi.fn();
    const prompt = vi.fn(async () => {});
    const abort = vi.fn(async () => {});
    const createSession: PiSessionFactory = async () => ({
      session: { sessionId: 'pi-session-1', setActiveToolsByName: activeTools, prompt, abort }
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

  it('aborts the Pi session when the owning activity is cancelled', async () => {
    const activeTools = vi.fn();
    const prompt = vi.fn(async () => {});
    const abort = vi.fn(async () => {});
    const controller = new AbortController();
    const gateway = new PiCodingAgentGateway(async () => ({
      session: { sessionId: 'pi-session-1', setActiveToolsByName: activeTools, prompt, abort }
    }));

    await expect(
      gateway.start({
        cwd: '/workspace',
        prompt: 'Change value',
        tools: ['forge_read'],
        executeTool: async () => ({ content: 'unused' }),
        onStarted: async () => {
          controller.abort();
        },
        cancellationSignal: controller.signal
      })
    ).rejects.toBeInstanceOf(PiSessionCancellationConfirmedError);

    expect(abort).toHaveBeenCalledOnce();
    expect(prompt).not.toHaveBeenCalled();
  });

  it('propagates a provider abort failure instead of confirming cancellation', async () => {
    const controller = new AbortController();
    const abort = vi.fn(async () => {
      throw new Error('Pi abort failed.');
    });
    const prompt = vi.fn(async () => {
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 0));
      throw new Error('Pi prompt interrupted.');
    });
    const gateway = new PiCodingAgentGateway(async () => ({
      session: {
        sessionId: 'pi-session-1',
        setActiveToolsByName: vi.fn(),
        prompt,
        abort
      }
    }));

    await expect(
      gateway.start({
        cwd: '/workspace',
        prompt: 'Change value',
        tools: ['forge_read'],
        executeTool: async () => ({ content: 'unused' }),
        onStarted: async () => {},
        cancellationSignal: controller.signal
      })
    ).rejects.toThrow('Pi abort failed.');
    expect(abort).toHaveBeenCalledOnce();
  });

  it('propagates an abort failure when prompt completion wins the cancellation race', async () => {
    const controller = new AbortController();
    let rejectAbort!: (error: Error) => void;
    let resolveAbortStarted!: () => void;
    const abortStarted = new Promise<void>((resolve) => {
      resolveAbortStarted = resolve;
    });
    const abort = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectAbort = reject;
          resolveAbortStarted();
        })
    );
    const prompt = vi.fn(async () => {
      controller.abort();
    });
    const gateway = new PiCodingAgentGateway(async () => ({
      session: {
        sessionId: 'pi-session-1',
        setActiveToolsByName: vi.fn(),
        prompt,
        abort
      }
    }));

    const start = gateway.start({
      cwd: '/workspace',
      prompt: 'Change value',
      tools: ['forge_read'],
      executeTool: async () => ({ content: 'unused' }),
      onStarted: async () => {},
      cancellationSignal: controller.signal
    });
    await abortStarted;
    rejectAbort(new Error('Pi abort failed after prompt completion.'));

    await expect(start).rejects.toThrow('Pi abort failed after prompt completion.');
    expect(abort).toHaveBeenCalledOnce();
  });
});
