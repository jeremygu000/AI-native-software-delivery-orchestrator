import type {
  CreatePersistedRunRequest,
  OrchestrationPersistence,
  PersistedReevaluation,
  PersistedTaskWorkspace,
  PersistedWriteLease,
  RecoveredRun,
  TaskContract,
  TaskWorkspace,
  WorkspaceManager,
  WriteGuard
} from '@ai-native-software-delivery-orchestrator/domain';
import { DrizzleSqliteOrchestrationPersistence } from '@ai-native-software-delivery-orchestrator/persistence';
import { InMemoryWriteGuard } from '@ai-native-software-delivery-orchestrator/runtime-guard';
import { DeterministicScheduler } from '@ai-native-software-delivery-orchestrator/scheduler';
import { describe, expect, it } from 'vitest';

import {
  FakeAgentRunner,
  FakeTaskVerifier,
  OrchestrationRuntime,
  OrchestrationRuntimeInputError,
  type RuntimeTaskBinding,
  type StartRuntimeRunRequest
} from './orchestration-runtime.js';

const task = (id: string, dependencies: readonly string[] = []): TaskContract => ({
  id,
  title: id,
  goal: `Complete ${id}`,
  dependencies: [...dependencies],
  expectedReads: [],
  expectedWrites: [],
  sharedResources: [],
  verification: []
});

class MemoryPersistence implements OrchestrationPersistence {
  request: CreatePersistedRunRequest | undefined;
  state: RecoveredRun['run']['state'] = 'ACTIVE';
  readonly reevaluations: PersistedReevaluation[] = [];
  readonly workspaces: PersistedTaskWorkspace[] = [];
  readonly leases: PersistedWriteLease[] = [];

  async createRun(request: CreatePersistedRunRequest): Promise<void> {
    this.request = request;
  }

  async persistReevaluation(reevaluation: PersistedReevaluation): Promise<void> {
    this.reevaluations.push(reevaluation);
  }

  async persistImpact(): Promise<void> {}

  async persistConflict(): Promise<void> {}

  async persistLease(record: PersistedWriteLease): Promise<void> {
    const index = this.leases.findIndex((entry) => entry.lease.id === record.lease.id);
    if (index >= 0) {
      this.leases[index] = record;
      return;
    }
    this.leases.push(record);
  }

  async persistWorkspace(record: PersistedTaskWorkspace): Promise<void> {
    const index = this.workspaces.findIndex((entry) => entry.workspace.id === record.workspace.id);
    if (index >= 0) {
      this.workspaces[index] = record;
      return;
    }
    this.workspaces.push(record);
  }

  async updateRunState(_runId: string, state: RecoveredRun['run']['state']): Promise<void> {
    this.state = state;
  }

  async recoverRun(runId: string): Promise<RecoveredRun | undefined> {
    if (this.request === undefined || this.request.run.id !== runId) {
      return undefined;
    }
    return {
      run: { ...this.request.run, state: this.state },
      tasks: this.request.tasks,
      hardConflicts: this.request.hardConflicts,
      riskConflicts: this.request.riskConflicts,
      scheduleOptions: this.request.scheduleOptions,
      events: this.reevaluations.map(({ event }) => event),
      transitions: this.reevaluations.flatMap(({ transitions }) => transitions),
      decisions: this.reevaluations.map(({ decision }) => decision),
      impacts: [],
      conflicts: [],
      leases: this.leases,
      workspaces: this.workspaces
    };
  }

  async replayRun(): Promise<readonly []> {
    return [];
  }
}

class MemoryWorkspaceManager implements WorkspaceManager {
  readonly created: TaskWorkspace[] = [];
  readonly integrationBlocks = new Set<string>();

  async create(request: Parameters<WorkspaceManager['create']>[0]): Promise<TaskWorkspace> {
    const existing = this.created.find((workspace) => workspace.id === request.id);
    if (existing !== undefined) {
      return existing;
    }
    const workspace: TaskWorkspace = { ...request, revision: 1, phase: 'READY_TO_INTEGRATE' };
    this.created.push(workspace);
    return workspace;
  }

