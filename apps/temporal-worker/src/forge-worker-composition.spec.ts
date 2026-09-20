import type {
  ActiveMutationClaimPersistence,
  AgentExecutionAttempt,
  CancellationPersistence,
  CreatePersistedRunRequest,
  IntegrationMutationClaimPersistence,
  OrchestrationPersistence,
  PersistedAgentExecutionAttempt,
  PersistedDispatch,
  PersistedReevaluation,
  PersistedRepairResumeDispatch,
  PersistedSchedulerDecision,
  PersistedTaskCodeReview,
  PersistedTaskConflict,
  PersistedTaskImpact,
  PersistedTaskRepairAttempt,
  PersistedTaskWorkspace,
  PersistedWriteLease,
  RecoveredRun,
  RepositoryGraph,
  TaskCodeReview,
  TaskCodeReviewStore,
  TaskImpact,
  TaskRepairAdmissionStore,
  TaskRepairResumeStore,
  TaskRepairAttempt,
  TaskRepairWorkItemStore,
  TaskRepairWorkItem,
  TaskWorkspace,
  TaskVerificationEvidenceStore,
  TaskVerificationEvidence
} from '@ai-native-software-delivery-orchestrator/domain';
import { taskLeasePlanFingerprint } from '@ai-native-software-delivery-orchestrator/domain';
import { DrizzleSqliteOrchestrationPersistence } from '@ai-native-software-delivery-orchestrator/persistence';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createForgeWorkerComposition,
  reviewPolicyFingerprint,
  verificationPolicyFingerprint,
  type ForgeWorkerCompositionOverrides
} from './forge-worker-composition.js';

