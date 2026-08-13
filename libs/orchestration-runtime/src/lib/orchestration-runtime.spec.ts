import type {
  AgentRunner,
  CreatePersistedRunRequest,
  OrchestrationPersistence,
  PersistedReevaluation,
  PersistedDispatch,
  PersistedTaskConflict,
  PersistedTaskImpact,
  PersistedAgentExecutionAttempt,
  PersistedTaskWorkspace,
  PersistedWriteLease,
  RecoveredRun,
  TaskContract,
  TaskVerifier,
  TaskWorkspace,
  WorkspaceManager,
  WriteGuard
} from '@ai-native-software-delivery-orchestrator/domain';
import {
  agentCommandPolicyFingerprint,
  defaultAgentCommandTrustedPath
} from '@ai-native-software-delivery-orchestrator/domain';
import {
  AgentToolRuntime,
  PiAgentRunner,
  type PiSessionGateway
} from '@ai-native-software-delivery-orchestrator/agent-runtime';
import { DrizzleSqliteOrchestrationPersistence } from '@ai-native-software-delivery-orchestrator/persistence';
import { InMemoryWriteGuard } from '@ai-native-software-delivery-orchestrator/runtime-guard';
import { DeterministicScheduler } from '@ai-native-software-delivery-orchestrator/scheduler';
import { GitWorkspaceManager } from '@ai-native-software-delivery-orchestrator/workspace-git';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

const leasePlanFingerprint = JSON.stringify({
  taskId: 'A',
  source: 'manual',
  resources: [{ type: 'project', projectId: 'project-A' }]
});

const directories: string[] = [];

const git = (cwd: string, args: readonly string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const createRepository = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'orchestration-runtime-'));
  directories.push(directory);
  git(directory, ['init', '--initial-branch=main']);
  git(directory, ['config', 'user.email', 'test@example.com']);
  git(directory, ['config', 'user.name', 'Test User']);
  writeFileSync(join(directory, 'value.txt'), 'base\n');
  git(directory, ['add', 'value.txt']);
  git(directory, ['commit', '-m', 'base']);
  return directory;
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
    rmSync(`${directory}-workspace-A`, { recursive: true, force: true });
  }
});

class MemoryPersistence implements OrchestrationPersistence {
  request: CreatePersistedRunRequest | undefined;
  state: RecoveredRun['run']['state'] = 'ACTIVE';
  readonly reevaluations: PersistedReevaluation[] = [];
  readonly workspaces: PersistedTaskWorkspace[] = [];
  readonly leases: PersistedWriteLease[] = [];
  readonly attempts: PersistedAgentExecutionAttempt[] = [];
  readonly impacts: PersistedTaskImpact[] = [];
  readonly conflicts: PersistedTaskConflict[] = [];

  async createRun(request: CreatePersistedRunRequest): Promise<void> {
    this.request = request;
  }

  async persistReevaluation(reevaluation: PersistedReevaluation): Promise<void> {
    this.reevaluations.push(reevaluation);
    for (const conflict of reevaluation.runtimeConflicts ?? []) {
      await this.persistConflict(conflict);
    }
  }

  async persistDispatch(dispatch: PersistedDispatch): Promise<void> {
    await this.persistReevaluation(dispatch.reevaluation);
    for (const attempt of dispatch.attempts) {
      await this.persistAttempt(attempt);
    }
  }

  async persistImpact(record: PersistedTaskImpact): Promise<void> {
    this.impacts.push(record);
  }

  async persistConflict(record: PersistedTaskConflict): Promise<void> {
    this.conflicts.push(record);
  }

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