  async integrate(workspace: TaskWorkspace) {
    if (this.integrationBlocks.has(workspace.taskId)) {
      return {
        status: 'blocked' as const,
        workspace: {
          ...workspace,
          revision: workspace.revision + 1,
          phase: 'INTEGRATION_BLOCKED' as const,
          blocker: { type: 'fast-forward-failed' as const, detail: 'Blocked.', conflictPaths: [] }
        }
      };
    }
    return {
      status: 'integrated' as const,
      workspace: {
        ...workspace,
        revision: workspace.revision + 1,
        phase: 'INTEGRATED' as const,
        integrationCommit: `commit-${workspace.taskId}`
      }
    };
  }

  async resumeIntegration(): Promise<never> {
    throw new Error('Not used by the local runtime.');
  }

  async abortIntegration(): Promise<never> {
    throw new Error('Not used by the local runtime.');
  }

  async dispose(): Promise<never> {
    throw new Error('Not used by the local runtime.');
  }
}

class MemoryWriteGuard implements WriteGuard {
  readonly blockedTaskIds = new Set<string>();
  readonly emptyBlockOwnerTaskIds = new Set<string>();
  readonly leases: PersistedWriteLease['lease'][] = [];

  async acquire(request: Parameters<WriteGuard['acquire']>[0]) {
    if (this.blockedTaskIds.has(request.taskId)) {
      return {
        status: 'blocked' as const,
        conflictingLeaseIds: this.emptyBlockOwnerTaskIds.has(request.taskId) ? [] : ['other-lease']
      };
    }
    const lease = {
      id: `lease-${request.taskId}`,
      runId: request.runId,
      agentId: request.agentId,
      taskId: request.taskId,
      resource: request.resource,
      mode: 'exclusive' as const,
      version: 1,
      state: 'ACTIVE' as const,
      acquiredAt: new Date('2026-08-12T00:00:00.000Z'),
      lastHeartbeatAt: new Date('2026-08-12T00:00:00.000Z')
    };
    this.leases.push(lease);
    return { status: 'granted' as const, lease };
  }

  async heartbeat(): Promise<never> {
    throw new Error('Not used by the local runtime.');
  }

  async markStale(): Promise<never> {
    throw new Error('Not used by the local runtime.');
  }

  async release(request: Parameters<WriteGuard['release']>[0]) {
    const lease = this.leases.find((candidate) => candidate.id === request.leaseId);
    if (lease === undefined || lease.version !== request.expectedVersion) {
      return { status: 'not-found' as const };
    }
    const released = {
      ...lease,
      version: 2,
      state: 'RELEASED' as const,
      releasedAt: new Date('2026-08-12T00:01:00.000Z')
    };
    this.leases[this.leases.indexOf(lease)] = released;
    return { status: 'released' as const, lease: released };
  }
}

const bindings = (taskIds: readonly string[]): readonly RuntimeTaskBinding[] =>
  taskIds.map((taskId) => ({
    taskId,
    agentId: `agent-${taskId}`,
    resource: { type: 'project', projectId: `project-${taskId}` },
    workspace: {
      id: `workspace-${taskId}`,
      runId: 'run-1',
      taskId,
      integrationRepositoryPath: '/integration',
      workspacePath: `/workspaces/${taskId}`,
      branchName: `orchestrator/run-1/${taskId}`,
      baseRef: 'main',
      integrationRef: 'main'
    }
  }));

const request = (tasks: readonly TaskContract[]): StartRuntimeRunRequest => ({
  run: {
    id: 'run-1',
    repositoryId: 'repository-1',
    state: 'ACTIVE',
    createdAt: '2026-08-12T00:00:00.000Z'
  },
  tasks,
  hardConflicts: [],
  riskConflicts: [],
  scheduleOptions: { maxConcurrency: 1 },
  taskBindings: bindings(tasks.map((entry) => entry.id))
});

const createRuntime = (
  persistence = new MemoryPersistence(),
  workspaceManager = new MemoryWorkspaceManager(),
  writeGuard = new MemoryWriteGuard(),
  agentRunner = new FakeAgentRunner(),
  verifier = new FakeTaskVerifier()
): OrchestrationRuntime =>
  new OrchestrationRuntime({
    scheduler: new DeterministicScheduler(),
    persistence,
    workspaceManager,
    writeGuard,
    agentRunner,
    verifier,
    now: () => new Date('2026-08-12T00:00:00.000Z')
  });