class MemoryPersistence
  implements
    OrchestrationPersistence,
    CancellationPersistence,
    ActiveMutationClaimPersistence,
    IntegrationMutationClaimPersistence,
    TaskCodeReviewStore,
    TaskVerificationEvidenceStore,
    TaskRepairAdmissionStore,
    TaskRepairResumeStore,
    TaskRepairWorkItemStore
{
  request: CreatePersistedRunRequest | undefined;
  state: RecoveredRun['run']['state'] = 'ACTIVE';
  readonly reevaluations: PersistedReevaluation[] = [];
  readonly workspaces: PersistedTaskWorkspace[] = [];
  readonly attempts: PersistedAgentExecutionAttempt[] = [];
  readonly impacts: PersistedTaskImpact[] = [];
  readonly reviews: PersistedTaskCodeReview[] = [];
  readonly repairAttempts: PersistedTaskRepairAttempt[] = [];
  readonly repairWorkItems: TaskRepairWorkItem[] = [];
  readonly leases: PersistedWriteLease[] = [];
  readonly repairResumeDispatches: PersistedRepairResumeDispatch[] = [];
  readonly integrationClaims: {
    runId: string;
    taskId: string;
    workspaceId: string;
    outputAttemptId: string;
  }[] = [];

  async createRun(request: CreatePersistedRunRequest): Promise<void> {
    this.request = request;
  }

  async recoverTaskBindings(runId: string) {
    return this.request?.run.id === runId ? this.request.taskBindings : [];
  }

  async recoverTaskBinding(runId: string, taskId: string) {
    return this.request?.run.id === runId
      ? this.request.taskBindings.find((binding) => binding.taskId === taskId)
      : undefined;
  }

  async persistReevaluation(reevaluation: PersistedReevaluation): Promise<void> {
    this.reevaluations.push(reevaluation);
  }

  async persistDispatch(dispatch: PersistedDispatch): Promise<void> {
    await this.persistReevaluation(dispatch.reevaluation);
    for (const attempt of dispatch.attempts) {
      await this.persistAttempt(attempt);
    }
  }

  async recoverDispatches(): Promise<readonly PersistedDispatch[]> {
    return this.reevaluations
      .filter((reeval) =>
        reeval.decision.decision.taskDecisions.some((td) => td.action === 'start')
      )
      .map((reeval) => ({
        reevaluation: reeval,
        attempts: this.attempts.filter((a) =>
          reeval.decision.decision.taskDecisions
            .filter((td) => td.action === 'start')
            .some((td) => td.taskId === a.attempt.taskId)
        )
      }));
  }

  async recoverAttempts(runId: string) {
    return this.attempts.filter((a) => a.runId === runId);
  }

  async recoverLeases(): Promise<readonly PersistedWriteLease[]> {
    return this.leases;
  }

  async persistImpact(record: PersistedTaskImpact): Promise<void> {
    this.impacts.push(record);
  }

  async persistReview(review: PersistedTaskCodeReview): Promise<void> {
    this.reviews.push(review);
  }

  async recoverReviews(runId: string) {
    return this.reviews.filter((review) => review.runId === runId);
  }

  async persistVerificationEvidence(): Promise<void> {}
  async recoverVerificationEvidence(): Promise<readonly TaskVerificationEvidence[]> {
    return [];
  }
  async persistConflict(): Promise<void> {}
  async recoverConflicts(): Promise<readonly PersistedTaskConflict[]> {
    return [];
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

  async claimBuilderStart(record: PersistedAgentExecutionAttempt): Promise<AgentExecutionAttempt> {
    if (this.state !== 'ACTIVE') {
      throw new Error(`Run is not active: ${record.runId}`);
    }
    const index = this.attempts.findIndex((entry) => entry.attempt.id === record.attempt.id);
    const existing = this.attempts[index]?.attempt;
    if (
      existing === undefined ||
      existing.state !== 'PREPARING' ||
      existing.revision + 1 !== record.attempt.revision
    ) {
      throw new Error(`Builder claim authority mismatch: ${record.attempt.id}`);
    }
    this.attempts[index] = record;
    return record.attempt;
  }

  async claimIntegrationStart(request: {
    runId: string;
    taskId: string;
    workspaceId: string;
    outputAttemptId: string;
  }): Promise<void> {
    if (this.state !== 'ACTIVE') {
      throw new Error(`Run is not active: ${request.runId}`);
    }
    const existing = this.integrationClaims.find(
      (claim) => claim.runId === request.runId && claim.taskId === request.taskId
    );
    if (existing === undefined) {
      this.integrationClaims.push(request);
      return;
    }
    if (
      existing.workspaceId !== request.workspaceId ||
      existing.outputAttemptId !== request.outputAttemptId
    ) {
      throw new Error(
        `Integration mutation claim authority mismatch: ${request.runId}/${request.taskId}`
      );
    }
  }

  async releaseIntegrationClaim(request: {
    runId: string;
    taskId: string;
    workspaceId: string;
    outputAttemptId: string;
  }): Promise<void> {
    const index = this.integrationClaims.findIndex(
      (claim) =>
        claim.runId === request.runId &&
        claim.taskId === request.taskId &&
        claim.workspaceId === request.workspaceId &&
        claim.outputAttemptId === request.outputAttemptId
    );
    if (index < 0) {
      throw new Error(
        `Integration mutation claim is missing or mismatched: ${request.runId}/${request.taskId}`
      );
    }
    this.integrationClaims.splice(index, 1);
  }

  async settleIntegrationCancellation(request: {
    runId: string;
    taskId: string;
    workspaceId: string;
    outputAttemptId: string;
    detail: string;
  }): Promise<void> {
    if (this.state !== 'CANCEL_REQUESTED') {
      throw new Error(`Run cancellation is not requested: ${request.runId}/${this.state}`);
    }
    if (request.detail.trim().length === 0) {
      throw new Error('Integration cancellation settlement detail must not be empty');
    }
    await this.releaseIntegrationClaim(request);
  }

  async hasActiveIntegrationClaim(runId: string): Promise<boolean> {
    return this.integrationClaims.some((claim) => claim.runId === runId);
  }

  async updateRunState(_runId: string, state: RecoveredRun['run']['state']): Promise<void> {
    this.state = state;
  }

  async requestCancellation(): Promise<
    | { status: 'requested' | 'already-requested'; state: 'CANCEL_REQUESTED' }
    | { status: 'terminal'; state: 'COMPLETED' | 'FAILED' | 'CANCELLED' }
  > {
    if (this.state === 'ACTIVE') {
      this.state = 'CANCEL_REQUESTED';
      return { status: 'requested', state: 'CANCEL_REQUESTED' };
    }
    if (this.state === 'CANCEL_REQUESTED') {
      return { status: 'already-requested', state: 'CANCEL_REQUESTED' };
    }
    return { status: 'terminal', state: this.state };
  }

  async finalizeCancellation(): Promise<
    | { status: 'cancelled'; state: 'CANCELLED' }
    | { status: 'not-requested'; state: 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'CANCELLED' }
  > {
    if (this.state === 'CANCEL_REQUESTED') {
      this.state = 'CANCELLED';
      return { status: 'cancelled', state: 'CANCELLED' };
    }
    return { status: 'not-requested', state: this.state };
  }

  async recoverRun(runId: string): Promise<RecoveredRun | undefined> {
    if (this.request === undefined || this.request.run.id !== runId) {
      return undefined;
    }
    return {
      run: { ...this.request.run, state: this.state },
      tasks: this.request.tasks,
      taskBindings: this.request.taskBindings,
      hardConflicts: this.request.hardConflicts,
      riskConflicts: this.request.riskConflicts,
      scheduleOptions: this.request.scheduleOptions,
      events: this.reevaluations.map(({ event }) => event),
      transitions: this.reevaluations.flatMap(({ transitions }) => transitions),
      decisions: this.reevaluations.map(({ decision }) => decision),
      impacts: this.impacts,
      conflicts: this.reevaluations.flatMap(({ runtimeConflicts }) => runtimeConflicts ?? []),
      leases: this.leases.filter((lease) => lease.runId === runId),
      workspaces: this.workspaces,
      attempts: this.attempts
    };
  }

  async replayRun(): Promise<readonly PersistedSchedulerDecision[]> {
    return this.reevaluations.map(({ decision }) => decision);
  }

  async persistIntegration(): Promise<void> {}
  async recoverIntegration(): Promise<undefined> {
    return undefined;
  }
  async persistRepairResumeDispatch(dispatch: PersistedRepairResumeDispatch): Promise<void> {
    this.repairResumeDispatches.push(dispatch);
  }
  async recoverRepairResumeDispatches(
    runId: string
  ): Promise<readonly PersistedRepairResumeDispatch[]> {
    return this.repairResumeDispatches.filter((dispatch) => dispatch.runId === runId);
  }

  async persistRepairAttempt(record: PersistedTaskRepairAttempt): Promise<void> {
    const index = this.repairAttempts.findIndex((entry) => entry.attempt.id === record.attempt.id);
    if (index >= 0) {
      this.repairAttempts[index] = record;
      return;
    }
    this.repairAttempts.push(record);
  }

  async claimRepairStart(record: PersistedTaskRepairAttempt): Promise<TaskRepairAttempt> {
    if (this.state !== 'ACTIVE') {
      throw new Error(`Run is not active: ${record.runId}`);
    }
    const index = this.repairAttempts.findIndex((entry) => entry.attempt.id === record.attempt.id);
    const existing = this.repairAttempts[index]?.attempt;
    if (
      existing === undefined ||
      existing.state !== 'PREPARING' ||
      existing.revision + 1 !== record.attempt.revision
    ) {
      throw new Error(`Repair claim authority mismatch: ${record.attempt.id}`);
    }
    this.repairAttempts[index] = record;
    return record.attempt;
  }

  async recoverRepairAttempts(): Promise<readonly PersistedTaskRepairAttempt[]> {
    return this.repairAttempts;
  }

  async recoverRepairAttemptHistory(): Promise<readonly PersistedTaskRepairAttempt[]> {
    return this.repairAttempts;
  }

  async admitRepairAttempt(request: { attempt: TaskRepairAttempt }): Promise<TaskRepairAttempt> {
    this.repairAttempts.push({ runId: request.attempt.runId, attempt: request.attempt });
    return request.attempt;
  }

  async resumeRepairAttempt(request: {
    runId: string;
    attemptId: string;
    expectedRevision: number;
    dispatch?: {
      taskId: string;
      dispatchId: string;
      authorizedAt: string;
    };
  }): Promise<
    | { status: 'resumed'; attempt: TaskRepairAttempt }
    | { status: 'not-found' }
    | { status: 'not-blocked'; state: TaskRepairAttempt['state'] }
    | { status: 'version-conflict'; actualRevision: number }
    | { status: 'lease-not-released'; actualState: 'ACTIVE' | 'RELEASED' | 'STALE' }
  > {
    const record = this.repairAttempts.find(
      (entry) => entry.attempt.id === request.attemptId && entry.runId === request.runId
    );
    if (record === undefined) {
      return { status: 'not-found' };
    }
    if (record.attempt.revision !== request.expectedRevision) {
      return { status: 'version-conflict', actualRevision: record.attempt.revision };
    }
    if (record.attempt.state !== 'BLOCKED') {
      return { status: 'not-blocked', state: record.attempt.state };
    }
    const lease = this.leases.find(
      (entry) => entry.runId === request.runId && entry.lease.id === record.attempt.blocker?.leaseId
    );
    if (
      lease === undefined ||
      (lease.lease.state !== 'RELEASED' && lease.lease.state !== 'STALE')
    ) {
      return { status: 'lease-not-released', actualState: lease?.lease.state ?? 'ACTIVE' };
    }
    const resumed = {
      ...record.attempt,
      state: 'PREPARING' as const,
      revision: record.attempt.revision + 1,
      blocker: undefined
    };
    this.repairAttempts[
      this.repairAttempts.findIndex((entry) => entry.attempt.id === request.attemptId)
    ] = {
      runId: request.runId,
      attempt: resumed
    };
    if (request.dispatch !== undefined) {
      this.repairResumeDispatches.push({
        runId: request.runId,
        taskId: request.dispatch.taskId,
        repairAttemptId: request.attemptId,
        repairRevision: resumed.revision,
        dispatchId: request.dispatch.dispatchId,
        authorizedAt: request.dispatch.authorizedAt
      });
    }
    return { status: 'resumed', attempt: resumed };
  }

  async recoverRepairWorkItems(): Promise<readonly TaskRepairWorkItem[]> {
    return this.repairWorkItems;
  }

  async persistRepairWorkItem(item: TaskRepairWorkItem): Promise<void> {
    const index = this.repairWorkItems.findIndex(
      (existing) => existing.repairAttemptId === item.repairAttemptId
    );
    if (index >= 0) {
      this.repairWorkItems[index] = item;
      return;
    }
    this.repairWorkItems.push(item);
  }

  async close(): Promise<void> {}
}

const createRunRequest = (taskIds: readonly string[]): CreatePersistedRunRequest => ({
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
      verificationPolicyFingerprint,
      codeReviewPolicyFingerprint: reviewPolicyFingerprint
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
    leasePlan: { taskId, source: 'manual' as const, predictedResources: [] },
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

const impactFor = (taskId: string): TaskImpact => ({
  predicted: {
    taskId,
    projectsRead: new Set(),
    projectsWritten: new Set(),
    explicitProjectsWritten: new Set(),
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
});

const emptyRepositoryGraph: RepositoryGraph = {
  repositoryPath: '/repo',
  projects: new Map(),
  projectDependencies: [],
  files: new Map(),
  symbols: new Map(),
  fileDependencies: [],
  symbolReferences: [],
  diagnostics: []
};

type BuilderExecutionOverride = NonNullable<ForgeWorkerCompositionOverrides['builderExecution']>;
type EvaluationOverride = NonNullable<ForgeWorkerCompositionOverrides['evaluation']>;
type IntegrationOverride = NonNullable<ForgeWorkerCompositionOverrides['integration']>;
type RepairExecutionOverride = NonNullable<ForgeWorkerCompositionOverrides['repairExecution']>;
type BuilderExecutionRequest = Parameters<BuilderExecutionOverride['execute']>[0];
type RepairExecutionRequest = Parameters<RepairExecutionOverride['execute']>[0];
type EvaluationRequest = Parameters<EvaluationOverride['evaluate']>[0];

const unexpectedExecution = (name: string) => async (): Promise<never> => {
  throw new Error(`${name} must not be called in this test`);
};

const unusedBuilderExecution = (): BuilderExecutionOverride => ({
  execute: unexpectedExecution('builder execution')
});

const unusedEvaluation = (): EvaluationOverride => ({
  evaluate: unexpectedExecution('builder-output evaluation')
});

const unusedIntegration = (): IntegrationOverride => ({
  integrate: unexpectedExecution('accepted-output integration')
});

const unusedRepairExecution = (): RepairExecutionOverride => ({
  execute: unexpectedExecution('repair execution')
});

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('temporal worker production vertical slice', () => {
  it('does not issue new authorizations after cancellation is requested', async () => {
    const persistence = new MemoryPersistence();
    await persistence.createRun(createRunRequest(['task-a']));
    await persistence.updateRunState('run-1', 'CANCEL_REQUESTED');

    const composition = await createForgeWorkerComposition({
      persistence,
      builderExecution: unusedBuilderExecution(),
      evaluation: unusedEvaluation(),
      integration: unusedIntegration(),
      repairExecution: unusedRepairExecution(),
      repositoryGraph: emptyRepositoryGraph
    });

    await expect(composition.forgeActivities.reevaluateRun({ runId: 'run-1' })).resolves.toEqual({
      runId: 'run-1',
      authorizedTasks: []
    });

    await composition.close();
  });

  it('rejects every external mutation activity after cancellation is requested', async () => {
    const persistence = new MemoryPersistence();
    await persistence.createRun(createRunRequest(['task-a']));
    await persistence.updateRunState('run-1', 'CANCEL_REQUESTED');
    const calls: string[] = [];
    const composition = await createForgeWorkerComposition({
      persistence,
      builderExecution: {
        execute: async () => {
          calls.push('builder');
          throw new Error('not reached');
        }
      } satisfies BuilderExecutionOverride,
      evaluation: {
        evaluate: async () => {
          calls.push('evaluation');
          throw new Error('not reached');
        }
      } satisfies EvaluationOverride,
      integration: {
        integrate: async () => {
          calls.push('integration');
          throw new Error('not reached');
        }
      } satisfies IntegrationOverride,
      repairExecution: {
        execute: async () => {
          calls.push('repair');
          throw new Error('not reached');
        }
      } satisfies RepairExecutionOverride,
      repositoryGraph: emptyRepositoryGraph
    });

    await expect(
      composition.forgeActivities.executeBuilder({
        runId: 'run-1',
        taskId: 'task-a',
        attemptId: 'attempt-task-a'
      })
    ).rejects.toThrow('Run does not accept mutations: run-1/CANCEL_REQUESTED');
    await expect(
      composition.forgeActivities.evaluateBuilderOutput({
        runId: 'run-1',
        taskId: 'task-a',
        workspaceId: 'workspace-task-a',
        builderAttemptId: 'attempt-task-a',
        impactId: 'attempt-task-a'
      })
    ).rejects.toThrow('Run does not accept mutations: run-1/CANCEL_REQUESTED');
    await expect(
      composition.forgeActivities.admitRepair({
        runId: 'run-1',
        taskId: 'task-a',
        reviewId: 'task-a:1',
        subjectRef: {
          builderAttemptId: 'attempt-task-a',
          outputAttemptId: 'attempt-task-a',
          workspaceId: 'workspace-task-a'
        }
      })
    ).rejects.toThrow('Run does not accept mutations: run-1/CANCEL_REQUESTED');
    await expect(
      composition.forgeActivities.executeRepair({
        runId: 'run-1',
        taskId: 'task-a',
        workspaceId: 'workspace-task-a',
        builderAttemptId: 'attempt-task-a',
        impactId: 'attempt-task-a',
        reviewId: 'task-a:1',
        repairAttemptId: 'repair-task-a'
      })
    ).rejects.toThrow('Run does not accept mutations: run-1/CANCEL_REQUESTED');
    await expect(
      composition.forgeActivities.integrateAcceptedOutput({
        runId: 'run-1',
        taskId: 'task-a',
        workspaceId: 'workspace-task-a',
        subjectRef: {
          builderAttemptId: 'attempt-task-a',
          outputAttemptId: 'attempt-task-a',
          workspaceId: 'workspace-task-a'
        }
      })
    ).rejects.toThrow('Run does not accept mutations: run-1/CANCEL_REQUESTED');
    await expect(
      composition.forgeActivities.resumeBlockedRepair({
        runId: 'run-1',
        repairAttemptId: 'repair-task-a'
      })
    ).rejects.toThrow('Run does not accept mutations: run-1/CANCEL_REQUESTED');
    expect(calls).toEqual([]);

    await composition.close();
  });

  it('finalizes a durable cancellation request only through the cancellation activity', async () => {
    const persistence = new MemoryPersistence();
    await persistence.createRun(createRunRequest(['task-a']));
    await persistence.updateRunState('run-1', 'CANCEL_REQUESTED');

    const composition = await createForgeWorkerComposition({
      persistence,
      builderExecution: unusedBuilderExecution(),
      evaluation: unusedEvaluation(),
      integration: unusedIntegration(),
      repairExecution: unusedRepairExecution(),
      repositoryGraph: emptyRepositoryGraph
    });

    await expect(
      composition.forgeActivities.finalizeRunCancellation?.({ runId: 'run-1' })
    ).resolves.toEqual({ runId: 'run-1', status: 'cancelled' });
    expect(persistence.state).toBe('CANCELLED');

    await composition.close();
  });

  it('keeps a cancellation request pending until unknown attempts are reconciled', async () => {
    const persistence = new MemoryPersistence();
    await persistence.createRun(createRunRequest(['task-a']));
    await persistence.updateRunState('run-1', 'CANCEL_REQUESTED');
    await persistence.persistAttempt({
      runId: 'run-1',
      attempt: {
        id: 'unknown-builder-attempt',
        runId: 'run-1',
        taskId: 'task-a',
        agentId: 'agent-1',
        workspaceId: 'workspace-task-a',
        leasePlanFingerprint: taskLeasePlanFingerprint({
          taskId: 'task-a',
          source: 'manual',
          predictedResources: []
        }),
        state: 'UNKNOWN',
        revision: 1,
        failure: { type: 'unknown-outcome', detail: 'activity cancellation raced with execution' }
      }
    });

    const composition = await createForgeWorkerComposition({
      persistence,
      builderExecution: unusedBuilderExecution(),
      evaluation: unusedEvaluation(),
      integration: unusedIntegration(),
      repairExecution: unusedRepairExecution(),
      repositoryGraph: emptyRepositoryGraph
    });

    await expect(
      composition.forgeActivities.finalizeRunCancellation?.({ runId: 'run-1' })
    ).resolves.toEqual({ runId: 'run-1', status: 'pending' });
    expect(persistence.state).toBe('CANCEL_REQUESTED');

    await composition.close();
  });

  it('keeps a cancellation request pending until active leases are released', async () => {
    const persistence = new MemoryPersistence();
    await persistence.createRun(createRunRequest(['task-a']));
    await persistence.updateRunState('run-1', 'CANCEL_REQUESTED');
    await persistence.persistLease({
      runId: 'run-1',
      lease: {
        id: 'active-cancellation-lease',
        runId: 'run-1',
        agentId: 'agent-1',
        taskId: 'task-a',
        resource: { type: 'project', projectId: 'project-a' },
        mode: 'exclusive',
        version: 1,
        state: 'ACTIVE',
        acquiredAt: new Date('2026-09-20T00:00:00.000Z'),
        lastHeartbeatAt: new Date('2026-09-20T00:00:00.000Z')
      }
    });

    const composition = await createForgeWorkerComposition({
      persistence,
      builderExecution: unusedBuilderExecution(),
      evaluation: unusedEvaluation(),
      integration: unusedIntegration(),
      repairExecution: unusedRepairExecution(),
      repositoryGraph: emptyRepositoryGraph
    });

    await expect(
      composition.forgeActivities.finalizeRunCancellation?.({ runId: 'run-1' })
    ).resolves.toEqual({ runId: 'run-1', status: 'pending' });
    expect(persistence.state).toBe('CANCEL_REQUESTED');

    await composition.close();
  });

  it('keeps cancellation pending while accepted-output integration is in flight', async () => {
    const persistence = new MemoryPersistence();
    const request = createRunRequest(['task-a']);
    await persistence.createRun(request);
    const [binding] = request.taskBindings;
    const workspace: TaskWorkspace = {
      ...binding.workspace,
      revision: 1,
      phase: 'READY_TO_INTEGRATE'
    };
    const subject = {
      builderAttemptId: 'builder-attempt-1',
      outputAttemptId: 'output-attempt-1',
      workspaceId: workspace.id,
      workspaceRevision: workspace.revision,
      workspaceChangeFingerprint: 'sha256:'.concat('a'.repeat(64)),
      impactFingerprint: 'sha256:'.concat('b'.repeat(64)),
      verificationFingerprint: 'sha256:'.concat('c'.repeat(64))
    };
    await persistence.persistWorkspace({ runId: 'run-1', workspace });
    await persistence.persistReview({
      runId: 'run-1',
      taskId: 'task-a',
      iteration: 1,
      subject,
      review: { recommendation: 'accept', summary: 'accepted', findings: [] }
    });
    let integrationEntered!: () => void;
    const integrationStarted = new Promise<void>((resolve) => {
      integrationEntered = resolve;
    });
    let settleIntegration!: () => void;
    const integrationSettled = new Promise<void>((resolve) => {
      settleIntegration = resolve;
    });
    const composition = await createForgeWorkerComposition({
      persistence,
      builderExecution: unusedBuilderExecution(),
      evaluation: unusedEvaluation(),
      integration: {
        async integrate(integrationRequest) {
          integrationEntered();
          await integrationSettled;
          const integrated: TaskWorkspace = {
            ...integrationRequest.workspace,
            revision: integrationRequest.workspace.revision + 1,
            phase: 'INTEGRATED',
            integrationCommit: 'commit-task-a'
          };
          await persistence.persistWorkspace({
            runId: integrationRequest.runId,
            workspace: integrated
          });
          return { status: 'integrated', workspace: integrated };
        }
      } satisfies IntegrationOverride,
      repairExecution: unusedRepairExecution(),
      repositoryGraph: emptyRepositoryGraph
    });

    const integration = composition.forgeActivities.integrateAcceptedOutput({
      runId: 'run-1',
      taskId: 'task-a',
      workspaceId: workspace.id,
      subjectRef: {
        builderAttemptId: subject.builderAttemptId,
        outputAttemptId: subject.outputAttemptId,
        workspaceId: subject.workspaceId
      }
    });
    await integrationStarted;
    await expect(persistence.requestCancellation()).resolves.toEqual({
      status: 'requested',
      state: 'CANCEL_REQUESTED'
    });
    await expect(
      composition.forgeActivities.finalizeRunCancellation?.({ runId: 'run-1' })
    ).resolves.toEqual({ runId: 'run-1', status: 'pending' });
    expect(persistence.state).toBe('CANCEL_REQUESTED');

    settleIntegration();
    await expect(integration).resolves.toEqual({
      runId: 'run-1',
      taskId: 'task-a',
      status: 'integrated'
    });
    await expect(
      composition.forgeActivities.finalizeRunCancellation?.({ runId: 'run-1' })
    ).resolves.toEqual({ runId: 'run-1', status: 'cancelled' });
    expect(persistence.state).toBe('CANCELLED');

    await composition.close();
  });

  it('resumes a blocked repair through exact blocker validation and reuses the same repairAttemptId', async () => {
    const persistence = new MemoryPersistence();
    const runRequest = createRunRequest(['task-a', 'task-b']);
    await persistence.createRun({
      ...runRequest,
      taskBindings: runRequest.taskBindings.map((binding) => ({
        ...binding,
        leasePlan: {
          ...binding.leasePlan,
          predictedResources:
            binding.taskId === 'task-b'
              ? [{ type: 'project' as const, projectId: 'project-a' }]
              : []
        }
      }))
    });

    const builderLeasePlanFingerprint = taskLeasePlanFingerprint({
      taskId: 'task-a',
      source: 'manual',
      predictedResources: []
    });
    const builderAttempt: AgentExecutionAttempt = {
      id: 'builder-attempt-1',
      runId: 'run-1',
      taskId: 'task-a',
      agentId: 'agent-1',
      workspaceId: 'workspace-task-a',
      leasePlanFingerprint: builderLeasePlanFingerprint,
      commandPolicyFingerprint: 'sha256:'.concat('9'.repeat(64)),
      state: 'COMPLETED',
      revision: 2,
      startedAt: new Date('2026-08-12T00:00:00.000Z'),
      completedAt: new Date('2026-08-12T00:01:00.000Z')
    };
    const workspace: TaskWorkspace = {
      runId: 'run-1',
      taskId: 'task-a',
      id: 'workspace-task-a',
      branchName: 'branch-task-a',
      baseRef: 'main',
      integrationRepositoryPath: '/repo/task-a',
      workspacePath: '/workspace/task-a',
      integrationRef: 'refs/heads/branch-task-a',
      revision: 1,
      phase: 'READY_TO_INTEGRATE'
    };
    const blockedRepair: TaskRepairAttempt = {
      id: 'repair-attempt-1',
      runId: 'run-1',
      taskId: 'task-a',
      agentId: 'agent-1',
      workspaceId: workspace.id,
      parentReviewIteration: 1,
      parentReviewSubject: {
        builderAttemptId: builderAttempt.id,
        outputAttemptId: builderAttempt.id,
        workspaceId: workspace.id,
        workspaceRevision: 1,
        workspaceChangeFingerprint: 'sha256:'.concat('a'.repeat(64)),
        impactFingerprint: 'sha256:'.concat('b'.repeat(64)),
        verificationFingerprint: 'sha256:'.concat('c'.repeat(64))
      },
      repairIteration: 1,
      state: 'BLOCKED',
      revision: 3,
      startedAt: new Date('2026-08-12T00:02:00.000Z'),
      blocker: { type: 'lease', leaseId: 'lease-blocker-1' }
    };
    const workItem: TaskRepairWorkItem = {
      runId: 'run-1',
      taskId: 'task-a',
      repairAttemptId: blockedRepair.id,
      builderAttemptId: builderAttempt.id,
      workspaceId: workspace.id,
      leasePlanFingerprint: builderLeasePlanFingerprint,
      impactFingerprint: 'sha256:'.concat('b'.repeat(64)),
      parentReviewIteration: 1,
      reviewIteration: 2,
      verificationPolicyFingerprint,
      codeReviewPolicyFingerprint: reviewPolicyFingerprint
    };

    persistence.attempts.push({ runId: 'run-1', attempt: builderAttempt });
    persistence.workspaces.push({ runId: 'run-1', workspace });
    persistence.impacts.push({ runId: 'run-1', taskId: 'task-a', impact: impactFor('task-a') });
    persistence.reviews.push({
      runId: 'run-1',
      taskId: 'task-a',
      iteration: 1,
      subject: blockedRepair.parentReviewSubject,
      review: {
        recommendation: 'repair',
        summary: 'needs repair',
        findings: []
      }
    });
    persistence.repairAttempts.push({ runId: 'run-1', attempt: blockedRepair });
    persistence.repairWorkItems.push(workItem);
    persistence.leases.push({
      runId: 'run-1',
      lease: {
        id: 'lease-blocker-1',
        runId: 'run-1',
        agentId: 'agent-blocker',
        taskId: 'task-z',
        resource: { type: 'project', projectId: 'project-a' },
        mode: 'exclusive',
        version: 3,
        state: 'RELEASED',
        acquiredAt: new Date('2026-08-12T00:00:00.000Z'),
        lastHeartbeatAt: new Date('2026-08-12T00:00:30.000Z'),
        releasedAt: new Date('2026-08-12T00:03:00.000Z')
      }
    });

    const composition = await createForgeWorkerComposition({
      persistence,
      builderExecution: unusedBuilderExecution(),
      evaluation: unusedEvaluation(),
      integration: unusedIntegration(),
      repairRunner: {
        async run(request) {
          await request.onStarted({
            sessionRef: { backend: 'repair-resume-fixture', value: 'repair-session' }
          });
          return {
            status: 'completed',
            sessionRef: { backend: 'repair-resume-fixture', value: 'repair-session' }
          };
        }
      },
      verifier: {
        async verify() {
          return { status: 'passed' };
        }
      },
      snapshots: {
        async capture({ repositoryPath }) {
          return {
            repositoryId: 'repo-1',
            repositoryRoot: repositoryPath,
            baseCommit: 'a'.repeat(40),
            workingTreeFingerprint: 'sha256:'.concat('e'.repeat(64)),
            dirty: true
          };
        }
      },
      reviewer: {
        async review() {
          return { recommendation: 'accept', summary: 'repair accepted', findings: [] };
        }
      },
      reconciler: {
        async reconcile({ taskId }) {
          return {
            observed: {
              taskId,
              filesRead: new Set(),
              filesCreated: new Set(['project-a:expanded.ts']),
              filesWritten: new Set(['project-a:expanded.ts']),
              filesDeleted: new Set(),
              symbolsWritten: new Set(),
              dependencyRequests: new Set(),
              manifestFilesChanged: new Set(),
              generatedFilesChanged: new Set()
            },
            reconciliation: {
              status: 'runtime-scope-expanded',
              expandedFileIds: new Set(['project-a:expanded.ts']),
              unleasedFileIds: new Set()
            },
            expandedResources: [
              { type: 'file', projectId: 'project-a', fileId: 'project-a:expanded.ts' }
            ]
          };
        }
      },
      repositoryGraph: emptyRepositoryGraph
    });
    const activities = composition.forgeActivities;

    const ignored = await activities.resumeBlockedRepair({
      runId: 'run-1',
      repairAttemptId: 'missing-repair'
    });
    expect(ignored.status).toBe('ignored');

    const resumed = await activities.resumeBlockedRepair({
      runId: 'run-1',
      repairAttemptId: blockedRepair.id
    });
    expect(resumed.status).toBe('resumed');
    expect(resumed.repairAttemptId).toBe(blockedRepair.id);
    expect(resumed.taskId).toBe('task-a');

    // Temporal may retry after the SQLite CAS commits but before its activity
    // response is delivered. The persisted dispatch for the PREPARING
    // revision must recover the same authorization without a second CAS.
    const recoveredAfterLostResponse = await activities.resumeBlockedRepair({
      runId: 'run-1',
      repairAttemptId: blockedRepair.id
    });
    expect(recoveredAfterLostResponse).toMatchObject({
      status: 'resumed',
      repairAttemptId: blockedRepair.id,
      taskId: 'task-a'
    });
    expect(persistence.repairResumeDispatches).toHaveLength(1);

    const repaired = await activities.executeRepair({
      runId: 'run-1',
      taskId: 'task-a',
      workspaceId: workspace.id,
      builderAttemptId: builderAttempt.id,
      impactId: builderAttempt.id,
      reviewId: 'task-a:1',
      repairAttemptId: blockedRepair.id
    });
    expect(repaired.state).toBe('completed');
    expect(repaired.repairAttemptId).toBe(blockedRepair.id);
    expect(repaired.recommendation).toBe('accept');
    expect(
      persistence.reevaluations.find(({ event }) => event.event.type === 'runtime-scope-expanded')
    ).toMatchObject({
      runtimeConflicts: [
        {
          taskA: 'task-a',
          taskB: 'task-b',
          conflict: {
            constraints: [expect.objectContaining({ type: 'runtime-scope-expansion' })]
          }
        }
      ]
    });
  }, 60000);

  it('reopens SQLite, hydrates active leases, and recovers the same durable resume authorization', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'forge-worker-restart-'));
    directories.push(directory);
    const databasePath = join(directory, 'run.sqlite');
    const writer = new DrizzleSqliteOrchestrationPersistence(databasePath);
    await writer.createRun(createRunRequest(['task-a']));

    const leasePlanFingerprint = taskLeasePlanFingerprint({
      taskId: 'task-a',
      source: 'manual',
      predictedResources: []
    });
    const workspace: TaskWorkspace = {
      runId: 'run-1',
      taskId: 'task-a',
      id: 'workspace-task-a',
      branchName: 'branch-task-a',
      baseRef: 'main',
      integrationRepositoryPath: '/repo/task-a',
      workspacePath: '/workspace/task-a',
      integrationRef: 'refs/heads/branch-task-a',
      revision: 1,
      phase: 'READY_TO_INTEGRATE'
    };
    const builderAttempt: AgentExecutionAttempt = {
      id: 'builder-attempt-restart',
      runId: 'run-1',
      taskId: 'task-a',
      agentId: 'agent-1',
      workspaceId: workspace.id,
      leasePlanFingerprint,
      state: 'COMPLETED',
      revision: 2,
      startedAt: new Date('2026-08-12T00:00:00.000Z'),
      completedAt: new Date('2026-08-12T00:01:00.000Z')
    };
    const parentSubject = {
      builderAttemptId: builderAttempt.id,
      outputAttemptId: builderAttempt.id,
      workspaceId: workspace.id,
      workspaceRevision: 1,
      workspaceChangeFingerprint: 'sha256:'.concat('a'.repeat(64)),
      impactFingerprint: 'sha256:'.concat('b'.repeat(64)),
      verificationFingerprint: 'sha256:'.concat('c'.repeat(64))
    };
    const blockedRepair: TaskRepairAttempt = {
      id: 'repair-attempt-restart',
      runId: 'run-1',
      taskId: 'task-a',
      agentId: 'agent-1',
      workspaceId: workspace.id,
      parentReviewIteration: 1,
      parentReviewSubject: parentSubject,
      repairIteration: 1,
      state: 'PREPARING',
      revision: 2,
      startedAt: new Date('2026-08-12T00:02:00.000Z'),
      blocker: undefined
    };
    await writer.persistWorkspace({ runId: 'run-1', workspace });
    await writer.persistAttempt({ runId: 'run-1', attempt: builderAttempt });
    await writer.persistImpact({ runId: 'run-1', taskId: 'task-a', impact: impactFor('task-a') });
    await writer.persistReview({
      runId: 'run-1',
      taskId: 'task-a',
      iteration: 1,
      subject: parentSubject,
      review: {
        recommendation: 'repair',
        summary: 'needs repair',
        findings: [
          {
            id: 'finding-restart',
            severity: 'high',
            fileIds: ['file:restart-fixture'],
            symbolIds: [],
            description: 'Repair required before integration.'
          }
        ]
      }
    });
    await writer.persistRepairAttempt({ runId: 'run-1', attempt: blockedRepair });
    await writer.persistRepairWorkItem({
      runId: 'run-1',
      taskId: 'task-a',
      repairAttemptId: blockedRepair.id,
      builderAttemptId: builderAttempt.id,
      workspaceId: workspace.id,
      leasePlanFingerprint,
      impactFingerprint: parentSubject.impactFingerprint,
      parentReviewIteration: 1,
      reviewIteration: 2,
      verificationPolicyFingerprint,
      codeReviewPolicyFingerprint: reviewPolicyFingerprint
    });
    await writer.persistLease({
      runId: 'run-1',
      lease: {
        id: 'lease-blocker-restart',
        runId: 'run-1',
        agentId: 'agent-blocker',
        taskId: 'task-z',
        resource: { type: 'project', projectId: 'project-a' },
        mode: 'exclusive',
        version: 2,
        state: 'ACTIVE',
        acquiredAt: new Date('2026-08-12T00:00:00.000Z'),
        lastHeartbeatAt: new Date('2026-08-12T00:00:30.000Z')
      }
    });
    await writer.persistLease({
      runId: 'run-1',
      lease: {
        id: 'lease-active-restart',
        runId: 'run-1',
        agentId: 'agent-active',
        taskId: 'task-z',
        resource: { type: 'project', projectId: 'project-b' },
        mode: 'exclusive',
        version: 2,
        state: 'ACTIVE',
        acquiredAt: new Date('2026-08-12T00:00:00.000Z'),
        lastHeartbeatAt: new Date('2026-08-12T00:00:30.000Z')
      }
    });
    const compositionA = await createForgeWorkerComposition({
      persistence: writer,
      repositoryGraph: emptyRepositoryGraph,
      builderExecution: unusedBuilderExecution(),
      evaluation: unusedEvaluation(),
      integration: unusedIntegration(),
      repairExecution: {
        async execute(request: RepairExecutionRequest) {
          if (request.preCreatedRepairAttempt === undefined) {
            throw new Error('Expected a pre-created repair attempt');
          }
          const blocked = {
            ...request.preCreatedRepairAttempt,
            state: 'BLOCKED' as const,
            revision: request.preCreatedRepairAttempt.revision + 1,
            blocker: { type: 'lease' as const, leaseId: 'lease-blocker-restart' }
          };
          await writer.persistRepairAttempt({ runId: 'run-1', attempt: blocked });
          return {
            state: 'blocked' as const,
            attempt: blocked,
            blockerLeaseId: 'lease-blocker-restart'
          };
        }
      } satisfies RepairExecutionOverride
    });
    await compositionA.forgeActivities.reevaluateRun({ runId: 'run-1' });
    const blocked = await compositionA.forgeActivities.executeRepair({
      runId: 'run-1',
      taskId: 'task-a',
      workspaceId: workspace.id,
      builderAttemptId: builderAttempt.id,
      impactId: builderAttempt.id,
      reviewId: 'task-a:1',
      repairAttemptId: blockedRepair.id
    });
    expect(blocked).toMatchObject({ state: 'blocked', repairAttemptId: blockedRepair.id });
    await compositionA.close();

    const reader = new DrizzleSqliteOrchestrationPersistence(databasePath);
    const hydratedLeaseSnapshots: string[][] = [];
    const compositionB = await createForgeWorkerComposition({
      persistence: reader,
      repositoryGraph: emptyRepositoryGraph,
      onWriteGuardHydrated: (_runId, leases) =>
        hydratedLeaseSnapshots.push(leases.map((lease) => lease.id).toSorted()),
      builderExecution: unusedBuilderExecution(),
      evaluation: unusedEvaluation(),
      repairExecution: {
        async execute(request: RepairExecutionRequest) {
          if (request.preCreatedRepairAttempt === undefined) {
            throw new Error('Expected a pre-created repair attempt');
          }
          const reviewSubject = {
            builderAttemptId: builderAttempt.id,
            outputAttemptId: request.preCreatedRepairAttempt.id,
            workspaceId: workspace.id,
            workspaceRevision: 2,
            workspaceChangeFingerprint: 'sha256:'.concat('d'.repeat(64)),
            impactFingerprint: parentSubject.impactFingerprint,
            verificationFingerprint: 'sha256:'.concat('e'.repeat(64))
          };
          const review: TaskCodeReview = {
            recommendation: 'accept',
            summary: 'restart repair accepted',
            findings: []
          };
          await reader.persistReview({
            runId: request.runId,
            taskId: 'task-a',
            iteration: 2,
            subject: reviewSubject,
            review
          });
          return {
            state: 'completed' as const,
            attempt: {
              ...request.preCreatedRepairAttempt,
              state: 'COMPLETED' as const,
              revision: request.preCreatedRepairAttempt.revision + 1,
              completedAt: new Date('2026-08-12T00:04:00.000Z')
            },
            recommendation: 'accept' as const,
            verification: {
              id: 'verification-restart-repair',
              runId: request.runId,
              taskId: request.preCreatedRepairAttempt.taskId,
              attemptId: request.preCreatedRepairAttempt.id,
              workspaceId: request.workspace.id,
              workspaceRevision: request.workspace.revision,
              workspaceChangeFingerprint: reviewSubject.workspaceChangeFingerprint,
              verificationPolicyFingerprint: 'fp',
              status: 'passed' as const,
              verifiedAt: new Date('2026-08-12T00:04:00.000Z').toISOString(),
              fingerprint: 'verification-restart-repair'
            },
            reviewSubject,
            review
          };
        }
      } satisfies RepairExecutionOverride,
      integration: {
        async integrate(request: { workspace: TaskWorkspace }) {
          return { status: 'integrated' as const, workspace: request.workspace };
        }
      } satisfies IntegrationOverride
    });
    const earlyWake = await compositionB.forgeActivities.resumeBlockedRepair({
      runId: 'run-1',
      repairAttemptId: blockedRepair.id
    });
    expect(earlyWake).toMatchObject({ status: 'ignored', repairAttemptId: blockedRepair.id });
    expect(hydratedLeaseSnapshots).toEqual([['lease-active-restart', 'lease-blocker-restart']]);

    const releaser = new DrizzleSqliteOrchestrationPersistence(databasePath);
    await releaser.persistLease({
      runId: 'run-1',
      lease: {
        id: 'lease-blocker-restart',
        runId: 'run-1',
        agentId: 'agent-blocker',
        taskId: 'task-z',
        resource: { type: 'project', projectId: 'project-a' },
        mode: 'exclusive',
        version: 3,
        state: 'RELEASED',
        acquiredAt: new Date('2026-08-12T00:00:00.000Z'),
        lastHeartbeatAt: new Date('2026-08-12T00:00:30.000Z'),
        releasedAt: new Date('2026-08-12T00:03:00.000Z')
      }
    });
    releaser.close();

    const resumed = await compositionB.forgeActivities.resumeBlockedRepair({
      runId: 'run-1',
      repairAttemptId: blockedRepair.id
    });
    expect(resumed).toMatchObject({
      status: 'resumed',
      repairAttemptId: blockedRepair.id,
      taskId: 'task-a'
    });
    expect(hydratedLeaseSnapshots).toEqual([
      ['lease-active-restart', 'lease-blocker-restart'],
      ['lease-active-restart', 'lease-blocker-restart']
    ]);

    const recoveredAfterLostResponse = await compositionB.forgeActivities.resumeBlockedRepair({
      runId: 'run-1',
      repairAttemptId: blockedRepair.id
    });
    expect(recoveredAfterLostResponse).toMatchObject({
      status: 'resumed',
      repairAttemptId: blockedRepair.id
    });
    expect(await reader.recoverRepairResumeDispatches('run-1')).toHaveLength(1);

    const repaired = await compositionB.forgeActivities.executeRepair({
      runId: 'run-1',
      taskId: 'task-a',
      workspaceId: workspace.id,
      builderAttemptId: builderAttempt.id,
      impactId: builderAttempt.id,
      reviewId: 'task-a:1',
      repairAttemptId: blockedRepair.id
    });
    expect(repaired).toMatchObject({
      state: 'completed',
      repairAttemptId: blockedRepair.id,
      recommendation: 'accept',
      reviewId: 'task-a:2'
    });
    if (repaired.subjectRef === undefined) {
      throw new Error('Expected persisted repair review subject');
    }
    const integrated = await compositionB.forgeActivities.integrateAcceptedOutput({
      runId: 'run-1',
      taskId: 'task-a',
      workspaceId: workspace.id,
      subjectRef: repaired.subjectRef
    });
    expect(integrated.status).toBe('integrated');
    await compositionB.close();
  }, 60000);

  it('persists builder scope expansion before later scheduling can authorize a conflicting task', async () => {
    const persistence = new MemoryPersistence();
    const request = createRunRequest(['task-a', 'task-b']);
    await persistence.createRun({
      ...request,
      tasks: request.tasks.map((task) => ({ ...task, dependencies: [] })),
      taskBindings: request.taskBindings.map((binding) => ({
        ...binding,
        leasePlan: {
          ...binding.leasePlan,
          predictedResources:
            binding.taskId === 'task-b' ? [{ type: 'project' as const, projectId: 'core' }] : []
        }
      }))
    });

    const composition = await createForgeWorkerComposition({
      persistence,
      repositoryGraph: emptyRepositoryGraph,
      workspaceManager: {
        async create(workspace) {
          return { ...workspace, revision: 1, phase: 'READY_TO_INTEGRATE' };
        },
        commit: unexpectedExecution('workspace commit'),
        integrate: unexpectedExecution('workspace integration'),
        resumeIntegration: unexpectedExecution('workspace integration resume'),
        abortIntegration: unexpectedExecution('workspace integration abort'),
        dispose: unexpectedExecution('workspace disposal')
      },
      builderAgentRunner: {
        async run(runRequest) {
          await runRequest.onStarted({
            sessionRef: { backend: 'scope-expansion-fixture', value: 'builder-session' }
          });
          return {
            status: 'completed' as const,
            sessionRef: { backend: 'scope-expansion-fixture', value: 'builder-session' }
          };
        }
      },
      reconciler: {
        async reconcile({ taskId }) {
          return {
            observed: {
              taskId,
              filesRead: new Set(),
              filesCreated: new Set(['core:expanded.ts']),
              filesWritten: new Set(['core:expanded.ts']),
              filesDeleted: new Set(),
              symbolsWritten: new Set(),
              dependencyRequests: new Set(),
              manifestFilesChanged: new Set(),
              generatedFilesChanged: new Set()
            },
            reconciliation: {
              status: 'runtime-scope-expanded' as const,
              expandedFileIds: new Set(['core:expanded.ts']),
              unleasedFileIds: new Set()
            },
            expandedResources: [
              { type: 'file' as const, projectId: 'core', fileId: 'core:expanded.ts' }
            ]
          };
        }
      }
    });

    const initial = await composition.forgeActivities.reevaluateRun({ runId: 'run-1' });
    expect(initial.authorizedTasks).toEqual([expect.objectContaining({ taskId: 'task-a' })]);

    await composition.forgeActivities.executeBuilder({
      runId: 'run-1',
      taskId: 'task-a',
      attemptId: initial.authorizedTasks[0].attemptId
    });

    const expansion = persistence.reevaluations.find(
      ({ event }) => event.event.type === 'runtime-scope-expanded'
    );
    expect(expansion).toMatchObject({
      event: {
        sequence: 2,
        event: {
          type: 'runtime-scope-expanded',
          taskId: 'task-a',
          conflictId: 'runtime-scope:task-a:task-b'
        }
      },
      runtimeConflicts: [
        {
          taskA: 'task-a',
          taskB: 'task-b',
          effectiveFromSequence: 2,
          conflict: {
            constraints: [
              expect.objectContaining({
                type: 'runtime-scope-expansion',
                resourceIds: ['core:expanded.ts']
              })
            ]
          }
        }
      ]
    });
    expect((await persistence.recoverRun('run-1'))?.conflicts).toEqual(expansion?.runtimeConflicts);

    const completed = persistence.reevaluations.find(
      ({ event }) => event.event.type === 'agent-completed' && event.event.taskId === 'task-a'
    );
    expect(completed?.decision.decision.taskDecisions).toContainEqual(
      expect.objectContaining({
        taskId: 'task-b',
        action: 'defer',
        reasons: [
          expect.objectContaining({
            type: 'hard-conflict',
            conflictingTaskIds: ['task-a'],
            constraintTypes: ['runtime-scope-expansion']
          })
        ]
      })
    );
    await expect(composition.forgeActivities.reevaluateRun({ runId: 'run-1' })).resolves.toEqual({
      runId: 'run-1',
      authorizedTasks: []
    });
    await composition.close();
  });

  it('preserves released lease history when rebuilding a guard for a new builder activity', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'forge-worker-lease-history-'));
    directories.push(directory);
    const databasePath = join(directory, 'authority.sqlite');
    const writer = new DrizzleSqliteOrchestrationPersistence(databasePath);
    const request = createRunRequest(['task-a']);
    await writer.createRun({
      ...request,
      taskBindings: request.taskBindings.map((binding) => ({
        ...binding,
        leasePlan: {
          ...binding.leasePlan,
          predictedResources: [{ type: 'project' as const, projectId: 'core' }]
        }
      }))
    });
    await writer.persistLease({
      runId: 'run-1',
      lease: {
        id: 'lease-1',
        runId: 'run-1',
        agentId: 'prior-agent',
        taskId: 'prior-task',
        resource: { type: 'project', projectId: 'previous' },
        mode: 'exclusive',
        version: 2,
        state: 'RELEASED',
        acquiredAt: new Date('2026-08-12T00:00:00.000Z'),
        lastHeartbeatAt: new Date('2026-08-12T00:00:30.000Z'),
        releasedAt: new Date('2026-08-12T00:01:00.000Z')
      }
    });
    writer.close();

    const reader = new DrizzleSqliteOrchestrationPersistence(databasePath);
    const hydratedLeaseIds: string[][] = [];
    const composition = await createForgeWorkerComposition({
      persistence: reader,
      repositoryGraph: emptyRepositoryGraph,
      onWriteGuardHydrated: (_runId, leases) =>
        hydratedLeaseIds.push(leases.map((lease) => lease.id).toSorted()),
      workspaceManager: {
        async create(workspace) {
          return { ...workspace, revision: 1, phase: 'READY_TO_INTEGRATE' };
        },
        commit: unexpectedExecution('workspace commit'),
        integrate: unexpectedExecution('workspace integration'),
        resumeIntegration: unexpectedExecution('workspace integration resume'),
        abortIntegration: unexpectedExecution('workspace integration abort'),
        dispose: unexpectedExecution('workspace disposal')
      },
      builderAgentRunner: {
        async run(runRequest) {
          await runRequest.onStarted({
            sessionRef: { backend: 'lease-history-fixture', value: 'builder-session' }
          });
          return {
            status: 'completed' as const,
            sessionRef: { backend: 'lease-history-fixture', value: 'builder-session' }
          };
        }
      },
      reconciler: {
        async reconcile({ taskId }) {
          return {
            observed: {
              taskId,
              filesRead: new Set(),
              filesCreated: new Set(),
              filesWritten: new Set(),
              filesDeleted: new Set(),
              symbolsWritten: new Set(),
              dependencyRequests: new Set(),
              manifestFilesChanged: new Set(),
              generatedFilesChanged: new Set()
            },
            reconciliation: {
              status: 'within-predicted-scope' as const,
              expandedFileIds: new Set(),
              unleasedFileIds: new Set()
            }
          };
        }
      }
    });

    const initial = await composition.forgeActivities.reevaluateRun({ runId: 'run-1' });
    await composition.forgeActivities.executeBuilder({
      runId: 'run-1',
      taskId: 'task-a',
      attemptId: initial.authorizedTasks[0].attemptId
    });

    expect(hydratedLeaseIds).toEqual([['lease-1']]);
    expect(await reader.recoverLeases('run-1')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ lease: expect.objectContaining({ id: 'lease-1', version: 2 }) }),
        expect.objectContaining({ lease: expect.objectContaining({ id: 'lease-2', version: 2 }) })
      ])
    );
    await composition.close();
  });

  it('blocks a competing builder before its start claim and reuses its preparing attempt after release', async () => {
    const persistence = new MemoryPersistence();
    const request = createRunRequest(['task-a', 'task-b']);
    await persistence.createRun({
      ...request,
      tasks: request.tasks.map((task) => ({ ...task, dependencies: [] })),
      taskBindings: request.taskBindings.map((binding) => ({
        ...binding,
        leasePlan: {
          ...binding.leasePlan,
          predictedResources: [{ type: 'project' as const, projectId: 'core' }]
        }
      })),
      scheduleOptions: { maxConcurrency: 2 }
    });

    let releaseTaskA: (() => void) | undefined;
    const taskAReleased = new Promise<void>((resolve) => {
      releaseTaskA = resolve;
    });
    let taskAStarted: (() => void) | undefined;
    const taskAStartedPromise = new Promise<void>((resolve) => {
      taskAStarted = resolve;
    });
    const startedTasks: string[] = [];
    const composition = await createForgeWorkerComposition({
      persistence,
      repositoryGraph: emptyRepositoryGraph,
      workspaceManager: {
        async create(workspace) {
          return { ...workspace, revision: 1, phase: 'READY_TO_INTEGRATE' };
        },
        commit: unexpectedExecution('workspace commit'),
        integrate: unexpectedExecution('workspace integration'),
        resumeIntegration: unexpectedExecution('workspace integration resume'),
        abortIntegration: unexpectedExecution('workspace integration abort'),
        dispose: unexpectedExecution('workspace disposal')
      },
      builderAgentRunner: {
        async run(runRequest) {
          startedTasks.push(runRequest.taskId);
          await runRequest.onStarted({
            sessionRef: { backend: 'competing-lease-fixture', value: runRequest.taskId }
          });
          if (runRequest.taskId === 'task-a') {
            taskAStarted?.();
            await taskAReleased;
          }
          return {
            status: 'completed' as const,
            sessionRef: { backend: 'competing-lease-fixture', value: runRequest.taskId }
          };
        }
      },
      reconciler: {
        async reconcile({ taskId }) {
          return {
            observed: {
              taskId,
              filesRead: new Set(),
              filesCreated: new Set(),
              filesWritten: new Set(),
              filesDeleted: new Set(),
              symbolsWritten: new Set(),
              dependencyRequests: new Set(),
              manifestFilesChanged: new Set(),
              generatedFilesChanged: new Set()
            },
            reconciliation: {
              status: 'within-predicted-scope' as const,
              expandedFileIds: new Set(),
              unleasedFileIds: new Set()
            }
          };
        }
      }
    });
    const activities = composition.forgeActivities;

    const initial = await activities.reevaluateRun({ runId: 'run-1' });
    expect(initial.authorizedTasks.map(({ taskId }) => taskId)).toEqual(['task-a', 'task-b']);
    const authorizationA = initial.authorizedTasks[0];
    const authorizationB = initial.authorizedTasks[1];
    const builderA = activities.executeBuilder({
      runId: 'run-1',
      taskId: authorizationA.taskId,
      attemptId: authorizationA.attemptId
    });
    await taskAStartedPromise;

    const blocked = await activities.executeBuilder({
      runId: 'run-1',
      taskId: authorizationB.taskId,
      attemptId: authorizationB.attemptId
    });
    expect(blocked).toEqual({
      status: 'blocked',
      runId: 'run-1',
      taskId: 'task-b',
      attemptId: authorizationB.attemptId,
      blockerLeaseId: expect.any(String)
    });
    expect(startedTasks).toEqual(['task-a']);
    expect(
      persistence.attempts.filter(({ attempt }) => attempt.id === authorizationB.attemptId)
    ).toEqual([
      expect.objectContaining({ attempt: expect.objectContaining({ state: 'PREPARING' }) })
    ]);

    releaseTaskA?.();
    await expect(builderA).resolves.toMatchObject({ status: 'completed', taskId: 'task-a' });

    const reauthorized = await activities.reevaluateRun({ runId: 'run-1' });
    expect(reauthorized.authorizedTasks).toEqual([
      { taskId: 'task-b', attemptId: authorizationB.attemptId }
    ]);
    expect(persistence.reevaluations.map(({ event }) => event.event.type)).toContain(
      'lease-blocked'
    );
    expect(persistence.reevaluations.map(({ event }) => event.event.type)).toContain(
      'lease-released'
    );

    await expect(
      activities.executeBuilder({
        runId: 'run-1',
        taskId: 'task-b',
        attemptId: authorizationB.attemptId
      })
    ).resolves.toMatchObject({ status: 'completed', taskId: 'task-b' });
    expect(startedTasks).toEqual(['task-a', 'task-b']);
    expect(persistence.attempts).toContainEqual(
      expect.objectContaining({
        attempt: expect.objectContaining({
          id: authorizationB.attemptId,
          state: 'COMPLETED'
        })
      })
    );
    await composition.close();
  });

  it('drives a dependent A→B run from fresh dispatch to completed finalization', async () => {
    const persistence = new MemoryPersistence();
    await persistence.createRun(createRunRequest(['task-a', 'task-b']));

    const builderExecution = {
      async execute(request: BuilderExecutionRequest) {
        const workspace: TaskWorkspace = {
          runId: request.runId,
          taskId: request.attempt.taskId,
          id: request.binding.workspace.id,
          branchName: `branch-${request.attempt.taskId}`,
          baseRef: 'main',
          integrationRepositoryPath: `/repo/${request.attempt.taskId}`,
          workspacePath: `/workspace/${request.attempt.taskId}`,
          integrationRef: `refs/heads/branch-${request.attempt.taskId}`,
          revision: 1,
          phase: 'READY_TO_INTEGRATE'
        };
        await persistence.persistWorkspace({ runId: request.runId, workspace });
        await persistence.persistImpact({
          runId: request.runId,
          taskId: request.attempt.taskId,
          impact: impactFor(request.attempt.taskId)
        });
        const attempt = {
          ...request.attempt,
          state: 'COMPLETED' as const,
          revision: request.attempt.revision + 1,
          startedAt: new Date('2026-08-12T00:00:00.000Z'),
          completedAt: new Date('2026-08-12T00:01:00.000Z')
        };
        const impact = impactFor(request.attempt.taskId);
        await persistence.persistAttempt({
          runId: request.runId,
          attempt
        });
        return { status: 'completed' as const, workspace, attempt, impact };
      }
    } satisfies BuilderExecutionOverride;

    const reviewByAttempt = new Map<string, TaskCodeReview>();

    const evaluation = {
      async evaluate(request: EvaluationRequest) {
        const subject = {
          builderAttemptId: request.builderAttempt.id,
          outputAttemptId: request.builderAttempt.id,
          workspaceId: request.builderAttempt.workspaceId,
          workspaceRevision: 1,
          workspaceChangeFingerprint: 'fp',
          impactFingerprint: 'fp',
          verificationFingerprint: 'fp',
          snapshotFingerprint: 'fp'
        };
        const review: TaskCodeReview = {
          recommendation: 'accept',
          summary: 'accepted',
          findings: []
        };
        const existing = await persistence.recoverReviews(request.runId);
        const iteration =
          existing
            .filter((candidate) => candidate.taskId === request.builderAttempt.taskId)
            .reduce((max, candidate) => Math.max(max, candidate.iteration), 0) + 1;
        await persistence.persistReview({
          runId: request.runId,
          taskId: request.builderAttempt.taskId,
          iteration,
          subject,
          review
        });
        reviewByAttempt.set(request.builderAttempt.id, review);
        return {
          verification: {
            id: `verification-${request.builderAttempt.taskId}`,
            runId: request.runId,
            taskId: request.builderAttempt.taskId,
            attemptId: request.builderAttempt.id,
            workspaceId: request.workspace.id,
            workspaceRevision: request.workspace.revision,
            workspaceChangeFingerprint: subject.workspaceChangeFingerprint,
            verificationPolicyFingerprint: 'fp',
            status: 'passed' as const,
            verifiedAt: new Date('2026-08-12T00:01:00.000Z').toISOString(),
            fingerprint: `verification-${request.builderAttempt.taskId}`
          },
          subject,
          review,
          recommendation: 'accept' as const
        };
      }
    } satisfies EvaluationOverride;

    const integration = {
      async integrate(request: { runId: string; taskId: string; workspace: TaskWorkspace }) {
        const integrated: TaskWorkspace = {
          ...request.workspace,
          revision: request.workspace.revision + 1,
          phase: 'INTEGRATED',
          integrationCommit: `commit-${request.taskId}`
        };
        await persistence.persistWorkspace({ runId: request.runId, workspace: integrated });
        return { status: 'integrated' as const, workspace: integrated };
      }
    } satisfies IntegrationOverride;

    const composition = await createForgeWorkerComposition({
      persistence,
      builderExecution,
      evaluation,
      integration,
      repairExecution: unusedRepairExecution(),
      repositoryGraph: emptyRepositoryGraph
    });
    const activities = composition.forgeActivities;

    const first = await activities.reevaluateRun({ runId: 'run-1' });
    expect(first.authorizedTasks).toHaveLength(1);
    const [taskA] = first.authorizedTasks;
    expect(taskA.taskId).toBe('task-a');
    const attemptA = taskA.attemptId;

    const builderA = await activities.executeBuilder({
      runId: 'run-1',
      taskId: 'task-a',
      attemptId: attemptA
    });
    expect(builderA.status).toBe('completed');
    if (builderA.status !== 'completed') {
      throw new Error('Expected task A builder completion');
    }
    expect(builderA.attemptId).toBe(attemptA);

    const midChain = await activities.reevaluateRun({ runId: 'run-1' });
    expect(midChain.authorizedTasks).toEqual([]);

    const evaluatedA = await activities.evaluateBuilderOutput({
      runId: 'run-1',
      taskId: 'task-a',
      workspaceId: builderA.workspaceId,
      builderAttemptId: attemptA,
      impactId: builderA.impactId
    });
    expect(evaluatedA.recommendation).toBe('accept');

    const integratedA = await activities.integrateAcceptedOutput({
      runId: 'run-1',
      taskId: 'task-a',
      workspaceId: builderA.workspaceId,
      subjectRef: evaluatedA.subjectRef
    });
    expect(integratedA.status).toBe('integrated');

    const afterA = await activities.reevaluateRun({ runId: 'run-1' });
    expect(afterA.authorizedTasks).toHaveLength(1);
    const [taskB] = afterA.authorizedTasks;
    expect(taskB.taskId).toBe('task-b');
    const attemptB = taskB.attemptId;
    expect(attemptB).not.toBe(attemptA);

    const builderB = await activities.executeBuilder({
      runId: 'run-1',
      taskId: 'task-b',
      attemptId: attemptB
    });
    expect(builderB.status).toBe('completed');
    if (builderB.status !== 'completed') {
      throw new Error('Expected task B builder completion');
    }
    const evaluatedB = await activities.evaluateBuilderOutput({
      runId: 'run-1',
      taskId: 'task-b',
      workspaceId: builderB.workspaceId,
      builderAttemptId: attemptB,
      impactId: builderB.impactId
    });
    await activities.integrateAcceptedOutput({
      runId: 'run-1',
      taskId: 'task-b',
      workspaceId: builderB.workspaceId,
      subjectRef: evaluatedB.subjectRef
    });

    const finalState = await activities.finalizeRunState({ runId: 'run-1' });
    expect(finalState.status).toBe('completed');
    expect(persistence.state).toBe('COMPLETED');
  }, 60000);
});
