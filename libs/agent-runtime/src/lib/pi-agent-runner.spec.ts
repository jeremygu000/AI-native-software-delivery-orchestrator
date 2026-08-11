import type { AgentRunRequest } from '@ai-native-software-delivery-orchestrator/domain';
import { InMemoryWriteGuard } from '@ai-native-software-delivery-orchestrator/runtime-guard';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentToolRuntime } from './agent-tool-runtime.js';
import { AgentCommandRuntime } from './agent-command-runtime.js';
import type { PiSessionGateway, PiToolCall, PiToolResult } from './pi-gateway.js';
import { PiAgentRunner } from './pi-agent-runner.js';

const directories: string[] = [];

const request = (
  workspacePath: string,
  onStarted: AgentRunRequest['onStarted']
): AgentRunRequest => ({
  attempt: {
    id: 'attempt-1',
    runId: 'run-1',
    taskId: 'task-1',
    agentId: 'agent-1',
    workspaceId: 'workspace-1',
    leasePlanFingerprint: 'lease-plan-1',
    state: 'STARTING',
    revision: 2,
    startedAt: new Date('2026-08-14T00:00:00.000Z')
  },
  runId: 'run-1',
  taskId: 'task-1',
  task: {
    id: 'task-1',
    title: 'Task',
    goal: 'Change value',
    dependencies: [],
    expectedReads: [],
    expectedWrites: [],
    sharedResources: [],
    verification: []
  },
  workspace: {
    id: 'workspace-1',
    runId: 'run-1',
    taskId: 'task-1',
    integrationRepositoryPath: workspacePath,
    workspacePath,
    branchName: 'orchestrator/run-1/task-1',
    baseRef: 'main',
    integrationRef: 'main',
    revision: 1,
    phase: 'READY_TO_INTEGRATE'
  },
  instructions: 'Change value',
  onStarted
});

class ScriptedPiGateway implements PiSessionGateway {
  readonly calls: PiToolCall[] = [];

  async start(options: {
    readonly cwd: string;
    readonly prompt: string;
    readonly tools: readonly PiToolCall['name'][];
    readonly executeTool: (call: PiToolCall) => Promise<PiToolResult>;
    readonly onStarted: (sessionId: string) => Promise<void>;
  }): Promise<{ readonly sessionId: string }> {
    expect(options.tools).toEqual([
      'forge_read',
      'forge_list',
      'forge_find',
      'forge_edit',
      'forge_write'
    ]);
    await options.onStarted('pi-session-1');
    this.calls.push({
      name: 'forge_edit',
      path: 'value.txt',
      expected: 'before',
      replacement: 'after'
    });
    const [call] = this.calls;
    await options.executeTool(call);
    return { sessionId: 'pi-session-1' };
  }
}

class BlockedPiGateway implements PiSessionGateway {
  async start(options: {
    readonly cwd: string;
    readonly prompt: string;
    readonly tools: readonly PiToolCall['name'][];
    readonly executeTool: (call: PiToolCall) => Promise<PiToolResult>;
    readonly onStarted: (sessionId: string) => Promise<void>;
  }): Promise<{ readonly sessionId: string }> {
    await options.onStarted('pi-session-1');
    await options.executeTool({ name: 'forge_write', path: 'value.txt', content: 'after\n' });
    await options.executeTool({ name: 'forge_write', path: 'value.txt', content: 'after again\n' });
    return { sessionId: 'pi-session-1' };
  }
}

class BlockedEditPiGateway implements PiSessionGateway {
  async start(options: {
    readonly cwd: string;
    readonly prompt: string;
    readonly tools: readonly PiToolCall['name'][];
    readonly executeTool: (call: PiToolCall) => Promise<PiToolResult>;
    readonly onStarted: (sessionId: string) => Promise<void>;
  }): Promise<{ readonly sessionId: string }> {
    await options.onStarted('pi-session-1');
    await options.executeTool({
      name: 'forge_edit',
      path: 'value.txt',
      expected: 'before',
      replacement: 'after'
    });
    return { sessionId: 'pi-session-1' };
  }
}

class WriteThenBlockedPiGateway implements PiSessionGateway {
  async start(options: {
    readonly cwd: string;
    readonly prompt: string;
    readonly tools: readonly PiToolCall['name'][];
    readonly executeTool: (call: PiToolCall) => Promise<PiToolResult>;
    readonly onStarted: (sessionId: string) => Promise<void>;
  }): Promise<{ readonly sessionId: string }> {
    await options.onStarted('pi-session-1');
    await options.executeTool({ name: 'forge_write', path: 'first.txt', content: 'first\n' });
    await options.executeTool({ name: 'forge_write', path: 'second.txt', content: 'second\n' });
    return { sessionId: 'pi-session-1' };
  }
}

class ReadOnlyPiGateway implements PiSessionGateway {
  readonly results: PiToolResult[] = [];

  async start(options: {
    readonly cwd: string;
    readonly prompt: string;
    readonly tools: readonly PiToolCall['name'][];
    readonly executeTool: (call: PiToolCall) => Promise<PiToolResult>;
    readonly onStarted: (sessionId: string) => Promise<void>;
  }): Promise<{ readonly sessionId: string }> {
    await options.onStarted('pi-session-1');
    this.results.push(await options.executeTool({ name: 'forge_read', path: 'value.txt' }));
    this.results.push(await options.executeTool({ name: 'forge_list' }));
    this.results.push(
      await options.executeTool({ name: 'forge_find', path: 'value.txt', text: 'before' })
    );
    return { sessionId: 'pi-session-1' };
  }
}

