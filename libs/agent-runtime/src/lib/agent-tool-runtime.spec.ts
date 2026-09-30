import type {
  OrchestrationPersistence,
  WriteGuard,
  WriteLease
} from '@ai-native-software-delivery-orchestrator/domain';
import { FencedMutationPort as MutationPort } from '@ai-native-software-delivery-orchestrator/domain';
import { InMemoryWriteGuard } from '@ai-native-software-delivery-orchestrator/runtime-guard';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentToolDeniedError, AgentToolRuntime } from './agent-tool-runtime.js';

const directories: string[] = [];

class LeasePersistence implements Pick<OrchestrationPersistence, 'persistImpact' | 'persistLease'> {
  readonly leases: Parameters<OrchestrationPersistence['persistLease']>[0][] = [];
  readonly impacts: Parameters<OrchestrationPersistence['persistImpact']>[0][] = [];

  async persistLease(
    record: Parameters<OrchestrationPersistence['persistLease']>[0]
  ): Promise<void> {
    this.leases.push(record);
  }

  async persistImpact(
    record: Parameters<OrchestrationPersistence['persistImpact']>[0]
  ): Promise<void> {
    this.impacts.push(record);
  }
}

const createTools = (
  workspacePath: string,
  writeGuard: WriteGuard,
  persistence: LeasePersistence,
  mutation?: ConstructorParameters<typeof AgentToolRuntime>[0]['mutation'],
  workspaceId?: string
) =>
  new AgentToolRuntime({
    runId: 'run-1',
    taskId: 'task-1',
    attemptId: 'attempt-1',
    agentId: 'agent-1',
    ...(workspaceId === undefined ? {} : { workspaceId }),
    workspacePath,
    writeGuard,
    ...(mutation === undefined ? {} : { mutation }),
    persistence: {
      createRun: async () => {},
      persistReevaluation: async () => {},
      persistDispatch: async () => {},
      persistImpact: (record) => persistence.persistImpact(record),
      persistConflict: async () => {},
      persistLease: (record) => persistence.persistLease(record),
      persistWorkspace: async () => {},
      persistAttempt: async () => {},
      updateRunState: async () => {},
      recoverRun: async () => undefined,
      recoverTaskBindings: async () => [],
      recoverTaskBinding: async () => undefined,
      replayRun: async () => [],
      recoverDispatches: async () => [],
      recoverAttempts: async () => [],
      recoverLeases: async () => [],
      persistIntegration: async () => {},
      recoverIntegration: async () => undefined,
      persistRepairResumeDispatch: async () => {},
      recoverRepairResumeDispatches: async () => []
    },
    resolveResource: (path) => ({ type: 'file', projectId: 'core', fileId: `core:${path}` }),
    resolveFileId: (path) => `core:${path}`
  });

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('AgentToolRuntime', () => {
  it('rejects a durable claim for a different attempt before creating tools', () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'agent-tools-'));
    directories.push(workspacePath);
    expect(() =>
      createTools(workspacePath, new InMemoryWriteGuard(), new LeasePersistence(), {
        onMutationUncertain: async () => {},
        port: new MutationPort({
          beginFencedMutation: async () => ({ id: 'permit-1', completionSecret: 'secret' }),
          endFencedMutation: async () => {}
        }),
        claim: {
          scopeId: 'scope-1',
          claimId: 'claim-1',
          token: 1,
          owner: { runId: 'run-1', taskId: 'task-1', attemptId: 'other', agentId: 'agent-1' }
        }
      })
    ).toThrow('Durable mutation owner does not match the agent attempt');
  });

  it('rejects a workspace-bound claim when physical workspace identity is absent or mismatched', () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'agent-tools-'));
    directories.push(workspacePath);
    const mutation = {
      onMutationUncertain: async () => {},
      port: new MutationPort({
        beginFencedMutation: async () => ({ id: 'permit-1', completionSecret: 'secret' }),
        endFencedMutation: async () => {}
      }),
      claim: {
        scopeId: 'scope-1',
        claimId: 'claim-1',
        token: 1,
        owner: {
          runId: 'run-1',
          taskId: 'task-1',
          attemptId: 'attempt-1',
          agentId: 'agent-1',
          workspaceId: 'workspace-1'
        }
      }
    };
    expect(() =>
      createTools(workspacePath, new InMemoryWriteGuard(), new LeasePersistence(), mutation)
    ).toThrow('Durable mutation owner does not match the agent attempt');
    expect(() =>
      createTools(
        workspacePath,
        new InMemoryWriteGuard(),
        new LeasePersistence(),
        mutation,
        'workspace-2'
      )
    ).toThrow('Durable mutation owner does not match the agent attempt');
    expect(() =>
      createTools(
        workspacePath,
        new InMemoryWriteGuard(),
        new LeasePersistence(),
        mutation,
        'workspace-1'
      )
    ).not.toThrow();
  });

  it('fences a file edit inside a live permit and rejects stale writes before reading or changing content', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'agent-tools-'));
    directories.push(workspacePath);
    writeFileSync(join(workspacePath, 'value.txt'), 'before\n');
    const calls: string[] = [];
    let current = true;
    const port = new MutationPort({
      beginFencedMutation: async (request) => {
        calls.push(`begin:${request.resource.type}`);
        if (!current) {
          throw new Error('stale token');
        }
        return { id: 'permit-1', completionSecret: 'secret' };
      },
      endFencedMutation: async () => {
        calls.push('end');
      }
    });
    const tools = createTools(workspacePath, new InMemoryWriteGuard(), new LeasePersistence(), {
      onMutationUncertain: async () => {},
      port,
      claim: {
        scopeId: 'scope-1',
        claimId: 'claim-1',
        token: 1,
        owner: { runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1', agentId: 'agent-1' }
      }
    });

    await tools.edit('value.txt', 'before', 'after');
    expect(readFileSync(join(workspacePath, 'value.txt'), 'utf8')).toBe('after\n');
    expect(calls).toEqual(['begin:file', 'end']);
    current = false;
    await expect(tools.edit('value.txt', 'after', 'stale')).rejects.toThrow('stale token');
    await expect(tools.write('value.txt', 'stale\n')).rejects.toThrow('stale token');
    expect(readFileSync(join(workspacePath, 'value.txt'), 'utf8')).toBe('after\n');
    expect(calls).toEqual(['begin:file', 'end', 'begin:file', 'begin:file']);
  });

  it('reports a failed impact record after a file write before ending its permit', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'agent-tools-'));
    directories.push(workspacePath);
    writeFileSync(join(workspacePath, 'value.txt'), 'before');
    const persistence = new LeasePersistence();
    persistence.persistImpact = async () => {
      throw new Error('impact failed');
    };
    const sequence: string[] = [];
    const tools = createTools(workspacePath, new InMemoryWriteGuard(), persistence, {
      port: new MutationPort({
        beginFencedMutation: async () => ({ id: 'permit', completionSecret: 'secret' }),
        endFencedMutation: async () => {
          sequence.push('permit ended');
        }
      }),
      claim: {
        scopeId: 'scope-1',
        claimId: 'claim-1',
        token: 1,
        owner: { runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1', agentId: 'agent-1' }
      },
      onMutationUncertain: async () => {
        sequence.push('claim held uncertain');
      }
    });
    await expect(tools.edit('value.txt', 'before', 'after')).rejects.toThrow('impact failed');
    expect(readFileSync(join(workspacePath, 'value.txt'), 'utf8')).toBe('after');
    expect(sequence).toEqual(['claim held uncertain', 'permit ended']);
  });

  it('retains ownership when a repository command fails after starting or permit completion fails', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'agent-tools-'));
    directories.push(workspacePath);
    const sequence: string[] = [];
    let completionFails = false;
    const tools = createTools(workspacePath, new InMemoryWriteGuard(), new LeasePersistence(), {
      port: new MutationPort({
        beginFencedMutation: async () => ({ id: 'permit', completionSecret: 'secret' }),
        endFencedMutation: async () => {
          sequence.push('permit ended');
          if (completionFails) {
            throw new Error('completion failed');
          }
        }
      }),
      claim: {
        scopeId: 'scope-1',
        claimId: 'claim-1',
        token: 1,
        owner: { runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1', agentId: 'agent-1' }
      },
      onMutationUncertain: async () => {
        sequence.push('claim held uncertain');
      }
    });
    await expect(
      tools.executeRepositoryMutation(async () => {
        sequence.push('command started');
        throw new Error('partial command failure');
      })
    ).rejects.toThrow('partial command failure');
    expect(sequence).toEqual(['command started', 'claim held uncertain', 'permit ended']);

    completionFails = true;
    await expect(tools.executeRepositoryMutation(async () => 'completed')).rejects.toThrow(
      'completion failed'
    );
    expect(sequence).toEqual([
      'command started',
      'claim held uncertain',
      'permit ended',
      'permit ended',
      'claim held uncertain'
    ]);
  });

  it('holds the permit through persisted impact and refuses repository commands without repository-wide authority', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'agent-tools-'));
    directories.push(workspacePath);
    writeFileSync(join(workspacePath, 'value.txt'), 'before\n');
    let finishImpact: (() => void) | undefined;
    const impactPending = new Promise<void>((resolve) => {
      finishImpact = resolve;
    });
    let impactStarted: (() => void) | undefined;
    const impactEntered = new Promise<void>((resolve) => {
      impactStarted = resolve;
    });
    const persistence = new LeasePersistence();
    persistence.persistImpact = async (record) => {
      impactStarted?.();
      await impactPending;
      persistence.impacts.push(record);
    };
    const ended = vi.fn(async () => {});
    const begin = vi.fn(async (request: Parameters<MutationPort['execute']>[0]) => {
      if (request.resource.type === 'repository') {
        throw new Error('repository lease required');
      }
      return { id: 'permit-1', completionSecret: 'secret' };
    });
    const tools = createTools(workspacePath, new InMemoryWriteGuard(), persistence, {
      onMutationUncertain: async () => {},
      port: new MutationPort({ beginFencedMutation: begin, endFencedMutation: ended }),
      claim: {
        scopeId: 'scope-1',
        claimId: 'claim-1',
        token: 1,
        owner: { runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1', agentId: 'agent-1' }
      }
    });

    const writing = tools.write('value.txt', 'after\n');
    await impactEntered;
    expect(readFileSync(join(workspacePath, 'value.txt'), 'utf8')).toBe('after\n');
    expect(ended).not.toHaveBeenCalled();
    const command = vi.fn(async () => 'executed');
    await expect(tools.executeRepositoryMutation(command)).rejects.toThrow(
      'repository lease required'
    );
    expect(command).not.toHaveBeenCalled();
    finishImpact?.();
    await expect(writing).resolves.toEqual({ status: 'written', path: 'value.txt' });
    expect(ended).toHaveBeenCalledOnce();
    expect(persistence.leases).toEqual([]);
    expect(begin.mock.calls.map(([request]) => request.resource.type)).toEqual([
      'file',
      'repository'
    ]);
  });
  it('edits only through a persisted write lease and records observed impact', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'agent-tools-'));
    directories.push(workspacePath);
    writeFileSync(join(workspacePath, 'value.txt'), 'before\n');
    writeFileSync(join(workspacePath, 'alpha.txt'), 'alpha\n');
    writeFileSync(join(workspacePath, 'zeta.txt'), 'zeta\n');
    const persistence = new LeasePersistence();
    const tools = createTools(workspacePath, new InMemoryWriteGuard(), persistence);

    await expect(tools.list()).resolves.toEqual(['alpha.txt', 'value.txt', 'zeta.txt']);
    await expect(tools.list('')).resolves.toEqual(['alpha.txt', 'value.txt', 'zeta.txt']);
    await expect(tools.read('value.txt')).resolves.toBe('before\n');
    await expect(tools.find('value.txt', 'before')).resolves.toEqual([1]);
    await expect(tools.find('value.txt', 'missing')).resolves.toEqual([]);
    await expect(tools.edit('value.txt', 'before', 'after')).resolves.toEqual({
      status: 'written',
      path: 'value.txt'
    });
    expect(readFileSync(join(workspacePath, 'value.txt'), 'utf8')).toBe('after\n');
    expect(persistence.leases).toMatchObject([
      { lease: { state: 'ACTIVE', resource: { type: 'file' } } }
    ]);
    expect(tools.observedImpact()).toMatchObject({
      filesRead: new Set(['core:', 'core:value.txt']),
      filesWritten: new Set(['core:value.txt'])
    });
    expect(persistence.impacts).toMatchObject([
      {
        impact: {
          observed: {
            filesRead: new Set(['core:', 'core:value.txt']),
            filesWritten: new Set(['core:value.txt'])
          }
        }
      }
    ]);
  });

  it('rejects paths outside the scoped workspace', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'agent-tools-'));
    directories.push(workspacePath);
    const tools = createTools(workspacePath, new InMemoryWriteGuard(), new LeasePersistence());

    await expect(tools.read('../outside.txt')).rejects.toThrow(AgentToolDeniedError);
    await expect(tools.write('.', 'invalid')).rejects.toThrow(AgentToolDeniedError);
    await expect(tools.list('..')).rejects.toThrow(AgentToolDeniedError);
  });

  it('rejects symlink paths that resolve outside the scoped workspace', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'agent-tools-'));
    const outsidePath = mkdtempSync(join(tmpdir(), 'agent-tools-outside-'));
    directories.push(workspacePath, outsidePath);
    writeFileSync(join(outsidePath, 'outside.txt'), 'outside\n');
    symlinkSync(outsidePath, join(workspacePath, 'escape'));
    const tools = createTools(workspacePath, new InMemoryWriteGuard(), new LeasePersistence());

    await expect(tools.read('escape/outside.txt')).rejects.toThrow(AgentToolDeniedError);
    await expect(tools.write('escape/new.txt', 'invalid\n')).rejects.toThrow(AgentToolDeniedError);
    expect(readFileSync(join(outsidePath, 'outside.txt'), 'utf8')).toBe('outside\n');
  });

  it('rejects an unresolvable symlink in the scoped workspace', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'agent-tools-'));
    directories.push(workspacePath);
    symlinkSync('loop', join(workspacePath, 'loop'));
    const tools = createTools(workspacePath, new InMemoryWriteGuard(), new LeasePersistence());

    await expect(tools.read('loop')).rejects.toThrow(AgentToolDeniedError);
  });

  it('rejects empty, missing, and ambiguous edit text', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'agent-tools-'));
    directories.push(workspacePath);
    writeFileSync(join(workspacePath, 'value.txt'), 'same same\n');
    const tools = createTools(workspacePath, new InMemoryWriteGuard(), new LeasePersistence());

    await expect(tools.find('value.txt', '')).rejects.toThrow('Search text must not be empty');
    await expect(tools.edit('value.txt', '', 'after')).rejects.toThrow(
      'Expected edit text must not be empty'
    );
    await expect(tools.edit('value.txt', 'missing', 'after')).rejects.toThrow(
      'Expected edit text was not found'
    );
    await expect(tools.edit('value.txt', 'same', 'after')).rejects.toThrow(
      'Expected edit text is ambiguous'
    );
  });

  it('acquires write authority before reading edit content', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'agent-tools-'));
    directories.push(workspacePath);
    writeFileSync(join(workspacePath, 'value.txt'), 'before\n');
    const tools = createTools(
      workspacePath,
      {
        acquire: async (request) => {
          writeFileSync(join(workspacePath, 'value.txt'), 'new\n');
          return {
            status: 'granted' as const,
            lease: {
              id: 'lease-1',
              runId: request.runId,
              taskId: request.taskId,
              agentId: request.agentId,
              resource: request.resource,
              mode: 'exclusive' as const,
              version: 1,
              state: 'ACTIVE' as const,
              acquiredAt: new Date('2026-08-14T00:00:00.000Z'),
              lastHeartbeatAt: new Date('2026-08-14T00:00:00.000Z')
            }
          };
        },
        heartbeat: async () => ({ status: 'not-found' }),
        markStale: async () => ({ status: 'not-found' }),
        release: async () => ({ status: 'not-found' })
      },
      new LeasePersistence()
    );

    await expect(tools.edit('value.txt', 'new', 'after')).resolves.toEqual({
      status: 'written',
      path: 'value.txt'
    });
    expect(readFileSync(join(workspacePath, 'value.txt'), 'utf8')).toBe('after\n');
  });

  it('reuses its acquired lease for repeated writes to one resource', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'agent-tools-'));
    directories.push(workspacePath);
    writeFileSync(join(workspacePath, 'value.txt'), 'before\n');
    const persistence = new LeasePersistence();
    const tools = createTools(workspacePath, new InMemoryWriteGuard(), persistence);

    await tools.write('value.txt', 'first\n');
    await tools.write('value.txt', 'second\n');

    expect(persistence.leases).toHaveLength(1);
    expect(readFileSync(join(workspacePath, 'value.txt'), 'utf8')).toBe('second\n');
  });

  it('uses an owned broader lease without acquiring a redundant child lease', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'agent-tools-'));
    directories.push(workspacePath);
    writeFileSync(join(workspacePath, 'value.txt'), 'before\n');
    const writeGuard = new InMemoryWriteGuard();
    const lease: WriteLease = {
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
    };
    const acquire = vi.spyOn(writeGuard, 'acquire');
    const persistence = new LeasePersistence();
    const tools = new AgentToolRuntime({
      runId: 'run-1',
      taskId: 'task-1',
      attemptId: 'attempt-1',
      agentId: 'agent-1',
      workspacePath,
      initialLeases: [lease],
      writeGuard,
      persistence: {
        createRun: async () => {},
        persistReevaluation: async () => {},
        persistDispatch: async () => {},
        persistImpact: (record) => persistence.persistImpact(record),
        persistConflict: async () => {},
        persistLease: (record) => persistence.persistLease(record),
        persistWorkspace: async () => {},
        persistAttempt: async () => {},
        updateRunState: async () => {},
        recoverRun: async () => undefined,
        recoverTaskBindings: async () => [],
        recoverTaskBinding: async () => undefined,
        replayRun: async () => [],
        recoverDispatches: async () => [],
        recoverAttempts: async () => [],
        recoverLeases: async () => [],
        persistIntegration: async () => {},
        recoverIntegration: async () => undefined,
        persistRepairResumeDispatch: async () => {},
        recoverRepairResumeDispatches: async () => []
      },
      resolveResource: (path) => ({ type: 'file', projectId: 'core', fileId: `core:${path}` }),
      resolveFileId: (path) => `core:${path}`
    });

    await expect(tools.write('value.txt', 'after\n')).resolves.toEqual({
      status: 'written',
      path: 'value.txt'
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(tools.leases()).toEqual([]);
    expect(readFileSync(join(workspacePath, 'value.txt'), 'utf8')).toBe('after\n');
  });

  it('records actual files even when a write uses a non-file lease resource', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'agent-tools-'));
    directories.push(workspacePath);
    writeFileSync(join(workspacePath, 'value.txt'), 'before\n');
    const persistence = new LeasePersistence();
    const tools = new AgentToolRuntime({
      runId: 'run-1',
      taskId: 'task-1',
      attemptId: 'attempt-1',
      agentId: 'agent-1',
      workspacePath,
      writeGuard: new InMemoryWriteGuard(),
      persistence: {
        createRun: async () => {},
        persistReevaluation: async () => {},
        persistDispatch: async () => {},
        persistImpact: async () => {},
        persistConflict: async () => {},
        persistLease: (record) => persistence.persistLease(record),
        persistWorkspace: async () => {},
        persistAttempt: async () => {},
        updateRunState: async () => {},
        recoverRun: async () => undefined,
        recoverTaskBindings: async () => [],
        recoverTaskBinding: async () => undefined,
        replayRun: async () => [],
        recoverDispatches: async () => [],
        recoverAttempts: async () => [],
        recoverLeases: async () => [],
        persistIntegration: async () => {},
        recoverIntegration: async () => undefined,
        persistRepairResumeDispatch: async () => {},
        recoverRepairResumeDispatches: async () => []
      },
      resolveResource: () => ({ type: 'shared-resource', resourceId: 'generated-output' }),
      resolveFileId: (path) => `core:${path}`
    });

    await tools.write('value.txt', 'after\n');
    expect(tools.observedImpact()).toMatchObject({ filesWritten: new Set(['core:value.txt']) });
  });

  it('rejects a malformed blocked lease result', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'agent-tools-'));
    directories.push(workspacePath);
    writeFileSync(join(workspacePath, 'value.txt'), 'before\n');
    const tools = createTools(
      workspacePath,
      {
        acquire: async () => ({ status: 'blocked', conflictingLeaseIds: [] }),
        heartbeat: async () => ({ status: 'not-found' }),
        markStale: async () => ({ status: 'not-found' }),
        release: async () => ({ status: 'not-found' })
      },
      new LeasePersistence()
    );

    await expect(tools.write('value.txt', 'after\n')).rejects.toThrow(
      'Write lease block is missing an owner'
    );
  });

  it('returns blocked without writing when another agent owns the resource', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'agent-tools-'));
    directories.push(workspacePath);
    writeFileSync(join(workspacePath, 'value.txt'), 'before\n');
    const guard = new InMemoryWriteGuard();
    await guard.acquire({
      runId: 'other-run',
      agentId: 'other-agent',
      taskId: 'other-task',
      resource: { type: 'file', projectId: 'core', fileId: 'core:value.txt' },
      mode: 'exclusive'
    });
    const tools = createTools(workspacePath, guard, new LeasePersistence());

    await expect(tools.write('value.txt', 'after\n')).resolves.toEqual({
      status: 'blocked',
      leaseId: 'lease-1'
    });
    expect(readFileSync(join(workspacePath, 'value.txt'), 'utf8')).toBe('before\n');
  });
});
