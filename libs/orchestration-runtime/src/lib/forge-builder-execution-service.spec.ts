import type {
  AgentExecutionAttempt,
  OrchestrationPersistence,
  TaskContract,
  TaskImpactReconciler,
  TaskWorkspace,
  WritableResource,
  WorkspaceManager,
  WriteGuard
} from '@ai-native-software-delivery-orchestrator/domain';
import { describe, expect, it } from 'vitest';

import {
  ForgeBuilderExecutionError,
  ForgeBuilderExecutionService
} from './forge-builder-execution-service.js';
import type { RuntimeTaskBinding } from './orchestration-runtime.js';

const task: TaskContract = {
  id: 'task-1',
  title: 'Task',
  goal: 'Complete task',
  dependencies: [],
  expectedReads: [],
  expectedWrites: [],
  sharedResources: [],
  verification: []
};
const workspace: TaskWorkspace = {
  id: 'workspace-1',
  runId: 'run-1',
  taskId: 'task-1',
  integrationRepositoryPath: '/integration',
  workspacePath: '/workspace',
  branchName: 'task',
  baseRef: 'base',
  integrationRef: 'main',
  revision: 1,
  phase: 'READY_TO_INTEGRATE'
};
const binding: RuntimeTaskBinding = {
  taskId: task.id,
  agentId: 'agent-1',
  leasePlan: {
    taskId: task.id,
    predictedResources: [{ type: 'project', projectId: 'core' }],
    source: 'manual'
  },
  workspace,
  impact: {
    predicted: {
      taskId: task.id,
      projectsRead: new Set(),
      projectsWritten: new Set(['core']),
      explicitProjectsWritten: new Set(['core']),
      filesRead: new Set(),
      filesWritten: new Set(['core:value.txt']),
      explicitFilesWritten: new Set(['core:value.txt']),
      globFilesWritten: new Set(),
      symbolDerivedFilesWritten: new Set(),
      symbolsRead: new Set(),
      symbolsWritten: new Set(),
      sharedResources: new Set(),
      sharedResourceAccesses: [],
      downstreamProjects: new Set(),
      riskSignals: []
    }
  }
};
const attempt: AgentExecutionAttempt = {
  id: 'builder-1',
  runId: 'run-1',
  taskId: task.id,
  agentId: 'agent-1',
  workspaceId: workspace.id,
  leasePlanFingerprint: 'lease-plan',
  state: 'PREPARING',
  revision: 1
};

