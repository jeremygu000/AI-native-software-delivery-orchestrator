import { Client } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterEach, describe, expect, it } from 'vitest';

import {
  taskVerificationEvidenceFingerprint,
  type AgentRunner,
  type RepositoryGraph,
  type TaskCodeReview,
  type TaskImpact,
  type TaskWorkspace,
  type WorkspaceManager
} from '@ai-native-software-delivery-orchestrator/domain';
import { DrizzleSqliteOrchestrationPersistence } from '@ai-native-software-delivery-orchestrator/persistence';
import { InMemoryWriteGuard } from '@ai-native-software-delivery-orchestrator/runtime-guard';
import { DeterministicScheduler } from '@ai-native-software-delivery-orchestrator/scheduler';
import {
  assertDurableExecutionSpikeOutcome,
  OrchestrationRuntime,
  RepairExecutionCoordinator,
  TaskCodeReviewCollector,
  TaskOutputAdmissionCoordinator,
  TaskRepairCoordinator,
  type DurableExecutionSpikeOutcome
} from '@ai-native-software-delivery-orchestrator/orchestration-runtime';
import { collectDurableExecutionOutcomeFromSqlite } from '@ai-native-software-delivery-orchestrator/runtime-v2-spike-harness';
import {
  forgeRunWorkflow,
  repairWakeSignal
} from '@ai-native-software-delivery-orchestrator/temporal-runtime';

import { createForgeWorkerComposition, reviewPolicyFingerprint, verificationPolicyFingerprint, type ForgeWorkerCompositionOverrides } from './forge-worker-composition.js';

const graph: RepositoryGraph = {
  repositoryPath: '/differential-repository',
  projects: new Map(),
  projectDependencies: [],
  files: new Map([
    ['file-1', { id: 'file-1', projectId: 'project-task-normal', path: 'file-1', isGenerated: false }]
  ]),
  symbols: new Map(),
  fileDependencies: [],
  symbolReferences: [],
  diagnostics: []
};

const fingerprint = `sha256:${'a'.repeat(64)}`;
// Temporal bundles JavaScript workflow code, so tests use the built package entrypoint.
const workflowPath = new URL(
  '../../../libs/temporal-runtime/dist/lib/workflows/forge-run.js',
  import.meta.url
).pathname;
const resources = (taskId: string): TaskImpact => ({
  predicted: {
    taskId,
    projectsRead: new Set(), projectsWritten: new Set(), explicitProjectsWritten: new Set(),
    filesRead: new Set(), filesWritten: new Set(), explicitFilesWritten: new Set(),
    globFilesWritten: new Set(), symbolDerivedFilesWritten: new Set(), symbolsRead: new Set(),
    symbolsWritten: new Set(), sharedResources: new Set(), sharedResourceAccesses: [],
    downstreamProjects: new Set(), riskSignals: []
  }
});

const verification = (input: Omit<Parameters<typeof taskVerificationEvidenceFingerprint>[0], 'fingerprint'>) => ({
  ...input,
  fingerprint: taskVerificationEvidenceFingerprint(input)
});

const normalizeRevisions = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(normalizeRevisions);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        key === 'revision' || key === 'blockedRevision' || key === 'resumedRevision'
          ? '<revision>'
          : normalizeRevisions(child)
      ])
    );
  }
  return value;
};

