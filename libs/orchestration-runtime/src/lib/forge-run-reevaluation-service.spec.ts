import type {
  CreatePersistedRunRequest,
  OrchestrationPersistence,
  PersistedDispatch,
  PersistedReevaluation,
  PersistedAgentExecutionAttempt,
  PersistedSchedulerDecision,
  RecoveredRun,
} from '@ai-native-software-delivery-orchestrator/domain';
import { describe, expect, it } from 'vitest';

import { ForgeRunReevaluationError, ForgeRunReevaluationService } from './forge-run-reevaluation-service.js';

const createRun = (taskIds: readonly string[]): CreatePersistedRunRequest => ({
  run: {
    id: 'run-1',
    repositoryId: 'repo-1',
    state: 'ACTIVE',
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
  tasks: taskIds.map((id, index) => ({
    id,
    title: id,
    goal: id,
    dependencies: index === 0 ? [] : ['task-a'],
    expectedReads: [],
    expectedWrites: [],
    sharedResources: [],
    verification: []
  })),
  taskBindings: taskIds.map((taskId, index) => ({
    runId: 'run-1',
    taskId,
    agentId: `agent-${index + 1}`,
    leasePlan: { taskId, source: 'manual', predictedResources: [] },
    workspace: {
      runId: 'run-1',
      taskId,
      id: `workspace-${taskId}`,
      branchName: `branch-${taskId}`,
      baseRef: 'main',
      integrationRepositoryPath: `/repo/${taskId}`,
      workspacePath: `/workspace/${taskId}`,
      integrationRef: `refs/heads/branch-${taskId}`
    }
  })),
  hardConflicts: [],
  riskConflicts: [],
  scheduleOptions: { maxConcurrency: 1 }
});

class MemoryPersistence implements OrchestrationPersistence {
  request: CreatePersistedRunRequest | undefined;
  readonly dispatches: PersistedDispatch[] = [];
  readonly reevaluations: PersistedReevaluation[] = [];
  readonly attempts: PersistedAgentExecutionAttempt[] = [];
  readonly runStates: Array<'ACTIVE' | 'COMPLETED' | 'FAILED' | 'CANCELLED'> = [];

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

  async recoverDispatches(runId: string): Promise<readonly PersistedDispatch[]> {
    return this.dispatches.filter((dispatch) => dispatch.reevaluation.event.runId === runId);
  }

  async persistDispatch(dispatch: PersistedDispatch): Promise<void> {
    this.dispatches.push(dispatch);
    this.reevaluations.push(dispatch.reevaluation);
    this.attempts.push(...dispatch.attempts);
  }

  async recoverTaskBindings(runId: string) {
    return this.request?.run.id === runId ? this.request.taskBindings : [];
  }

  async recoverTaskBinding(runId: string, taskId: string) {
    return this.request?.run.id === runId
      ? this.request.taskBindings.find((binding) => binding.taskId === taskId)
      : undefined;
  }

  async updateRunState(runId: string, state: 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'CANCELLED'): Promise<void> {
    if (this.request?.run.id === runId) {
      this.runStates.push(state);
    }
  }

  async persistReevaluation(): Promise<void> {}
  async persistAttempt(): Promise<void> {}
  async persistWorkspace(): Promise<void> {}
  async persistLease(): Promise<void> {}
  async persistImpact(): Promise<void> {}
  async persistReview(): Promise<void> {}
  async recoverReviews(): Promise<readonly []> { return []; }
  async persistVerificationEvidence(): Promise<void> {}
  async recoverVerificationEvidence(): Promise<readonly []> { return []; }
  async recoverAttempts(): Promise<readonly PersistedAgentExecutionAttempt[]> { return this.attempts; }
  async recoverLeases(): Promise<readonly []> { return []; }
  async persistConflict(): Promise<void> {}
  async persistIntegration(): Promise<void> {}
  async recoverIntegration(): Promise<undefined> { return undefined; }
  async persistRepairResumeDispatch(): Promise<void> {}
  async recoverRepairResumeDispatches(): Promise<readonly []> { return []; }
  async replayRun(runId: string): Promise<readonly PersistedSchedulerDecision[]> {
    return this.dispatches
      .filter((dispatch) => dispatch.reevaluation.event.runId === runId)
      .map((dispatch) => dispatch.reevaluation.decision);
  }
  async close(): Promise<void> {}
}

describe('ForgeRunReevaluationService', () => {
  it('fails closed when the run cannot be recovered', async () => {
    const service = new ForgeRunReevaluationService({ persistence: new MemoryPersistence() as unknown as OrchestrationPersistence });

    await expect(service.recoverAuthorizations('missing')).rejects.toThrow(ForgeRunReevaluationError);
  });

  it('replays persisted dispatch authorizations', async () => {
    const persistence = new MemoryPersistence();
    await persistence.createRun(createRun(['task-a', 'task-b']));
    await persistence.persistDispatch({
      reevaluation: {
        event: {
          runId: 'run-1',
          sequence: 1,
          occurredAt: '2026-08-12T00:00:00.000Z',
          event: { type: 'run-started' }
        },
        transitions: [],
        decision: {
          runId: 'run-1',
          sequence: 1,
          inputSnapshot: { taskStates: [], runtimeBlocks: [] },
          decision: {
            taskDecisions: [
              {
                taskId: 'task-a',
                action: 'start',
                fromState: 'READY',
                toState: 'RUNNING',
                reasons: [{ type: 'selected-by-priority', priority: 0, detail: 'test' }]
              }
            ]
          }
        }
      },
      attempts: [
        {
          runId: 'run-1',
          attempt: {
            id: 'attempt-a',
            runId: 'run-1',
            taskId: 'task-a',
            agentId: 'agent-1',
            workspaceId: 'workspace-task-a',
            leasePlanFingerprint: 'lease-a',
            state: 'PREPARING',
            revision: 1
          }
        }
      ]
    });

    const service = new ForgeRunReevaluationService({ persistence });
    await expect(service.recoverAuthorizations('run-1')).resolves.toEqual([
      { taskId: 'task-a', attemptId: 'attempt-a' }
    ]);
  });
});
