import type {
  AgentExecutionAttempt,
  CreatePersistedRunRequest,
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
  TaskRepairAttempt,
  TaskRepairWorkItem,
  TaskWorkspace,
  TaskVerificationEvidence
} from '@ai-native-software-delivery-orchestrator/domain';
import { taskLeasePlanFingerprint } from '@ai-native-software-delivery-orchestrator/domain';
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createForgeWorkerComposition,
  reviewPolicyFingerprint,
  verificationPolicyFingerprint
} from './forge-worker-composition.js';

class MemoryPersistence implements OrchestrationPersistence, TaskCodeReviewStore {
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
  async persistLease(): Promise<void> {}

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
      taskBindings: this.request.taskBindings,
      hardConflicts: this.request.hardConflicts,
      riskConflicts: this.request.riskConflicts,
      scheduleOptions: this.request.scheduleOptions,
      events: this.reevaluations.map(({ event }) => event),
      transitions: this.reevaluations.flatMap(({ transitions }) => transitions),
      decisions: this.reevaluations.map(({ decision }) => decision),
      impacts: this.impacts,
      conflicts: [],
      leases: [],
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
  async persistRepairResumeDispatch(): Promise<void> {}
  async recoverRepairResumeDispatches(): Promise<readonly PersistedRepairResumeDispatch[]> {
    return [];
  }

  async persistRepairAttempt(record: PersistedTaskRepairAttempt): Promise<void> {
    const index = this.repairAttempts.findIndex((entry) => entry.attempt.id === record.attempt.id);
    if (index >= 0) {
      this.repairAttempts[index] = record;
      return;
    }
    this.repairAttempts.push(record);
  }

  async recoverRepairAttempts(): Promise<readonly PersistedTaskRepairAttempt[]> {
    return this.repairAttempts;
  }

  async recoverRepairAttemptHistory(): Promise<readonly PersistedTaskRepairAttempt[]> {
    return this.repairAttempts;
  }

  async admitRepairAttempt(request: {
    attempt: TaskRepairAttempt;
  }): Promise<TaskRepairAttempt> {
    this.repairAttempts.push({ runId: request.attempt.runId, attempt: request.attempt });
    return request.attempt;
  }

  async resumeRepairAttempt(request: {
    runId: string;
    attemptId: string;
    expectedRevision: number;
  }): Promise<
    | { status: 'resumed'; attempt: TaskRepairAttempt }
    | { status: 'not-found' }
    | { status: 'not-blocked'; state: TaskRepairAttempt['state'] }
    | { status: 'version-conflict'; actualRevision: number }
    | { status: 'lease-not-released'; actualState: 'ACTIVE' | 'RELEASED' | 'STALE' }
  > {
    const record = this.repairAttempts.find((entry) => entry.attempt.id === request.attemptId && entry.runId === request.runId);
    if (record === undefined) {
      return { status: 'not-found' };
    }
    if (record.attempt.revision !== request.expectedRevision) {
      return { status: 'version-conflict', actualRevision: record.attempt.revision };
    }
    if (record.attempt.state !== 'BLOCKED') {
      return { status: 'not-blocked', state: record.attempt.state };
    }
    const lease = this.leases.find((entry) => entry.runId === request.runId && entry.lease.id === record.attempt.blocker?.leaseId);
    if (lease === undefined || (lease.lease.state !== 'RELEASED' && lease.lease.state !== 'STALE')) {
      return { status: 'lease-not-released', actualState: lease?.lease.state ?? 'ACTIVE' };
    }
    const resumed = {
      ...record.attempt,
      state: 'PREPARING' as const,
      revision: record.attempt.revision + 1,
      blocker: undefined
    };
    this.repairAttempts[this.repairAttempts.findIndex((entry) => entry.attempt.id === request.attemptId)] = {
      runId: request.runId,
      attempt: resumed
    };
    return { status: 'resumed', attempt: resumed };
  }