const createLegacyRuntime = (
  persistence: DrizzleSqliteOrchestrationPersistence,
  blockFirstRepair = false
) => {
  let firstRepair = blockFirstRepair;
  const writeGuard = new InMemoryWriteGuard();
  const workspaceManager: WorkspaceManager = {
    async create(request) {
      return { ...request, revision: 1, phase: 'READY_TO_INTEGRATE' };
    },
    async commit(request) {
      return request.workspace;
    },
    async integrate(workspace) {
      const outputAttemptId = (await persistence.recoverRepairAttempts(workspace.runId))
        .toReversed()
        .find(({ attempt }) => attempt.state === 'COMPLETED')?.attempt.id;
      await persistence.persistIntegration(workspace.runId, 'integrated', outputAttemptId);
      return {
        status: 'integrated' as const,
        workspace: {
          ...workspace,
          revision: workspace.revision + 1,
          phase: 'INTEGRATED' as const,
          integrationCommit: `commit-${workspace.taskId}`
        }
      };
    },
    async resumeIntegration() {
      throw new Error('Not used by the legacy differential fixture.');
    },
    async abortIntegration() {
      throw new Error('Not used by the legacy differential fixture.');
    },
    async dispose() {
      throw new Error('Not used by the legacy differential fixture.');
    }
  };
  const snapshots = {
    async capture({ repositoryPath }: { readonly repositoryPath: string }) {
      return {
        repositoryId: 'repository-snapshot',
        repositoryRoot: repositoryPath,
        baseCommit: 'a'.repeat(40),
        workingTreeFingerprint: fingerprint,
        dirty: true
      };
    }
  };
  const subjects = {
    createSubject({ builderAttempt, outputAttemptId, workspace, verificationFingerprint }: {
      readonly builderAttempt: { readonly id: string };
      readonly outputAttemptId: string;
      readonly workspace: TaskWorkspace;
      readonly verificationFingerprint: string;
    }) {
      return {
        builderAttemptId: builderAttempt.id,
        outputAttemptId,
        workspaceId: workspace.id,
        workspaceRevision: workspace.revision,
        workspaceChangeFingerprint: fingerprint,
        impactFingerprint: fingerprint,
        verificationFingerprint
      };
    }
  };
  const createEvidence = ({ id, attempt, workspace, verificationPolicyFingerprint: policyFingerprint }: {
    readonly id: string;
    readonly attempt: { readonly id: string; readonly runId: string; readonly taskId: string };
    readonly workspace: TaskWorkspace;
    readonly verificationPolicyFingerprint: string;
  }) => verification({
    id,
    runId: attempt.runId,
    taskId: attempt.taskId,
    attemptId: attempt.id,
    workspaceId: workspace.id,
    workspaceRevision: workspace.revision,
    workspaceChangeFingerprint: fingerprint,
    verificationPolicyFingerprint: policyFingerprint,
    status: 'passed',
    verifiedAt: attempt.id === 'attempt-1' ? '2026-09-20T00:01:00.000Z' : '2026-09-20T00:02:00.000Z'
  });
  const reviews = new TaskCodeReviewCollector({
    reviewer: {
      async review(request) {
        return request.iteration === 1
          ? {
              recommendation: 'repair' as const,
              summary: 'repair once',
              findings: [{ id: 'finding-1', severity: 'medium' as const, fileIds: ['file-1'], symbolIds: [], description: 'Repair required.' }]
            }
          : { recommendation: 'accept' as const, summary: 'accepted repair', findings: [] };
      }
    },
    store: persistence
  });
  const admission = new TaskOutputAdmissionCoordinator({
    snapshots,
    subjects,
    reviews,
    reviewStore: persistence,
    verificationEvidence: persistence,
    createEvidenceId: (() => {
      let next = 1;
      return () => `legacy-verification-${next++}`;
    })(),
    createVerificationEvidence: createEvidence
  });
  const repairs = new TaskRepairCoordinator({
    store: persistence,
    reviews: persistence,
    maxRepairs: 2,
    createId: () => 'repair-1'
  });
  const repairExecution = new RepairExecutionCoordinator({
    repairs,
    runner: {
      async run(request) {
        await request.onStarted({
          sessionRef: { backend: 'legacy-fixture', value: 'repair-session' }
        });
        if (firstRepair) {
          firstRepair = false;
          return { status: 'blocked' as const, leaseId: 'lease-blocker', detail: 'Blocked by the fixture lease.' };
        }
        return { status: 'completed' as const };
      }
    },
    reconciler: {
      async reconcile({ taskId }) {
        return {
          observed: {
            taskId,
            filesRead: new Set(), filesCreated: new Set(), filesWritten: new Set(), filesDeleted: new Set(),
            symbolsWritten: new Set(), dependencyRequests: new Set(), manifestFilesChanged: new Set(), generatedFilesChanged: new Set()
          },
          reconciliation: { status: 'within-predicted-scope' as const, expandedFileIds: new Set(), unleasedFileIds: new Set() }
        };
      }
    },
    verifier: { async verify() { return { status: 'passed' as const }; } },
    snapshots,
    subjects,
    reviews,
    verificationEvidence: persistence,
    writeGuard,
    persistence,
    feedback: { leaseBlocked: async () => undefined, scopeExpanded: async () => undefined },
    createEvidenceId: (() => {
      let next = 1;
      return () => `legacy-repair-verification-${next++}`;
    })(),
    createVerificationEvidence: createEvidence
  });
  const agentRunner: AgentRunner = {
    async run(request) {
      await request.onStarted({
        sessionRef: { backend: 'legacy-fixture', value: 'builder-session' }
      });
      return {
        status: 'completed' as const,
        sessionRef: { backend: 'legacy-fixture', value: 'builder-session' }
      };
    }
  };
  return new OrchestrationRuntime({
    scheduler: new DeterministicScheduler(),
    persistence,
    workspaceManager,
    writeGuard,
    agentRunner,
    verifier: { async verify() { return { status: 'passed' as const }; } },
    repairAttempts: persistence,
    repairWorkItems: persistence,
    outputReview: { admission, repairs, repairExecution, repository: { files: graph.files, symbols: graph.symbols } },
    createAttemptId: () => 'attempt-1'
  });
};

