import type {
  CreatePersistedRunRequest,
  OrchestrationPersistence,
  PersistedAgentExecutionAttempt,
  PersistedDispatch,
  PersistedSchedulerDecision,
  PersistedTaskCodeReview,
  RecoveredRun,
  TaskCodeReviewStore
} from '@ai-native-software-delivery-orchestrator/domain';
import { describe, expect, it } from 'vitest';

import { ForgeRunProgressionService } from './forge-run-progression-service.js';

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
    dependencies: index === 0 ? [] : [taskIds[index - 1]],
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

class MemoryPersistence implements OrchestrationPersistence, TaskCodeReviewStore {
  request: CreatePersistedRunRequest | undefined;
  readonly dispatches: PersistedDispatch[] = [];
  readonly attempts: PersistedAgentExecutionAttempt[] = [];
  readonly reviews: PersistedTaskCodeReview[] = [];
  readonly runStates: Array<'ACTIVE' | 'COMPLETED' | 'FAILED' | 'CANCELLED'> = [];

  async createRun(request: CreatePersistedRunRequest): Promise<void> {
    this.request = request;
  }

  async recoverRun(runId: string): Promise<RecoveredRun | undefined> {
    if (this.request?.run.id !== runId) {
      return undefined;
    }
    return {
      run: { ...this.request.run, state: this.runStates.at(-1) ?? this.request.run.state },
      tasks: this.request.tasks,
      taskBindings: this.request.taskBindings,
      hardConflicts: this.request.hardConflicts,
      riskConflicts: this.request.riskConflicts,
      scheduleOptions: this.request.scheduleOptions,
      events: this.dispatches.map((dispatch) => dispatch.reevaluation.event),
      decisions: this.dispatches.map((dispatch) => dispatch.reevaluation.decision),
      attempts: this.attempts,
      workspaces: [],
      leases: [],
      impacts: [],
      transitions: this.dispatches.flatMap((dispatch) => dispatch.reevaluation.transitions),
      conflicts: []
    };
  }

  async recoverDispatches(runId: string): Promise<readonly PersistedDispatch[]> {
    return this.dispatches.filter((dispatch) => dispatch.reevaluation.event.runId === runId);
  }