const createHarness = (
  runner: ConstructorParameters<typeof ForgeBuilderExecutionService>[0]['agentRunner'],
  options?: Pick<
    ConstructorParameters<typeof ForgeBuilderExecutionService>[0],
    'claimStart' | 'leaseReleased' | 'reconciler' | 'scopeExpanded'
  >
) => {
  const attempts: AgentExecutionAttempt[] = [];
  const leases: any[] = [];
  const sideEffects: string[] = [];
  const scopeExpansionRequests: {
    readonly runId: string;
    readonly taskId: string;
    readonly expandedResources: readonly WritableResource[];
  }[] = [];
  const persistence: Pick<
    OrchestrationPersistence,
    'persistWorkspace' | 'persistLease' | 'persistAttempt' | 'persistImpact'
  > = {
    persistWorkspace: async () => undefined,
    persistLease: async ({ lease }) => {
      leases.push(lease);
    },
    persistAttempt: async ({ attempt: persisted }) => {
      attempts.push(persisted);
    },
    persistImpact: async () => {
      sideEffects.push('persist-impact');
    }
  };
  const guard: WriteGuard = {
    acquire: async (request) => ({
      status: 'granted',
      lease: {
        id: 'lease-1',
        runId: request.runId,
        agentId: request.agentId,
        taskId: request.taskId,
        resource: request.resource,
        mode: 'exclusive',
        version: 1,
        state: 'ACTIVE',
        acquiredAt: new Date(),
        lastHeartbeatAt: new Date()
      }
    }),
    heartbeat: async () => ({ status: 'not-found' }),
    markStale: async () => ({ status: 'not-found' }),
    release: async ({ leaseId }) => ({
      status: 'released',
      lease: {
        id: leaseId,
        runId: 'run-1',
        agentId: 'agent-1',
        taskId: task.id,
        resource: { type: 'project', projectId: 'core' },
        mode: 'exclusive',
        version: 2,
        state: 'RELEASED',
        acquiredAt: new Date(),
        lastHeartbeatAt: new Date(),
        releasedAt: new Date()
      }
    })
  };
  const manager: WorkspaceManager = {
    create: async () => workspace,
    commit: async () => workspace,
    integrate: async () => {
      throw new Error('Not used');
    },
    resumeIntegration: async () => {
      throw new Error('Not used');
    },
    abortIntegration: async () => {
      throw new Error('Not used');
    },
    dispose: async () => {
      throw new Error('Not used');
    }
  };
  return {
    attempts,
    leases,
    sideEffects,
    scopeExpansionRequests,
    service: new ForgeBuilderExecutionService({
      persistence,
      workspaceManager: manager,
      writeGuard: guard,
      agentRunner: runner,
      reconciler: options?.reconciler,
      claimStart: options?.claimStart,
      leaseReleased: options?.leaseReleased,
      scopeExpanded: async (request) => {
        sideEffects.push('scope-expanded');
        scopeExpansionRequests.push(request);
        await options?.scopeExpanded?.(request);
      },
      now: () => new Date('2026-08-17T00:00:00.000Z')
    })
  };
};