  async recoverRepairWorkItems(): Promise<readonly TaskRepairWorkItem[]> {
    return this.repairWorkItems;
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

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('temporal worker production vertical slice', () => {
  it('resumes a blocked repair through exact blocker validation and reuses the same repairAttemptId', async () => {
    const persistence = new MemoryPersistence();
    await persistence.createRun(createRunRequest(['task-a']));

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
        version: 2,
        state: 'RELEASED',
        acquiredAt: new Date('2026-08-12T00:00:00.000Z'),
        lastHeartbeatAt: new Date('2026-08-12T00:00:30.000Z'),
        releasedAt: new Date('2026-08-12T00:03:00.000Z')
      }
    });

    const repairExecution = {
      async execute(request: { runId: string; preCreatedRepairAttempt: TaskRepairAttempt }) {
        const reviewSubject = {
          builderAttemptId: builderAttempt.id,
          outputAttemptId: blockedRepair.id,
          workspaceId: workspace.id,
          workspaceRevision: 2,
          workspaceChangeFingerprint: 'sha256:'.concat('e'.repeat(64)),
          impactFingerprint: 'sha256:'.concat('b'.repeat(64)),
          verificationFingerprint: 'sha256:'.concat('f'.repeat(64))
        };
        const review: TaskCodeReview = {
          recommendation: 'accept',
          summary: 'repair accepted',
          findings: []
        };
        await persistence.persistReview({
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
          verification: { fingerprint: 'verification-repair-1' },
          reviewSubject,
          review
        };
      }
    };

    const composition = await createForgeWorkerComposition({
      persistence: persistence as never,
      builderExecution: { execute: async () => undefined } as never,
      evaluation: { evaluate: async () => { throw new Error('not used'); } } as never,
      integration: { integrate: async () => { throw new Error('not used'); } } as never,
      repairExecution: repairExecution as never,
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
  }, 60000);

  it('drives a dependent A→B run from fresh dispatch to completed finalization', async () => {
    const persistence = new MemoryPersistence();
    await persistence.createRun(createRunRequest(['task-a', 'task-b']));

    const builderExecution = {
      async execute(request: {
        runId: string;
        attempt: AgentExecutionAttempt;
        binding: { workspace: { id: string } };
      }) {
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
        await persistence.persistAttempt({
          runId: request.runId,
          attempt: {
            ...request.attempt,
            state: 'COMPLETED',
            revision: request.attempt.revision + 1,
            startedAt: new Date('2026-08-12T00:00:00.000Z'),
            completedAt: new Date('2026-08-12T00:01:00.000Z')
          }
        });
      }
    };

    const reviewByAttempt = new Map<string, TaskCodeReview>();

    const evaluation = {
      async evaluate(request: { runId: string; builderAttempt: AgentExecutionAttempt }) {
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
          verification: { fingerprint: `verification-${request.builderAttempt.taskId}` },
          subject,
          review,
          recommendation: 'accept' as const
        };
      }
    };

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
    };

    const composition = await createForgeWorkerComposition({
      persistence: persistence as never,
      builderExecution: builderExecution as never,
      evaluation: evaluation as never,
      integration: integration as never,
      repairExecution: { execute: async () => { throw new Error('no repair in accept path'); } } as never,
      repositoryGraph: emptyRepositoryGraph
    });
    const activities = composition.forgeActivities;

    const first = await activities.reevaluateRun({ runId: 'run-1' });
    expect(first.authorizedTasks).toHaveLength(1);
    expect(first.authorizedTasks[0]!.taskId).toBe('task-a');
    const attemptA = first.authorizedTasks[0]!.attemptId;

    const builderA = await activities.executeBuilder({
      runId: 'run-1',
      taskId: 'task-a',
      attemptId: attemptA
    });
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
    expect(afterA.authorizedTasks[0]!.taskId).toBe('task-b');
    const attemptB = afterA.authorizedTasks[0]!.attemptId;
    expect(attemptB).not.toBe(attemptA);

    const builderB = await activities.executeBuilder({
      runId: 'run-1',
      taskId: 'task-b',
      attemptId: attemptB
    });
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