  async persistAttempt(record: PersistedAgentExecutionAttempt): Promise<void> {
    const index = this.attempts.findIndex((entry) => entry.attempt.id === record.attempt.id);
    if (index >= 0) {
      this.attempts[index] = record;
      return;
    }
    this.attempts.push(record);
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
      impacts: this.impacts,
      conflicts: this.conflicts,
      leases: this.leases,
      workspaces: this.workspaces,
      attempts: this.attempts
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

  async commit(request: Parameters<WorkspaceManager['commit']>[0]): Promise<TaskWorkspace> {
    return request.workspace;
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
    leasePlan: {
      taskId,
      predictedResources: [{ type: 'project', projectId: `project-${taskId}` }],
      source: 'manual'
    },
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
    createdAt: '2026-08-12T00:00:00.000Z',
    authority: {
      artifactId: 'plan-1',
      artifactRevision: 1,
      approvalId: 'approval-1',
      planFingerprint: `sha256:${'1'.repeat(64)}`,
      approvalFingerprint: `sha256:${'2'.repeat(64)}`,
      claimFingerprint: `sha256:${'3'.repeat(64)}`,
      executionFingerprint: `sha256:${'4'.repeat(64)}`,
      repositoryRoot: '/repository',
      baseCommit: '5'.repeat(40),
      workingTreeFingerprint: `sha256:${'6'.repeat(64)}`,
      repositoryFactsFingerprint: `sha256:${'7'.repeat(64)}`,
      sharedResourcePolicyFingerprint: `sha256:${'8'.repeat(64)}`,
      verificationPolicyFingerprint: `sha256:${'9'.repeat(64)}`
    }
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
  agentRunner: AgentRunner = new FakeAgentRunner(),
  verifier: TaskVerifier = new FakeTaskVerifier()
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

class ConcurrentAgentRunner implements AgentRunner {
  readonly started: string[] = [];
  #release: (() => void) | undefined;
  readonly #bothStarted = new Promise<void>((resolve) => {
    this.#release = resolve;
  });

  async run(agentRequest: Parameters<AgentRunner['run']>[0]) {
    this.started.push(agentRequest.taskId);
    await agentRequest.onStarted({
      sessionRef: { backend: 'fake', value: `session-${agentRequest.taskId}` }
    });
    if (this.started.length === 2) {
      this.#release?.();
    }
    await this.#bothStarted;
    return { status: 'completed' as const };
  }
}

describe('OrchestrationRuntime', () => {
  it('fails before verification when reconciliation finds an unleased change', async () => {
    const persistence = new MemoryPersistence();
    const verifier = new FakeTaskVerifier();
    const runtime = new OrchestrationRuntime({
      scheduler: new DeterministicScheduler(),
      persistence,
      workspaceManager: new MemoryWorkspaceManager(),
      writeGuard: new MemoryWriteGuard(),
      agentRunner: new FakeAgentRunner(),
      verifier,
      impactReconciler: {
        reconcile: async ({ taskId }) => ({
          observed: {
            taskId,
            filesRead: new Set(),
            filesCreated: new Set(),
            filesWritten: new Set(['project-A:unleased.txt']),
            filesDeleted: new Set(),
            symbolsWritten: new Set(),
            dependencyRequests: new Set(),
            manifestFilesChanged: new Set(),
            generatedFilesChanged: new Set()
          },
          reconciliation: {
            status: 'unleased-change',
            expandedFileIds: new Set(['project-A:unleased.txt']),
            unleasedFileIds: new Set(['project-A:unleased.txt'])
          }
        })
      }
    });

    await expect(runtime.startRun(request([task('A')]))).resolves.toMatchObject({
      run: { state: 'FAILED' },
      snapshot: { taskStates: [{ taskId: 'A', state: 'FAILED' }] }
    });
    expect(persistence.impacts).toMatchObject([
      { impact: { reconciliation: { status: 'unleased-change' } } }
    ]);
    expect(persistence.leases).toMatchObject([{ lease: { state: 'RELEASED' } }]);
  });

  it('persists a hard conflict for leased scope expansion before verification', async () => {
    const persistence = new MemoryPersistence();
    const runtime = new OrchestrationRuntime({
      scheduler: new DeterministicScheduler(),
      persistence,
      workspaceManager: new MemoryWorkspaceManager(),
      writeGuard: new MemoryWriteGuard(),
      agentRunner: new FakeAgentRunner(),
      verifier: new FakeTaskVerifier(),
      impactReconciler: {
        reconcile: async ({ taskId }) => ({
          observed: {
            taskId,
            filesRead: new Set(),
            filesCreated: new Set(['project-B:overlap.txt']),
            filesWritten: new Set(['project-B:overlap.txt']),
            filesDeleted: new Set(),
            symbolsWritten: new Set(),
            dependencyRequests: new Set(),
            manifestFilesChanged: new Set(),
            generatedFilesChanged: new Set()
          },
          reconciliation: {
            status: 'runtime-scope-expanded',
            expandedFileIds: new Set(['project-B:overlap.txt']),
            unleasedFileIds: new Set()
          },
          expandedResources: [
            { type: 'file', projectId: 'project-B', fileId: 'project-B:overlap.txt' }
          ]
        })
      }
    });
    const baseRun = request([task('A'), task('B')]);
    const run: StartRuntimeRunRequest = {
      ...baseRun,
      taskBindings: baseRun.taskBindings.map((binding) =>
        binding.taskId === 'B'
          ? {
              ...binding,
              impact: {
                predicted: {
                  taskId: 'B',
                  projectsRead: new Set<string>(),
                  projectsWritten: new Set<string>(),
                  explicitProjectsWritten: new Set<string>(),
                  filesRead: new Set<string>(),
                  filesWritten: new Set(['project-B:overlap.txt']),
                  explicitFilesWritten: new Set(['project-B:overlap.txt']),
                  globFilesWritten: new Set<string>(),
                  symbolDerivedFilesWritten: new Set<string>(),
                  symbolsRead: new Set<string>(),
                  symbolsWritten: new Set<string>(),
                  sharedResources: new Set<string>(),
                  sharedResourceAccesses: [],
                  downstreamProjects: new Set<string>(),
                  riskSignals: []
                }
              }
            }
          : binding
      )
    };

    await expect(runtime.startRun(run)).resolves.toMatchObject({ run: { state: 'COMPLETED' } });
    expect(persistence.conflicts).toMatchObject([
      {
        taskA: 'A',
        taskB: 'B',
        conflict: { severity: 'hard', constraints: [{ type: 'runtime-scope-expansion' }] }
      }
    ]);
  });

  it('detects expansion against another task project-wide lease plan', async () => {
    const persistence = new MemoryPersistence();
    const runtime = new OrchestrationRuntime({
      scheduler: new DeterministicScheduler(),
      persistence,
      workspaceManager: new MemoryWorkspaceManager(),
      writeGuard: new MemoryWriteGuard(),
      agentRunner: new FakeAgentRunner(),
      verifier: new FakeTaskVerifier(),
      impactReconciler: {
        reconcile: async ({ taskId }) => ({
          observed: {
            taskId,
            filesRead: new Set(),
            filesCreated: new Set(['project-B:new.txt']),
            filesWritten: new Set(['project-B:new.txt']),
            filesDeleted: new Set(),
            symbolsWritten: new Set(),
            dependencyRequests: new Set(),
            manifestFilesChanged: new Set(),
            generatedFilesChanged: new Set()
          },
          reconciliation: {
            status: 'runtime-scope-expanded',
            expandedFileIds: new Set(['project-B:new.txt']),
            unleasedFileIds: new Set()
          },
          expandedResources: [{ type: 'file', projectId: 'project-B', fileId: 'project-B:new.txt' }]
        })
      }
    });
    const baseRun = request([task('A'), task('B')]);
    const run: StartRuntimeRunRequest = {
      ...baseRun,
      taskBindings: baseRun.taskBindings.map((binding) =>
        binding.taskId === 'B'
          ? {
              ...binding,
              leasePlan: {
                taskId: 'B',
                source: 'manual',
                predictedResources: [{ type: 'project', projectId: 'project-B' }]
              }
            }
          : binding
      )
    };

    await runtime.startRun(run);

    expect(persistence.conflicts).toMatchObject([
      {
        taskA: 'A',
        taskB: 'B',
        conflict: {
          constraints: [{ type: 'runtime-scope-expansion', resourceIds: ['project-B:new.txt'] }]
        }
      }
    ]);
  });

  it('runs independent task agents concurrently while serializing lifecycle operations', async () => {
    const persistence = new MemoryPersistence();
    const agent = new ConcurrentAgentRunner();
    const runtime = createRuntime(persistence, undefined, undefined, agent);
    const run = request([task('A'), task('B')]);

    await expect(
      runtime.startRun({
        ...run,
        scheduleOptions: { maxConcurrency: 2 }
      })
    ).resolves.toMatchObject({
      snapshot: {
        taskStates: [
          { taskId: 'A', state: 'COMPLETED' },
          { taskId: 'B', state: 'COMPLETED' }
        ]
      }
    });
    expect(agent.started).toEqual(['A', 'B']);
  });

  it('blocks a conflicting concurrent task before its agent starts', async () => {
    const persistence = new MemoryPersistence();
    const started: string[] = [];
    const agent: AgentRunner = {
      run: async (agentRequest) => {
        started.push(agentRequest.taskId);
        await agentRequest.onStarted({
          sessionRef: { backend: 'fake', value: `session-${agentRequest.taskId}` }
        });
        return { status: 'completed' };
      }
    };
    const guard = new MemoryWriteGuard();
    guard.blockedTaskIds.add('B');
    const runtime = createRuntime(persistence, undefined, guard, agent);
    const run = request([task('A'), task('B')]);
    const [first, second] = run.taskBindings;

    await expect(
      runtime.startRun({
        ...run,
        scheduleOptions: { maxConcurrency: 2 },
        taskBindings: [first, second]
      })
    ).resolves.toMatchObject({
      snapshot: {
        taskStates: [
          { taskId: 'A', state: 'COMPLETED' },
          { taskId: 'B', state: 'BLOCKED' }
        ]
      }
    });
    expect(started).toEqual(['A']);
    expect(persistence.reevaluations.map(({ event }) => event.event.type)).toContain(
      'lease-blocked'
    );
  });

  it('releases the lifecycle queue after one concurrent agent fails before establishment', async () => {
    const persistence = new MemoryPersistence();
    const started: string[] = [];
    const agent: AgentRunner = {
      run: async (agentRequest) => {
        started.push(agentRequest.taskId);
        if (agentRequest.taskId === 'A') {
          throw new Error('Agent A preparation failed.');
        }
        await agentRequest.onStarted({ sessionRef: { backend: 'fake', value: 'session-B' } });
        return { status: 'completed' };
      }
    };
    const runtime = createRuntime(persistence, undefined, undefined, agent);
    const run = request([task('A'), task('B')]);

    await expect(
      runtime.startRun({
        ...run,
        scheduleOptions: { maxConcurrency: 2 }
      })
    ).rejects.toThrow('Agent runner failed for task A: Agent A preparation failed.');
    expect(started).toContain('B');
  });

  it('waits for started concurrent agents to settle before returning a fatal error', async () => {
    const persistence = new MemoryPersistence();
    let releaseB: (() => void) | undefined;
    const bFinished = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    let runSettled = false;
    const agent: AgentRunner = {
      run: async (agentRequest) => {
        if (agentRequest.taskId === 'A') {
          throw new Error('Agent A failed.');
        }
        await agentRequest.onStarted({ sessionRef: { backend: 'fake', value: 'session-B' } });
        await bFinished;
        return { status: 'completed' };
      }
    };
    const runtime = createRuntime(persistence, undefined, undefined, agent);
    const run = request([task('A'), task('B')]);
    const execution = runtime
      .startRun({ ...run, scheduleOptions: { maxConcurrency: 2 } })
      .finally(() => {
        runSettled = true;
      });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(runSettled).toBe(false);
    releaseB?.();
    await expect(execution).rejects.toThrow('Agent runner failed for task A: Agent A failed.');
  });

  it('releases the lifecycle queue after workspace preparation throws', async () => {
    const persistence = new MemoryPersistence();
    const started: string[] = [];
    const workspaceManager = new MemoryWorkspaceManager();
    const create = workspaceManager.create.bind(workspaceManager);
    workspaceManager.create = async (workspace) => {
      if (workspace.taskId === 'A') {
        throw new Error('Workspace A preparation failed.');
      }
      return create(workspace);
    };
    const agent: AgentRunner = {
      run: async (agentRequest) => {
        started.push(agentRequest.taskId);
        await agentRequest.onStarted({ sessionRef: { backend: 'fake', value: 'session-B' } });
        return { status: 'completed' };
      }
    };
    const runtime = createRuntime(persistence, workspaceManager, undefined, agent);
    const run = request([task('A'), task('B')]);

    await expect(
      runtime.startRun({
        ...run,
        scheduleOptions: { maxConcurrency: 2 }
      })
    ).rejects.toThrow('Workspace A preparation failed.');
    expect(started).toContain('B');
  });

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
    expect(
      recovered.attempts.map(({ attempt }) => [attempt.taskId, attempt.state, attempt.revision])
    ).toEqual([
      ['A', 'COMPLETED', 4],
      ['B', 'COMPLETED', 4]
    ]);
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

  it('marks an interrupted external attempt unknown during recovery', async () => {
    const persistence = new MemoryPersistence();
    await persistence.createRun(request([task('A')]));
    const commandPolicy = {
      commands: [
        {
          id: 'check-types',
          executable: 'pnpm',
          args: ['typecheck'],
          effect: 'validation' as const,
          timeoutMs: 30_000,
          maxOutputBytes: 10_000
        }
      ],
      environment: {}
    };
    await persistence.persistDispatch({
      reevaluation: {
        event: {
          runId: 'run-1',
          sequence: 1,
          occurredAt: '2026-08-12T00:00:00.000Z',
          event: { type: 'run-started' }
        },
        transitions: [
          { runId: 'run-1', sequence: 1, taskId: 'A', fromState: 'PENDING', toState: 'READY' },
          { runId: 'run-1', sequence: 1, taskId: 'A', fromState: 'READY', toState: 'RUNNING' }
        ],
        decision: {
          runId: 'run-1',
          sequence: 1,
          inputSnapshot: { taskStates: [{ taskId: 'A', state: 'PENDING' }], runtimeBlocks: [] },
          decision: {
            taskDecisions: [
              {
                taskId: 'A',
                action: 'ready',
                fromState: 'PENDING',
                toState: 'READY',
                reasons: [{ type: 'dependencies-completed', dependencyTaskIds: [] }]
              },
              {
                taskId: 'A',
                action: 'start',
                fromState: 'READY',
                toState: 'RUNNING',
                reasons: [{ type: 'selected-by-priority', priority: 0 }]
              }
            ]
          }
        }
      },
      attempts: [
        {
          runId: 'run-1',
          attempt: {
            id: 'attempt-A',
            runId: 'run-1',
            taskId: 'A',
            agentId: 'agent-A',
            workspaceId: 'workspace-A',
            leasePlanFingerprint,
            commandPolicyFingerprint: agentCommandPolicyFingerprint(commandPolicy),
            trustedCommandPath: '/toolchain-v1/bin',
            state: 'PREPARING',
            revision: 1
          }
        }
      ]
    });
    await persistence.persistAttempt({
      runId: 'run-1',
      attempt: {
        id: 'attempt-A',
        runId: 'run-1',
        taskId: 'A',
        agentId: 'agent-A',
        workspaceId: 'workspace-A',
        leasePlanFingerprint,
        state: 'STARTING',
        revision: 2,
        startedAt: new Date('2026-08-12T00:00:00.000Z')
      }
    });
    const runtime = createRuntime(persistence);

    await expect(runtime.recoverRun('run-1')).resolves.toMatchObject({
      snapshot: { taskStates: [{ taskId: 'A', state: 'RUNNING' }] },
      attempts: [
        {
          attempt: {
            state: 'UNKNOWN',
            revision: 3,
            failure: { type: 'unknown-outcome' }
          }
        }
      ]
    });
  });

  it('reapplies persisted runtime scope conflicts before resuming dispatch', async () => {
    const persistence = new MemoryPersistence();
    const run = request([task('A'), task('B')]);
    await persistence.createRun(run);
    await persistence.persistReevaluation({
      event: {
        runId: 'run-1',
        sequence: 1,
        occurredAt: '2026-08-12T00:00:00.000Z',
        event: { type: 'agent-completed', taskId: 'A', state: 'VERIFYING' }
      },
      transitions: [],
      decision: {
        runId: 'run-1',
        sequence: 1,
        inputSnapshot: {
          taskStates: [
            { taskId: 'A', state: 'VERIFYING' },
            { taskId: 'B', state: 'READY' }
          ],
          runtimeBlocks: []
        },
        decision: { taskDecisions: [] }
      }
    });
    await persistence.persistConflict({
      runId: 'run-1',
      taskA: 'A',
      taskB: 'B',
      conflict: {
        taskA: 'A',
        taskB: 'B',
        score: 100,
        severity: 'hard',
        reasons: [
          {
            type: 'same-file',
            score: 100,
            detail: 'Observed runtime scope overlaps another task predicted write scope.',
            resourceIds: ['project-B:overlap.txt']
          }
        ],
        constraints: [
          {
            type: 'runtime-scope-expansion',
            detail: 'Observed runtime scope expansion must be reconciled before future dispatch.',
            resourceIds: ['project-B:overlap.txt']
          }
        ],
        recommendedAction: 'serialize'
      }
    });
    const dispatch = vi.fn<AgentRunner['run']>();
    const runtime = createRuntime(persistence, undefined, undefined, { run: dispatch });

    await expect(runtime.startOrResumeRun(run)).resolves.toMatchObject({
      snapshot: {
        taskStates: [
          { taskId: 'A', state: 'VERIFYING' },
          { taskId: 'B', state: 'READY' }
        ]
      }
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(persistence.reevaluations.at(-1)).toMatchObject({
      event: { event: { type: 'runtime-reconciliation-recovered' } },
      decision: {
        decision: {
          taskDecisions: expect.arrayContaining([
            {
              taskId: 'B',
              action: 'defer',
              reasons: [
                {
                  type: 'hard-conflict',
                  conflictingTaskIds: ['A'],
                  constraintTypes: ['runtime-scope-expansion']
                }
              ]
            }
          ])
        }
      }
    });
  });

  it('serializes concurrent PREPARING recovery without dispatching the agent twice', async () => {
    const persistence = new MemoryPersistence();
    await persistence.createRun(request([task('A')]));
    await persistence.persistDispatch({
      reevaluation: {
        event: {
          runId: 'run-1',
          sequence: 1,
          occurredAt: '2026-08-12T00:00:00.000Z',
          event: { type: 'run-started' }
        },
        transitions: [
          { runId: 'run-1', sequence: 1, taskId: 'A', fromState: 'PENDING', toState: 'READY' },
          { runId: 'run-1', sequence: 1, taskId: 'A', fromState: 'READY', toState: 'RUNNING' }
        ],
        decision: {
          runId: 'run-1',
          sequence: 1,
          inputSnapshot: { taskStates: [{ taskId: 'A', state: 'PENDING' }], runtimeBlocks: [] },
          decision: {
            taskDecisions: [
              {
                taskId: 'A',
                action: 'ready',
                fromState: 'PENDING',
                toState: 'READY',
                reasons: [{ type: 'dependencies-completed', dependencyTaskIds: [] }]
              },
              {
                taskId: 'A',
                action: 'start',
                fromState: 'READY',
                toState: 'RUNNING',
                reasons: [{ type: 'selected-by-priority', priority: 0 }]
              }
            ]
          }
        }
      },
      attempts: [
        {
          runId: 'run-1',
          attempt: {
            id: 'attempt-A',
            runId: 'run-1',
            taskId: 'A',
            agentId: 'agent-A',
            workspaceId: 'workspace-A',
            leasePlanFingerprint,
            commandPolicyFingerprint: agentCommandPolicyFingerprint(undefined),
            trustedCommandPath: defaultAgentCommandTrustedPath,
            state: 'PREPARING',
            revision: 1
          }
        }
      ]
    });
    const runAgent = vi.fn(async (agentRequest: Parameters<AgentRunner['run']>[0]) => {
      await agentRequest.onStarted({});
      return { status: 'completed' as const };
    });
    const createResumingRuntime = () =>
      new OrchestrationRuntime({
        scheduler: new DeterministicScheduler(),
        persistence,
        workspaceManager: new MemoryWorkspaceManager(),
        writeGuard: new MemoryWriteGuard(),
        agentRunner: { run: runAgent },
        verifier: new FakeTaskVerifier(),
        now: () => new Date('2026-08-12T00:00:00.000Z')
      });
    const firstRuntime = createResumingRuntime();
    const secondRuntime = createResumingRuntime();

    const runRequest = request([task('A')]);
    const [first, second] = await Promise.all([
      firstRuntime.startOrResumeRun(runRequest),
      secondRuntime.startOrResumeRun(runRequest)
    ]);

    expect(first).toMatchObject({
      snapshot: { taskStates: [{ taskId: 'A', state: 'COMPLETED' }] },
      attempts: [{ attempt: { state: 'COMPLETED', revision: 4 } }]
    });
    expect(second.run.state).toBe('COMPLETED');
    expect(runAgent).toHaveBeenCalledOnce();
    expect(persistence.reevaluations[0]?.event.sequence).toBe(1);
  });

  it('records a definite agent failure when runner throws before onStarted', async () => {
    const persistence = new MemoryPersistence();
    const throwingAgent: AgentRunner = {
      run: async () => {
        throw new Error('Provider unavailable.');
      }
    };
    const runtime = createRuntime(persistence, undefined, undefined, throwingAgent);

    await expect(runtime.startRun(request([task('A')]))).rejects.toThrow(
      'Agent runner failed for task A: Provider unavailable.'
    );
    await expect(runtime.recoverRun('run-1')).resolves.toMatchObject({
      run: { state: 'FAILED' },
      snapshot: { taskStates: [{ taskId: 'A', state: 'FAILED' }] },
      attempts: [{ attempt: { state: 'FAILED', failure: { type: 'execution-failed' } } }],
      leases: [{ lease: { state: 'RELEASED' } }]
    });
  });

  it('records an unknown outcome when runner throws after onStarted', async () => {
    const persistence = new MemoryPersistence();
    const throwingAgent: AgentRunner = {
      run: async (agentRequest) => {
        await agentRequest.onStarted({ sessionRef: { backend: 'fake', value: 'session-A' } });
        throw new Error('Provider connection lost.');
      }
    };
    const runtime = createRuntime(persistence, undefined, undefined, throwingAgent);

    await expect(runtime.startRun(request([task('A')]))).rejects.toThrow(
      'Agent runner failed for task A: Provider connection lost.'
    );
    await expect(runtime.recoverRun('run-1')).resolves.toMatchObject({
      run: { state: 'FAILED' },
      snapshot: { taskStates: [{ taskId: 'A', state: 'RUNNING' }] },
      attempts: [{ attempt: { state: 'UNKNOWN', failure: { type: 'unknown-outcome' } } }],
      leases: [{ lease: { state: 'ACTIVE' } }]
    });
  });

  it('records an unknown outcome when Pi disconnects after onStarted', async () => {
    const persistence = new MemoryPersistence();
    const gateway: PiSessionGateway = {
      start: async ({ onStarted }) => {
        await onStarted('pi-session-1');
        throw new Error('Pi connection lost.');
      }
    };
    const runtime = createRuntime(
      persistence,
      undefined,
      undefined,
      new PiAgentRunner({
        gateway,
        createTools: (agentRequest) =>
          new AgentToolRuntime({
            runId: agentRequest.runId,
            taskId: agentRequest.taskId,
            attemptId: agentRequest.attempt.id,
            agentId: agentRequest.attempt.agentId,
            workspacePath: agentRequest.workspace.workspacePath,
            writeGuard: new InMemoryWriteGuard(),
            persistence,
            resolveResource: (path) => ({
              type: 'file',
              projectId: 'core',
              fileId: `core:${path}`
            }),
            resolveFileId: (path) => `core:${path}`
          })
      })
    );

    await expect(runtime.startRun(request([task('A')]))).rejects.toThrow(
      'Agent runner failed for task A: Pi connection lost.'
    );
    await expect(runtime.recoverRun('run-1')).resolves.toMatchObject({
      snapshot: { taskStates: [{ taskId: 'A', state: 'RUNNING' }] },
      attempts: [
        { attempt: { state: 'UNKNOWN', sessionRef: { backend: 'pi', value: 'pi-session-1' } } }
      ],
      leases: [{ lease: { state: 'ACTIVE' } }]
    });
  });

  const prepareRecoveryIdentity = async () => {
    const persistence = new MemoryPersistence();
    await persistence.createRun(request([task('A')]));
    const commandPolicy = {
      commands: [
        {
          id: 'check-types',
          executable: 'pnpm',
          args: ['typecheck'],
          effect: 'validation' as const,
          timeoutMs: 30_000,
          maxOutputBytes: 10_000
        }
      ],
      environment: {}
    };
    await persistence.persistDispatch({
      reevaluation: {
        event: {
          runId: 'run-1',
          sequence: 1,
          occurredAt: '2026-08-12T00:00:00.000Z',
          event: { type: 'run-started' }
        },
        transitions: [
          { runId: 'run-1', sequence: 1, taskId: 'A', fromState: 'PENDING', toState: 'READY' },
          { runId: 'run-1', sequence: 1, taskId: 'A', fromState: 'READY', toState: 'RUNNING' }
        ],
        decision: {
          runId: 'run-1',
          sequence: 1,
          inputSnapshot: { taskStates: [{ taskId: 'A', state: 'PENDING' }], runtimeBlocks: [] },
          decision: {
            taskDecisions: [
              {
                taskId: 'A',
                action: 'ready',
                fromState: 'PENDING',
                toState: 'READY',
                reasons: [{ type: 'dependencies-completed', dependencyTaskIds: [] }]
              },
              {
                taskId: 'A',
                action: 'start',
                fromState: 'READY',
                toState: 'RUNNING',
                reasons: [{ type: 'selected-by-priority', priority: 0 }]
              }
            ]
          }
        }
      },
      attempts: [
        {
          runId: 'run-1',
          attempt: {
            id: 'attempt-A',
            runId: 'run-1',
            taskId: 'A',
            agentId: 'agent-A',
            workspaceId: 'workspace-A',
            leasePlanFingerprint,
            commandPolicyFingerprint: agentCommandPolicyFingerprint(commandPolicy),
            trustedCommandPath: '/toolchain-v1/bin',
            state: 'PREPARING',
            revision: 1
          }
        }
      ]
    });
    const run = request([task('A')]);
    const binding = run.taskBindings[0];
    return { persistence, run, binding, commandPolicy };
  };

  it('rejects PREPARING recovery when durable agent identity differs', async () => {
    const { persistence, run, binding, commandPolicy } = await prepareRecoveryIdentity();
    await expect(
      createRuntime(persistence).recoverAndResumeRun({
        ...run,
        taskBindings: [
          { ...binding, commandPolicy, trustedCommandPath: '/toolchain-v1/bin', agentId: 'agent-B' }
        ]
      })
    ).rejects.toThrow('Recovery binding does not match durable attempt: A');
  });

  it('rejects PREPARING recovery when command policy differs', async () => {
    const { persistence, run, binding } = await prepareRecoveryIdentity();
    await expect(
      createRuntime(persistence).recoverAndResumeRun({
        ...run,
        taskBindings: [
          {
            ...binding,
            commandPolicy: {
              commands: [
                {
                  id: 'check-types',
                  executable: 'pnpm',
                  args: ['typecheck'],
                  effect: 'validation',
                  timeoutMs: 30_000,
                  maxOutputBytes: 10_000
                }
              ],
              environment: { CI: '1' }
            }
          }
        ]
      })
    ).rejects.toThrow('Recovery binding does not match durable attempt: A');
  });

  it('rejects PREPARING recovery when command environment differs', async () => {
    const { persistence, run, binding, commandPolicy } = await prepareRecoveryIdentity();
    await expect(
      createRuntime(persistence).recoverAndResumeRun({
        ...run,
        taskBindings: [
          {
            ...binding,
            commandPolicy: {
              ...commandPolicy,
              environment: { CI: '1' }
            }
          }
        ]
      })
    ).rejects.toThrow('Recovery binding does not match durable attempt: A');
  });

  it('rejects PREPARING recovery when workspace identity differs', async () => {
    const { persistence, run, binding, commandPolicy } = await prepareRecoveryIdentity();
    await expect(
      createRuntime(persistence).recoverAndResumeRun({
        ...run,
        taskBindings: [
          {
            ...binding,
            commandPolicy,
            trustedCommandPath: '/toolchain-v1/bin',
            workspace: { ...binding.workspace, id: 'workspace-B' }
          }
        ]
      })
    ).rejects.toThrow('Recovery binding does not match durable attempt: A');
  });

  it('rejects PREPARING recovery when lease plan differs', async () => {
    const { persistence, run, binding, commandPolicy } = await prepareRecoveryIdentity();
    await expect(
      createRuntime(persistence).recoverAndResumeRun({
        ...run,
        taskBindings: [
          {
            ...binding,
            commandPolicy,
            trustedCommandPath: '/toolchain-v1/bin',
            leasePlan: {
              ...binding.leasePlan,
              source: 'runtime-derived'
            }
          }
        ]
      })
    ).rejects.toThrow('Recovery binding does not match durable attempt: A');
  });

  it('rejects PREPARING recovery when trusted command path differs', async () => {
    const { persistence, run, binding, commandPolicy } = await prepareRecoveryIdentity();
    await expect(
      createRuntime(persistence).recoverAndResumeRun({
        ...run,
        taskBindings: [{ ...binding, commandPolicy, trustedCommandPath: '/toolchain-v2/bin' }]
      })
    ).rejects.toThrow('Recovery binding does not match durable attempt: A');
  });

  it('resumes PREPARING recovery when durable identity matches', async () => {
    const { persistence, run, binding, commandPolicy } = await prepareRecoveryIdentity();
    await expect(
      createRuntime(persistence).recoverAndResumeRun({
        ...run,
        taskBindings: [{ ...binding, commandPolicy, trustedCommandPath: '/toolchain-v1/bin' }]
      })
    ).resolves.toMatchObject({ snapshot: { taskStates: [{ taskId: 'A', state: 'COMPLETED' }] } });
  });

  it('rejects a legacy PREPARING attempt without command authority identity', async () => {
    const persistence = new MemoryPersistence();
    await persistence.createRun(request([task('A')]));
    await persistence.persistDispatch({
      reevaluation: {
        event: {
          runId: 'run-1',
          sequence: 1,
          occurredAt: '2026-08-12T00:00:00.000Z',
          event: { type: 'run-started' }
        },
        transitions: [
          { runId: 'run-1', sequence: 1, taskId: 'A', fromState: 'PENDING', toState: 'READY' },
          { runId: 'run-1', sequence: 1, taskId: 'A', fromState: 'READY', toState: 'RUNNING' }
        ],
        decision: {
          runId: 'run-1',
          sequence: 1,
          inputSnapshot: { taskStates: [{ taskId: 'A', state: 'PENDING' }], runtimeBlocks: [] },
          decision: { taskDecisions: [] }
        }
      },
      attempts: [
        {
          runId: 'run-1',
          attempt: {
            id: 'attempt-A',
            runId: 'run-1',
            taskId: 'A',
            agentId: 'agent-A',
            workspaceId: 'workspace-A',
            leasePlanFingerprint,
            state: 'PREPARING',
            revision: 1
          }
        }
      ]
    });

    await expect(
      createRuntime(persistence).recoverAndResumeRun(request([task('A')]))
    ).rejects.toThrow('Recovery binding does not match durable attempt: A');
  });

  it('rejects an invalid command policy before dispatching an agent', async () => {
    let runs = 0;
    const runtime = createRuntime(undefined, undefined, undefined, {
      run: async () => {
        runs += 1;
        return { status: 'completed' };
      }
    });
    const run = request([task('A')]);
    const binding = run.taskBindings[0];

    await expect(
      runtime.startRun({
        ...run,
        taskBindings: [
          {
            ...binding,
            commandPolicy: {
              commands: [
                {
                  id: 'check-types',
                  executable: 'pnpm',
                  args: ['typecheck'],
                  timeoutMs: 1,
                  maxOutputBytes: 1
                }
              ],
              environment: { PATH: '/unsafe' }
            }
          }
        ]
      })
    ).rejects.toThrow();
    expect(runs).toBe(0);
  });

  it('turns a completed result without onStarted into a durable failed attempt', async () => {
    const persistence = new MemoryPersistence();
    const invalidAgent: AgentRunner = {
      run: async () => ({ status: 'completed' })
    };
    const runtime = createRuntime(persistence, undefined, undefined, invalidAgent);

    await expect(runtime.startRun(request([task('A')]))).rejects.toThrow(
      'Agent execution did not establish: A'
    );
    await expect(runtime.recoverRun('run-1')).resolves.toMatchObject({
      run: { state: 'FAILED' },
      snapshot: { taskStates: [{ taskId: 'A', state: 'FAILED' }] },
      attempts: [{ attempt: { state: 'FAILED', failure: { type: 'execution-failed' } } }],
      leases: [{ lease: { state: 'RELEASED' } }]
    });
  });

  it('releases earlier leases when a later canonical lease is blocked', async () => {
    const persistence = new MemoryPersistence();
    const writeGuard = new InMemoryWriteGuard({
      now: () => new Date('2026-08-12T00:00:00.000Z'),
      createLeaseId: (() => {
        let number = 1;
        return () => `lease-${number++}`;
      })()
    });
    await writeGuard.acquire({
      runId: 'other-run',
      agentId: 'other-agent',
      taskId: 'other-task',
      resource: { type: 'shared-resource', resourceId: 'lockfile' },
      mode: 'exclusive'
    });
    const runtime = new OrchestrationRuntime({
      scheduler: new DeterministicScheduler(),
      persistence,
      workspaceManager: new MemoryWorkspaceManager(),
      writeGuard,
      agentRunner: new FakeAgentRunner(),
      verifier: new FakeTaskVerifier(),
      now: () => new Date('2026-08-12T00:00:00.000Z'),
      createAttemptId: () => 'attempt-A'
    });
    const run = request([task('A')]);
    const binding = run.taskBindings[0];

    await expect(
      runtime.startRun({
        ...run,
        taskBindings: [
          {
            ...binding,
            leasePlan: {
              taskId: 'A',
              predictedResources: [
                { type: 'project', projectId: 'core' },
                { type: 'shared-resource', resourceId: 'lockfile' }
              ],
              source: 'manual'
            }
          }
        ]
      })
    ).resolves.toMatchObject({ snapshot: { taskStates: [{ taskId: 'A', state: 'BLOCKED' }] } });
    expect(persistence.leases).toMatchObject([{ lease: { id: 'lease-2', state: 'RELEASED' } }]);
    expect(persistence.attempts).toMatchObject([{ attempt: { state: 'PREPARING', revision: 1 } }]);
  });

  it('releases multiple acquired leases in reverse canonical order when a later lease is blocked', async () => {
    const persistence = new MemoryPersistence();
    const calls: string[] = [];
    const writeGuard: WriteGuard = {
      acquire: async (acquireRequest) => {
        calls.push(`acquire:${acquireRequest.resource.type}`);
        if (acquireRequest.resource.type === 'shared-resource') {
          return { status: 'blocked', conflictingLeaseIds: ['other-lease'] };
        }
        const lease = {
          id: `lease-${acquireRequest.resource.type}`,
          runId: acquireRequest.runId,
          agentId: acquireRequest.agentId,
          taskId: acquireRequest.taskId,
          resource: acquireRequest.resource,
          mode: 'exclusive' as const,
          version: 1,
          state: 'ACTIVE' as const,
          acquiredAt: new Date('2026-08-12T00:00:00.000Z'),
          lastHeartbeatAt: new Date('2026-08-12T00:00:00.000Z')
        };
        return { status: 'granted', lease };
      },
      release: async (releaseRequest) => {
        calls.push(`release:${releaseRequest.leaseId}`);
        const type = releaseRequest.leaseId.replace('lease-', '');
        return {
          status: 'released' as const,
          lease: {
            id: releaseRequest.leaseId,
            runId: 'run-1',
            agentId: 'agent-A',
            taskId: 'A',
            resource:
              type === 'project'
                ? { type: 'project' as const, projectId: 'core' }
                : { type: 'file' as const, projectId: 'core', fileId: 'core:index' },
            mode: 'exclusive' as const,
            version: 2,
            state: 'RELEASED' as const,
            acquiredAt: new Date('2026-08-12T00:00:00.000Z'),
            lastHeartbeatAt: new Date('2026-08-12T00:00:00.000Z'),
            releasedAt: new Date('2026-08-12T00:01:00.000Z')
          }
        };
      },
      heartbeat: async () => ({ status: 'not-found' }),
      markStale: async () => ({ status: 'not-found' })
    };
    const runtime = new OrchestrationRuntime({
      scheduler: new DeterministicScheduler(),
      persistence,
      workspaceManager: new MemoryWorkspaceManager(),
      writeGuard,
      agentRunner: new FakeAgentRunner(),
      verifier: new FakeTaskVerifier(),
      now: () => new Date('2026-08-12T00:00:00.000Z'),
      createAttemptId: () => 'attempt-A'
    });
    const run = request([task('A')]);
    const binding = run.taskBindings[0];

    await expect(
      runtime.startRun({
        ...run,
        taskBindings: [
          {
            ...binding,
            leasePlan: {
              taskId: 'A',
              predictedResources: [
                { type: 'shared-resource', resourceId: 'lockfile' },
                { type: 'file', projectId: 'core', fileId: 'core:index' },
                { type: 'project', projectId: 'core' }
              ],
              source: 'manual'
            }
          }
        ]
      })
    ).resolves.toMatchObject({ snapshot: { taskStates: [{ taskId: 'A', state: 'BLOCKED' }] } });
    expect(calls).toEqual([
      'acquire:project',
      'acquire:file',
      'acquire:shared-resource',
      'release:lease-file',
      'release:lease-project'
    ]);
    expect(persistence.leases.map(({ lease }) => [lease.id, lease.state])).toEqual([
      ['lease-project', 'RELEASED'],
      ['lease-file', 'RELEASED']
    ]);
  });

  it('fails safely when an earlier lease cannot be rolled back after a later lease is blocked', async () => {
    const persistence = new MemoryPersistence();
    const writeGuard = new InMemoryWriteGuard({
      now: () => new Date('2026-08-12T00:00:00.000Z'),
      createLeaseId: (() => {
        let number = 1;
        return () => `lease-${number++}`;
      })()
    });
    await writeGuard.acquire({
      runId: 'other-run',
      agentId: 'other-agent',
      taskId: 'other-task',
      resource: { type: 'shared-resource', resourceId: 'lockfile' },
      mode: 'exclusive'
    });
    writeGuard.release = async () => ({ status: 'not-found' });
    const runtime = new OrchestrationRuntime({
      scheduler: new DeterministicScheduler(),
      persistence,
      workspaceManager: new MemoryWorkspaceManager(),
      writeGuard,
      agentRunner: new FakeAgentRunner(),
      verifier: new FakeTaskVerifier(),
      now: () => new Date('2026-08-12T00:00:00.000Z'),
      createAttemptId: () => 'attempt-A'
    });
    const run = request([task('A')]);
    const binding = run.taskBindings[0];

    await expect(
      runtime.startRun({
        ...run,
        taskBindings: [
          {
            ...binding,
            leasePlan: {
              taskId: 'A',
              predictedResources: [
                { type: 'project', projectId: 'core' },
                { type: 'shared-resource', resourceId: 'lockfile' }
              ],
              source: 'manual'
            }
          }
        ]
      })
    ).rejects.toThrow('Lease rollback failed for task A: not-found');
    expect(persistence.reevaluations.map(({ event }) => event.event.type)).toEqual([
      'run-started',
      'lease-release-failed'
    ]);
    expect(persistence.leases).toMatchObject([{ lease: { id: 'lease-2', state: 'ACTIVE' } }]);
    await expect(runtime.recoverRun('run-1')).resolves.toMatchObject({
      run: { state: 'FAILED' },
      leases: [{ lease: { id: 'lease-2', state: 'ACTIVE' } }]
    });
  });

  it('recovers an ACTIVE orphaned lease from real SQLite after rollback failure', async () => {
    const persistence = new DrizzleSqliteOrchestrationPersistence();
    const writeGuard = new InMemoryWriteGuard({
      now: () => new Date('2026-08-12T00:00:00.000Z'),
      createLeaseId: (() => {
        let number = 1;
        return () => `lease-${number++}`;
      })()
    });
    await writeGuard.acquire({
      runId: 'other-run',
      agentId: 'other-agent',
      taskId: 'other-task',
      resource: { type: 'shared-resource', resourceId: 'lockfile' },
      mode: 'exclusive'
    });
    writeGuard.release = async () => ({ status: 'not-found' });
    const runtime = new OrchestrationRuntime({
      scheduler: new DeterministicScheduler(),
      persistence,
      workspaceManager: new MemoryWorkspaceManager(),
      writeGuard,
      agentRunner: new FakeAgentRunner(),
      verifier: new FakeTaskVerifier(),
      now: () => new Date('2026-08-12T00:00:00.000Z'),
      createAttemptId: () => 'attempt-A'
    });
    const run = request([task('A')]);
    const binding = run.taskBindings[0];

    await expect(
      runtime.startRun({
        ...run,
        taskBindings: [
          {
            ...binding,
            leasePlan: {
              taskId: 'A',
              predictedResources: [
                { type: 'project', projectId: 'core' },
                { type: 'shared-resource', resourceId: 'lockfile' }
              ],
              source: 'manual'
            }
          }
        ]
      })
    ).rejects.toThrow('Lease rollback failed for task A: not-found');
    await expect(runtime.recoverRun('run-1')).resolves.toMatchObject({
      run: { state: 'FAILED' },
      leases: [{ lease: { id: 'lease-2', state: 'ACTIVE', resource: { type: 'project' } } }]
    });
    persistence.close();
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

  it('returns a completed run on an identical retry without dispatching the agent again', async () => {
    const runAgent = vi.fn(async (agentRequest: Parameters<AgentRunner['run']>[0]) => {
      await agentRequest.onStarted({});
      return { status: 'completed' as const };
    });
    const runtime = createRuntime(undefined, undefined, undefined, { run: runAgent });
    const runRequest = request([task('A')]);

    await runtime.startOrResumeRun(runRequest);
    const retried = await runtime.startOrResumeRun(runRequest);

    expect(retried.run.state).toBe('COMPLETED');
    expect(runAgent).toHaveBeenCalledOnce();
  });

  it('rejects a retry when durable execution authority differs', async () => {
    const runtime = createRuntime();
    const runRequest = request([task('A')]);
    await runtime.startOrResumeRun(runRequest);

    await expect(
      runtime.startOrResumeRun({
        ...runRequest,
        run: {
          ...runRequest.run,
          authority: {
            ...runRequest.run.authority,
            executionFingerprint: `sha256:${'e'.repeat(64)}`
          }
        }
      })
    ).rejects.toThrow('Existing run authority does not match retry request');
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

  it('replays a dynamically sequenced runtime scope conflict through SQLite', async () => {
    const persistence = new DrizzleSqliteOrchestrationPersistence();
    const baseRun = request([task('A'), task('B')]);
    const run: StartRuntimeRunRequest = {
      ...baseRun,
      taskBindings: baseRun.taskBindings.map((binding) =>
        binding.taskId === 'B'
          ? {
              ...binding,
              leasePlan: {
                taskId: 'B',
                source: 'manual',
                predictedResources: [{ type: 'project', projectId: 'project-B' }]
              }
            }
          : binding
      ),
      scheduleOptions: { maxConcurrency: 1 }
    };
    const runtime = new OrchestrationRuntime({
      scheduler: new DeterministicScheduler(),
      persistence,
      workspaceManager: new MemoryWorkspaceManager(),
      writeGuard: new InMemoryWriteGuard({ now: () => new Date('2026-08-12T00:00:00.000Z') }),
      agentRunner: new FakeAgentRunner(),
      verifier: new FakeTaskVerifier(),
      impactReconciler: {
        reconcile: async ({ taskId }) => ({
          observed: {
            taskId,
            filesRead: new Set(),
            filesCreated: new Set(['project-B:new.txt']),
            filesWritten: new Set(['project-B:new.txt']),
            filesDeleted: new Set(),
            symbolsWritten: new Set(),
            dependencyRequests: new Set(),
            manifestFilesChanged: new Set(),
            generatedFilesChanged: new Set()
          },
          reconciliation: {
            status: 'runtime-scope-expanded',
            expandedFileIds: new Set(['project-B:new.txt']),
            unleasedFileIds: new Set()
          },
          expandedResources: [{ type: 'file', projectId: 'project-B', fileId: 'project-B:new.txt' }]
        })
      },
      now: () => new Date('2026-08-12T00:00:00.000Z')
    });

    await runtime.startRun(run);

    const recovered = await persistence.recoverRun('run-1');
    expect(recovered?.events.map((event) => event.event.type)).toContain(
      'runtime-reconciliation-recovered'
    );
    expect(recovered).toMatchObject({
      conflicts: [
        {
          effectiveFromSequence: expect.any(Number),
          conflict: { constraints: [{ type: 'runtime-scope-expansion' }] }
        }
      ]
    });
    await expect(
      persistence.replayRun('run-1', new DeterministicScheduler())
    ).resolves.toHaveLength(11);
    persistence.close();
  });

  it('integrates a real Git workspace edit with SQLite recovery and released leases', async () => {
    const integrationRepositoryPath = createRepository();
    const persistence = new DrizzleSqliteOrchestrationPersistence();
    const writingAgent: AgentRunner = {
      run: async (agentRequest) => {
        await agentRequest.onStarted({ sessionRef: { backend: 'fake', value: 'session-A' } });
        writeFileSync(join(agentRequest.workspace.workspacePath, 'value.txt'), 'changed\n');
        return { status: 'completed', sessionRef: { backend: 'fake', value: 'session-A' } };
      }
    };
    const runtime = new OrchestrationRuntime({
      scheduler: new DeterministicScheduler(),
      persistence,
      workspaceManager: new GitWorkspaceManager(),
      writeGuard: new InMemoryWriteGuard({
        now: () => new Date('2026-08-12T00:00:00.000Z')
      }),
      agentRunner: writingAgent,
      verifier: new FakeTaskVerifier(),
      now: () => new Date('2026-08-12T00:00:00.000Z'),
      createAttemptId: () => 'attempt-A'
    });
    const run = request([task('A')]);
    const binding = run.taskBindings[0];

    const recovered = await runtime.startRun({
      ...run,
      taskBindings: [
        {
          ...binding,
          workspace: {
            ...binding.workspace,
            integrationRepositoryPath,
            workspacePath: `${integrationRepositoryPath}-workspace-A`
          }
        }
      ]
    });

    expect(readFileSync(join(integrationRepositoryPath, 'value.txt'), 'utf8')).toBe('changed\n');
    expect(recovered).toMatchObject({
      snapshot: { taskStates: [{ taskId: 'A', state: 'COMPLETED' }] },
      workspaces: [{ workspace: { phase: 'INTEGRATED', revision: 2 } }],
      leases: [{ lease: { state: 'RELEASED' } }],
      attempts: [{ attempt: { state: 'COMPLETED', sessionRef: { value: 'session-A' } } }]
    });
    await expect(
      persistence.replayRun('run-1', new DeterministicScheduler())
    ).resolves.toHaveLength(5);
    persistence.close();
  });

  it('integrates a guarded Pi custom edit through SQLite, verifier, and real Git', async () => {
    const integrationRepositoryPath = createRepository();
    const persistence = new DrizzleSqliteOrchestrationPersistence();
    const guard = new InMemoryWriteGuard({
      now: () => new Date('2026-08-14T00:00:00.000Z')
    });
    const acquire = vi.spyOn(guard, 'acquire');
    const gateway: PiSessionGateway = {
      start: async ({ executeTool, onStarted }) => {
        await onStarted('pi-session-1');
        await executeTool({
          name: 'forge_edit',
          path: 'value.txt',
          expected: 'base',
          replacement: 'pi'
        });
        return { sessionId: 'pi-session-1' };
      }
    };
    const runtime = new OrchestrationRuntime({
      scheduler: new DeterministicScheduler(),
      persistence,
      workspaceManager: new GitWorkspaceManager(),
      writeGuard: guard,
      agentRunner: new PiAgentRunner({
        gateway,
        createTools: (agentRequest) =>
          new AgentToolRuntime({
            runId: agentRequest.runId,
            taskId: agentRequest.taskId,
            attemptId: agentRequest.attempt.id,
            agentId: agentRequest.attempt.agentId,
            workspacePath: agentRequest.workspace.workspacePath,
            writeGuard: guard,
            persistence,
            resolveResource: (path) => ({
              type: 'file',
              projectId: 'core',
              fileId: `core:${path}`
            }),
            resolveFileId: (path) => `core:${path}`
          })
      }),
      verifier: new FakeTaskVerifier(),
      now: () => new Date('2026-08-14T00:00:00.000Z'),
      createAttemptId: () => 'attempt-A'
    });
    const run = request([task('A')]);
    const binding = run.taskBindings[0];
    const impact = {
      predicted: {
        taskId: 'A',
        projectsRead: new Set<string>(),
        projectsWritten: new Set<string>(),
        explicitProjectsWritten: new Set<string>(),
        filesRead: new Set<string>(),
        filesWritten: new Set(['core:value.txt']),
        explicitFilesWritten: new Set(['core:value.txt']),
        globFilesWritten: new Set<string>(),
        symbolDerivedFilesWritten: new Set<string>(),
        symbolsRead: new Set<string>(),
        symbolsWritten: new Set<string>(),
        sharedResources: new Set<string>(),
        sharedResourceAccesses: [],
        downstreamProjects: new Set<string>(),
        riskSignals: []
      }
    };

    const recovered = await runtime.startRun({
      ...run,
      taskBindings: [
        {
          ...binding,
          impact,
          leasePlan: {
            taskId: 'A',
            predictedResources: [{ type: 'project', projectId: 'core' }],
            source: 'manual'
          },
          workspace: {
            ...binding.workspace,
            integrationRepositoryPath,
            workspacePath: `${integrationRepositoryPath}-workspace-A`
          }
        }
      ]
    });

    expect(readFileSync(join(integrationRepositoryPath, 'value.txt'), 'utf8')).toBe('pi\n');
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(recovered).toMatchObject({
      snapshot: { taskStates: [{ taskId: 'A', state: 'COMPLETED' }] },
      attempts: [{ attempt: { sessionRef: { backend: 'pi', value: 'pi-session-1' } } }]
    });
    expect((await persistence.recoverRun('run-1'))?.impacts).toMatchObject([
      { impact: { observed: { filesWritten: new Set(['core:value.txt']) } } }
    ]);
    persistence.close();
  });

  it('blocks a Pi conflicting write without modifying the workspace', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'pi-blocked-'));
    directories.push(workspacePath);
    writeFileSync(join(workspacePath, 'value.txt'), 'base\n');
    const persistence = new MemoryPersistence();
    const guard = new InMemoryWriteGuard();
    await guard.acquire({
      runId: 'other-run',
      agentId: 'other-agent',
      taskId: 'other-task',
      resource: { type: 'file', projectId: 'core', fileId: 'core:value.txt' },
      mode: 'exclusive'
    });
    const gateway: PiSessionGateway = {
      start: async ({ executeTool, onStarted }) => {
        await onStarted('pi-session-1');
        await executeTool({ name: 'forge_write', path: 'value.txt', content: 'changed\n' });
        return { sessionId: 'pi-session-1' };
      }
    };
    const runtime = new OrchestrationRuntime({
      scheduler: new DeterministicScheduler(),
      persistence,
      workspaceManager: new MemoryWorkspaceManager(),
      writeGuard: guard,
      agentRunner: new PiAgentRunner({
        gateway,
        createTools: (agentRequest) =>
          new AgentToolRuntime({
            runId: agentRequest.runId,
            taskId: agentRequest.taskId,
            attemptId: agentRequest.attempt.id,
            agentId: agentRequest.attempt.agentId,
            workspacePath: agentRequest.workspace.workspacePath,
            writeGuard: guard,
            persistence,
            resolveResource: (path) => ({
              type: 'file',
              projectId: 'core',
              fileId: `core:${path}`
            }),
            resolveFileId: (path) => `core:${path}`
          })
      }),
      verifier: new FakeTaskVerifier(),
      now: () => new Date('2026-08-14T00:00:00.000Z')
    });
    const run = request([task('A')]);
    const binding = run.taskBindings[0];

    await expect(
      runtime.startRun({
        ...run,
        taskBindings: [{ ...binding, workspace: { ...binding.workspace, workspacePath } }]
      })
    ).resolves.toMatchObject({ snapshot: { taskStates: [{ taskId: 'A', state: 'BLOCKED' }] } });
    expect(readFileSync(join(workspacePath, 'value.txt'), 'utf8')).toBe('base\n');
    expect(persistence.reevaluations.map(({ event }) => event.event.type)).toContain(
      'lease-blocked'
    );
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

  it('rejects incomplete bindings', async () => {
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
    expect(new OrchestrationRuntimeInputError('Invalid.').name).toBe(
      'OrchestrationRuntimeInputError'
    );
  });

  it('returns configured fake-agent and fake-verifier failures', async () => {
    const [binding] = bindings(['A']);
    const workspace = await new MemoryWorkspaceManager().create(binding.workspace);
    const fakeAgent = new FakeAgentRunner(new Map([['A', 'Agent failure.']]));
    const fakeVerifier = new FakeTaskVerifier(new Map([['A', 'Verification failure.']]));

    await expect(
      fakeAgent.run({
        attempt: {
          id: 'attempt-1',
          runId: 'run-1',
          taskId: 'A',
          agentId: 'agent-A',
          workspaceId: workspace.id,
          leasePlanFingerprint,
          state: 'STARTING',
          revision: 2
        },
        runId: 'run-1',
        taskId: 'A',
        task: task('A'),
        workspace,
        instructions: 'Complete A',
        onStarted: async () => {}
      })
    ).resolves.toEqual({
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
