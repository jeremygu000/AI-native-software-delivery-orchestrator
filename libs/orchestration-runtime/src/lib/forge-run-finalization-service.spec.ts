import type {
  CreatePersistedRunRequest,
  OrchestrationPersistence,
  RecoveredRun,
  PersistedAgentExecutionAttempt,
} from '@ai-native-software-delivery-orchestrator/domain';
import { describe, expect, it } from 'vitest';

import { ForgeRunFinalizationError, ForgeRunFinalizationService } from './forge-run-finalization-service.js';

const createRun = (
  state: 'ACTIVE' | 'COMPLETED' | 'FAILED',
  options?: { readonly attempts?: readonly PersistedAgentExecutionAttempt[] }
): CreatePersistedRunRequest => ({
  run: {
    id: 'run-1',
    repositoryId: 'repo-1',
    state,
    createdAt: '2026-08-12T00:00:00.000Z',
    authority: {
      artifactId: 'artifact-1',
      artifactRevision: 1,
      approvalId: 'approval-1',
      planFingerprint: 'sha256:'.concat('1'.repeat(64)),
      approvalFingerprint: 'sha256:'.concat('2'.repeat(64)),
      claimFingerprint: 'sha256:'.concat('3'.repeat(64)),
      executionFingerprint: 'sha256:'.concat('4'.repeat(64)),
      repositoryRoot: '/repo',
      baseCommit: 'a'.repeat(40),
      workingTreeFingerprint: 'sha256:'.concat('5'.repeat(64)),
      repositoryFactsFingerprint: 'sha256:'.concat('6'.repeat(64)),
      sharedResourcePolicyFingerprint: 'sha256:'.concat('7'.repeat(64)),
      verificationPolicyFingerprint: 'sha256:'.concat('8'.repeat(64)),
      codeReviewPolicyFingerprint: 'sha256:'.concat('9'.repeat(64))
    }
  },
  tasks: [
    {
      id: 'task-a',
      title: 'task-a',
      goal: 'task-a',
      dependencies: [],
      expectedReads: [],
      expectedWrites: [],
      sharedResources: [],
      verification: []
    }
  ],
  taskBindings: [
    {
      runId: 'run-1',
      taskId: 'task-a',
      agentId: 'agent-a',
      leasePlan: { taskId: 'task-a', source: 'manual', predictedResources: [] },
      workspace: {
        runId: 'run-1',
        taskId: 'task-a',
        id: 'workspace-a',
        branchName: 'branch-a',
        baseRef: 'main',
        integrationRepositoryPath: '/repo/a',
        workspacePath: '/workspace/a',
        integrationRef: 'refs/heads/branch-a'
      }
    }
  ],
  hardConflicts: [],
  riskConflicts: [],
  scheduleOptions: { maxConcurrency: 1 }
});

class MemoryPersistence implements OrchestrationPersistence {
  request: CreatePersistedRunRequest | undefined;
  attempts: readonly PersistedAgentExecutionAttempt[] = [];
  readonly states: Array<'ACTIVE' | 'COMPLETED' | 'FAILED' | 'CANCELLED'> = [];

  async createRun(request: CreatePersistedRunRequest): Promise<void> {
    this.request = request;
  }

  async recoverRun(runId: string): Promise<RecoveredRun | undefined> {
    if (this.request?.run.id !== runId) {
      return undefined;
    }
    return {
      run: this.request.run,
      tasks: this.request.tasks,
      taskBindings: this.request.taskBindings,
      hardConflicts: this.request.hardConflicts,
      riskConflicts: this.request.riskConflicts,
      scheduleOptions: this.request.scheduleOptions,
      events: [],
      decisions: [],
      attempts: this.attempts,
      workspaces: [],
      leases: [],
      impacts: [],
      transitions: [],
      conflicts: []
    };
  }

  async updateRunState(_runId: string, state: 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'CANCELLED'): Promise<void> {
    this.states.push(state);
  }

  async recoverTaskBindings(): Promise<readonly []> { return []; }
  async recoverTaskBinding(): Promise<undefined> { return undefined; }
  async recoverDispatches(): Promise<readonly []> { return []; }
  async persistDispatch(): Promise<void> {}
  async persistReevaluation(): Promise<void> {}
  async persistAttempt(): Promise<void> {}
  async persistWorkspace(): Promise<void> {}
  async persistLease(): Promise<void> {}
  async persistImpact(): Promise<void> {}
  async persistReview(): Promise<void> {}
  async recoverReviews(): Promise<readonly []> { return []; }
  async persistVerificationEvidence(): Promise<void> {}
  async recoverVerificationEvidence(): Promise<readonly []> { return []; }
  async recoverAttempts(): Promise<readonly []> { return []; }
  async recoverLeases(): Promise<readonly []> { return []; }
  async persistConflict(): Promise<void> {}
  async persistIntegration(): Promise<void> {}
  async recoverIntegration(): Promise<undefined> { return undefined; }
  async persistRepairResumeDispatch(): Promise<void> {}
  async recoverRepairResumeDispatches(): Promise<readonly []> { return []; }
  async replayRun(): Promise<readonly []> { return []; }
  async close(): Promise<void> {}
}

describe('ForgeRunFinalizationService', () => {
  it('fails closed when the run cannot be recovered', async () => {
    const service = new ForgeRunFinalizationService({ persistence: new MemoryPersistence() as unknown as OrchestrationPersistence });

    await expect(service.finalize('missing')).rejects.toThrow(ForgeRunFinalizationError);
  });

  it('fails closed for non-terminal active state without inventing a terminal result', async () => {
    const persistence = new MemoryPersistence();
    await persistence.createRun(createRun('ACTIVE'));

    const service = new ForgeRunFinalizationService({ persistence });
    await expect(service.finalize('run-1')).rejects.toThrow(ForgeRunFinalizationError);
    expect(persistence.states).toHaveLength(0);
  });

  it('reports completed for fully completed runs', async () => {
    const persistence = new MemoryPersistence();
    await persistence.createRun(createRun('COMPLETED'));
    persistence.attempts = [
      {
        runId: 'run-1',
        attempt: {
          id: 'attempt-a',
          runId: 'run-1',
          taskId: 'task-a',
          agentId: 'agent-a',
          workspaceId: 'workspace-a',
          leasePlanFingerprint: 'lease-a',
          state: 'COMPLETED',
          revision: 1,
          startedAt: new Date('2026-08-12T00:00:00.000Z'),
          completedAt: new Date('2026-08-12T00:01:00.000Z')
        }
      } as PersistedAgentExecutionAttempt
    ];

    const service = new ForgeRunFinalizationService({ persistence });
    await expect(service.finalize('run-1')).resolves.toBe('completed');
    expect(persistence.states.at(-1)).toBe('COMPLETED');
  });
});
