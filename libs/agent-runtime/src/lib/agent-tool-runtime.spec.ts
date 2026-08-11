import type {
  OrchestrationPersistence,
  WriteGuard,
  WriteLease
} from '@ai-native-software-delivery-orchestrator/domain';
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
  persistence: LeasePersistence
) =>
  new AgentToolRuntime({
    runId: 'run-1',
    taskId: 'task-1',
    attemptId: 'attempt-1',
    agentId: 'agent-1',
    workspacePath,
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
      replayRun: async () => []
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
    expect(tools.observedImpact()).toMatchObject({ filesWritten: new Set(['core:value.txt']) });
    expect(persistence.impacts).toMatchObject([
      { impact: { observed: { filesWritten: new Set(['core:value.txt']) } } }
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
        replayRun: async () => []
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
        replayRun: async () => []
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