const normalizeOutcome = (outcome: DurableExecutionSpikeOutcome) => {
  const stableIds = new Map<string, string>([
    [outcome.builderAttempt.id, 'builder-attempt'],
    [outcome.builderAttempt.runId, 'run'],
    [outcome.builderAttempt.workspaceId, 'workspace']
  ]);
  for (const [index, repair] of outcome.repairs.entries()) {
    stableIds.set(repair.id, `repair-${index + 1}`);
  }
  for (const [index, evidence] of outcome.verifications.entries()) {
    stableIds.set(evidence.id, `verification-${index + 1}`);
    stableIds.set(evidence.fingerprint, `verification-fingerprint-${index + 1}`);
  }
  const normalize = (value: unknown): unknown => {
    if (typeof value === 'string') {
      if (stableIds.has(value)) {
        return stableIds.get(value);
      }
      return /^\d{4}-\d{2}-\d{2}T/.test(value) ? '<timestamp>' : value;
    }
    if (Array.isArray(value)) {
      return value.map(normalize);
    }
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalize(child)]));
    }
    return value;
  };
  const normalized = normalize(outcome);
  // Absolute revisions reflect runtime-local transition bookkeeping. Each
  // outcome independently proves the durable blocked-to-resumed relationship.
  return normalizeRevisions(normalized);
};

const createRun = (runId: string, taskId: string) => ({
  run: {
    id: runId, repositoryId: `repository-${runId}`, state: 'ACTIVE' as const,
    createdAt: '2026-09-20T00:00:00.000Z',
    authority: {
      artifactId: 'plan', artifactRevision: 1, approvalId: 'approval', planFingerprint: fingerprint,
      approvalFingerprint: fingerprint, claimFingerprint: fingerprint, executionFingerprint: fingerprint,
      repositoryRoot: '/differential-repository', baseCommit: 'a'.repeat(40),
      workingTreeFingerprint: fingerprint, repositoryFactsFingerprint: fingerprint,
      sharedResourcePolicyFingerprint: fingerprint, verificationPolicyFingerprint,
      codeReviewPolicyFingerprint: reviewPolicyFingerprint
    }
  },
  tasks: [{ id: taskId, title: taskId, goal: taskId, dependencies: [], expectedReads: [], expectedWrites: [], sharedResources: [], verification: [] }],
  hardConflicts: [], riskConflicts: [], scheduleOptions: { maxConcurrency: 1 },
  taskBindings: [{
    runId, taskId, agentId: `agent-${taskId}`,
    leasePlan: { taskId, predictedResources: [{ type: 'project' as const, projectId: `project-${taskId}` }], source: 'manual' as const },
    workspace: { id: `workspace-${runId}`, runId, taskId, integrationRepositoryPath: '/integration', workspacePath: '/workspace', branchName: `orchestrator/${runId}`, baseRef: 'main', integrationRef: 'main' }
  }]
});

