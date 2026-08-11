import type {
  AgentCommandExecutor,
  AgentCommandSandbox
} from '@ai-native-software-delivery-orchestrator/domain';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  AgentCommandRuntime,
  NodeAgentCommandExecutor,
  SandboxedAgentCommandExecutor
} from './agent-command-runtime.js';
import { AgentToolDeniedError } from './agent-tool-runtime.js';

describe('AgentCommandRuntime', () => {
  it('runs only a policy-approved fixed command in the task workspace', async () => {
    const calls: Parameters<AgentCommandExecutor['execute']>[0][] = [];
    const executor: AgentCommandExecutor = {
      execute: async (request) => {
        calls.push(request);
        return { status: 'completed', exitCode: 0, stdout: 'checked\n', stderr: '' };
      }
    };
    const runtime = new AgentCommandRuntime(executor);
    runtime.bindRuntimePolicy(
      {
        commands: [
          {
            id: 'check-types',
            executable: 'pnpm',
            args: ['typecheck'],
            timeoutMs: 30_000,
            maxOutputBytes: 10_000
          }
        ],
        environment: { CI: '1' }
      },
      '/workspace/task-1'
    );

    await expect(runtime.run('check-types')).resolves.toEqual({
      status: 'completed',
      exitCode: 0,
      stdout: 'checked\n',
      stderr: ''
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: { id: 'check-types', executable: 'pnpm', args: ['typecheck'] },
      cwd: '/workspace/task-1',
      environment: { CI: '1' }
    });
  });

  it('passes the policy sandbox profile to the command executor', async () => {
    const calls: Parameters<AgentCommandExecutor['execute']>[0][] = [];
    const runtime = new AgentCommandRuntime({
      execute: async (request) => {
        calls.push(request);
        return { status: 'completed', exitCode: 0, stdout: '', stderr: '' };
      }
    });
    runtime.bindRuntimePolicy(
      {
        commands: [{ id: 'check', executable: 'node', args: [], timeoutMs: 1, maxOutputBytes: 1 }],
        environment: {},
        sandbox: {
          kind: 'docker-read-only',
          image: 'trusted/node:24',
          assurance: 'production-validation',
          network: 'deny',
          workspaceAccess: 'read-only',
          processTree: 'container',
          memoryBytes: 1_073_741_824,
          cpuCount: 2,
          pidLimit: 256
        }
      },
      '/workspace/task-1'
    );

    await runtime.run('check');
    expect(calls[0]?.sandbox).toMatchObject({ kind: 'docker-read-only', image: 'trusted/node:24' });
  });

  it('rejects an unapproved command ID without invoking the executor', async () => {
    const runtime = new AgentCommandRuntime({
      execute: async () => {
        throw new Error('Executor must not run.');
      }
    });
    runtime.bindRuntimePolicy({ commands: [], environment: {} }, '/workspace/task-1');

    await expect(runtime.run('shell')).rejects.toThrow(AgentToolDeniedError);
  });

  it('rejects command execution before policy binding', async () => {
    const runtime = new AgentCommandRuntime({
      execute: async () => ({ status: 'completed', exitCode: 0, stdout: '', stderr: '' })
    });

    await expect(runtime.run('check-types')).rejects.toThrow(AgentToolDeniedError);
  });

  it('captures successful and nonzero fixed commands without a shell', async () => {
    const executor = new NodeAgentCommandExecutor();
    const completed = await executor.execute({
      command: {
        id: 'success',
        executable: 'node',
        args: ['-e', "process.stdout.write('ok')"],
        timeoutMs: 5_000,
        maxOutputBytes: 100
      },
      cwd: process.cwd(),
      environment: {}
    });
    const nonzero = await executor.execute({
      command: {
        id: 'nonzero',
        executable: 'node',
        args: ['-e', "process.stderr.write('bad'); process.exit(2)"],
        timeoutMs: 5_000,
        maxOutputBytes: 100
      },
      cwd: process.cwd(),
      environment: {}
    });

    expect(completed).toMatchObject({ status: 'completed', exitCode: 0, stdout: 'ok' });
    expect(nonzero).toMatchObject({ status: 'completed', exitCode: 2, stderr: 'bad' });
  });

  it('keeps PATH orchestrator-owned even for an unvalidated executor request', async () => {
    const trustedPath = dirname(process.execPath);
    const executor = new NodeAgentCommandExecutor({ trustedPath });

    await expect(
      executor.execute({
        command: {
          id: 'path',
          executable: 'node',
          args: [
            '-e',
            "process.stdout.write(process.env.PATH === process.argv[1] ? 'safe' : 'unsafe')",
            trustedPath
          ],
          timeoutMs: 5_000,
          maxOutputBytes: 100
        },
        cwd: process.cwd(),
        environment: { PATH: '/unsafe' }
      })
    ).resolves.toMatchObject({ status: 'completed', stdout: 'safe' });
  });

  it('selects Docker and native sandbox profiles without exposing trusted path policy input', async () => {
    const requests: Parameters<AgentCommandSandbox['execute']>[0][] = [];
    const executor = new SandboxedAgentCommandExecutor({
      trustedPath: '/runtime/trusted',
      sandbox: {
        execute: async (request) => {
          requests.push(request);
          return { status: 'completed', exitCode: 0, stdout: '', stderr: '' };
        }
      }
    });
    const command = { id: 'check', executable: 'node', args: [], timeoutMs: 1, maxOutputBytes: 1 };

    await executor.execute({
      command,
      sandbox: {
        kind: 'docker-read-only',
        image: 'node:24-alpine',
        assurance: 'production-validation',
        network: 'deny',
        workspaceAccess: 'read-only',
        processTree: 'container',
        memoryBytes: 1_073_741_824,
        cpuCount: 2,
        pidLimit: 256
      },
      cwd: '/workspace',
      environment: {}
    });
    await executor.execute({
      command,
      sandbox: {
        kind: 'macos-read-only',
        assurance: 'developer-only',
        network: 'deny',
        workspaceAccess: 'read-only',
        processTree: 'direct-child'
      },
      cwd: '/workspace',
      environment: {}
    });

    expect(requests).toMatchObject([
      {
        profile: { kind: 'docker-read-only' },
        trustedPath: '/runtime/trusted'
      },
      { profile: { kind: 'macos-read-only' }, trustedPath: '/runtime/trusted' }
    ]);
  });

  it('uses the default trusted local profile without Docker', async () => {
    const requests: Parameters<AgentCommandExecutor['execute']>[0][] = [];
    const trustedLocalExecutor: AgentCommandExecutor = {
      execute: async (request) => {
        requests.push(request);
        return { status: 'completed', exitCode: 0, stdout: '', stderr: '' };
      }
    };
    const executor = new SandboxedAgentCommandExecutor({ trustedLocalExecutor });

    await executor.execute({
      command: { id: 'check', executable: 'node', args: [], timeoutMs: 1, maxOutputBytes: 1 },
      cwd: '/workspace',
      environment: {}
    });

    expect(requests).toMatchObject([{ command: { id: 'check' }, cwd: '/workspace' }]);
  });

  it('uses the trusted local executor for the default developer profile', async () => {
    const calls: Parameters<AgentCommandExecutor['execute']>[0][] = [];
    const executor = new SandboxedAgentCommandExecutor({
      trustedLocalExecutor: {
        execute: async (request) => {
          calls.push(request);
          return { status: 'completed', exitCode: 0, stdout: '', stderr: '' };
        }
      }
    });

    await executor.execute({
      command: { id: 'check', executable: 'node', args: [], timeoutMs: 1, maxOutputBytes: 1 },
      cwd: '/workspace',
      environment: {}
    });

    expect(calls).toMatchObject([{ command: { id: 'check' }, cwd: '/workspace' }]);
  });

  it('terminates timed-out, cancelled, and output-limited commands', async () => {
    const executor = new NodeAgentCommandExecutor();
    const timedOut = await executor.execute({
      command: {
        id: 'timeout',
        executable: 'node',
        args: ['-e', 'setTimeout(() => {}, 5000)'],
        timeoutMs: 20,
        maxOutputBytes: 100
      },
      cwd: process.cwd(),
      environment: {}
    });
    const controller = new AbortController();
    const cancelledPromise = executor.execute({
      command: {
        id: 'cancel',
        executable: 'node',
        args: ['-e', 'setTimeout(() => {}, 5000)'],
        timeoutMs: 5_000,
        maxOutputBytes: 100
      },
      cwd: process.cwd(),
      environment: {},
      signal: controller.signal
    });
    controller.abort();
    const cancelled = await cancelledPromise;
    const limited = await executor.execute({
      command: {
        id: 'limited',
        executable: 'node',
        args: ['-e', "process.stdout.write('output too long')"],
        timeoutMs: 5_000,
        maxOutputBytes: 4
      },
      cwd: process.cwd(),
      environment: {}
    });

    expect(timedOut).toMatchObject({ status: 'timed-out' });
    expect(cancelled).toMatchObject({ status: 'cancelled' });
    expect(limited).toMatchObject({ status: 'output-limited', stdout: 'outp' });
  });

  it('escalates to SIGKILL when a command ignores SIGTERM', async () => {
    const executor = new NodeAgentCommandExecutor({ terminationGraceMs: 20 });

    await expect(
      executor.execute({
        command: {
          id: 'ignores-term',
          executable: 'node',
          args: ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
          timeoutMs: 20,
          maxOutputBytes: 100
        },
        cwd: process.cwd(),
        environment: {}
      })
    ).resolves.toMatchObject({ status: 'timed-out' });
  });

  it('escalates cancellation when a command ignores SIGTERM', async () => {
    const executor = new NodeAgentCommandExecutor({ terminationGraceMs: 20 });
    const controller = new AbortController();
    const cancelled = executor.execute({
      command: {
        id: 'ignores-cancel',
        executable: 'node',
        args: ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
        timeoutMs: 5_000,
        maxOutputBytes: 100
      },
      cwd: process.cwd(),
      environment: {},
      signal: controller.signal
    });
    controller.abort();
    await expect(cancelled).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('escalates output limits when a command ignores SIGTERM', async () => {
    const executor = new NodeAgentCommandExecutor({ terminationGraceMs: 20 });
    const limited = executor.execute({
      command: {
        id: 'ignores-output-limit',
        executable: 'node',
        args: [
          '-e',
          "process.on('SIGTERM', () => {}); process.stdout.write('long output'); setInterval(() => {}, 1000)"
        ],
        timeoutMs: 5_000,
        maxOutputBytes: 4
      },
      cwd: process.cwd(),
      environment: {}
    });

    await expect(limited).resolves.toMatchObject({ status: 'output-limited', stdout: 'long' });
  });

  it('honors an already-aborted command signal', async () => {
    const executor = new NodeAgentCommandExecutor({ terminationGraceMs: 20 });
    const controller = new AbortController();
    controller.abort();

    await expect(
      executor.execute({
        command: {
          id: 'pre-cancelled',
          executable: 'node',
          args: ['-e', 'setTimeout(() => {}, 5000)'],
          timeoutMs: 5_000,
          maxOutputBytes: 100
        },
        cwd: process.cwd(),
        environment: {},
        signal: controller.signal
      })
    ).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('reports a command startup failure without throwing process details', async () => {
    const executor = new NodeAgentCommandExecutor();

    await expect(
      executor.execute({
        command: {
          id: 'missing',
          executable: 'missing-agent-command',
          args: [],
          timeoutMs: 5_000,
          maxOutputBytes: 100
        },
        cwd: process.cwd(),
        environment: {}
      })
    ).resolves.toMatchObject({ status: 'failed', detail: 'Command could not start: missing' });
  });
});