class FailingPiGateway implements PiSessionGateway {
  async start(_options: {
    readonly cwd: string;
    readonly prompt: string;
    readonly tools: readonly PiToolCall['name'][];
    readonly executeTool: (call: PiToolCall) => Promise<PiToolResult>;
    readonly onStarted: (sessionId: string) => Promise<void>;
  }): Promise<{ readonly sessionId: string }> {
    throw new Error('Pi gateway failed.');
  }
}

class PostStartFailingPiGateway implements PiSessionGateway {
  async start(options: {
    readonly cwd: string;
    readonly prompt: string;
    readonly tools: readonly PiToolCall['name'][];
    readonly executeTool: (call: PiToolCall) => Promise<PiToolResult>;
    readonly onStarted: (sessionId: string) => Promise<void>;
  }): Promise<{ readonly sessionId: string }> {
    await options.onStarted('pi-session-1');
    throw new Error('Pi connection lost.');
  }
}

class DeniedPiGateway implements PiSessionGateway {
  async start(options: {
    readonly cwd: string;
    readonly prompt: string;
    readonly tools: readonly PiToolCall['name'][];
    readonly executeTool: (call: PiToolCall) => Promise<PiToolResult>;
    readonly onStarted: (sessionId: string) => Promise<void>;
  }): Promise<{ readonly sessionId: string }> {
    await options.onStarted('pi-session-1');
    const result = await options.executeTool({
      name: 'forge_edit',
      path: 'value.txt',
      expected: '',
      replacement: 'after'
    });
    expect(result).toEqual({ content: 'Expected edit text must not be empty', isError: true });
    return { sessionId: 'pi-session-1' };
  }
}

class WritingPiGateway implements PiSessionGateway {
  async start(options: {
    readonly cwd: string;
    readonly prompt: string;
    readonly tools: readonly PiToolCall['name'][];
    readonly executeTool: (call: PiToolCall) => Promise<PiToolResult>;
    readonly onStarted: (sessionId: string) => Promise<void>;
  }): Promise<{ readonly sessionId: string }> {
    await options.onStarted('pi-session-1');
    await expect(
      options.executeTool({ name: 'forge_write', path: 'value.txt', content: 'after\n' })
    ).resolves.toEqual({ content: 'Wrote value.txt' });
    return { sessionId: 'pi-session-1' };
  }
}

class ProjectLeaseWritingPiGateway implements PiSessionGateway {
  async start(options: {
    readonly cwd: string;
    readonly prompt: string;
    readonly tools: readonly PiToolCall['name'][];
    readonly executeTool: (call: PiToolCall) => Promise<PiToolResult>;
    readonly onStarted: (sessionId: string) => Promise<void>;
  }): Promise<{ readonly sessionId: string }> {
    await options.onStarted('pi-session-1');
    await expect(
      options.executeTool({ name: 'forge_write', path: 'value.txt', content: 'after\n' })
    ).resolves.toEqual({ content: 'Wrote value.txt' });
    return { sessionId: 'pi-session-1' };
  }
}

class CommandPiGateway implements PiSessionGateway {
  readonly result: PiToolResult[] = [];

  async start(options: {
    readonly cwd: string;
    readonly prompt: string;
    readonly tools: readonly PiToolCall['name'][];
    readonly executeTool: (call: PiToolCall) => Promise<PiToolResult>;
    readonly onStarted: (sessionId: string) => Promise<void>;
  }): Promise<{ readonly sessionId: string }> {
    await options.onStarted('pi-session-1');
    this.result.push(
      await options.executeTool({ name: 'forge_command', commandId: 'check-types' })
    );
    this.result.push(await options.executeTool({ name: 'forge_command', commandId: 'shell' }));
    return { sessionId: 'pi-session-1' };
  }
}

class CommandFailurePiGateway implements PiSessionGateway {
  readonly result: PiToolResult[] = [];

  async start(options: {
    readonly cwd: string;
    readonly prompt: string;
    readonly tools: readonly PiToolCall['name'][];
    readonly executeTool: (call: PiToolCall) => Promise<PiToolResult>;
    readonly onStarted: (sessionId: string) => Promise<void>;
  }): Promise<{ readonly sessionId: string }> {
    expect(options.tools).not.toContain('forge_command');
    await options.onStarted('pi-session-1');
    this.result.push(
      await options.executeTool({ name: 'forge_command', commandId: 'check-types' })
    );
    return { sessionId: 'pi-session-1' };
  }
}

class FailedAllowedCommandPiGateway implements PiSessionGateway {
  readonly result: PiToolResult[] = [];

  async start(options: {
    readonly cwd: string;
    readonly prompt: string;
    readonly tools: readonly PiToolCall['name'][];
    readonly executeTool: (call: PiToolCall) => Promise<PiToolResult>;
    readonly onStarted: (sessionId: string) => Promise<void>;
  }): Promise<{ readonly sessionId: string }> {
    expect(options.tools).toContain('forge_command');
    await options.onStarted('pi-session-1');
    this.result.push(
      await options.executeTool({ name: 'forge_command', commandId: 'check-types' })
    );
    return { sessionId: 'pi-session-1' };
  }
}

