import { describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ create: vi.fn(), active: vi.fn(), prompt: vi.fn() }));
vi.mock('@mariozechner/pi-coding-agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mariozechner/pi-coding-agent')>()),
  createAgentSession: sdk.create
}));
import { PiCodingAgentGateway } from './pi-gateway.js';

describe('default Pi SDK session adapter', () => {
  it('forwards configuration and waits for establishment before using the SDK session', async () => {
    const calls: string[] = [];
    sdk.create.mockResolvedValue({
      session: { sessionId: 'sdk-session', setActiveToolsByName: sdk.active, prompt: sdk.prompt }
    });
    sdk.prompt.mockImplementation(async (prompt: string) => {
      calls.push(prompt);
    });
    await expect(
      new PiCodingAgentGateway().start({
        cwd: '/workspace',
        prompt: 'Implement the approved task',
        tools: ['forge_read'],
        executeTool: async () => ({ content: 'unused' }),
        onStarted: async (id) => {
          calls.push(`started:${id}`);
        }
      })
    ).resolves.toEqual({ sessionId: 'sdk-session' });
    expect(sdk.create).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/workspace', noTools: 'builtin', tools: ['forge_read'] })
    );
    expect(sdk.active).toHaveBeenLastCalledWith(['forge_read']);
    expect(calls).toEqual(['started:sdk-session', 'Implement the approved task']);
  });

  it('propagates SDK creation and prompt errors without claiming session completion', async () => {
    const options = {
      cwd: '/workspace',
      prompt: 'Task',
      tools: [] as const,
      executeTool: async () => ({ content: 'unused' }),
      onStarted: vi.fn(async () => {})
    };
    sdk.create.mockRejectedValueOnce(new Error('SDK creation failed'));
    await expect(new PiCodingAgentGateway().start(options)).rejects.toThrow('SDK creation failed');
    expect(options.onStarted).not.toHaveBeenCalled();
    sdk.create.mockResolvedValueOnce({
      session: { sessionId: 'failed-session', setActiveToolsByName: sdk.active, prompt: sdk.prompt }
    });
    sdk.prompt.mockRejectedValueOnce(new Error('SDK inference failed'));
    await expect(new PiCodingAgentGateway().start(options)).rejects.toThrow('SDK inference failed');
    expect(options.onStarted).toHaveBeenCalledWith('failed-session');
  });
});