describe('OrchestrationRuntime', () => {
  it('executes a dependency chain through lease, fake agent, verification, and integration', async () => {
    const persistence = new MemoryPersistence();
    const runtime = createRuntime(persistence);

    const recovered = await runtime.startRun(request([task('A'), task('B', ['A'])]));

    expect(recovered.snapshot.taskStates).toEqual([
      { taskId: 'A', state: 'COMPLETED' },
      { taskId: 'B', state: 'COMPLETED' }
    ]);
    expect(recovered.workspaces.map(({ workspace }) => workspace.phase)).toEqual([
      'INTEGRATED',
      'INTEGRATED'
    ]);
    expect(recovered.leases.map(({ lease }) => lease.state)).toEqual(['RELEASED', 'RELEASED']);
    expect(persistence.reevaluations.map(({ event }) => event.event.type)).toEqual([
      'run-started',
      'agent-completed',
      'lease-released',
      'verification-completed',
      'workspace-integrated',
      'agent-completed',
      'lease-released',
      'verification-completed',
      'workspace-integrated'
    ]);
  });

  it('fails a task and lets the scheduler cancel its dependent after an agent failure', async () => {
    const persistence = new MemoryPersistence();
    const runtime = createRuntime(
      persistence,
      undefined,
      undefined,
      new FakeAgentRunner(new Map([['A', 'Agent failed.']]))
    );

    const recovered = await runtime.startRun(request([task('A'), task('B', ['A'])]));

    expect(recovered.snapshot.taskStates).toEqual([
      { taskId: 'A', state: 'FAILED' },
      { taskId: 'B', state: 'CANCELLED' }
    ]);
    expect(persistence.workspaces).toHaveLength(1);
  });

  it('fails a task after verification without attempting integration', async () => {
    const persistence = new MemoryPersistence();
    const workspaceManager = new MemoryWorkspaceManager();
    const runtime = createRuntime(
      persistence,
      workspaceManager,
      undefined,
      undefined,
      new FakeTaskVerifier(new Map([['A', 'Verification failed.']]))
    );

    const recovered = await runtime.startRun(request([task('A')]));

    expect(recovered.snapshot.taskStates).toEqual([{ taskId: 'A', state: 'FAILED' }]);
    expect(persistence.workspaces[0]?.workspace.phase).toBe('READY_TO_INTEGRATE');
  });

  it('persists runtime lease blocking evidence without running the agent', async () => {
    const persistence = new MemoryPersistence();
    const writeGuard = new MemoryWriteGuard();
    writeGuard.blockedTaskIds.add('A');
    const runtime = createRuntime(persistence, undefined, writeGuard);

    const recovered = await runtime.startRun(request([task('A')]));

    expect(recovered.snapshot).toEqual({
      taskStates: [{ taskId: 'A', state: 'BLOCKED' }],
      runtimeBlocks: [{ taskId: 'A', blockers: [{ type: 'lease', leaseId: 'other-lease' }] }]
    });
    expect(persistence.leases).toEqual([]);
    await expect(runtime.recoverRun('run-1')).resolves.toMatchObject({
      snapshot: { runtimeBlocks: [{ taskId: 'A', blockers: [{ leaseId: 'other-lease' }] }] }
    });
  });

  it('returns a blocked task when another run owns its write lease', async () => {
    const persistence = new MemoryPersistence();
    const writeGuard = new InMemoryWriteGuard({
      now: () => new Date('2026-08-12T00:00:00.000Z')
    });
    await writeGuard.acquire({
      runId: 'other-run',
      agentId: 'other-agent',
      taskId: 'other-task',
      resource: { type: 'project', projectId: 'project-A' },
      mode: 'exclusive'
    });
    const runtime = new OrchestrationRuntime({
      scheduler: new DeterministicScheduler(),
      persistence,
      workspaceManager: new MemoryWorkspaceManager(),
      writeGuard,
      agentRunner: new FakeAgentRunner(),
      verifier: new FakeTaskVerifier(),
      now: () => new Date('2026-08-12T00:00:00.000Z')
    });

    await expect(runtime.startRun(request([task('A')]))).resolves.toMatchObject({
      snapshot: {
        taskStates: [{ taskId: 'A', state: 'BLOCKED' }],
        runtimeBlocks: [{ taskId: 'A', blockers: [{ type: 'lease' }] }]
      }
    });
    expect(persistence.reevaluations.map(({ event }) => event.event.type)).toEqual([
      'run-started',
      'lease-blocked'
    ]);
  });

  it('removes a released runtime lease blocker from a recovered snapshot', async () => {
    const persistence = new MemoryPersistence();
    const runtime = createRuntime(persistence);
    await persistence.createRun(request([task('A')]));
    await persistence.persistReevaluation({
      event: {
        runId: 'run-1',
        sequence: 1,
        occurredAt: '2026-08-12T00:00:00.000Z',
        event: { type: 'lease-released', taskId: 'A', leaseId: 'lease-1' }
      },
      transitions: [],
      decision: {
        runId: 'run-1',
        sequence: 1,
        inputSnapshot: {
          taskStates: [{ taskId: 'A', state: 'BLOCKED' }],
          runtimeBlocks: [{ taskId: 'A', blockers: [{ type: 'lease', leaseId: 'lease-1' }] }]
        },
        decision: { taskDecisions: [] }
      }
    });

    await expect(runtime.recoverRun('run-1')).resolves.toMatchObject({
      snapshot: { taskStates: [{ taskId: 'A', state: 'BLOCKED' }], runtimeBlocks: [] },
      workspaces: [],
      leases: []
    });
  });

  it('persists a blocked integration workspace and leaves the task integrating for recovery', async () => {
    const persistence = new MemoryPersistence();
    const workspaceManager = new MemoryWorkspaceManager();
    workspaceManager.integrationBlocks.add('A');
    const runtime = createRuntime(persistence, workspaceManager);

    const recovered = await runtime.startRun(request([task('A')]));

    expect(recovered.snapshot.taskStates).toEqual([{ taskId: 'A', state: 'INTEGRATING' }]);
    expect(recovered.workspaces[0]?.workspace).toMatchObject({
      phase: 'INTEGRATION_BLOCKED',
      revision: 2
    });
  });

  it('recovers the latest scheduler snapshot and current evidence', async () => {
    const persistence = new MemoryPersistence();
    const runtime = createRuntime(persistence);
    await runtime.startRun(request([task('A')]));

    await expect(runtime.recoverRun('run-1')).resolves.toMatchObject({
      snapshot: { taskStates: [{ taskId: 'A', state: 'COMPLETED' }] },
      workspaces: [{ workspace: { phase: 'INTEGRATED' } }],
      leases: [{ lease: { state: 'RELEASED' } }]
    });
    await expect(runtime.recoverRun('missing')).resolves.toBeUndefined();
  });

  it('recovers an eventless persisted run without inventing runtime side effects', async () => {
    const persistence = new MemoryPersistence();
    await persistence.createRun(request([task('A')]));
    const runtime = createRuntime(persistence);

    await expect(runtime.recoverRun('run-1')).resolves.toMatchObject({
      snapshot: { taskStates: [{ taskId: 'A', state: 'PENDING' }], runtimeBlocks: [] },
      workspaces: [],
      leases: []
    });
  });

  it('rejects a persisted decision without its matching runtime event', async () => {
    const persistence = new MemoryPersistence();
    await persistence.createRun(request([task('A')]));
    persistence.reevaluations.push({
      event: {
        runId: 'run-1',
        sequence: 1,
        occurredAt: '2026-08-12T00:00:00.000Z',
        event: { type: 'run-started' }
      },
      transitions: [],
      decision: {
        runId: 'run-1',
        sequence: 2,
        inputSnapshot: { taskStates: [{ taskId: 'A', state: 'PENDING' }], runtimeBlocks: [] },
        decision: { taskDecisions: [] }
      }
    });
    const runtime = createRuntime(persistence);

    await expect(runtime.recoverRun('run-1')).rejects.toThrow(
      'Missing runtime event for persisted decision: run-1/2'
    );
  });

  it('persists and recovers a completed run through SQLite and the in-memory write guard', async () => {
    const persistence = new DrizzleSqliteOrchestrationPersistence();
    const runtime = new OrchestrationRuntime({
      scheduler: new DeterministicScheduler(),
      persistence,
      workspaceManager: new MemoryWorkspaceManager(),
      writeGuard: new InMemoryWriteGuard({
        now: () => new Date('2026-08-12T00:00:00.000Z')
      }),
      agentRunner: new FakeAgentRunner(),
      verifier: new FakeTaskVerifier(),
      now: () => new Date('2026-08-12T00:00:00.000Z')
    });

    await runtime.startRun(request([task('A')]));

    await expect(runtime.recoverRun('run-1')).resolves.toMatchObject({
      snapshot: { taskStates: [{ taskId: 'A', state: 'COMPLETED' }] },
      workspaces: [{ workspace: { phase: 'INTEGRATED', revision: 2 } }],
      leases: [{ lease: { state: 'RELEASED', version: 2 } }]
    });
    await expect(
      persistence.replayRun('run-1', new DeterministicScheduler())
    ).resolves.toHaveLength(5);
    persistence.close();
  });

  it('fails safely when a granted lease cannot be released', async () => {
    const persistence = new MemoryPersistence();
    const writeGuard = new MemoryWriteGuard();
    writeGuard.release = async () => ({ status: 'not-found' });
    const runtime = createRuntime(persistence, undefined, writeGuard);

    await expect(runtime.startRun(request([task('A')]))).rejects.toThrow(
      'Lease release failed for task A: not-found'
    );
    expect(persistence.reevaluations.map(({ event }) => event.event.type)).toEqual([
      'run-started',
      'agent-completed',
      'lease-release-failed'
    ]);
    await expect(runtime.recoverRun('run-1')).resolves.toMatchObject({
      run: { state: 'FAILED' },
      snapshot: { taskStates: [{ taskId: 'A', state: 'VERIFYING' }] },
      leases: [{ lease: { state: 'ACTIVE' } }]
    });
  });

  it('rejects a lease block that omits its conflicting owner', async () => {
    const writeGuard = new MemoryWriteGuard();
    writeGuard.blockedTaskIds.add('A');
    writeGuard.emptyBlockOwnerTaskIds.add('A');
    const runtime = createRuntime(undefined, undefined, writeGuard);

    await expect(runtime.startRun(request([task('A')]))).rejects.toThrow(
      'Lease block is missing an owner: A'
    );
  });

  it('rejects incomplete bindings and unsupported concurrent dispatch', async () => {
    const runtime = createRuntime();
    const oneTask = request([task('A')]);
    const binding = oneTask.taskBindings[0];
    const twoTasks = request([task('A'), task('B')]);
    const secondBinding = twoTasks.taskBindings[1];

    await expect(
      runtime.startRun({ ...oneTask, taskBindings: [], scheduleOptions: { maxConcurrency: 1 } })
    ).rejects.toThrow('Missing task binding: A');
    await expect(
      runtime.startRun({
        ...twoTasks,
        taskBindings: [
          twoTasks.taskBindings[0],
          { ...secondBinding, workspace: { ...secondBinding.workspace, taskId: 'A' } }
        ]
      })
    ).rejects.toThrow('Workspace binding must match run and task: B');
    await expect(
      runtime.startRun({
        ...oneTask,
        taskBindings: [...oneTask.taskBindings, { ...binding }]
      })
    ).rejects.toThrow('Duplicate task binding: A');
    await expect(
      runtime.startRun({
        ...oneTask,
        taskBindings: [...oneTask.taskBindings, { ...binding, taskId: 'unknown' }]
      })
    ).rejects.toThrow('Unknown task binding: unknown');
    await expect(
      runtime.startRun({ ...oneTask, scheduleOptions: { maxConcurrency: 2 } })
    ).rejects.toThrow('currently requires maxConcurrency of 1');
    expect(new OrchestrationRuntimeInputError('Invalid.').name).toBe(
      'OrchestrationRuntimeInputError'
    );
  });

  it('returns configured fake-agent and fake-verifier failures', async () => {
    const [binding] = bindings(['A']);
    const workspace = await new MemoryWorkspaceManager().create(binding.workspace);
    const fakeAgent = new FakeAgentRunner(new Map([['A', 'Agent failure.']]));
    const fakeVerifier = new FakeTaskVerifier(new Map([['A', 'Verification failure.']]));

    await expect(fakeAgent.run({ runId: 'run-1', task: task('A'), workspace })).resolves.toEqual({
      status: 'failed',
      detail: 'Agent failure.'
    });
    await expect(
      fakeVerifier.verify({ runId: 'run-1', task: task('A'), workspace })
    ).resolves.toEqual({
      status: 'failed',
      detail: 'Verification failure.'
    });
  });
});
