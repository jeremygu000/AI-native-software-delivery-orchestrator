import { Client } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  type AgentRunner,
  type RepositoryGraph,
  type RecoveredRun,
  type WorkspaceManager
} from '@ai-native-software-delivery-orchestrator/domain';
import { DrizzleSqliteOrchestrationPersistence } from '@ai-native-software-delivery-orchestrator/persistence';
import { InMemoryWriteGuard } from '@ai-native-software-delivery-orchestrator/runtime-guard';
import {
  SnapshotTaskCodeReviewSubjectProvider,
  TemporalRunLauncher,
  TaskVerificationEvidenceFactory
} from '@ai-native-software-delivery-orchestrator/run-preparation';
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
  integrationWakeSignal,
  repairWakeSignal
} from '@ai-native-software-delivery-orchestrator/temporal-runtime';

import {
  createForgeWorkerComposition,
  reviewPolicyFingerprint,
  verificationPolicyFingerprint,
  type ForgeWorkerCompositionOverrides
} from './forge-worker-composition.js';

const graph: RepositoryGraph = {
  repositoryPath: '/differential-repository',
  projects: new Map(),
  projectDependencies: [],
  files: new Map([
    [
      'file-1',
      { id: 'file-1', projectId: 'project-task-normal', path: 'file-1', isGenerated: false }
    ]
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

interface ScenarioScript {
  blockNextRepair: boolean;
  blockNextIntegration?: boolean;
  readonly integrationResumeCount?: { count: number };
  readonly expandBuilderScopeForTaskId?: string;
  readonly reviewRecommendations?: Readonly<Record<number, 'accept' | 'repair'>>;
  readonly throwBuilderAfterStarted?: boolean;
  readonly throwRepairAfterStarted?: boolean;
  readonly temporalRunnerCounts?: { builder: number; repair: number };
  readonly builderStarts?: string[];
  readonly onBuilderStarted?: (taskId: string) => void;
  readonly waitForBuilderCompletion?: (taskId: string) => Promise<void>;
}

const integrateScenarioWorkspace = (
  workspace: Parameters<WorkspaceManager['integrate']>[0],
  script: ScenarioScript
) => {
  if (script.blockNextIntegration) {
    script.blockNextIntegration = false;
    return {
      status: 'blocked' as const,
      workspace: {
        ...workspace,
        revision: workspace.revision + 1,
        phase: 'INTEGRATION_BLOCKED' as const,
        blocker: {
          type: 'fast-forward-failed' as const,
          detail: 'Blocked by the differential fixture.',
          conflictPaths: []
        }
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
};

const reviewForScenario = (script: ScenarioScript, iteration: number) => {
  const recommendation =
    script.reviewRecommendations?.[iteration] ?? (iteration === 1 ? 'repair' : 'accept');
  return recommendation === 'repair'
    ? {
        recommendation,
        summary: `repair required at iteration ${iteration}`,
        findings: [
          {
            id: `finding-${iteration}`,
            severity: 'medium' as const,
            fileIds: ['file-1'],
            symbolIds: [],
            description: 'Repair required.'
          }
        ]
      }
    : { recommendation, summary: `accepted at iteration ${iteration}`, findings: [] };
};

const expectBudgetRejection = async (operation: Promise<unknown>) => {
  try {
    await operation;
    throw new Error('Expected repair-budget exhaustion to reject.');
  } catch (error) {
    const messages: string[] = [];
    let current: unknown = error;
    while (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
    }
    expect(messages.join('\n')).toMatch(/budget/i);
  }
};

const expectRejectionContaining = async (operation: Promise<unknown>, text: string) => {
  try {
    await operation;
    throw new Error(`Expected rejection containing: ${text}`);
  } catch (error) {
    const messages: string[] = [];
    let current: unknown = error;
    while (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
    }
    expect(messages.join('\n')).toContain(text);
  }
};

const assertUnknownAttemptAuthority = async (
  persistence: DrizzleSqliteOrchestrationPersistence,
  runId: string,
  expected: {
    readonly runState: 'ACTIVE' | 'FAILED';
    readonly repair: boolean;
    readonly retainsActiveLease: boolean;
  }
) => {
  const recovered = await persistence.recoverRun(runId);
  expect(recovered?.run.state).toBe(expected.runState);
  const attempt = expected.repair
    ? (await persistence.recoverRepairAttempts(runId)).at(-1)?.attempt
    : recovered?.attempts.at(-1)?.attempt;
  expect(attempt).toEqual(
    expect.objectContaining({
      state: 'UNKNOWN',
      sessionRef: expect.objectContaining({ backend: 'differential-fixture' }),
      failure: expect.objectContaining({ type: 'unknown-outcome' })
    })
  );
  expect(recovered?.leases.some(({ lease }) => lease.state === 'ACTIVE')).toBe(
    expected.retainsActiveLease
  );
};

const reconcileScenarioImpact = (taskId: string, script: ScenarioScript) => {
  const expanded = taskId === script.expandBuilderScopeForTaskId;
  return {
    observed: {
      taskId,
      filesRead: new Set<string>(),
      filesCreated: expanded ? new Set(['core:expanded.ts']) : new Set<string>(),
      filesWritten: expanded ? new Set(['core:expanded.ts']) : new Set<string>(),
      filesDeleted: new Set<string>(),
      symbolsWritten: new Set<string>(),
      dependencyRequests: new Set<string>(),
      manifestFilesChanged: new Set<string>(),
      generatedFilesChanged: new Set<string>()
    },
    reconciliation: {
      status: expanded ? ('runtime-scope-expanded' as const) : ('within-predicted-scope' as const),
      expandedFileIds: expanded ? new Set(['core:expanded.ts']) : new Set<string>(),
      unleasedFileIds: new Set<string>()
    },
    ...(expanded
      ? {
          expandedResources: [
            { type: 'file' as const, projectId: 'core', fileId: 'core:expanded.ts' }
          ]
        }
      : {})
  };
};

const createLegacyRuntime = (
  persistence: DrizzleSqliteOrchestrationPersistence,
  script: ScenarioScript
) => {
  const writeGuard = new InMemoryWriteGuard();
  const workspaceManager: WorkspaceManager = {
    async create(request) {
      return { ...request, revision: 1, phase: 'READY_TO_INTEGRATE' };
    },
    async commit(request) {
      return request.workspace;
    },
    async integrate(workspace) {
      return integrateScenarioWorkspace(workspace, script);
    },
    async resumeIntegration(workspace) {
      if (script.integrationResumeCount !== undefined) {
        script.integrationResumeCount.count += 1;
      }
      return integrateScenarioWorkspace(workspace, script);
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
  const subjects = new SnapshotTaskCodeReviewSubjectProvider();
  const evidenceFactory = new TaskVerificationEvidenceFactory();
  const reviews = new TaskCodeReviewCollector({
    reviewer: {
      async review(request) {
        return reviewForScenario(script, request.iteration);
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
    createVerificationEvidence: (evidence) => evidenceFactory.create(evidence)
  });
  let nextRepairId = 1;
  const repairs = new TaskRepairCoordinator({
    store: persistence,
    reviews: persistence,
    maxRepairs: 2,
    createId: () => `repair-${nextRepairId++}`
  });
  const repairExecution = new RepairExecutionCoordinator({
    repairs,
    runner: {
      async run(request) {
        await request.onStarted({
          sessionRef: { backend: 'differential-fixture', value: 'repair-session' }
        });
        if (script.throwRepairAfterStarted) {
          throw new Error('post-start repair disconnect');
        }
        if (script.blockNextRepair) {
          script.blockNextRepair = false;
          return {
            status: 'blocked' as const,
            leaseId: 'lease-blocker',
            detail: 'Blocked by the fixture lease.'
          };
        }
        return { status: 'completed' as const };
      }
    },
    reconciler: {
      async reconcile({ taskId }) {
        return reconcileScenarioImpact(taskId, script);
      }
    },
    verifier: {
      async verify() {
        return { status: 'passed' as const };
      }
    },
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
    createVerificationEvidence: (evidence) => evidenceFactory.create(evidence)
  });
  const agentRunner: AgentRunner = {
    async run(request) {
      await request.onStarted({
        sessionRef: { backend: 'differential-fixture', value: 'builder-session' }
      });
      script.builderStarts?.push(request.taskId);
      script.onBuilderStarted?.(request.taskId);
      await script.waitForBuilderCompletion?.(request.taskId);
      if (script.throwBuilderAfterStarted) {
        throw new Error('post-start builder disconnect');
      }
      return {
        status: 'completed' as const,
        sessionRef: { backend: 'differential-fixture', value: 'builder-session' }
      };
    }
  };
  return new OrchestrationRuntime({
    scheduler: new DeterministicScheduler(),
    persistence,
    workspaceManager,
    writeGuard,
    agentRunner,
    impactReconciler: {
      async reconcile({ taskId }) {
        return reconcileScenarioImpact(taskId, script);
      }
    },
    verifier: {
      async verify() {
        return { status: 'passed' as const };
      }
    },
    repairAttempts: persistence,
    repairWorkItems: persistence,
    outputReview: {
      admission,
      repairs,
      repairExecution,
      repository: { files: graph.files, symbols: graph.symbols }
    },
    createAttemptId: (() => {
      let next = 1;
      return () => `attempt-${next++}`;
    })()
  });
};

const normalizeOutcome = (outcome: DurableExecutionSpikeOutcome) => {
  const repairs = [...outcome.repairs].toSorted(
    (left, right) => left.repairIteration - right.repairIteration
  );
  const stableIds = new Map<string, string>([
    [outcome.builderAttempt.id, 'builder-attempt'],
    [outcome.builderAttempt.runId, 'run'],
    [outcome.builderAttempt.workspaceId, 'workspace']
  ]);
  for (const [index, repair] of repairs.entries()) {
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
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, normalize(child)])
      );
    }
    return value;
  };
  const normalized = normalize({ ...outcome, repairs });
  // Absolute revisions reflect runtime-local transition bookkeeping. Each
  // outcome independently proves the durable blocked-to-resumed relationship.
  return normalizeRevisions(normalized);
};

const repairsByIteration = (outcome: DurableExecutionSpikeOutcome) =>
  [...outcome.repairs].toSorted((left, right) => left.repairIteration - right.repairIteration);

const createRun = (runId: string, taskId: string) => ({
  run: {
    id: runId,
    repositoryId: `repository-${runId}`,
    state: 'ACTIVE' as const,
    createdAt: '2026-09-20T00:00:00.000Z',
    authority: {
      artifactId: 'plan',
      artifactRevision: 1,
      approvalId: 'approval',
      planFingerprint: fingerprint,
      approvalFingerprint: fingerprint,
      claimFingerprint: fingerprint,
      executionFingerprint: fingerprint,
      repositoryRoot: `/differential-repository/${runId}`,
      baseCommit: 'a'.repeat(40),
      workingTreeFingerprint: fingerprint,
      repositoryFactsFingerprint: fingerprint,
      sharedResourcePolicyFingerprint: fingerprint,
      verificationPolicyFingerprint,
      codeReviewPolicyFingerprint: reviewPolicyFingerprint
    }
  },
  tasks: [
    {
      id: taskId,
      title: taskId,
      goal: taskId,
      dependencies: [],
      expectedReads: [],
      expectedWrites: [],
      sharedResources: [],
      verification: []
    }
  ],
  hardConflicts: [],
  riskConflicts: [],
  scheduleOptions: { maxConcurrency: 1 },
  taskBindings: [
    {
      runId,
      taskId,
      agentId: `agent-${taskId}`,
      leasePlan: {
        taskId,
        predictedResources: [{ type: 'project' as const, projectId: `project-${taskId}` }],
        source: 'manual' as const
      },
      workspace: {
        id: `workspace-${runId}`,
        runId,
        taskId,
        integrationRepositoryPath: `/integration/${runId}`,
        workspacePath: `/workspace/${runId}`,
        branchName: `orchestrator/${runId}`,
        baseRef: 'main',
        integrationRef: 'main'
      }
    }
  ]
});

const createScopeExpansionRun = (runId: string) => ({
  run: {
    id: runId,
    repositoryId: `repository-${runId}`,
    state: 'ACTIVE' as const,
    createdAt: '2026-09-20T00:00:00.000Z',
    authority: {
      artifactId: 'plan',
      artifactRevision: 1,
      approvalId: 'approval',
      planFingerprint: fingerprint,
      approvalFingerprint: fingerprint,
      claimFingerprint: fingerprint,
      executionFingerprint: fingerprint,
      repositoryRoot: `/differential-repository/${runId}`,
      baseCommit: 'a'.repeat(40),
      workingTreeFingerprint: fingerprint,
      repositoryFactsFingerprint: fingerprint,
      sharedResourcePolicyFingerprint: fingerprint,
      verificationPolicyFingerprint,
      codeReviewPolicyFingerprint: reviewPolicyFingerprint
    }
  },
  tasks: ['task-a', 'task-b'].map((taskId) => ({
    id: taskId,
    title: taskId,
    goal: taskId,
    dependencies: [],
    expectedReads: [],
    expectedWrites: [],
    sharedResources: [],
    verification: []
  })),
  hardConflicts: [],
  riskConflicts: [],
  scheduleOptions: { maxConcurrency: 1 },
  taskBindings: ['task-a', 'task-b'].map((taskId) => ({
    runId,
    taskId,
    agentId: `agent-${taskId}`,
    leasePlan: {
      taskId,
      predictedResources:
        taskId === 'task-b' ? [{ type: 'project' as const, projectId: 'core' }] : [],
      source: 'manual' as const
    },
    workspace: {
      id: `workspace-${runId}-${taskId}`,
      runId,
      taskId,
      integrationRepositoryPath: `/integration/${runId}/${taskId}`,
      workspacePath: `/workspace/${runId}/${taskId}`,
      branchName: `orchestrator/${runId}/${taskId}`,
      baseRef: 'main',
      integrationRef: 'main'
    }
  }))
});

const createDependencyRun = (runId: string) => ({
  run: {
    id: runId,
    repositoryId: `repository-${runId}`,
    state: 'ACTIVE' as const,
    createdAt: '2026-09-20T00:00:00.000Z',
    authority: {
      artifactId: 'plan',
      artifactRevision: 1,
      approvalId: 'approval',
      planFingerprint: fingerprint,
      approvalFingerprint: fingerprint,
      claimFingerprint: fingerprint,
      executionFingerprint: fingerprint,
      repositoryRoot: `/differential-repository/${runId}`,
      baseCommit: 'a'.repeat(40),
      workingTreeFingerprint: fingerprint,
      repositoryFactsFingerprint: fingerprint,
      sharedResourcePolicyFingerprint: fingerprint,
      verificationPolicyFingerprint,
      codeReviewPolicyFingerprint: reviewPolicyFingerprint
    }
  },
  tasks: ['task-a', 'task-b'].map((taskId) => ({
    id: taskId,
    title: taskId,
    goal: taskId,
    dependencies: taskId === 'task-b' ? ['task-a'] : [],
    expectedReads: [],
    expectedWrites: [],
    sharedResources: [],
    verification: []
  })),
  hardConflicts: [],
  riskConflicts: [],
  scheduleOptions: { maxConcurrency: 1 },
  taskBindings: ['task-a', 'task-b'].map((taskId) => ({
    runId,
    taskId,
    agentId: `agent-${taskId}`,
    leasePlan: {
      taskId,
      predictedResources: [{ type: 'project' as const, projectId: `project-${taskId}` }],
      source: 'manual' as const
    },
    workspace: {
      id: `workspace-${runId}-${taskId}`,
      runId,
      taskId,
      integrationRepositoryPath: `/integration/${runId}/${taskId}`,
      workspacePath: `/workspace/${runId}/${taskId}`,
      branchName: `orchestrator/${runId}/${taskId}`,
      baseRef: 'main',
      integrationRef: 'main'
    }
  }))
});

const createCompetingLeaseRun = (runId: string) => ({
  run: {
    id: runId,
    repositoryId: `repository-${runId}`,
    state: 'ACTIVE' as const,
    createdAt: '2026-09-20T00:00:00.000Z',
    authority: {
      artifactId: 'plan',
      artifactRevision: 1,
      approvalId: 'approval',
      planFingerprint: fingerprint,
      approvalFingerprint: fingerprint,
      claimFingerprint: fingerprint,
      executionFingerprint: fingerprint,
      repositoryRoot: `/differential-repository/${runId}`,
      baseCommit: 'a'.repeat(40),
      workingTreeFingerprint: fingerprint,
      repositoryFactsFingerprint: fingerprint,
      sharedResourcePolicyFingerprint: fingerprint,
      verificationPolicyFingerprint,
      codeReviewPolicyFingerprint: reviewPolicyFingerprint
    }
  },
  tasks: ['task-a', 'task-b'].map((taskId) => ({
    id: taskId,
    title: taskId,
    goal: taskId,
    dependencies: [],
    expectedReads: [],
    expectedWrites: [],
    sharedResources: [],
    verification: []
  })),
  hardConflicts: [],
  riskConflicts: [],
  scheduleOptions: { maxConcurrency: 2 },
  taskBindings: ['task-a', 'task-b'].map((taskId) => ({
    runId,
    taskId,
    agentId: `agent-${taskId}`,
    leasePlan: {
      taskId,
      predictedResources: [{ type: 'project' as const, projectId: 'core' }],
      source: 'manual' as const
    },
    workspace: {
      id: `workspace-${runId}-${taskId}`,
      runId,
      taskId,
      integrationRepositoryPath: `/integration/${runId}/${taskId}`,
      workspacePath: `/workspace/${runId}/${taskId}`,
      branchName: `orchestrator/${runId}/${taskId}`,
      baseRef: 'main',
      integrationRef: 'main'
    }
  }))
});

const assertDependencyProgression = async (
  persistence: DrizzleSqliteOrchestrationPersistence,
  runId: string
) => {
  const recovered = await persistence.recoverRun(runId);
  expect(recovered?.run.state).toBe('COMPLETED');
  expect(recovered?.attempts).toHaveLength(2);
  expect(recovered?.attempts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        attempt: expect.objectContaining({ taskId: 'task-a', state: 'COMPLETED' })
      }),
      expect.objectContaining({
        attempt: expect.objectContaining({ taskId: 'task-b', state: 'COMPLETED' })
      })
    ])
  );
  if (recovered === undefined) {
    throw new Error(`Missing dependency differential run: ${runId}`);
  }

  const taskAIntegration = recovered.events.find(
    ({ event }) => event.type === 'workspace-integrated' && event.taskId === 'task-a'
  );
  const taskBAuthorization = recovered.decisions.find((decision) =>
    decision.decision.taskDecisions.some(
      (taskDecision) => taskDecision.taskId === 'task-b' && taskDecision.action === 'start'
    )
  );
  expect(taskAIntegration).toBeDefined();
  expect(taskBAuthorization).toBeDefined();
  if (taskAIntegration === undefined || taskBAuthorization === undefined) {
    throw new Error(
      'Dependency progression is missing task-a integration or task-b authorization.'
    );
  }
  expect(taskBAuthorization.sequence).toBeGreaterThanOrEqual(taskAIntegration.sequence);
  expect(taskBAuthorization.inputSnapshot.taskStates).toContainEqual({
    taskId: 'task-a',
    state: 'COMPLETED'
  });

  return {
    authorizations: recovered.decisions.flatMap(({ inputSnapshot, decision }) =>
      decision.taskDecisions
        .filter((taskDecision) => taskDecision.action === 'start')
        .map(({ taskId, action, fromState, toState, reasons }) => ({
          taskId,
          action,
          inputTaskStates: inputSnapshot.taskStates,
          ...(fromState === undefined ? {} : { fromState }),
          ...(toState === undefined ? {} : { toState }),
          reasonTypes: reasons.map((reason) => reason.type)
        }))
    ),
    attempts: recovered.attempts.map(({ attempt }) => ({
      taskId: attempt.taskId,
      state: attempt.state,
      revision: attempt.revision
    }))
  };
};

const runtimeConflictProjection = (conflicts: RecoveredRun['conflicts']) =>
  conflicts
    .filter(({ conflict }) =>
      conflict.constraints.some((constraint) => constraint.type === 'runtime-scope-expansion')
    )
    .map(({ taskA, taskB, conflict, effectiveFromSequence }) => ({
      taskA,
      taskB,
      effectiveFromSequence,
      severity: conflict.severity,
      constraints: conflict.constraints.map((constraint) => ({
        type: constraint.type,
        resourceIds: [...constraint.resourceIds].toSorted()
      }))
    }))
    .toSorted((left, right) => left.taskA.localeCompare(right.taskA));

const assertScopeExpansionAuthority = async (
  persistence: DrizzleSqliteOrchestrationPersistence,
  runId: string
) => {
  const recovered = await persistence.recoverRun(runId);
  expect(recovered).toBeDefined();
  const runtimeConflicts = runtimeConflictProjection(recovered!.conflicts);
  expect(runtimeConflicts).toEqual([
    {
      taskA: 'task-a',
      taskB: 'task-b',
      effectiveFromSequence: expect.any(Number),
      severity: 'hard',
      constraints: [{ type: 'runtime-scope-expansion', resourceIds: ['core:expanded.ts'] }]
    }
  ]);
  const [runtimeConflict] = runtimeConflicts;
  const effectiveFromSequence = runtimeConflict.effectiveFromSequence;
  expect(effectiveFromSequence).toEqual(expect.any(Number));
  if (effectiveFromSequence === undefined) {
    throw new Error('Runtime scope conflict is missing its effective scheduler sequence.');
  }
  const taskBAuthorization = recovered!.decisions.find(
    (decision) =>
      decision.sequence > effectiveFromSequence &&
      decision.decision.taskDecisions.some(
        (taskDecision) => taskDecision.taskId === 'task-b' && taskDecision.action === 'start'
      )
  );
  const taskACompletion = recovered!.events.find(
    ({ event }) => event.type === 'workspace-integrated' && event.taskId === 'task-a'
  );
  expect(taskBAuthorization).toBeDefined();
  expect(taskACompletion).toBeDefined();
  expect(recovered!.attempts).toContainEqual(
    expect.objectContaining({ attempt: expect.objectContaining({ taskId: 'task-b' }) })
  );
  expect(taskBAuthorization!.sequence).toBe(taskACompletion!.sequence);
  expect(taskBAuthorization!.inputSnapshot.taskStates).toContainEqual({
    taskId: 'task-a',
    state: 'COMPLETED'
  });
  expect(taskBAuthorization!.sequence).toBeGreaterThan(effectiveFromSequence);

  const replayed = await persistence.replayRun(runId, new DeterministicScheduler());
  const deferred = replayed.find(
    (decision) =>
      decision.sequence >= effectiveFromSequence &&
      decision.decision.taskDecisions.some(
        (taskDecision) =>
          taskDecision.taskId === 'task-b' &&
          taskDecision.action === 'defer' &&
          taskDecision.reasons.some((reason) => reason.type === 'hard-conflict')
      )
  );
  expect(deferred).toBeDefined();
  return runtimeConflicts;
};

const adapterOverrides = (
  persistence: DrizzleSqliteOrchestrationPersistence,
  script: ScenarioScript
): ForgeWorkerCompositionOverrides => {
  return {
    persistence,
    repositoryGraph: graph,
    workspaceManager: {
      async create(request) {
        return { ...request, revision: 1, phase: 'READY_TO_INTEGRATE' };
      },
      async commit(request) {
        return request.workspace;
      },
      async integrate(workspace) {
        return integrateScenarioWorkspace(workspace, script);
      },
      async resumeIntegration(workspace) {
        if (script.integrationResumeCount !== undefined) {
          script.integrationResumeCount.count += 1;
        }
        return integrateScenarioWorkspace(workspace, script);
      },
      async abortIntegration() {
        throw new Error('Not used by the differential fixture.');
      },
      async dispose() {
        throw new Error('Not used by the differential fixture.');
      }
    },
    snapshots: {
      async capture({ repositoryPath }) {
        return {
          repositoryId: 'repository-snapshot',
          repositoryRoot: repositoryPath,
          baseCommit: 'a'.repeat(40),
          workingTreeFingerprint: fingerprint,
          dirty: true
        };
      }
    },
    reviewer: {
      async review(request) {
        return reviewForScenario(script, request.iteration);
      }
    },
    verifier: {
      async verify() {
        return { status: 'passed' as const };
      }
    },
    builderAgentRunner: {
      async run(request) {
        if (script.temporalRunnerCounts !== undefined) {
          script.temporalRunnerCounts.builder += 1;
        }
        await request.onStarted({
          sessionRef: { backend: 'differential-fixture', value: 'builder-session' }
        });
        script.builderStarts?.push(request.taskId);
        script.onBuilderStarted?.(request.taskId);
        await script.waitForBuilderCompletion?.(request.taskId);
        if (script.throwBuilderAfterStarted) {
          throw new Error('post-start builder disconnect');
        }
        return {
          status: 'completed' as const,
          sessionRef: { backend: 'differential-fixture', value: 'builder-session' }
        };
      }
    },
    repairRunner: {
      async run(request) {
        if (script.temporalRunnerCounts !== undefined) {
          script.temporalRunnerCounts.repair += 1;
        }
        await request.onStarted({
          sessionRef: { backend: 'differential-fixture', value: 'repair-session' }
        });
        if (script.throwRepairAfterStarted) {
          throw new Error('post-start repair disconnect');
        }
        if (script.blockNextRepair) {
          script.blockNextRepair = false;
          return {
            status: 'blocked' as const,
            leaseId: 'lease-blocker',
            detail: 'Blocked by the fixture lease.'
          };
        }
        return {
          status: 'completed' as const,
          sessionRef: { backend: 'differential-fixture', value: 'repair-session' }
        };
      }
    },
    reconciler: {
      async reconcile({ taskId }) {
        return reconcileScenarioImpact(taskId, script);
      }
    }
  };
};

const waitForBlockedRepair = async (
  persistence: DrizzleSqliteOrchestrationPersistence,
  runId: string
) => {
  for (let attempts = 0; attempts < 100; attempts++) {
    const repair = (await persistence.recoverRepairAttempts(runId)).find(
      ({ attempt }) => attempt.state === 'BLOCKED'
    )?.attempt;
    if (repair !== undefined) {
      return repair;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for blocked repair: ${runId}`);
};

const waitForBlockedIntegration = async (
  persistence: DrizzleSqliteOrchestrationPersistence,
  runId: string,
  taskId: string,
  minimumRevision = 0
) => {
  for (let attempts = 0; attempts < 100; attempts++) {
    const recovered = await persistence.recoverRun(runId);
    const workspace = recovered?.workspaces
      .filter(
        (record) =>
          record.workspace.taskId === taskId && record.workspace.phase === 'INTEGRATION_BLOCKED'
      )
      .toSorted((left, right) => right.workspace.revision - left.workspace.revision)
      .at(0)?.workspace;
    const subject = (await persistence.recoverReviews(runId)).find(
      (record) =>
        record.taskId === taskId &&
        record.review.recommendation === 'accept' &&
        record.subject?.workspaceId === workspace?.id
    )?.subject;
    if (workspace !== undefined && workspace.revision > minimumRevision && subject !== undefined) {
      return { workspace, subject };
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for blocked integration: ${runId}/${taskId}`);
};

describe('M3.9 legacy and Temporal differential acceptance', () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  it('launches initialized authority through an independent Temporal worker', async () => {
    const runId = `m310-launch-${crypto.randomUUID()}`;
    const taskId = 'task-launch';
    const persistence = new DrizzleSqliteOrchestrationPersistence(':memory:');
    const composition = await createForgeWorkerComposition(
      adapterOverrides(persistence, { blockNextRepair: false })
    );
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: `m310-${runId}`,
      workflowsPath: workflowPath,
      activities: composition.forgeActivities
    });
    const client = new Client({ connection: environment.client.connection });
    const workerRun = worker.run();
    let handle:
      | Awaited<ReturnType<typeof client.workflow.start<typeof forgeRunWorkflow>>>
      | undefined;
    const launcher = new TemporalRunLauncher({
      persistence,
      workflow: {
        async start(launchedRunId) {
          handle = await client.workflow.start(forgeRunWorkflow, {
            taskQueue: worker.options.taskQueue,
            workflowId: `forge-run:${launchedRunId}`,
            args: [{ runId: launchedRunId }],
            workflowIdConflictPolicy: 'USE_EXISTING'
          });
          return {
            workflowId: handle.workflowId,
            workflowRunId: handle.firstExecutionRunId
          };
        }
      }
    });

    try {
      await expect(launcher.startOrResumeRun(createRun(runId, taskId))).resolves.toEqual({
        runId,
        workflowId: `forge-run:${runId}`,
        workflowRunId: expect.any(String)
      });
      if (handle === undefined) {
        throw new Error('Temporal launch did not return a workflow handle');
      }
      await expect(handle.result()).resolves.toEqual({ runId, status: 'completed' });
      const outcome = await collectDurableExecutionOutcomeFromSqlite(runId, { persistence });
      assertDurableExecutionSpikeOutcome({ outcome, scenario: 'build-review-repair-integrate' });
    } finally {
      worker.shutdown();
      await workerRun;
      await composition.close();
      persistence.close();
      await environment.teardown();
    }
  }, 30_000);

  it('persists the frozen build-review-repair-exact-integration evidence contract', async () => {
    const runId = `m36-normal-${crypto.randomUUID()}`;
    const taskId = 'task-normal';
    const persistence = new DrizzleSqliteOrchestrationPersistence(':memory:');
    await persistence.createRun(createRun(runId, taskId));
    const composition = await createForgeWorkerComposition(
      adapterOverrides(persistence, { blockNextRepair: false })
    );
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: `m36-${runId}`,
      workflowsPath: workflowPath,
      activities: composition.forgeActivities
    });

    const client = new Client({ connection: environment.client.connection });
    const workerRun = worker.run();
    try {
      const result = await client.workflow.execute(forgeRunWorkflow, {
        taskQueue: worker.options.taskQueue,
        workflowId: `forge-run:${runId}`,
        args: [{ runId }]
      });
      expect(result).toEqual({ runId, status: 'completed' });
      const outcome = await collectDurableExecutionOutcomeFromSqlite(runId, { persistence });
      expect(outcome.verifications.at(-1)?.attemptId).toBe(outcome.repairs.at(-1)?.id);
      expect(outcome.reviews.at(-1)?.subject.outputAttemptId).toBe(outcome.repairs.at(-1)?.id);
      assertDurableExecutionSpikeOutcome({ outcome, scenario: 'build-review-repair-integrate' });
      expect(outcome.integration.outputAttemptId).toBe(outcome.repairs.at(-1)?.id);

      const legacyPersistence = new DrizzleSqliteOrchestrationPersistence(':memory:');
      try {
        const legacyRuntime = createLegacyRuntime(legacyPersistence, { blockNextRepair: false });
        const legacyRunId = `${runId}-legacy`;
        await legacyRuntime.startRun(createRun(legacyRunId, taskId));
        const legacyOutcome = await collectDurableExecutionOutcomeFromSqlite(legacyRunId, {
          persistence: legacyPersistence
        });
        assertDurableExecutionSpikeOutcome({
          outcome: legacyOutcome,
          scenario: 'build-review-repair-integrate'
        });
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

  it('resumes only the exact blocked integration and waits through a repeated block', async () => {
    const runId = `m39-blocked-integration-${crypto.randomUUID()}`;
    const taskId = 'task-blocked-integration';
    const temporalScript: ScenarioScript = {
      blockNextRepair: false,
      blockNextIntegration: true,
      integrationResumeCount: { count: 0 }
    };
    const temporalPersistence = new DrizzleSqliteOrchestrationPersistence(':memory:');
    await temporalPersistence.createRun(createRun(runId, taskId));
    const temporalComposition = await createForgeWorkerComposition(
      adapterOverrides(temporalPersistence, temporalScript)
    );
    const temporalEnvironment = await TestWorkflowEnvironment.createTimeSkipping();
    const temporalWorker = await Worker.create({
      connection: temporalEnvironment.nativeConnection,
      taskQueue: `m39-${runId}`,
      workflowsPath: workflowPath,
      activities: temporalComposition.forgeActivities
    });
    const temporalWorkerRun = temporalWorker.run();
    try {
      const client = new Client({ connection: temporalEnvironment.client.connection });
      const handle = await client.workflow.start(forgeRunWorkflow, {
        taskQueue: temporalWorker.options.taskQueue,
        workflowId: `forge-run:${runId}`,
        args: [{ runId }]
      });
      const blocked = await waitForBlockedIntegration(temporalPersistence, runId, taskId);
      await handle.signal(integrationWakeSignal, {
        taskId: 'wrong-task',
        workspaceId: blocked.workspace.id,
        subjectRef: blocked.subject
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(temporalScript.integrationResumeCount?.count).toBe(0);

      temporalScript.blockNextIntegration = true;
      await handle.signal(integrationWakeSignal, {
        taskId,
        workspaceId: blocked.workspace.id,
        subjectRef: blocked.subject
      });
      const blockedAgain = await waitForBlockedIntegration(
        temporalPersistence,
        runId,
        taskId,
        blocked.workspace.revision
      );
      expect(blockedAgain.workspace.revision).toBeGreaterThan(blocked.workspace.revision);
      await handle.signal(integrationWakeSignal, {
        taskId,
        workspaceId: blockedAgain.workspace.id,
        subjectRef: blockedAgain.subject
      });
      await expect(handle.result()).resolves.toEqual({ runId, status: 'completed' });
      const temporalOutcome = await collectDurableExecutionOutcomeFromSqlite(runId, {
        persistence: temporalPersistence
      });

      const legacyRunId = `${runId}-legacy`;
      const legacyScript: ScenarioScript = {
        blockNextRepair: false,
        blockNextIntegration: true,
        integrationResumeCount: { count: 0 }
      };
      const legacyPersistence = new DrizzleSqliteOrchestrationPersistence(':memory:');
      try {
        await createLegacyRuntime(legacyPersistence, legacyScript).startRun(
          createRun(legacyRunId, taskId)
        );
        await waitForBlockedIntegration(legacyPersistence, legacyRunId, taskId);
        legacyScript.blockNextIntegration = true;
        await createLegacyRuntime(legacyPersistence, legacyScript).recoverAndResumeRun(
          createRun(legacyRunId, taskId)
        );
        await waitForBlockedIntegration(legacyPersistence, legacyRunId, taskId);
        await createLegacyRuntime(legacyPersistence, legacyScript).recoverAndResumeRun(
          createRun(legacyRunId, taskId)
        );
        const legacyOutcome = await collectDurableExecutionOutcomeFromSqlite(legacyRunId, {
          persistence: legacyPersistence
        });
        for (const outcome of [temporalOutcome, legacyOutcome]) {
          expect(outcome.integration.status).toBe('integrated');
          expect(outcome.reviews).toHaveLength(2);
          expect(outcome.verifications).toHaveLength(2);
          expect(outcome.repairs).toHaveLength(1);
        }
        expect(temporalScript.integrationResumeCount?.count).toBe(2);
        expect(legacyScript.integrationResumeCount?.count).toBe(2);
        expect(normalizeOutcome(legacyOutcome)).toEqual(normalizeOutcome(temporalOutcome));
      } finally {
        legacyPersistence.close();
      }
    } finally {
      temporalWorker.shutdown();
      await temporalWorkerRun;
      await temporalComposition.close();
      temporalPersistence.close();
      await temporalEnvironment.teardown();
    }
  }, 30_000);

  it('fails closed after a builder disconnects following durable session establishment', async () => {
    const runId = `m39-builder-unknown-${crypto.randomUUID()}`;
    const taskId = 'task-builder-unknown';
    const script: ScenarioScript = {
      blockNextRepair: false,
      throwBuilderAfterStarted: true,
      temporalRunnerCounts: { builder: 0, repair: 0 }
    };
    const persistence = new DrizzleSqliteOrchestrationPersistence(':memory:');
    await persistence.createRun(createRun(runId, taskId));
    const composition = await createForgeWorkerComposition(adapterOverrides(persistence, script));
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: `m39-${runId}`,
      workflowsPath: workflowPath,
      activities: composition.forgeActivities
    });
    const workerRun = worker.run();
    try {
      const client = new Client({ connection: environment.client.connection });
      await expectRejectionContaining(
        client.workflow.execute(forgeRunWorkflow, {
          taskQueue: worker.options.taskQueue,
          workflowId: `forge-run:${runId}`,
          args: [{ runId }]
        }),
        'post-start builder disconnect'
      );
      await assertUnknownAttemptAuthority(persistence, runId, {
        runState: 'FAILED',
        repair: false,
        retainsActiveLease: true
      });
      expect(script.temporalRunnerCounts?.builder).toBe(1);

      const legacyRunId = `${runId}-legacy`;
      const legacyPersistence = new DrizzleSqliteOrchestrationPersistence(':memory:');
      try {
        await expectRejectionContaining(
          createLegacyRuntime(legacyPersistence, script).startRun(createRun(legacyRunId, taskId)),
          'post-start builder disconnect'
        );
        await assertUnknownAttemptAuthority(legacyPersistence, legacyRunId, {
          runState: 'FAILED',
          repair: false,
          retainsActiveLease: true
        });
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

  it('keeps a repair UNKNOWN without terminalizing unresolved mutation authority', async () => {
    const runId = `m39-repair-unknown-${crypto.randomUUID()}`;
    const taskId = 'task-repair-unknown';
    const script: ScenarioScript = {
      blockNextRepair: false,
      throwRepairAfterStarted: true,
      temporalRunnerCounts: { builder: 0, repair: 0 }
    };
    const persistence = new DrizzleSqliteOrchestrationPersistence(':memory:');
    await persistence.createRun(createRun(runId, taskId));
    const composition = await createForgeWorkerComposition(adapterOverrides(persistence, script));
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: `m39-${runId}`,
      workflowsPath: workflowPath,
      activities: composition.forgeActivities
    });
    const workerRun = worker.run();
    try {
      const client = new Client({ connection: environment.client.connection });
      await expectRejectionContaining(
        client.workflow.execute(forgeRunWorkflow, {
          taskQueue: worker.options.taskQueue,
          workflowId: `forge-run:${runId}`,
          args: [{ runId }]
        }),
        'Run is not terminal'
      );
      await assertUnknownAttemptAuthority(persistence, runId, {
        runState: 'ACTIVE',
        repair: true,
        retainsActiveLease: false
      });
      expect(script.temporalRunnerCounts?.repair).toBe(1);

      const legacyRunId = `${runId}-legacy`;
      const legacyPersistence = new DrizzleSqliteOrchestrationPersistence(':memory:');
      try {
        await expectRejectionContaining(
          createLegacyRuntime(legacyPersistence, script).startRun(createRun(legacyRunId, taskId)),
          'post-start repair disconnect'
        );
        await assertUnknownAttemptAuthority(legacyPersistence, legacyRunId, {
          runState: 'ACTIVE',
          repair: true,
          retainsActiveLease: false
        });
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
    const directory = mkdtempSync(join(tmpdir(), 'm36-temporal-restart-'));
    const databasePath = join(directory, 'run.sqlite');
    const persistenceA = new DrizzleSqliteOrchestrationPersistence(databasePath);
    await persistenceA.createRun(createRun(runId, 'task-blocked'));
    await persistenceA.persistLease({
      runId,
      lease: {
        id: 'lease-blocker',
        runId,
        agentId: 'blocker',
        taskId: 'other-task',
        resource: { type: 'project', projectId: 'project-blocker' },
        mode: 'exclusive',
        version: 1,
        state: 'ACTIVE',
        acquiredAt: new Date(),
        lastHeartbeatAt: new Date()
      }
    });
    const temporalScript = { blockNextRepair: true };
    const compositionA = await createForgeWorkerComposition(
      adapterOverrides(persistenceA, temporalScript)
    );
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const taskQueue = `m36-${runId}`;
    const workerA = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: workflowPath,
      activities: compositionA.forgeActivities,
      // A restart cannot retain workflow cache state from worker A.
      maxCachedWorkflows: 0
    });
    const client = new Client({ connection: environment.client.connection });
    const workerRunA = workerA.run();
    try {
      const handle = await client.workflow.start(forgeRunWorkflow, {
        taskQueue,
        workflowId: `forge-run:${runId}`,
        args: [{ runId }]
      });
      const blocked = await waitForBlockedRepair(persistenceA, runId);
      workerA.shutdown();
      await workerRunA;
      expect(workerA.getState()).toBe('STOPPED');
      await compositionA.close();
      persistenceA.close();

      const persistenceB = new DrizzleSqliteOrchestrationPersistence(databasePath);
      const compositionB = await createForgeWorkerComposition(
        adapterOverrides(persistenceB, temporalScript)
      );
      const workerB = await Worker.create({
        connection: environment.nativeConnection,
        taskQueue,
        workflowsPath: workflowPath,
        activities: compositionB.forgeActivities,
        maxCachedWorkflows: 0
      });
      const workerRunB = workerB.run();
      let outcome: DurableExecutionSpikeOutcome;
      try {
        await persistenceB.persistLease({
          runId,
          lease: {
            id: 'lease-blocker',
            runId,
            agentId: 'blocker',
            taskId: 'other-task',
            resource: { type: 'project', projectId: 'project-blocker' },
            mode: 'exclusive',
            version: 2,
            state: 'RELEASED',
            acquiredAt: new Date(),
            lastHeartbeatAt: new Date(),
            releasedAt: new Date()
          }
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        await handle.signal(repairWakeSignal, { repairAttemptId: blocked.id });
        await expect(handle.result()).resolves.toEqual({ runId, status: 'completed' });
        outcome = await collectDurableExecutionOutcomeFromSqlite(runId, {
          persistence: persistenceB
        });
        assertDurableExecutionSpikeOutcome({ outcome, scenario: 'blocked-repair-restart-resume' });
        expect(outcome.blockedResume?.repairAttemptId).toBe(blocked.id);
        expect(outcome.dispatchCount).toBe(1);
      } finally {
        workerB.shutdown();
        await workerRunB;
        await compositionB.close();
        persistenceB.close();
      }

      const legacyDirectory = mkdtempSync(join(tmpdir(), 'm36-legacy-restart-'));
      const legacyDatabasePath = join(legacyDirectory, 'run.sqlite');
      const legacyPersistenceA = new DrizzleSqliteOrchestrationPersistence(legacyDatabasePath);
      let legacyPersistenceB: DrizzleSqliteOrchestrationPersistence | undefined;
      try {
        const legacyRunId = `${runId}-legacy`;
        await legacyPersistenceA.createRun(createRun(legacyRunId, 'task-blocked'));
        await legacyPersistenceA.persistLease({
          runId: legacyRunId,
          lease: {
            id: 'lease-blocker',
            runId: legacyRunId,
            agentId: 'blocker',
            taskId: 'other-task',
            resource: { type: 'project', projectId: 'project-blocker' },
            mode: 'exclusive',
            version: 1,
            state: 'ACTIVE',
            acquiredAt: new Date(),
            lastHeartbeatAt: new Date()
          }
        });
        const legacyScript = { blockNextRepair: true };
        const legacyRuntimeA = createLegacyRuntime(legacyPersistenceA, legacyScript);
        await legacyRuntimeA.startOrResumeRun(createRun(legacyRunId, 'task-blocked'));
        const legacyBlocked = (await legacyPersistenceA.recoverRepairAttempts(legacyRunId)).find(
          ({ attempt }) => attempt.state === 'BLOCKED'
        )?.attempt;
        expect(legacyBlocked).toBeDefined();
        legacyPersistenceA.close();

        legacyPersistenceB = new DrizzleSqliteOrchestrationPersistence(legacyDatabasePath);
        await legacyPersistenceB.persistLease({
          runId: legacyRunId,
          lease: {
            id: 'lease-blocker',
            runId: legacyRunId,
            agentId: 'blocker',
            taskId: 'other-task',
            resource: { type: 'project', projectId: 'project-blocker' },
            mode: 'exclusive',
            version: 2,
            state: 'RELEASED',
            acquiredAt: new Date(),
            lastHeartbeatAt: new Date(),
            releasedAt: new Date()
          }
        });
        const legacyRuntimeB = createLegacyRuntime(legacyPersistenceB, legacyScript);
        await legacyRuntimeB.recoverAndResumeRun(createRun(legacyRunId, 'task-blocked'));
        const legacyOutcome = await collectDurableExecutionOutcomeFromSqlite(legacyRunId, {
          persistence: legacyPersistenceB
        });
        assertDurableExecutionSpikeOutcome({
          outcome: legacyOutcome,
          scenario: 'blocked-repair-restart-resume'
        });
        expect(legacyOutcome.blockedResume?.repairAttemptId).toBe(legacyBlocked?.id);
        expect(legacyOutcome.dispatchCount).toBe(1);
        expect(normalizeOutcome(legacyOutcome)).toEqual(normalizeOutcome(outcome));
      } finally {
        legacyPersistenceA.close();
        legacyPersistenceB?.close();
        rmSync(legacyDirectory, { recursive: true, force: true });
      }
    } finally {
      if (workerA.getState() !== 'STOPPED') {
        workerA.shutdown();
        await workerRunA;
      }
      await compositionA.close();
      persistenceA.close();
      await environment.teardown();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('restarts a durably blocked integration and resumes its exact subject', async () => {
    const runId = `m39-blocked-integration-restart-${crypto.randomUUID()}`;
    const taskId = 'task-blocked-integration-restart';
    const directory = mkdtempSync(join(tmpdir(), 'm39-temporal-integration-restart-'));
    const databasePath = join(directory, 'run.sqlite');
    const temporalScript: ScenarioScript = {
      blockNextRepair: false,
      blockNextIntegration: true,
      integrationResumeCount: { count: 0 }
    };
    const persistenceA = new DrizzleSqliteOrchestrationPersistence(databasePath);
    await persistenceA.createRun(createRun(runId, taskId));
    const compositionA = await createForgeWorkerComposition(
      adapterOverrides(persistenceA, temporalScript)
    );
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const taskQueue = `m39-${runId}`;
    const workerA = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: workflowPath,
      activities: compositionA.forgeActivities,
      maxCachedWorkflows: 0
    });
    const client = new Client({ connection: environment.client.connection });
    const workerRunA = workerA.run();
    try {
      const handle = await client.workflow.start(forgeRunWorkflow, {
        taskQueue,
        workflowId: `forge-run:${runId}`,
        args: [{ runId }]
      });
      const blocked = await waitForBlockedIntegration(persistenceA, runId, taskId);
      workerA.shutdown();
      await workerRunA;
      expect(workerA.getState()).toBe('STOPPED');
      await compositionA.close();
      persistenceA.close();

      const persistenceB = new DrizzleSqliteOrchestrationPersistence(databasePath);
      const compositionB = await createForgeWorkerComposition(
        adapterOverrides(persistenceB, temporalScript)
      );
      const workerB = await Worker.create({
        connection: environment.nativeConnection,
        taskQueue,
        workflowsPath: workflowPath,
        activities: compositionB.forgeActivities,
        maxCachedWorkflows: 0
      });
      const workerRunB = workerB.run();
      let temporalOutcome: DurableExecutionSpikeOutcome;
      try {
        await handle.signal(integrationWakeSignal, {
          taskId,
          workspaceId: blocked.workspace.id,
          subjectRef: blocked.subject
        });
        await expect(handle.result()).resolves.toEqual({ runId, status: 'completed' });
        temporalOutcome = await collectDurableExecutionOutcomeFromSqlite(runId, {
          persistence: persistenceB
        });
        expect(temporalOutcome.integration.status).toBe('integrated');
        expect(temporalScript.integrationResumeCount?.count).toBe(1);
      } finally {
        workerB.shutdown();
        await workerRunB;
        await compositionB.close();
        persistenceB.close();
      }

      const legacyDirectory = mkdtempSync(join(tmpdir(), 'm39-legacy-integration-restart-'));
      const legacyDatabasePath = join(legacyDirectory, 'run.sqlite');
      const legacyScript: ScenarioScript = {
        blockNextRepair: false,
        blockNextIntegration: true,
        integrationResumeCount: { count: 0 }
      };
      const legacyRunId = `${runId}-legacy`;
      const legacyPersistenceA = new DrizzleSqliteOrchestrationPersistence(legacyDatabasePath);
      let legacyPersistenceB: DrizzleSqliteOrchestrationPersistence | undefined;
      try {
        await createLegacyRuntime(legacyPersistenceA, legacyScript).startRun(
          createRun(legacyRunId, taskId)
        );
        await waitForBlockedIntegration(legacyPersistenceA, legacyRunId, taskId);
        legacyPersistenceA.close();

        legacyPersistenceB = new DrizzleSqliteOrchestrationPersistence(legacyDatabasePath);
        await createLegacyRuntime(legacyPersistenceB, legacyScript).recoverAndResumeRun(
          createRun(legacyRunId, taskId)
        );
        const legacyOutcome = await collectDurableExecutionOutcomeFromSqlite(legacyRunId, {
          persistence: legacyPersistenceB
        });
        expect(legacyOutcome.integration.status).toBe('integrated');
        expect(legacyScript.integrationResumeCount?.count).toBe(1);
        expect(normalizeOutcome(legacyOutcome)).toEqual(normalizeOutcome(temporalOutcome));
      } finally {
        legacyPersistenceA.close();
        legacyPersistenceB?.close();
        rmSync(legacyDirectory, { recursive: true, force: true });
      }
    } finally {
      if (workerA.getState() !== 'STOPPED') {
        workerA.shutdown();
        await workerRunA;
      }
      await compositionA.close();
      persistenceA.close();
      await environment.teardown();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('matches two completed repairs before accepting and integrating repair two', async () => {
    const runId = `m39-two-repairs-${crypto.randomUUID()}`;
    const taskId = 'task-two-repairs';
    const script: ScenarioScript = {
      blockNextRepair: false,
      reviewRecommendations: { 1: 'repair', 2: 'repair', 3: 'accept' }
    };
    const temporalPersistence = new DrizzleSqliteOrchestrationPersistence(':memory:');
    await temporalPersistence.createRun(createRun(runId, taskId));
    const composition = await createForgeWorkerComposition(
      adapterOverrides(temporalPersistence, script)
    );
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: `m39-${runId}`,
      workflowsPath: workflowPath,
      activities: composition.forgeActivities
    });
    const workerRun = worker.run();
    try {
      const client = new Client({ connection: environment.client.connection });
      await expect(
        client.workflow.execute(forgeRunWorkflow, {
          taskQueue: worker.options.taskQueue,
          workflowId: `forge-run:${runId}`,
          args: [{ runId }]
        })
      ).resolves.toEqual({ runId, status: 'completed' });
      const temporalOutcome = await collectDurableExecutionOutcomeFromSqlite(runId, {
        persistence: temporalPersistence
      });

      const legacyRunId = `${runId}-legacy`;
      const legacyPersistence = new DrizzleSqliteOrchestrationPersistence(':memory:');
      try {
        await createLegacyRuntime(legacyPersistence, script).startRun(
          createRun(legacyRunId, taskId)
        );
        const legacyOutcome = await collectDurableExecutionOutcomeFromSqlite(legacyRunId, {
          persistence: legacyPersistence
        });
        for (const outcome of [temporalOutcome, legacyOutcome]) {
          const repairs = repairsByIteration(outcome);
          expect(repairs.map((repair) => repair.repairIteration)).toEqual([1, 2]);
          expect(repairs.every((repair) => repair.state === 'COMPLETED')).toBe(true);
          expect(outcome.reviews.map(({ review }) => review.recommendation)).toEqual([
            'repair',
            'repair',
            'accept'
          ]);
          expect(outcome.verifications.at(-1)?.attemptId).toBe(repairs[1]?.id);
          expect(outcome.reviews.at(-1)?.subject.outputAttemptId).toBe(repairs[1]?.id);
          expect(outcome.integration).toEqual({
            status: 'integrated',
            outputAttemptId: repairs[1]?.id
          });
        }
        expect(normalizeOutcome(legacyOutcome)).toEqual(normalizeOutcome(temporalOutcome));
      } finally {
        legacyPersistence.close();
      }
    } finally {
      worker.shutdown();
      await workerRun;
      await composition.close();
      temporalPersistence.close();
      await environment.teardown();
    }
  }, 30_000);

  it('preserves repair evidence without integration when the repair budget is exhausted', async () => {
    const runId = `m39-repair-budget-${crypto.randomUUID()}`;
    const taskId = 'task-repair-budget';
    const script: ScenarioScript = {
      blockNextRepair: false,
      reviewRecommendations: { 1: 'repair', 2: 'repair', 3: 'repair' }
    };
    const temporalPersistence = new DrizzleSqliteOrchestrationPersistence(':memory:');
    await temporalPersistence.createRun(createRun(runId, taskId));
    const composition = await createForgeWorkerComposition(
      adapterOverrides(temporalPersistence, script)
    );
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: `m39-${runId}`,
      workflowsPath: workflowPath,
      activities: composition.forgeActivities
    });
    const workerRun = worker.run();
    try {
      const client = new Client({ connection: environment.client.connection });
      await expectBudgetRejection(
        client.workflow.execute(forgeRunWorkflow, {
          taskQueue: worker.options.taskQueue,
          workflowId: `forge-run:${runId}`,
          args: [{ runId }]
        })
      );
      const temporalOutcome = await collectDurableExecutionOutcomeFromSqlite(runId, {
        persistence: temporalPersistence
      });

      const legacyRunId = `${runId}-legacy`;
      const legacyPersistence = new DrizzleSqliteOrchestrationPersistence(':memory:');
      try {
        await expectBudgetRejection(
          createLegacyRuntime(legacyPersistence, script).startRun(createRun(legacyRunId, taskId))
        );
        const legacyOutcome = await collectDurableExecutionOutcomeFromSqlite(legacyRunId, {
          persistence: legacyPersistence
        });
        for (const [outcome, persistence, currentRunId] of [
          [temporalOutcome, temporalPersistence, runId],
          [legacyOutcome, legacyPersistence, legacyRunId]
        ] as const) {
          const repairs = repairsByIteration(outcome);
          expect(repairs).toHaveLength(2);
          expect(repairs.map((repair) => repair.repairIteration)).toEqual([1, 2]);
          expect(repairs.every((repair) => repair.state === 'COMPLETED')).toBe(true);
          expect(outcome.reviews.map(({ review }) => review.recommendation)).toEqual([
            'repair',
            'repair',
            'repair'
          ]);
          expect(outcome.verifications).toHaveLength(3);
          expect(outcome.integration.status).toBe('blocked');
          const recovered = await persistence.recoverRun(currentRunId);
          expect(recovered?.events.some(({ event }) => event.type === 'workspace-integrated')).toBe(
            false
          );
        }
        expect(normalizeOutcome(legacyOutcome)).toEqual(normalizeOutcome(temporalOutcome));
      } finally {
        legacyPersistence.close();
      }
    } finally {
      worker.shutdown();
      await workerRun;
      await composition.close();
      temporalPersistence.close();
      await environment.teardown();
    }
  }, 30_000);

  it('serializes a runtime scope expansion before authorizing the conflicting task', async () => {
    const runId = `m39-scope-expansion-${crypto.randomUUID()}`;
    const temporalPersistence = new DrizzleSqliteOrchestrationPersistence(':memory:');
    await temporalPersistence.createRun(createScopeExpansionRun(runId));
    const temporalScript = { blockNextRepair: false, expandBuilderScopeForTaskId: 'task-a' };
    const composition = await createForgeWorkerComposition(
      adapterOverrides(temporalPersistence, temporalScript)
    );
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: `m39-${runId}`,
      workflowsPath: workflowPath,
      activities: composition.forgeActivities
    });
    const client = new Client({ connection: environment.client.connection });
    const workerRun = worker.run();
    try {
      await expect(
        client.workflow.execute(forgeRunWorkflow, {
          taskQueue: worker.options.taskQueue,
          workflowId: `forge-run:${runId}`,
          args: [{ runId }]
        })
      ).resolves.toEqual({ runId, status: 'completed' });

      const temporalRun = await temporalPersistence.recoverRun(runId);
      expect(temporalRun?.attempts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            attempt: expect.objectContaining({ taskId: 'task-a', state: 'COMPLETED' })
          }),
          expect.objectContaining({
            attempt: expect.objectContaining({ taskId: 'task-b', state: 'COMPLETED' })
          })
        ])
      );
      const temporalConflicts = await assertScopeExpansionAuthority(temporalPersistence, runId);

      const legacyRunId = `${runId}-legacy`;
      const legacyPersistence = new DrizzleSqliteOrchestrationPersistence(':memory:');
      try {
        const legacyRuntime = createLegacyRuntime(legacyPersistence, {
          blockNextRepair: false,
          expandBuilderScopeForTaskId: 'task-a'
        });
        await legacyRuntime.startRun(createScopeExpansionRun(legacyRunId));
        const legacyRun = await legacyPersistence.recoverRun(legacyRunId);
        expect(legacyRun?.attempts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              attempt: expect.objectContaining({ taskId: 'task-a', state: 'COMPLETED' })
            }),
            expect.objectContaining({
              attempt: expect.objectContaining({ taskId: 'task-b', state: 'COMPLETED' })
            })
          ])
        );
        const legacyConflicts = await assertScopeExpansionAuthority(legacyPersistence, legacyRunId);
        expect(legacyConflicts).toEqual(temporalConflicts);
      } finally {
        legacyPersistence.close();
      }
    } finally {
      worker.shutdown();
      await workerRun;
      await composition.close();
      temporalPersistence.close();
      await environment.teardown();
    }
  }, 30_000);

  it('matches dependency-gated scheduler authorization and builder progression', async () => {
    const runId = `m39-dependency-${crypto.randomUUID()}`;
    const temporalPersistence = new DrizzleSqliteOrchestrationPersistence(':memory:');
    await temporalPersistence.createRun(createDependencyRun(runId));
    const composition = await createForgeWorkerComposition(
      adapterOverrides(temporalPersistence, { blockNextRepair: false })
    );
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: `m39-${runId}`,
      workflowsPath: workflowPath,
      activities: composition.forgeActivities
    });
    const workerRun = worker.run();
    try {
      const client = new Client({ connection: environment.client.connection });
      await expect(
        client.workflow.execute(forgeRunWorkflow, {
          taskQueue: worker.options.taskQueue,
          workflowId: `forge-run:${runId}`,
          args: [{ runId }]
        })
      ).resolves.toEqual({ runId, status: 'completed' });
      const temporalProgression = await assertDependencyProgression(temporalPersistence, runId);

      const legacyRunId = `${runId}-legacy`;
      const legacyPersistence = new DrizzleSqliteOrchestrationPersistence(':memory:');
      try {
        await createLegacyRuntime(legacyPersistence, { blockNextRepair: false }).startRun(
          createDependencyRun(legacyRunId)
        );
        const legacyProgression = await assertDependencyProgression(legacyPersistence, legacyRunId);
        expect(legacyProgression).toEqual(temporalProgression);
      } finally {
        legacyPersistence.close();
      }
    } finally {
      worker.shutdown();
      await workerRun;
      await composition.close();
      temporalPersistence.close();
      await environment.teardown();
    }
  }, 30_000);

  it(
    'matches same-run competing lease blocking and original-attempt reauthorization',
    { timeout: 60_000 },
    async () => {
      const runId = `m39-competing-lease-${crypto.randomUUID()}`;
      const temporalPersistence = new DrizzleSqliteOrchestrationPersistence(':memory:');
      await temporalPersistence.createRun(createCompetingLeaseRun(runId));
      let releaseTemporalBuilderA: (() => void) | undefined;
      const temporalBuilderARelease = new Promise<void>((resolve) => {
        releaseTemporalBuilderA = resolve;
      });
      let temporalBuilderAStarted: (() => void) | undefined;
      const temporalBuilderAStart = new Promise<void>((resolve) => {
        temporalBuilderAStarted = resolve;
      });
      const temporalStarts: string[] = [];
      const temporalScript: ScenarioScript = {
        blockNextRepair: false,
        builderStarts: temporalStarts,
        onBuilderStarted: (taskId) => {
          if (taskId === 'task-a') {
            temporalBuilderAStarted?.();
          }
        },
        waitForBuilderCompletion: async (taskId) => {
          if (taskId === 'task-a') {
            await temporalBuilderARelease;
          }
        }
      };
      const composition = await createForgeWorkerComposition(
        adapterOverrides(temporalPersistence, temporalScript)
      );
      const environment = await TestWorkflowEnvironment.createTimeSkipping();
      const worker = await Worker.create({
        connection: environment.nativeConnection,
        taskQueue: `m39-${runId}`,
        workflowsPath: workflowPath,
        activities: composition.forgeActivities
      });
      const workerRun = worker.run();
      try {
        const client = new Client({ connection: environment.client.connection });
        const handle = await client.workflow.start(forgeRunWorkflow, {
          taskQueue: worker.options.taskQueue,
          workflowId: `forge-run:${runId}`,
          args: [{ runId }]
        });
        await temporalBuilderAStart;
        await expect
          .poll(async () => {
            const recovered = await temporalPersistence.recoverRun(runId);
            return recovered?.events.some(
              ({ event }) => event.type === 'lease-blocked' && event.taskId === 'task-b'
            );
          })
          .toBe(true);
        const temporalBlocked = await temporalPersistence.recoverRun(runId);
        const temporalAttemptB = temporalBlocked?.attempts.find(
          ({ attempt }) => attempt.taskId === 'task-b'
        )?.attempt;
        expect(temporalAttemptB).toMatchObject({ state: 'PREPARING' });
        expect(temporalStarts).toEqual(['task-a']);

        if (releaseTemporalBuilderA === undefined) {
          throw new Error('Temporal builder A release was not initialized');
        }
        releaseTemporalBuilderA();
        await expect.poll(() => temporalStarts, { timeout: 5_000 }).toEqual(['task-a', 'task-b']);
        await expect(handle.result()).resolves.toEqual({ runId, status: 'completed' });
        const temporalCompleted = await temporalPersistence.recoverRun(runId);
        expect(temporalCompleted?.attempts).toContainEqual(
          expect.objectContaining({
            attempt: expect.objectContaining({
              id: temporalAttemptB?.id,
              taskId: 'task-b',
              state: 'COMPLETED'
            })
          })
        );
        expect(temporalStarts).toEqual(['task-a', 'task-b']);

        const legacyRunId = `${runId}-legacy`;
        const legacyPersistence = new DrizzleSqliteOrchestrationPersistence(':memory:');
        try {
          let releaseLegacyBuilderA: (() => void) | undefined;
          const legacyBuilderARelease = new Promise<void>((resolve) => {
            releaseLegacyBuilderA = resolve;
          });
          let legacyBuilderAStarted: (() => void) | undefined;
          const legacyBuilderAStart = new Promise<void>((resolve) => {
            legacyBuilderAStarted = resolve;
          });
          const legacyStarts: string[] = [];
          const legacyScript: ScenarioScript = {
            blockNextRepair: false,
            builderStarts: legacyStarts,
            onBuilderStarted: (taskId) => {
              if (taskId === 'task-a') {
                legacyBuilderAStarted?.();
              }
            },
            waitForBuilderCompletion: async (taskId) => {
              if (taskId === 'task-a') {
                await legacyBuilderARelease;
              }
            }
          };
          const legacyRuntime = createLegacyRuntime(legacyPersistence, legacyScript);
          const legacyRun = legacyRuntime.startRun(createCompetingLeaseRun(legacyRunId));
          await legacyBuilderAStart;
          await expect
            .poll(async () => {
              const recovered = await legacyPersistence.recoverRun(legacyRunId);
              return recovered?.events.some(
                ({ event }) => event.type === 'lease-blocked' && event.taskId === 'task-b'
              );
            })
            .toBe(true);
          const legacyBlocked = await legacyPersistence.recoverRun(legacyRunId);
          const legacyAttemptB = legacyBlocked?.attempts.find(
            ({ attempt }) => attempt.taskId === 'task-b'
          )?.attempt;
          expect(legacyAttemptB).toMatchObject({ state: 'PREPARING' });
          expect(legacyStarts).toEqual(['task-a']);

          if (releaseLegacyBuilderA === undefined) {
            throw new Error('Legacy builder A release was not initialized');
          }
          releaseLegacyBuilderA();
          await expect.poll(() => legacyStarts, { timeout: 5_000 }).toEqual(['task-a', 'task-b']);
          await expect(legacyRun).resolves.toMatchObject({
            snapshot: {
              taskStates: [
                { taskId: 'task-a', state: 'COMPLETED' },
                { taskId: 'task-b', state: 'COMPLETED' }
              ]
            }
          });
          const legacyCompleted = await legacyPersistence.recoverRun(legacyRunId);
          expect(legacyCompleted?.attempts).toContainEqual(
            expect.objectContaining({
              attempt: expect.objectContaining({
                id: legacyAttemptB?.id,
                taskId: 'task-b',
                state: 'COMPLETED'
              })
            })
          );
          expect(legacyStarts).toEqual(['task-a', 'task-b']);
          expect(
            temporalCompleted?.events
              .filter(
                ({ event }) => event.type === 'lease-blocked' || event.type === 'lease-released'
              )
              .map(({ event }) => event.type)
          ).toEqual(
            legacyCompleted?.events
              .filter(
                ({ event }) => event.type === 'lease-blocked' || event.type === 'lease-released'
              )
              .map(({ event }) => event.type)
          );
        } finally {
          legacyPersistence.close();
        }
      } finally {
        worker.shutdown();
        await workerRun;
        await composition.close();
        temporalPersistence.close();
        await environment.teardown();
      }
    }
  );
});