const overrides = (persistence: DrizzleSqliteOrchestrationPersistence, blockFirstRepair = false): ForgeWorkerCompositionOverrides => {
  let firstRepair = blockFirstRepair;
  return {
  persistence,
  repositoryGraph: graph,
  builderExecution: {
    async execute(request) {
      const workspace: TaskWorkspace = { ...request.binding.workspace, revision: 1, phase: 'READY_TO_INTEGRATE' };
      await persistence.persistWorkspace({ runId: request.runId, workspace });
      await persistence.persistImpact({ runId: request.runId, taskId: request.task.id, impact: resources(request.task.id) });
      const activeLease = { id: 'lease-1', runId: request.runId, agentId: request.binding.agentId, taskId: request.task.id, resource: request.binding.leasePlan.predictedResources[0], mode: 'exclusive' as const, version: 1, state: 'ACTIVE' as const, acquiredAt: new Date('2026-09-20T00:01:00.000Z'), lastHeartbeatAt: new Date('2026-09-20T00:01:00.000Z') };
      await persistence.persistLease({ runId: request.runId, lease: activeLease });
      await persistence.persistLease({ runId: request.runId, lease: { ...activeLease, version: 2, state: 'RELEASED', releasedAt: new Date('2026-09-20T00:01:00.000Z') } });
      await persistence.persistAttempt({ runId: request.runId, attempt: { ...request.attempt, state: 'COMPLETED', revision: request.attempt.revision + 2, sessionRef: { backend: 'legacy-fixture', value: 'builder-session' }, completedAt: new Date('2026-09-20T00:01:00.000Z') } });
      return { workspace, attempt: request.attempt, impact: resources(request.task.id) };
    }
  },
  evaluation: {
    async evaluate(request) {
      const verificationEvidence = verification({ id: `verification-${request.builderAttempt.id}`, runId: request.runId, taskId: request.task.id, attemptId: request.builderAttempt.id, workspaceId: request.workspace.id, workspaceRevision: 1, workspaceChangeFingerprint: fingerprint, verificationPolicyFingerprint, status: 'passed', verifiedAt: '2026-09-20T00:01:00.000Z' });
      const subject = { builderAttemptId: request.builderAttempt.id, outputAttemptId: request.builderAttempt.id, workspaceId: request.workspace.id, workspaceRevision: 1, workspaceChangeFingerprint: fingerprint, impactFingerprint: fingerprint, verificationFingerprint: verificationEvidence.fingerprint };
      const review: TaskCodeReview = { recommendation: 'repair', summary: 'repair once', findings: [{ id: 'finding-1', severity: 'medium', fileIds: ['file-1'], symbolIds: [], description: 'Repair required.' }] };
      await persistence.persistVerificationEvidence(verificationEvidence);
      await persistence.persistReview({ runId: request.runId, taskId: request.task.id, iteration: 1, subject, review });
      return { verification: verificationEvidence, subject, review, recommendation: 'repair' as const };
    }
  },
  repairExecution: {
    async execute(request) {
      const attempt = request.preCreatedRepairAttempt;
      if (attempt === undefined) {
        throw new Error('Expected a pre-created repair attempt');
      }
      if (firstRepair) {
        firstRepair = false;
        const blocked = { ...attempt, state: 'BLOCKED' as const, revision: attempt.revision + 1, blocker: { type: 'lease' as const, leaseId: 'lease-blocker' } };
        await persistence.persistRepairAttempt({ runId: request.runId, attempt: blocked });
        return { state: 'blocked' as const, attempt: blocked, blockerLeaseId: 'lease-blocker' };
      }
      const verificationEvidence = verification({ id: `verification-${attempt.id}`, runId: request.runId, taskId: request.task.id, attemptId: attempt.id, workspaceId: request.workspace.id, workspaceRevision: 1, workspaceChangeFingerprint: fingerprint, verificationPolicyFingerprint, status: 'passed', verifiedAt: '2026-09-20T00:02:00.000Z' });
      const subject = { ...request.subject, outputAttemptId: attempt.id, workspaceRevision: 1, verificationFingerprint: verificationEvidence.fingerprint };
      const review: TaskCodeReview = { recommendation: 'accept', summary: 'accepted repair', findings: [] };
      await persistence.persistVerificationEvidence(verificationEvidence);
      await persistence.persistReview({ runId: request.runId, taskId: request.task.id, iteration: 2, subject, review });
      const completed = { ...attempt, state: 'COMPLETED' as const, revision: attempt.revision + 2, sessionRef: { backend: 'legacy-fixture', value: 'repair-session' }, completedAt: new Date('2026-09-20T00:02:00.000Z') };
      await persistence.persistRepairAttempt({ runId: request.runId, attempt: completed });
      return { state: 'completed' as const, attempt: completed, recommendation: 'accept' as const, verification: verificationEvidence, reviewSubject: subject, review };
    }
  },
  integration: {
    async integrate(request) {
      await persistence.persistIntegration(request.runId, 'integrated', request.subject.outputAttemptId);
      return { status: 'integrated' as const, workspace: { ...request.workspace, phase: 'INTEGRATED', integrationCommit: `commit-${request.taskId}`, revision: request.workspace.revision + 1 } };
    }
  }
};
};