  async persistDispatch(dispatch: PersistedDispatch): Promise<void> {
    this.dispatches.push(dispatch);
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

  async persistReview(review: PersistedTaskCodeReview): Promise<void> {
    this.reviews.push(review);
  }

  async recoverReviews(): Promise<readonly PersistedTaskCodeReview[]> {
    return this.reviews;
  }

  async persistReevaluation(): Promise<void> {}
  async persistAttempt(): Promise<void> {}
  async persistWorkspace(): Promise<void> {}
  async persistLease(): Promise<void> {}
  async persistImpact(): Promise<void> {}
  async persistVerificationEvidence(): Promise<void> {}
  async recoverVerificationEvidence(): Promise<readonly []> { return []; }
  async recoverAttempts(): Promise<readonly PersistedAgentExecutionAttempt[]> { return this.attempts; }
  async recoverLeases(): Promise<readonly []> { return []; }
  async persistConflict(): Promise<void> {}
  async persistIntegration(): Promise<void> {}
  async recoverIntegration(): Promise<undefined> { return undefined; }
  async persistRepairResumeDispatch(): Promise<void> {}
  async recoverRepairResumeDispatches(): Promise<readonly []> { return []; }
  async replayRun(): Promise<readonly PersistedSchedulerDecision[]> {
    return this.dispatches.map((dispatch) => dispatch.reevaluation.decision);
  }
  async close(): Promise<void> {}
}

describe('ForgeRunProgressionService', () => {
  it('returns the same durable authorization when the same event is retried', async () => {
    const persistence = new MemoryPersistence();
    await persistence.createRun(createRun(['task-a']));
    let counter = 0;
    const progression = new ForgeRunProgressionService({
      persistence,
      createAttemptId: () => `attempt-${++counter}`
    });

    const first = await progression.advance('run-1', { type: 'run-started' });
    const second = await progression.advance('run-1', { type: 'run-started' });

    expect(first).toEqual([{ taskId: 'task-a', attemptId: 'attempt-1' }]);
    expect(second).toEqual(first);
    expect(persistence.dispatches).toHaveLength(1);
  });

  it('advances a dependent chain from A completion to B authorization', async () => {
    const persistence = new MemoryPersistence();
    await persistence.createRun(createRun(['task-a', 'task-b']));
    let counter = 0;
    const progression = new ForgeRunProgressionService({
      persistence,
      createAttemptId: () => `attempt-${++counter}`
    });

    await progression.advance('run-1', { type: 'run-started' });
    await progression.advance('run-1', { type: 'agent-completed', taskId: 'task-a', state: 'VERIFYING' });
    await progression.advance('run-1', { type: 'verification-completed', taskId: 'task-a', state: 'INTEGRATING' });
    const afterIntegration = await progression.advance('run-1', {
      type: 'workspace-integrated',
      taskId: 'task-a',
      state: 'COMPLETED'
    });

    expect(afterIntegration).toEqual([{ taskId: 'task-b', attemptId: 'attempt-2' }]);
    await progression.advance('run-1', { type: 'agent-completed', taskId: 'task-b', state: 'VERIFYING' });
    await progression.advance('run-1', { type: 'verification-completed', taskId: 'task-b', state: 'INTEGRATING' });
    await progression.advance('run-1', { type: 'workspace-integrated', taskId: 'task-b', state: 'COMPLETED' });
    const finalized = await progression.finalize('run-1');
    expect(finalized).toBe('completed');
    expect(persistence.runStates.at(-1)).toBe('COMPLETED');
  });

  it('finalizes to completed once every task is completed', async () => {
    const persistence = new MemoryPersistence();
    await persistence.createRun(createRun(['task-a']));
    const progression = new ForgeRunProgressionService({ persistence, createAttemptId: () => 'attempt-1' });

    await progression.advance('run-1', { type: 'run-started' });
    await progression.advance('run-1', { type: 'agent-completed', taskId: 'task-a', state: 'VERIFYING' });
    await progression.advance('run-1', { type: 'verification-completed', taskId: 'task-a', state: 'INTEGRATING' });
    await progression.advance('run-1', { type: 'workspace-integrated', taskId: 'task-a', state: 'COMPLETED' });

    await expect(progression.finalize('run-1')).resolves.toBe('completed');
    expect(persistence.runStates.at(-1)).toBe('COMPLETED');
  });

  it('recovers the persisted repair review at parent iteration + 1 without duplicating it', async () => {
    const persistence = new MemoryPersistence();
    await persistence.createRun(createRun(['task-a']));
    const progression = new ForgeRunProgressionService({ persistence });

    const subject = {
      builderAttemptId: 'attempt-1',
      outputAttemptId: 'repair-1',
      workspaceId: 'workspace-task-a',
      workspaceRevision: 2,
      workspaceChangeFingerprint: 'fp',
      impactFingerprint: 'fp',
      verificationFingerprint: 'fp',
      snapshotFingerprint: 'fp'
    };
    const review = { recommendation: 'accept' as const, summary: 'ok', findings: [] };
    await persistence.persistReview({
      runId: 'run-1',
      taskId: 'task-a',
      iteration: 1,
      subject: { ...subject, outputAttemptId: 'attempt-1', workspaceRevision: 1 },
      review: { recommendation: 'repair', summary: 'fix', findings: [] }
    });
    await persistence.persistReview({
      runId: 'run-1',
      taskId: 'task-a',
      iteration: 2,
      subject,
      review
    });

    const recovered = await progression.recoverCompletedRepairReview({
      runId: 'run-1',
      taskId: 'task-a',
      parentReviewIteration: 1,
      subject,
      review
    });

    expect(recovered.iteration).toBe(2);
    expect(persistence.reviews).toHaveLength(2);
  });

  it('rejects a repair review whose persisted subject does not match execution output', async () => {
    const persistence = new MemoryPersistence();
    await persistence.createRun(createRun(['task-a']));
    const progression = new ForgeRunProgressionService({ persistence });

    const subject = {
      builderAttemptId: 'attempt-1',
      outputAttemptId: 'repair-1',
      workspaceId: 'workspace-task-a',
      workspaceRevision: 2,
      workspaceChangeFingerprint: 'fp',
      impactFingerprint: 'fp',
      verificationFingerprint: 'fp',
      snapshotFingerprint: 'fp'
    };
    const review = { recommendation: 'accept' as const, summary: 'ok', findings: [] };
    await persistence.persistReview({
      runId: 'run-1',
      taskId: 'task-a',
      iteration: 2,
      subject: { ...subject, outputAttemptId: 'other' },
      review
    });

    await expect(
      progression.recoverCompletedRepairReview({
        runId: 'run-1',
        taskId: 'task-a',
        parentReviewIteration: 1,
        subject,
        review
      })
    ).rejects.toThrow('Persisted repair review subject mismatch');
    expect(persistence.reviews).toHaveLength(1);
  });
});