class EmptyCommandPiGateway implements PiSessionGateway {
  readonly result: PiToolResult[] = [];

  async start(options: {
    readonly cwd: string;
    readonly prompt: string;
    readonly tools: readonly PiToolCall['name'][];
    readonly executeTool: (call: PiToolCall) => Promise<PiToolResult>;
    readonly onStarted: (sessionId: string) => Promise<void>;
  }): Promise<{ readonly sessionId: string }> {
    await options.onStarted('pi-session-1');
    this.result.push(
      await options.executeTool({ name: 'forge_command', commandId: 'check-types' })
    );
    return { sessionId: 'pi-session-1' };
  }
}

class ReadFailingPiGateway implements PiSessionGateway {
  async start(options: {
    readonly cwd: string;
    readonly prompt: string;
    readonly tools: readonly PiToolCall['name'][];
    readonly executeTool: (call: PiToolCall) => Promise<PiToolResult>;
    readonly onStarted: (sessionId: string) => Promise<void>;
  }): Promise<{ readonly sessionId: string }> {
    await options.onStarted('pi-session-1');
    await options.executeTool({ name: 'forge_read', path: 'missing.txt' });
    return { sessionId: 'pi-session-1' };
  }
}

class OutOfOrderPiGateway implements PiSessionGateway {
  readonly results: PiToolResult[] = [];

  async start(options: {
    readonly cwd: string;
    readonly prompt: string;
    readonly tools: readonly PiToolCall['name'][];
    readonly executeTool: (call: PiToolCall) => Promise<PiToolResult>;
    readonly onStarted: (sessionId: string) => Promise<void>;
  }): Promise<{ readonly sessionId: string }> {
    this.results.push(
      await options.executeTool({ name: 'forge_write', path: 'value.txt', content: 'after\n' })
    );
    await options.onStarted('pi-session-1');
    return { sessionId: 'pi-session-1' };
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('PiAgentRunner', () => {
  it('rejects a tool call before the durable session callback resolves', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'pi-runner-'));
    directories.push(workspacePath);
    writeFileSync(join(workspacePath, 'value.txt'), 'before\n');
    const gateway = new OutOfOrderPiGateway();
    const writeGuard = new InMemoryWriteGuard();
    const acquire = vi.spyOn(writeGuard, 'acquire');
    const runner = new PiAgentRunner({
      gateway,
      createTools: (agentRequest) =>
        new AgentToolRuntime({
          runId: agentRequest.runId,
          taskId: agentRequest.taskId,
          attemptId: agentRequest.attempt.id,
          agentId: agentRequest.attempt.agentId,
          workspacePath: agentRequest.workspace.workspacePath,
          resolveResource: (path) => ({ type: 'file', projectId: 'core', fileId: `core:${path}` }),
          resolveFileId: (path) => `core:${path}`,
          writeGuard,
          persistence: {
            createRun: async () => {},
            persistReevaluation: async () => {},
            persistDispatch: async () => {},
            persistImpact: async () => {},
            persistConflict: async () => {},
            persistLease: async () => {},
            persistWorkspace: async () => {},
            persistAttempt: async () => {},
            updateRunState: async () => {},
            recoverRun: async () => undefined,
            replayRun: async () => []
          }
        })
    });

    await expect(runner.run(request(workspacePath, async () => {}))).resolves.toMatchObject({
      status: 'completed'
    });
    expect(gateway.results).toEqual([
      { content: 'Pi session is not durably established', isError: true }
    ]);
    expect(acquire).not.toHaveBeenCalled();
    expect(readFileSync(join(workspacePath, 'value.txt'), 'utf8')).toBe('before\n');
  });