const waitForBlockedRepair = async (persistence: DrizzleSqliteOrchestrationPersistence, runId: string) => {
  for (let attempts = 0; attempts < 100; attempts++) {
    const repair = (await persistence.recoverRepairAttempts(runId)).find(({ attempt }) => attempt.state === 'BLOCKED')?.attempt;
    if (repair !== undefined) {
      return repair;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for blocked repair: ${runId}`);
};

describe('M3.6 legacy and Temporal differential acceptance', () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())); });

  it('persists the frozen build-review-repair-exact-integration evidence contract', async () => {
    const runId = `m36-normal-${crypto.randomUUID()}`;
    const taskId = 'task-normal';
    const persistence = new DrizzleSqliteOrchestrationPersistence(':memory:');
    await persistence.createRun(createRun(runId, taskId));
    const composition = await createForgeWorkerComposition(overrides(persistence));
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const worker = await Worker.create({ connection: environment.nativeConnection, taskQueue: `m36-${runId}`, workflowsPath: workflowPath, activities: composition.forgeActivities });
    const client = new Client({ connection: environment.client.connection });
    const workerRun = worker.run();
    try {
      const result = await client.workflow.execute(forgeRunWorkflow, { taskQueue: worker.options.taskQueue, workflowId: `forge-run:${runId}`, args: [{ runId }] });
      expect(result).toEqual({ runId, status: 'completed' });
      const outcome = await collectDurableExecutionOutcomeFromSqlite(runId, { persistence });
      expect(outcome.verifications.at(-1)?.attemptId).toBe(outcome.repairs.at(-1)?.id);
      expect(outcome.reviews.at(-1)?.subject.outputAttemptId).toBe(outcome.repairs.at(-1)?.id);
      assertDurableExecutionSpikeOutcome({ outcome, scenario: 'build-review-repair-integrate' });
      expect(outcome.integration.outputAttemptId).toBe(outcome.repairs.at(-1)?.id);

      const legacyPersistence = new DrizzleSqliteOrchestrationPersistence(':memory:');
      try {
        const legacyRuntime = createLegacyRuntime(legacyPersistence);
        const legacyRunId = `${runId}-legacy`;
        await legacyRuntime.startRun(createRun(legacyRunId, taskId));
        const legacyOutcome = await collectDurableExecutionOutcomeFromSqlite(legacyRunId, { persistence: legacyPersistence });
        assertDurableExecutionSpikeOutcome({ outcome: legacyOutcome, scenario: 'build-review-repair-integrate' });
        expect(normalizeOutcome(legacyOutcome)).toEqual(normalizeOutcome(outcome));
      } finally {
        legacyPersistence.close();
      }
    } finally {
      worker.shutdown();
      await workerRun;
      await composition.close();
      persistence.close();
      await environment.teardown();
    }
  }, 30_000);

  it('keeps a blocked repair on its exact ID until its lease release wake resumes it', async () => {
    const runId = `m36-blocked-${crypto.randomUUID()}`;
    const persistence = new DrizzleSqliteOrchestrationPersistence(':memory:');
    await persistence.createRun(createRun(runId, 'task-blocked'));
    await persistence.persistLease({ runId, lease: { id: 'lease-blocker', runId, agentId: 'blocker', taskId: 'other-task', resource: { type: 'project', projectId: 'project-blocker' }, mode: 'exclusive', version: 1, state: 'ACTIVE', acquiredAt: new Date(), lastHeartbeatAt: new Date() } });
    const composition = await createForgeWorkerComposition(overrides(persistence, true));
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const worker = await Worker.create({ connection: environment.nativeConnection, taskQueue: `m36-${runId}`, workflowsPath: workflowPath, activities: composition.forgeActivities });
    const client = new Client({ connection: environment.client.connection });
    const workerRun = worker.run();
    try {
      const handle = await client.workflow.start(forgeRunWorkflow, { taskQueue: worker.options.taskQueue, workflowId: `forge-run:${runId}`, args: [{ runId }] });
      const blocked = await waitForBlockedRepair(persistence, runId);
      await persistence.persistLease({ runId, lease: { id: 'lease-blocker', runId, agentId: 'blocker', taskId: 'other-task', resource: { type: 'project', projectId: 'project-blocker' }, mode: 'exclusive', version: 2, state: 'RELEASED', acquiredAt: new Date(), lastHeartbeatAt: new Date(), releasedAt: new Date() } });
      await handle.signal(repairWakeSignal, { repairAttemptId: blocked.id });
      await expect(handle.result()).resolves.toEqual({ runId, status: 'completed' });
      const outcome = await collectDurableExecutionOutcomeFromSqlite(runId, { persistence });
      assertDurableExecutionSpikeOutcome({ outcome, scenario: 'blocked-repair-restart-resume' });
      expect(outcome.blockedResume?.repairAttemptId).toBe(blocked.id);
      expect(outcome.dispatchCount).toBe(1);

      const legacyPersistence = new DrizzleSqliteOrchestrationPersistence(':memory:');
      try {
        const legacyRunId = `${runId}-legacy`;
        await legacyPersistence.createRun(createRun(legacyRunId, 'task-blocked'));
        await legacyPersistence.persistLease({ runId: legacyRunId, lease: { id: 'lease-blocker', runId: legacyRunId, agentId: 'blocker', taskId: 'other-task', resource: { type: 'project', projectId: 'project-blocker' }, mode: 'exclusive', version: 1, state: 'ACTIVE', acquiredAt: new Date(), lastHeartbeatAt: new Date() } });
        const legacyRuntime = createLegacyRuntime(legacyPersistence, true);
        await legacyRuntime.startOrResumeRun(createRun(legacyRunId, 'task-blocked'));
        const legacyBlocked = (await legacyPersistence.recoverRepairAttempts(legacyRunId)).find(({ attempt }) => attempt.state === 'BLOCKED')?.attempt;
        expect(legacyBlocked).toBeDefined();
        await legacyPersistence.persistLease({ runId: legacyRunId, lease: { id: 'lease-blocker', runId: legacyRunId, agentId: 'blocker', taskId: 'other-task', resource: { type: 'project', projectId: 'project-blocker' }, mode: 'exclusive', version: 2, state: 'RELEASED', acquiredAt: new Date(), lastHeartbeatAt: new Date(), releasedAt: new Date() } });
        await legacyRuntime.recoverAndResumeRun(createRun(legacyRunId, 'task-blocked'));
        const legacyOutcome = await collectDurableExecutionOutcomeFromSqlite(legacyRunId, { persistence: legacyPersistence });
        assertDurableExecutionSpikeOutcome({
          outcome: legacyOutcome,
          scenario: 'blocked-repair-restart-resume'
        });
        expect(legacyOutcome.blockedResume?.repairAttemptId).toBe(legacyBlocked!.id);
        expect(legacyOutcome.dispatchCount).toBe(1);
        expect(normalizeOutcome(legacyOutcome)).toEqual(normalizeOutcome(outcome));
      } finally {
        legacyPersistence.close();
      }
    } finally {
      worker.shutdown();
      await workerRun;
      await composition.close();
      persistence.close();
      await environment.teardown();
    }
  }, 30_000);
});