describe('ForgeBuilderExecutionService', () => {
  it('persists builder lifecycle, observed impact, and released authority', async () => {
    const { service, attempts, leases } = createHarness({
      run: async (request) => {
        await request.onStarted({ sessionRef: { backend: 'fake', value: 'builder' } });
        return { status: 'completed' };
      }
    });
    const result = await service.execute({
      runId: 'run-1',
      task,
      binding,
      attempt
    });
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') {
      throw new Error('Expected completed builder execution');
    }
    expect(result.attempt).toMatchObject({ id: 'builder-1', state: 'COMPLETED' });
    expect(attempts).toMatchObject([
      { state: 'STARTING' },
      { state: 'RUNNING' },
      { state: 'COMPLETED' }
    ]);
    expect(leases.at(-1)).toMatchObject({ state: 'RELEASED' });
  });

  it('keeps the attempt PREPARING when an ordinary lease conflict blocks execution', async () => {
    let runnerCalls = 0;
    const { attempts, leases } = createHarness({
      run: async () => {
        runnerCalls += 1;
        return { status: 'completed' };
      }
    });
    const blockedGuard: WriteGuard = {
      acquire: async () => ({ status: 'blocked', conflictingLeaseIds: ['lease-owner'] }),
      heartbeat: async () => ({ status: 'not-found' }),
      markStale: async () => ({ status: 'not-found' }),
      release: async () => ({ status: 'not-found' })
    };
    const blockedService = new ForgeBuilderExecutionService({
      persistence: {
        persistWorkspace: async () => undefined,
        persistLease: async ({ lease }) => {
          leases.push(lease);
        },
        persistAttempt: async ({ attempt: persisted }) => {
          attempts.push(persisted);
        },
        persistImpact: async () => undefined
      },
      workspaceManager: {
        create: async () => workspace,
        commit: async () => workspace,
        integrate: async () => {
          throw new Error('Not used');
        },
        resumeIntegration: async () => {
          throw new Error('Not used');
        },
        abortIntegration: async () => {
          throw new Error('Not used');
        },
        dispose: async () => {
          throw new Error('Not used');
        }
      },
      writeGuard: blockedGuard,
      agentRunner: {
        run: async () => {
          runnerCalls += 1;
          return { status: 'completed' };
        }
      }
    });

    await expect(
      blockedService.execute({ runId: 'run-1', task, binding, attempt })
    ).resolves.toEqual({
      status: 'blocked',
      blockerLeaseId: 'lease-owner'
    });
    expect(runnerCalls).toBe(0);
    expect(attempts).toEqual([]);
    expect(leases).toEqual([]);
  });

  it('persists expanded impact before reporting scope expansion and releasing leases', async () => {
    const expandedResources = [
      { type: 'file' as const, projectId: 'core', fileId: 'core:expanded.txt' }
    ];
    const reconciler: TaskImpactReconciler = {
      reconcile: async () => ({
        observed: {
          taskId: task.id,
          filesRead: new Set(),
          filesCreated: new Set(['core:expanded.txt']),
          filesWritten: new Set(['core:expanded.txt']),
          filesDeleted: new Set(),
          symbolsWritten: new Set(),
          dependencyRequests: new Set(),
          manifestFilesChanged: new Set(),
          generatedFilesChanged: new Set()
        },
        reconciliation: {
          status: 'runtime-scope-expanded',
          expandedFileIds: new Set(['core:expanded.txt']),
          unleasedFileIds: new Set()
        },
        expandedResources
      })
    };
    const { service, leases, scopeExpansionRequests, sideEffects } = createHarness(
      {
        run: async (request) => {
          await request.onStarted({ sessionRef: { backend: 'fake', value: 'builder' } });
          return { status: 'completed' };
        }
      },
      { reconciler }
    );

    await service.execute({ runId: 'run-1', task, binding, attempt });

    expect(sideEffects).toEqual(['persist-impact', 'scope-expanded']);
    expect(scopeExpansionRequests).toEqual([
      { runId: 'run-1', taskId: 'task-1', expandedResources }
    ]);
    expect(leases.at(-1)).toMatchObject({ state: 'RELEASED' });
  });

  it('fails and releases leases when the builder never establishes', async () => {
    const { service, attempts, leases } = createHarness({
      run: async () => ({ status: 'failed', detail: 'Cannot start.' })
    });
    await expect(
      service.execute({
        runId: 'run-1',
        task,
        binding,
        attempt
      })
    ).rejects.toThrow(ForgeBuilderExecutionError);
    expect(attempts.at(-1)).toMatchObject({
      state: 'FAILED',
      failure: { type: 'execution-failed' }
    });
    expect(leases.at(-1)).toMatchObject({ state: 'RELEASED' });
  });

  it('records UNKNOWN and retains authority when the builder fails after start', async () => {
    const { service, attempts, leases } = createHarness({
      run: async (request) => {
        await request.onStarted({ sessionRef: { backend: 'fake', value: 'builder' } });
        throw new Error('Lost contact.');
      }
    });
    await expect(
      service.execute({
        runId: 'run-1',
        task,
        binding,
        attempt
      })
    ).rejects.toThrow('Lost contact');
    expect(attempts.at(-1)).toMatchObject({
      state: 'UNKNOWN',
      failure: { type: 'unknown-outcome' }
    });
    expect(leases).toHaveLength(1);
    expect(leases[0]).toMatchObject({ state: 'ACTIVE' });
  });

  it('records confirmed cancellation and releases authority after start', async () => {
    const { service, attempts, leases } = createHarness({
      run: async (request) => {
        await request.onStarted({ sessionRef: { backend: 'fake', value: 'builder' } });
        return { status: 'cancelled', detail: 'Cancellation confirmed by agent.' };
      }
    });
    await expect(
      service.execute({
        runId: 'run-1',
        task,
        binding,
        attempt
      })
    ).rejects.toThrow('Cancellation confirmed by agent');
    expect(attempts.at(-1)).toMatchObject({
      state: 'CANCELLED',
      failure: { type: 'cancelled' }
    });
    expect(leases.at(-1)).toMatchObject({ state: 'RELEASED' });
  });
});