  it('routes Pi custom edit through the supplied controlled tool runtime', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'pi-runner-'));
    directories.push(workspacePath);
    writeFileSync(join(workspacePath, 'value.txt'), 'before\n');
    const gateway = new ScriptedPiGateway();
    let startedSession = '';
    const runner = new PiAgentRunner({
      gateway,
      createTools: (agentRequest) =>
        new AgentToolRuntime({
          runId: agentRequest.runId,
          taskId: agentRequest.taskId,
          attemptId: agentRequest.attempt.id,
          agentId: agentRequest.attempt.agentId,
          workspacePath: agentRequest.workspace.workspacePath,
          resolveResource: (path) => ({ type: 'file', projectId: 'core', fileId: `core:${path}` }),
          resolveFileId: (path) => `core:${path}`,
          writeGuard: {
            acquire: async (leaseRequest) => ({
              status: 'granted',
              lease: {
                id: 'lease-1',
                runId: leaseRequest.runId,
                agentId: leaseRequest.agentId,
                taskId: leaseRequest.taskId,
                resource: leaseRequest.resource,
                mode: 'exclusive',
                version: 1,
                state: 'ACTIVE',
                acquiredAt: new Date('2026-08-14T00:00:00.000Z'),
                lastHeartbeatAt: new Date('2026-08-14T00:00:00.000Z')
              }
            }),
            heartbeat: async () => ({ status: 'not-found' }),
            markStale: async () => ({ status: 'not-found' }),
            release: async () => ({ status: 'not-found' })
          },
          persistence: {
            createRun: async () => {},
            persistReevaluation: async () => {},
            persistDispatch: async () => {},
            persistImpact: async () => {},
            persistConflict: async () => {},
            persistLease: async () => {},
            persistWorkspace: async () => {},
            persistAttempt: async () => {},
            updateRunState: async () => {},
            recoverRun: async () => undefined,
            replayRun: async () => []
          }
        })
    });
    const agentRequest = request(workspacePath, async ({ sessionRef }) => {
      startedSession = sessionRef?.value ?? '';
    });

    await expect(runner.run(agentRequest)).resolves.toMatchObject({
      status: 'completed',
      sessionRef: { backend: 'pi', value: 'pi-session-1' },
      observedImpact: { filesWritten: new Set(['core:value.txt']) }
    });
    expect(startedSession).toBe('pi-session-1');
    expect(readFileSync(join(workspacePath, 'value.txt'), 'utf8')).toBe('after\n');
  });

  it('returns blocked after a custom Pi write lease conflict', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'pi-runner-'));
    directories.push(workspacePath);
    writeFileSync(join(workspacePath, 'value.txt'), 'before\n');
    const writeGuard = new InMemoryWriteGuard();
    await writeGuard.acquire({
      runId: 'other-run',
      agentId: 'other-agent',
      taskId: 'other-task',
      resource: { type: 'file', projectId: 'core', fileId: 'core:value.txt' },
      mode: 'exclusive'
    });
    const runner = new PiAgentRunner({
      gateway: new BlockedPiGateway(),
      createTools: (agentRequest) =>
        new AgentToolRuntime({
          runId: agentRequest.runId,
          taskId: agentRequest.taskId,
          attemptId: agentRequest.attempt.id,
          agentId: agentRequest.attempt.agentId,
          workspacePath: agentRequest.workspace.workspacePath,
          resolveResource: (path) => ({ type: 'file', projectId: 'core', fileId: `core:${path}` }),
          resolveFileId: (path) => `core:${path}`,
          writeGuard,
          persistence: {
            createRun: async () => {},
            persistReevaluation: async () => {},
            persistDispatch: async () => {},
            persistImpact: async () => {},
            persistConflict: async () => {},
            persistLease: async () => {},
            persistWorkspace: async () => {},
            persistAttempt: async () => {},
            updateRunState: async () => {},
            recoverRun: async () => undefined,
            replayRun: async () => []
          }
        })
    });

    await expect(runner.run(request(workspacePath, async () => {}))).resolves.toMatchObject({
      status: 'blocked',
      leaseId: 'lease-1',
      detail: 'Write blocked by lease: lease-1'
    });
    expect(readFileSync(join(workspacePath, 'value.txt'), 'utf8')).toBe('before\n');
  });

  it('returns blocked after a custom Pi edit lease conflict', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'pi-runner-'));
    directories.push(workspacePath);
    writeFileSync(join(workspacePath, 'value.txt'), 'before\n');
    const writeGuard = new InMemoryWriteGuard();
    await writeGuard.acquire({
      runId: 'other-run',
      agentId: 'other-agent',
      taskId: 'other-task',
      resource: { type: 'file', projectId: 'core', fileId: 'core:value.txt' },
      mode: 'exclusive'
    });
    const runner = new PiAgentRunner({
      gateway: new BlockedEditPiGateway(),
      createTools: (agentRequest) =>
        new AgentToolRuntime({
          runId: agentRequest.runId,
          taskId: agentRequest.taskId,
          attemptId: agentRequest.attempt.id,
          agentId: agentRequest.attempt.agentId,
          workspacePath: agentRequest.workspace.workspacePath,
          resolveResource: (path) => ({ type: 'file', projectId: 'core', fileId: `core:${path}` }),
          resolveFileId: (path) => `core:${path}`,
          writeGuard,
          persistence: {
            createRun: async () => {},
            persistReevaluation: async () => {},
            persistDispatch: async () => {},
            persistImpact: async () => {},
            persistConflict: async () => {},
            persistLease: async () => {},
            persistWorkspace: async () => {},
            persistAttempt: async () => {},
            updateRunState: async () => {},
            recoverRun: async () => undefined,
            replayRun: async () => []
          }
        })
    });

    await expect(runner.run(request(workspacePath, async () => {}))).resolves.toMatchObject({
      status: 'blocked',
      leaseId: 'lease-1'
    });
    expect(readFileSync(join(workspacePath, 'value.txt'), 'utf8')).toBe('before\n');
  });

  it('returns dynamic lease and observed impact evidence after a later Pi write blocks', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'pi-runner-'));
    directories.push(workspacePath);
    writeFileSync(join(workspacePath, 'first.txt'), 'before\n');
    writeFileSync(join(workspacePath, 'second.txt'), 'before\n');
    const writeGuard = new InMemoryWriteGuard({
      createLeaseId: (() => {
        let number = 1;
        return () => `lease-${number++}`;
      })()
    });
    await writeGuard.acquire({
      runId: 'other-run',
      agentId: 'other-agent',
      taskId: 'other-task',
      resource: { type: 'file', projectId: 'core', fileId: 'core:second.txt' },
      mode: 'exclusive'
    });
    const runner = new PiAgentRunner({
      gateway: new WriteThenBlockedPiGateway(),
      createTools: (agentRequest) =>
        new AgentToolRuntime({
          runId: agentRequest.runId,
          taskId: agentRequest.taskId,
          attemptId: agentRequest.attempt.id,
          agentId: agentRequest.attempt.agentId,
          workspacePath: agentRequest.workspace.workspacePath,
          resolveResource: (path) => ({ type: 'file', projectId: 'core', fileId: `core:${path}` }),
          resolveFileId: (path) => `core:${path}`,
          writeGuard,
          persistence: {
            createRun: async () => {},
            persistReevaluation: async () => {},
            persistDispatch: async () => {},
            persistImpact: async () => {},
            persistConflict: async () => {},
            persistLease: async () => {},
            persistWorkspace: async () => {},
            persistAttempt: async () => {},
            updateRunState: async () => {},
            recoverRun: async () => undefined,
            replayRun: async () => []
          }
        })
    });

    await expect(runner.run(request(workspacePath, async () => {}))).resolves.toMatchObject({
      status: 'blocked',
      leaseId: 'lease-1',
      observedImpact: { filesWritten: new Set(['core:first.txt']) },
      additionalLeases: [{ id: 'lease-2', state: 'ACTIVE' }]
    });
    expect(readFileSync(join(workspacePath, 'first.txt'), 'utf8')).toBe('first\n');
    expect(readFileSync(join(workspacePath, 'second.txt'), 'utf8')).toBe('before\n');
  });

  it('routes Pi custom read-only tools through the scoped runtime', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'pi-runner-'));
    directories.push(workspacePath);
    writeFileSync(join(workspacePath, 'value.txt'), 'before\n');
    const gateway = new ReadOnlyPiGateway();
    const runner = new PiAgentRunner({
      gateway,
      createTools: (agentRequest) =>
        new AgentToolRuntime({
          runId: agentRequest.runId,
          taskId: agentRequest.taskId,
          attemptId: agentRequest.attempt.id,
          agentId: agentRequest.attempt.agentId,
          workspacePath: agentRequest.workspace.workspacePath,
          resolveResource: (path) => ({ type: 'file', projectId: 'core', fileId: `core:${path}` }),
          resolveFileId: (path) => `core:${path}`,
          writeGuard: {
            acquire: async () => ({ status: 'blocked', conflictingLeaseIds: ['unused'] }),
            heartbeat: async () => ({ status: 'not-found' }),
            markStale: async () => ({ status: 'not-found' }),
            release: async () => ({ status: 'not-found' })
          },
          persistence: {
            createRun: async () => {},
            persistReevaluation: async () => {},
            persistDispatch: async () => {},
            persistImpact: async () => {},
            persistConflict: async () => {},
            persistLease: async () => {},
            persistWorkspace: async () => {},
            persistAttempt: async () => {},
            updateRunState: async () => {},
            recoverRun: async () => undefined,
            replayRun: async () => []
          }
        })
    });

    await expect(runner.run(request(workspacePath, async () => {}))).resolves.toMatchObject({
      status: 'completed'
    });
    expect(gateway.results).toEqual([
      { content: 'before\n' },
      { content: 'value.txt' },
      { content: '1' }
    ]);
  });

  it('routes Pi custom write through the scoped runtime', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'pi-runner-'));
    directories.push(workspacePath);
    writeFileSync(join(workspacePath, 'value.txt'), 'before\n');
    const runner = new PiAgentRunner({
      gateway: new WritingPiGateway(),
      createTools: (agentRequest) =>
        new AgentToolRuntime({
          runId: agentRequest.runId,
          taskId: agentRequest.taskId,
          attemptId: agentRequest.attempt.id,
          agentId: agentRequest.attempt.agentId,
          workspacePath: agentRequest.workspace.workspacePath,
          resolveResource: (path) => ({ type: 'file', projectId: 'core', fileId: `core:${path}` }),
          resolveFileId: (path) => `core:${path}`,
          writeGuard: new InMemoryWriteGuard(),
          persistence: {
            createRun: async () => {},
            persistReevaluation: async () => {},
            persistDispatch: async () => {},
            persistImpact: async () => {},
            persistConflict: async () => {},
            persistLease: async () => {},
            persistWorkspace: async () => {},
            persistAttempt: async () => {},
            updateRunState: async () => {},
            recoverRun: async () => undefined,
            replayRun: async () => []
          }
        })
    });

    await expect(runner.run(request(workspacePath, async () => {}))).resolves.toMatchObject({
      status: 'completed',
      observedImpact: { filesWritten: new Set(['core:value.txt']) }
    });
    expect(readFileSync(join(workspacePath, 'value.txt'), 'utf8')).toBe('after\n');
  });

  it('binds runtime leases even when the tool factory omits them', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'pi-runner-'));
    directories.push(workspacePath);
    writeFileSync(join(workspacePath, 'value.txt'), 'before\n');
    const writeGuard = new InMemoryWriteGuard();
    const acquire = vi.spyOn(writeGuard, 'acquire');
    const runner = new PiAgentRunner({
      gateway: new ProjectLeaseWritingPiGateway(),
      createTools: (agentRequest) =>
        new AgentToolRuntime({
          runId: agentRequest.runId,
          taskId: agentRequest.taskId,
          attemptId: agentRequest.attempt.id,
          agentId: agentRequest.attempt.agentId,
          workspacePath: agentRequest.workspace.workspacePath,
          resolveResource: (path) => ({ type: 'file', projectId: 'core', fileId: `core:${path}` }),
          resolveFileId: (path) => `core:${path}`,
          writeGuard,
          persistence: {
            createRun: async () => {},
            persistReevaluation: async () => {},
            persistDispatch: async () => {},
            persistImpact: async () => {},
            persistConflict: async () => {},
            persistLease: async () => {},
            persistWorkspace: async () => {},
            persistAttempt: async () => {},
            updateRunState: async () => {},
            recoverRun: async () => undefined,
            replayRun: async () => []
          }
        })
    });
    const agentRequest = request(workspacePath, async () => {});

    await expect(
      runner.run({
        ...agentRequest,
        impact: {
          predicted: {
            taskId: 'task-1',
            projectsRead: new Set(),
            projectsWritten: new Set(['core']),
            explicitProjectsWritten: new Set(['core']),
            filesRead: new Set(),
            filesWritten: new Set(),
            explicitFilesWritten: new Set(),
            globFilesWritten: new Set(),
            symbolDerivedFilesWritten: new Set(),
            symbolsRead: new Set(),
            symbolsWritten: new Set(),
            sharedResources: new Set(),
            sharedResourceAccesses: [],
            downstreamProjects: new Set(),
            riskSignals: []
          }
        },
        leases: [
          {
            id: 'lease-project',
            runId: 'run-1',
            taskId: 'task-1',
            agentId: 'agent-1',
            resource: { type: 'project', projectId: 'core' },
            mode: 'exclusive',
            version: 1,
            state: 'ACTIVE',
            acquiredAt: new Date('2026-08-14T00:00:00.000Z'),
            lastHeartbeatAt: new Date('2026-08-14T00:00:00.000Z')
          }
        ]
      })
    ).resolves.toMatchObject({ status: 'completed', additionalLeases: [] });
    expect(acquire).not.toHaveBeenCalled();
    expect(readFileSync(join(workspacePath, 'value.txt'), 'utf8')).toBe('after\n');
  });

  it('routes only policy-approved Pi commands through the controlled executor', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'pi-runner-'));
    directories.push(workspacePath);
    const gateway = new CommandPiGateway();
    const commands: string[] = [];
    const runner = new PiAgentRunner({
      gateway,
      createTools: (agentRequest) =>
        new AgentToolRuntime({
          runId: agentRequest.runId,
          taskId: agentRequest.taskId,
          attemptId: agentRequest.attempt.id,
          agentId: agentRequest.attempt.agentId,
          workspacePath: agentRequest.workspace.workspacePath,
          resolveResource: (path) => ({ type: 'file', projectId: 'core', fileId: `core:${path}` }),
          resolveFileId: (path) => `core:${path}`,
          writeGuard: new InMemoryWriteGuard(),
          persistence: {
            createRun: async () => {},
            persistReevaluation: async () => {},
            persistDispatch: async () => {},
            persistImpact: async () => {},
            persistConflict: async () => {},
            persistLease: async () => {},
            persistWorkspace: async () => {},
            persistAttempt: async () => {},
            updateRunState: async () => {},
            recoverRun: async () => undefined,
            replayRun: async () => []
          }
        }),
      createCommands: () =>
        new AgentCommandRuntime({
          execute: async ({ command }) => {
            commands.push(command.id);
            return { status: 'completed', exitCode: 0, stdout: 'checked', stderr: '' };
          }
        })
    });
    const agentRequest = request(workspacePath, async () => {});

    await expect(
      runner.run({
        ...agentRequest,
        commandPolicy: {
          commands: [
            {
              id: 'check-types',
              executable: 'pnpm',
              args: ['typecheck'],
              timeoutMs: 30_000,
              maxOutputBytes: 10_000
            }
          ],
          environment: {}
        }
      })
    ).resolves.toMatchObject({ status: 'completed' });
    expect(commands).toEqual(['check-types']);
    expect(gateway.result).toEqual([
      { content: 'checked' },
      { content: 'Agent command is not allowed: shell', isError: true }
    ]);
  });

  it('does not enable commands without policy and maps command failures to tool errors', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'pi-runner-'));
    directories.push(workspacePath);
    const gateway = new CommandFailurePiGateway();
    const runner = new PiAgentRunner({
      gateway,
      createTools: (agentRequest) =>
        new AgentToolRuntime({
          runId: agentRequest.runId,
          taskId: agentRequest.taskId,
          attemptId: agentRequest.attempt.id,
          agentId: agentRequest.attempt.agentId,
          workspacePath: agentRequest.workspace.workspacePath,
          resolveResource: (path) => ({ type: 'file', projectId: 'core', fileId: `core:${path}` }),
          resolveFileId: (path) => `core:${path}`,
          writeGuard: new InMemoryWriteGuard(),
          persistence: {
            createRun: async () => {},
            persistReevaluation: async () => {},
            persistDispatch: async () => {},
            persistImpact: async () => {},
            persistConflict: async () => {},
            persistLease: async () => {},
            persistWorkspace: async () => {},
            persistAttempt: async () => {},
            updateRunState: async () => {},
            recoverRun: async () => undefined,
            replayRun: async () => []
          }
        }),
      createCommands: () =>
        new AgentCommandRuntime({
          execute: async () => ({
            status: 'failed',
            detail: 'not available',
            stdout: '',
            stderr: ''
          })
        })
    });

    await expect(runner.run(request(workspacePath, async () => {}))).resolves.toMatchObject({
      status: 'completed'
    });
    expect(gateway.result).toEqual([
      { content: 'Agent command is not allowed: check-types', isError: true }
    ]);
  });

  it('maps an allowed command failure to a Pi tool error', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'pi-runner-'));
    directories.push(workspacePath);
    const gateway = new FailedAllowedCommandPiGateway();
    const runner = new PiAgentRunner({
      gateway,
      createTools: (agentRequest) =>
        new AgentToolRuntime({
          runId: agentRequest.runId,
          taskId: agentRequest.taskId,
          attemptId: agentRequest.attempt.id,
          agentId: agentRequest.attempt.agentId,
          workspacePath: agentRequest.workspace.workspacePath,
          resolveResource: (path) => ({ type: 'file', projectId: 'core', fileId: `core:${path}` }),
          resolveFileId: (path) => `core:${path}`,
          writeGuard: new InMemoryWriteGuard(),
          persistence: {
            createRun: async () => {},
            persistReevaluation: async () => {},
            persistDispatch: async () => {},
            persistImpact: async () => {},
            persistConflict: async () => {},
            persistLease: async () => {},
            persistWorkspace: async () => {},
            persistAttempt: async () => {},
            updateRunState: async () => {},
            recoverRun: async () => undefined,
            replayRun: async () => []
          }
        }),
      createCommands: () =>
        new AgentCommandRuntime({
          execute: async () => ({
            status: 'failed',
            detail: 'not available',
            stdout: '',
            stderr: 'failed'
          })
        })
    });
    const agentRequest = request(workspacePath, async () => {});

    await expect(
      runner.run({
        ...agentRequest,
        commandPolicy: {
          commands: [
            {
              id: 'check-types',
              executable: 'pnpm',
              args: ['typecheck'],
              timeoutMs: 30_000,
              maxOutputBytes: 10_000
            }
          ],
          environment: {}
        }
      })
    ).resolves.toMatchObject({ status: 'completed' });
    expect(gateway.result).toEqual([{ content: 'failed', isError: true }]);
  });

  it('returns a successful empty-output command status without a Pi tool error', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'pi-runner-'));
    directories.push(workspacePath);
    const gateway = new EmptyCommandPiGateway();
    const runner = new PiAgentRunner({
      gateway,
      createTools: (agentRequest) =>
        new AgentToolRuntime({
          runId: agentRequest.runId,
          taskId: agentRequest.taskId,
          attemptId: agentRequest.attempt.id,
          agentId: agentRequest.attempt.agentId,
          workspacePath: agentRequest.workspace.workspacePath,
          resolveResource: (path) => ({ type: 'file', projectId: 'core', fileId: `core:${path}` }),
          resolveFileId: (path) => `core:${path}`,
          writeGuard: new InMemoryWriteGuard(),
          persistence: {
            createRun: async () => {},
            persistReevaluation: async () => {},
            persistDispatch: async () => {},
            persistImpact: async () => {},
            persistConflict: async () => {},
            persistLease: async () => {},
            persistWorkspace: async () => {},
            persistAttempt: async () => {},
            updateRunState: async () => {},
            recoverRun: async () => undefined,
            replayRun: async () => []
          }
        }),
      createCommands: () =>
        new AgentCommandRuntime({
          execute: async () => ({ status: 'completed', exitCode: 0, stdout: '', stderr: '' })
        })
    });
    const agentRequest = request(workspacePath, async () => {});

    await runner.run({
      ...agentRequest,
      commandPolicy: {
        commands: [
          {
            id: 'check-types',
            executable: 'pnpm',
            args: ['typecheck'],
            timeoutMs: 30_000,
            maxOutputBytes: 10_000
          }
        ],
        environment: {}
      }
    });
    expect(gateway.result).toEqual([{ content: 'completed' }]);
  });

  it('returns completed when Pi receives a handled read-tool error', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'pi-runner-'));
    directories.push(workspacePath);
    const runner = new PiAgentRunner({
      gateway: new ReadFailingPiGateway(),
      createTools: (agentRequest) =>
        new AgentToolRuntime({
          runId: agentRequest.runId,
          taskId: agentRequest.taskId,
          attemptId: agentRequest.attempt.id,
          agentId: agentRequest.attempt.agentId,
          workspacePath: agentRequest.workspace.workspacePath,
          resolveResource: (path) => ({ type: 'file', projectId: 'core', fileId: `core:${path}` }),
          resolveFileId: (path) => `core:${path}`,
          writeGuard: new InMemoryWriteGuard(),
          persistence: {
            createRun: async () => {},
            persistReevaluation: async () => {},
            persistDispatch: async () => {},
            persistImpact: async () => {},
            persistConflict: async () => {},
            persistLease: async () => {},
            persistWorkspace: async () => {},
            persistAttempt: async () => {},
            updateRunState: async () => {},
            recoverRun: async () => undefined,
            replayRun: async () => []
          }
        })
    });

    await expect(runner.run(request(workspacePath, async () => {}))).resolves.toMatchObject({
      status: 'completed'
    });
  });

  it('returns a failed result when Pi gateway startup throws', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'pi-runner-'));
    directories.push(workspacePath);
    const runner = new PiAgentRunner({
      gateway: new FailingPiGateway(),
      createTools: (agentRequest) =>
        new AgentToolRuntime({
          runId: agentRequest.runId,
          taskId: agentRequest.taskId,
          attemptId: agentRequest.attempt.id,
          agentId: agentRequest.attempt.agentId,
          workspacePath: agentRequest.workspace.workspacePath,
          resolveResource: (path) => ({ type: 'file', projectId: 'core', fileId: `core:${path}` }),
          resolveFileId: (path) => `core:${path}`,
          writeGuard: {
            acquire: async () => ({ status: 'blocked', conflictingLeaseIds: ['unused'] }),
            heartbeat: async () => ({ status: 'not-found' }),
            markStale: async () => ({ status: 'not-found' }),
            release: async () => ({ status: 'not-found' })
          },
          persistence: {
            createRun: async () => {},
            persistReevaluation: async () => {},
            persistDispatch: async () => {},
            persistImpact: async () => {},
            persistConflict: async () => {},
            persistLease: async () => {},
            persistWorkspace: async () => {},
            persistAttempt: async () => {},
            updateRunState: async () => {},
            recoverRun: async () => undefined,
            replayRun: async () => []
          }
        })
    });

    await expect(runner.run(request(workspacePath, async () => {}))).resolves.toEqual({
      status: 'failed',
      detail: 'Pi gateway failed.'
    });
  });

  it('returns a failed result when controlled tool construction throws', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'pi-runner-'));
    directories.push(workspacePath);
    const runner = new PiAgentRunner({
      gateway: new ScriptedPiGateway(),
      createTools: () => {
        throw new Error('Tool runtime construction failed.');
      }
    });

    await expect(runner.run(request(workspacePath, async () => {}))).resolves.toEqual({
      status: 'failed',
      detail: 'Tool runtime construction failed.'
    });
  });

  it('throws when Pi fails after durable session establishment', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'pi-runner-'));
    directories.push(workspacePath);
    const runner = new PiAgentRunner({
      gateway: new PostStartFailingPiGateway(),
      createTools: (agentRequest) =>
        new AgentToolRuntime({
          runId: agentRequest.runId,
          taskId: agentRequest.taskId,
          attemptId: agentRequest.attempt.id,
          agentId: agentRequest.attempt.agentId,
          workspacePath: agentRequest.workspace.workspacePath,
          resolveResource: (path) => ({ type: 'file', projectId: 'core', fileId: `core:${path}` }),
          resolveFileId: (path) => `core:${path}`,
          writeGuard: new InMemoryWriteGuard(),
          persistence: {
            createRun: async () => {},
            persistReevaluation: async () => {},
            persistDispatch: async () => {},
            persistImpact: async () => {},
            persistConflict: async () => {},
            persistLease: async () => {},
            persistWorkspace: async () => {},
            persistAttempt: async () => {},
            updateRunState: async () => {},
            recoverRun: async () => undefined,
            replayRun: async () => []
          }
        })
    });

    await expect(runner.run(request(workspacePath, async () => {}))).rejects.toThrow(
      'Pi connection lost.'
    );
  });

  it('returns completed after a denied non-mutating Pi tool request', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'pi-runner-'));
    directories.push(workspacePath);
    writeFileSync(join(workspacePath, 'value.txt'), 'before\n');
    const runner = new PiAgentRunner({
      gateway: new DeniedPiGateway(),
      createTools: (agentRequest) =>
        new AgentToolRuntime({
          runId: agentRequest.runId,
          taskId: agentRequest.taskId,
          attemptId: agentRequest.attempt.id,
          agentId: agentRequest.attempt.agentId,
          workspacePath: agentRequest.workspace.workspacePath,
          resolveResource: (path) => ({ type: 'file', projectId: 'core', fileId: `core:${path}` }),
          resolveFileId: (path) => `core:${path}`,
          writeGuard: {
            acquire: async () => ({ status: 'blocked', conflictingLeaseIds: ['unused'] }),
            heartbeat: async () => ({ status: 'not-found' }),
            markStale: async () => ({ status: 'not-found' }),
            release: async () => ({ status: 'not-found' })
          },
          persistence: {
            createRun: async () => {},
            persistReevaluation: async () => {},
            persistDispatch: async () => {},
            persistImpact: async () => {},
            persistConflict: async () => {},
            persistLease: async () => {},
            persistWorkspace: async () => {},
            persistAttempt: async () => {},
            updateRunState: async () => {},
            recoverRun: async () => undefined,
            replayRun: async () => []
          }
        })
    });

    await expect(runner.run(request(workspacePath, async () => {}))).resolves.toMatchObject({
      status: 'completed'
    });
    expect(readFileSync(join(workspacePath, 'value.txt'), 'utf8')).toBe('before\n');
  });
});
