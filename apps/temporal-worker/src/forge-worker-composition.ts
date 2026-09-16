import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import {
  AgentToolRuntime,
  PiAgentRunner,
  PiCodingAgentGateway,
  PiTaskCodeReviewer,
  PiCodeReviewModelResolver
} from '@ai-native-software-delivery-orchestrator/agent-runtime';
import type {
  AgentExecutionAttempt,
  ExecutionPlan,
  HardTaskConflict,
  TaskImpact,
  TaskWorkspace,
  TaskVerificationEvidence,
  PersistedDispatch,
  Scheduler,
  SchedulerDecision,
  SchedulerEvent,
  ScheduleOptions,
  TaskContract,
  SchedulerSnapshot,
} from '@ai-native-software-delivery-orchestrator/domain';
import { DrizzleSqliteOrchestrationPersistence } from '@ai-native-software-delivery-orchestrator/persistence';
import { analyzeRepository } from '@ai-native-software-delivery-orchestrator/repository-analysis';
import { codeReviewPolicyFingerprint, fingerprintPlanValue } from '@ai-native-software-delivery-orchestrator/planning';
import {
  RepositoryImpactReconciler,
  RepositoryResourceResolver,
  SnapshotTaskCodeReviewSubjectProvider,
  TaskVerificationEvidenceFactory
} from '@ai-native-software-delivery-orchestrator/run-preparation';
import { InMemoryWriteGuard } from '@ai-native-software-delivery-orchestrator/runtime-guard';
import {
  GitRepositorySnapshotProvider,
  GitWorkspaceChangeInspector,
  GitWorkspaceManager
} from '@ai-native-software-delivery-orchestrator/workspace-git';
import {
  ForgeAcceptedOutputIntegrationService,
  ForgeBuilderExecutionService,
  ForgeBuilderOutputEvaluationService,
  ForgeRepairExecutionService,
  RepairExecutionCoordinator,
  TaskCodeReviewCollector,
  TaskOutputAdmissionCoordinator,
  TaskRepairCoordinator
} from '@ai-native-software-delivery-orchestrator/orchestration-runtime';
import type {
  AdmitRepairInput,
  AdmitRepairResult,
  ExecuteBuilderInput,
  ExecuteBuilderResult,
  ExecuteRepairInput,
  ExecuteRepairResult,
  EvaluateBuilderOutputInput,
  EvaluateBuilderOutputResult,
  FinalizeRunStateInput,
  FinalizeRunStateResult,
  ForgeActivities,
  IntegrateAcceptedOutputInput,
  IntegrateAcceptedOutputResult,
  ReevaluateRunInput,
  ReevaluateRunResult
} from '@ai-native-software-delivery-orchestrator/temporal-runtime';
import { SandboxedPackageScriptVerifier } from '../../../libs/run-preparation/src/lib/local-runtime-starter.js';

const WORKER_DATABASE_PATH =
  process.env.FORGE_WORKER_DATABASE_PATH ?? resolve(process.cwd(), 'dist', 'temporal-worker.sqlite');
const WORKER_REPOSITORY_PATH = process.env.FORGE_WORKER_REPOSITORY_PATH ?? process.cwd();

const codeReviewPolicy = {
  version: 1,
  reviewer: {
    implementation: 'pi-task-code-reviewer' as const,
    agentBackend: 'pi' as const,
    model: { provider: 'openai', id: 'gpt-4.1' },
    toolProfile: 'workspace-read-only-v1' as const,
    outputSchemaVersion: 1,
    promptVersion: 'v1' as const
  }
} as const;

const verificationPolicy = {
  version: 2,
  autonomousRules: ['package-script-required', 'free-form-command-forbidden'] as const,
  packageScriptRunner: 'npm-from-pinned-node-image' as const,
  executionProfile: {
    kind: 'docker-read-only' as const,
    image: 'node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43',
    assurance: 'production-validation' as const,
    network: 'deny' as const,
    workspaceAccess: 'read-only' as const,
    processTree: 'container' as const,
    memoryBytes: 1_073_741_824,
    cpuCount: 2,
    pidLimit: 256
  }
} as const;

const verificationPolicyFingerprint = fingerprintPlanValue(verificationPolicy);
const reviewPolicyFingerprint = codeReviewPolicyFingerprint(codeReviewPolicy);

const createVerificationEvidence = (request: {
  readonly id: string;
  readonly attempt: AgentExecutionAttempt;
  readonly workspace: TaskWorkspace;
  readonly snapshot: Awaited<ReturnType<GitRepositorySnapshotProvider['capture']>>;
  readonly verificationPolicyFingerprint: string;
  readonly verifiedAt: Date;
}): TaskVerificationEvidence => new TaskVerificationEvidenceFactory().create(request);

const createScheduler = (tasks: readonly TaskContract[]): Scheduler => ({
  createInitialPlan(): ExecutionPlan {
    return {
      waves: tasks.length === 0 ? [] : [{ index: 0, taskIds: tasks.map((task) => task.id) }]
    };
  },
  reevaluate(_event: SchedulerEvent, snapshot: SchedulerSnapshot, nextTasks, _hardConflicts: readonly HardTaskConflict[], _riskConflicts, options: ScheduleOptions): SchedulerDecision {
    const runningTaskIds = snapshot.taskStates.filter((task) => task.state === 'RUNNING').map((task) => task.taskId);
    const taskStates = new Map(snapshot.taskStates.map((task) => [task.taskId, task.state]));
    const taskDecisions = nextTasks
      .filter((task) => taskStates.get(task.id) === 'PENDING')
      .map((task) => ({
        taskId: task.id,
        action: 'ready' as const,
        fromState: 'PENDING' as const,
        toState: 'READY' as const,
        reasons: [
          {
            type: 'dependencies-completed' as const,
            dependencyTaskIds: task.dependencies,
            detail: task.dependencies.length === 0 ? 'No dependencies remain.' : undefined
          }
        ]
      }));
    const readyDecisions = taskDecisions.flatMap((decision) => [
      decision,
      {
        taskId: decision.taskId,
        action: 'start' as const,
        fromState: 'READY' as const,
        toState: 'RUNNING' as const,
        reasons: [
          {
            type: 'selected-by-priority' as const,
            priority: 0,
            detail: runningTaskIds.length >= options.maxConcurrency ? 'Awaiting capacity.' : undefined
          }
        ]
      }
    ]);
    return { taskDecisions: readyDecisions };
  }
});

const createCurrentImpact = (taskId: string): TaskImpact => ({
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

export interface ForgeWorkerComposition {
  readonly forgeActivities: ForgeActivities;
  close(): Promise<void>;
}

export async function createForgeWorkerComposition(): Promise<ForgeWorkerComposition> {
  const repository = await analyzeRepository(WORKER_REPOSITORY_PATH);
  const persistence = new DrizzleSqliteOrchestrationPersistence(WORKER_DATABASE_PATH);
  const writeGuard = new InMemoryWriteGuard();
  const workspaceManager = new GitWorkspaceManager();
  const snapshots = new GitRepositorySnapshotProvider();
  const resources = new RepositoryResourceResolver(repository.graph);
  const reconciler = new RepositoryImpactReconciler({
    changes: new GitWorkspaceChangeInspector(),
    resources
  });
  const subjects = new SnapshotTaskCodeReviewSubjectProvider();

  const reviews = new TaskCodeReviewCollector({
    reviewer: new PiTaskCodeReviewer({
      policy: codeReviewPolicy,
      modelResolver: new PiCodeReviewModelResolver(),
      createTools: (request) =>
        new AgentToolRuntime({
          runId: request.runId,
          taskId: request.task.id,
          attemptId: request.builderAttempt.id,
          agentId: request.builderAttempt.agentId,
          workspacePath: request.workspace.workspacePath,
          resolveResource: (path) => resources.resolve(path),
          resolveFileId: (path) => resources.fileId(path),
          persistence,
          writeGuard
        })
    }),
    store: persistence
  });

  const verifier = new SandboxedPackageScriptVerifier({
    policy: verificationPolicy,
    graph: repository.graph
  });

  const admission = new TaskOutputAdmissionCoordinator({
    snapshots,
    subjects,
    reviews,
    reviewStore: persistence,
    verificationEvidence: persistence,
    createVerificationEvidence,
    createEvidenceId: randomUUID
  });

  const repairCoordinator = new TaskRepairCoordinator({
    store: persistence,
    reviews: persistence,
    maxRepairs: 2,
    createId: randomUUID
  });

  const builderExecution = new ForgeBuilderExecutionService({
    persistence,
    workspaceManager,
    writeGuard,
    agentRunner: new PiAgentRunner({
      gateway: new PiCodingAgentGateway(),
      createTools: (request) =>
        new AgentToolRuntime({
          runId: request.runId,
          taskId: request.taskId,
          attemptId: request.attempt.id,
          agentId: request.attempt.agentId,
          workspacePath: request.workspace.workspacePath,
          resolveResource: (path) => resources.resolve(path),
          resolveFileId: (path) => resources.fileId(path),
          persistence,
          writeGuard
        })
    }),
    reconciler
  });

  const evaluation = new ForgeBuilderOutputEvaluationService({
    snapshots,
    subjects,
    reviews,
    reviewStore: persistence,
    verificationEvidence: persistence,
    createVerificationEvidence,
    createEvidenceId: randomUUID
  });

  const repairExecution = new ForgeRepairExecutionService({
    repairCoordinator,
    executionCoordinator: new RepairExecutionCoordinator({
      repairs: repairCoordinator,
      runner: new PiAgentRunner({
        gateway: new PiCodingAgentGateway(),
        createTools: (request) =>
          new AgentToolRuntime({
            runId: request.runId,
            taskId: request.taskId,
            attemptId: request.attempt.id,
            agentId: request.attempt.agentId,
            workspacePath: request.workspace.workspacePath,
            resolveResource: (path) => resources.resolve(path),
            resolveFileId: (path) => resources.fileId(path),
            persistence,
            writeGuard
          })
      }),
      reconciler,
      verifier,
      snapshots,
      subjects,
      reviews,
      verificationEvidence: persistence,
      writeGuard,
      persistence,
      feedback: { leaseBlocked: async () => undefined, scopeExpanded: async () => undefined },
      createEvidenceId: randomUUID,
      createVerificationEvidence
    })
  });

  const integration = new ForgeAcceptedOutputIntegrationService({
    coordinator: admission,
    workspaceManager,
    persistence
  });

  const recoverTaskContext = async (runId: string, taskId: string, attemptId?: string) => {
    const binding = await persistence.recoverTaskBinding(runId, taskId);
    const recoveredRun = await persistence.recoverRun(runId);
    if (recoveredRun !== undefined) {
      if (
        recoveredRun.run.authority.verificationPolicyFingerprint !== verificationPolicyFingerprint ||
        recoveredRun.run.authority.codeReviewPolicyFingerprint !== reviewPolicyFingerprint
      ) {
        throw new Error(`Worker policy authority mismatch for ${runId}`);
      }
    }
    const task = recoveredRun?.tasks.find((candidate) => candidate.id === taskId);
    const workspaceId = binding?.workspace.id;
    const workspace =
      workspaceId === undefined
        ? undefined
        : recoveredRun?.workspaces.find((candidate) => candidate.workspace.id === workspaceId)?.workspace;
    const attempt =
      attemptId === undefined
        ? recoveredRun?.attempts.find((candidate) => candidate.attempt.taskId === taskId)?.attempt
        : recoveredRun?.attempts.find((candidate) => candidate.attempt.id === attemptId)?.attempt;
    return {
      binding,
      recoveredRun,
      task,
      workspace,
      attempt
    };
  };

  const recoverReviewById = async (runId: string, reviewId: string) => {
    const reviews = await persistence.recoverReviews(runId);
    const [taskId, iterationRaw] = reviewId.split(':');
    const iteration = Number(iterationRaw);
    if (taskId.length === 0 || !Number.isInteger(iteration) || iteration < 1) {
      throw new Error(`Invalid review reference: ${reviewId}`);
    }
    const review = reviews.find((candidate) => candidate.taskId === taskId && candidate.iteration === iteration);
    if (review === undefined) {
      throw new Error(`Missing persisted review authority: ${runId}/${reviewId}`);
    }
    return review;
  };

  const forgeActivities: ForgeActivities = {
    async reevaluateRun(input: ReevaluateRunInput): Promise<ReevaluateRunResult> {
      const recovered = await persistence.recoverRun(input.runId);
      if (recovered === undefined) {
        return { runId: input.runId, authorizedTasks: [] };
      }
      const scheduler = createScheduler(recovered.tasks);
      const reevaluation = {
        event: { runId: input.runId, sequence: recovered.events.length + 1, occurredAt: new Date().toISOString(), event: { type: 'run-started' } as never },
        transitions: [],
        decision: {
          runId: input.runId,
          sequence: recovered.decisions.length + 1,
          inputSnapshot: { taskStates: [], runtimeBlocks: [] },
          decision: scheduler.reevaluate(
            { type: 'run-started' },
            { taskStates: [], runtimeBlocks: [] },
            recovered.tasks,
            recovered.hardConflicts,
            recovered.riskConflicts,
            recovered.scheduleOptions
          )
        }
      } satisfies PersistedDispatch['reevaluation'];
      const attempts = recovered.taskBindings.map((binding) => ({
        runId: input.runId,
        attempt: {
          id: `${input.runId}:${binding.taskId}:preparing`,
          runId: input.runId,
          taskId: binding.taskId,
          agentId: binding.agentId,
          workspaceId: binding.workspace.id,
          leasePlanFingerprint: `sha256:${binding.taskId.padEnd(64, '0').slice(0, 64)}`,
          commandPolicyFingerprint: binding.commandPolicy === undefined ? undefined : `sha256:${binding.taskId.padEnd(64, '1').slice(0, 64)}`,
          trustedCommandPath: binding.trustedCommandPath,
          state: 'PREPARING' as const,
          revision: 1
        }
      }));
      await persistence.persistDispatch({ reevaluation, attempts });
      return {
        runId: input.runId,
        authorizedTasks: attempts.map(({ attempt }) => ({
          taskId: attempt.taskId,
          attemptId: attempt.id
        }))
      };
    },
    async executeBuilder(input: ExecuteBuilderInput): Promise<ExecuteBuilderResult> {
      const context = await recoverTaskContext(input.runId, input.taskId, input.attemptId);
      if (context.binding === undefined || context.task === undefined || context.attempt === undefined) {
        throw new Error(`Missing durable builder authority: ${input.runId}/${input.taskId}`);
      }
      if (context.attempt.id !== input.attemptId || context.attempt.state !== 'PREPARING') {
        throw new Error(`Builder attempt authority mismatch: ${input.runId}/${input.taskId}/${input.attemptId}`);
      }
      await builderExecution.execute({
        runId: input.runId,
        task: context.task,
        binding: context.binding,
        attempt: context.attempt
      });
      const refreshed = await persistence.recoverRun(input.runId);
      const impact = refreshed?.impacts.find((impact) => impact.taskId === input.taskId)?.impact;
      const workspace = refreshed?.workspaces.find((entry) => entry.workspace.taskId === input.taskId)?.workspace;
      if (workspace === undefined || impact === undefined) {
        throw new Error(`Missing persisted builder outputs: ${input.runId}/${input.taskId}`);
      }
      return {
        runId: input.runId,
        taskId: input.taskId,
        workspaceId: workspace.id,
        attemptId: input.attemptId,
        impactId: `${input.runId}:${input.taskId}`
      };
    },
    async evaluateBuilderOutput(input: EvaluateBuilderOutputInput): Promise<EvaluateBuilderOutputResult> {
      const context = await recoverTaskContext(input.runId, input.taskId, input.builderAttemptId);
      if (context.task === undefined || context.workspace === undefined || context.attempt === undefined) {
        throw new Error(`Missing durable evaluation authority: ${input.runId}/${input.taskId}`);
      }
      if (context.attempt.id !== input.builderAttemptId) {
        throw new Error(`Builder attempt mismatch: ${input.runId}/${input.taskId}/${input.builderAttemptId}`);
      }
      const result = await evaluation.evaluate({
        runId: input.runId,
        task: context.task,
        builderAttempt: context.attempt,
        workspace: context.workspace,
        impact: context.recoveredRun?.impacts.find((impact) => impact.taskId === input.taskId)?.impact ??
          createCurrentImpact(input.taskId),
        verificationPolicyFingerprint,
        repository: { files: repository.graph.files, symbols: repository.graph.symbols }
      });
      const recoveredReviews = await persistence.recoverReviews(input.runId);
      const reviewRecord = [...recoveredReviews].reverse().find((record) => record.taskId === input.taskId);
      if (reviewRecord === undefined) {
        throw new Error(`Missing persisted review authority: ${input.runId}/${input.taskId}`);
      }
      return {
        runId: input.runId,
        taskId: input.taskId,
        recommendation: result.recommendation,
        verificationId: result.verification.fingerprint,
        subjectRef: {
          builderAttemptId: result.subject.builderAttemptId,
          outputAttemptId: result.subject.outputAttemptId,
          workspaceId: result.subject.workspaceId
        },
        reviewId: `${input.taskId}:${reviewRecord.iteration}`
      };
    },
    async admitRepair(input: AdmitRepairInput): Promise<AdmitRepairResult> {
      const review = await recoverReviewById(input.runId, input.reviewId);
      const context = await recoverTaskContext(input.runId, input.taskId, review.subject?.builderAttemptId);
      if (context.binding === undefined || context.task === undefined || context.workspace === undefined || context.attempt === undefined || review.subject === undefined) {
        throw new Error(`Missing durable repair admission authority: ${input.runId}/${input.taskId}`);
      }
      const repair = await repairCoordinator.prepare({
        runId: input.runId,
        taskId: input.taskId,
        agentId: context.binding.agentId,
        workspaceId: context.workspace.id,
        reviewIteration: review.iteration,
        review: review.review,
        subject: review.subject
      });
      return {
        runId: input.runId,
        taskId: input.taskId,
        repairAttemptId: repair.id
      };
    },
    async executeRepair(input: ExecuteRepairInput): Promise<ExecuteRepairResult> {
      const repairAttempts = await persistence.recoverRepairAttempts(input.runId);
      const admittedRepair = repairAttempts.find((attempt) => attempt.attempt.id === input.repairAttemptId)?.attempt;
      if (admittedRepair === undefined) {
        throw new Error(`Repair attempt not admitted: ${input.repairAttemptId}`);
      }
      const review = await recoverReviewById(input.runId, input.reviewId);
      const context = await recoverTaskContext(input.runId, input.taskId, input.builderAttemptId);
      if (context.binding === undefined || context.task === undefined || context.workspace === undefined || context.attempt === undefined || review.subject === undefined) {
        throw new Error(`Missing durable repair execution authority: ${input.runId}/${input.taskId}`);
      }
      if (context.attempt.id !== input.builderAttemptId) {
        throw new Error(`Builder attempt authority mismatch: ${input.runId}/${input.taskId}/${input.builderAttemptId}`);
      }
      const result = await repairExecution.execute({
        runId: input.runId,
        agentId: context.binding.agentId,
        builderAttempt: context.attempt,
        task: context.task,
        workspace: context.workspace,
        impact: context.recoveredRun?.impacts.find((impact) => impact.taskId === input.taskId)?.impact ?? createCurrentImpact(input.taskId),
        leases: (context.recoveredRun?.leases ?? []).map(({ lease }) => lease).filter((lease) => lease.taskId === input.taskId),
        verificationPolicyFingerprint,
        repository: { files: repository.graph.files, symbols: repository.graph.symbols },
        reviewIteration: review.iteration,
        review: review.review,
        subject: review.subject,
        maxRepairs: 2,
        preCreatedRepairAttempt: admittedRepair
      });
      if (result.state !== 'completed') {
        return {
          runId: input.runId,
          taskId: input.taskId,
          state: result.state,
          repairAttemptId: result.attempt.id,
          blockerLeaseId: result.state === 'blocked' ? result.blockerLeaseId : undefined,
          detail: result.state === 'unknown' ? result.detail : undefined
        };
      }
      return {
        runId: input.runId,
        taskId: input.taskId,
        state: 'completed',
        repairAttemptId: result.attempt.id,
        recommendation: result.recommendation,
        verificationId: result.verification.fingerprint,
        subjectRef: {
          builderAttemptId: result.reviewSubject.builderAttemptId,
          outputAttemptId: result.reviewSubject.outputAttemptId,
          workspaceId: result.reviewSubject.workspaceId
        },
        reviewId: `${input.taskId}:${review.iteration + 1}`
      };
    },
    async integrateAcceptedOutput(input: IntegrateAcceptedOutputInput): Promise<IntegrateAcceptedOutputResult> {
      const context = await recoverTaskContext(input.runId, input.taskId);
      if (context.task === undefined || context.workspace === undefined) {
        throw new Error(`Missing durable integration authority: ${input.runId}/${input.taskId}`);
      }
      const recoveredReviews = await persistence.recoverReviews(input.runId);
      const acceptedReview = recoveredReviews.find((candidate) =>
        candidate.taskId === input.taskId &&
        candidate.review.recommendation === 'accept' &&
        candidate.subject !== undefined &&
        candidate.subject.builderAttemptId === input.subjectRef.builderAttemptId &&
        candidate.subject.outputAttemptId === input.subjectRef.outputAttemptId &&
        candidate.subject.workspaceId === input.subjectRef.workspaceId
      );
      if (acceptedReview === undefined) {
        throw new Error(`No accepted review available for ${input.runId}/${input.taskId}`);
      }
      const acceptedSubject = acceptedReview.subject;
      if (acceptedSubject === undefined) {
        throw new Error(`Missing accepted review subject for ${input.runId}/${input.taskId}`);
      }
      if (
        acceptedSubject.builderAttemptId !== input.subjectRef.builderAttemptId ||
        acceptedSubject.outputAttemptId !== input.subjectRef.outputAttemptId ||
        acceptedSubject.workspaceId !== input.subjectRef.workspaceId
      ) {
        throw new Error(`Accepted subject mismatch for ${input.runId}/${input.taskId}`);
      }
      await integration.integrate({
        runId: input.runId,
        taskId: input.taskId,
        workspace: context.workspace,
        subject: acceptedSubject,
        task: context.task
      });
      return { runId: input.runId, taskId: input.taskId, status: 'integrated' };
    },
    async finalizeRunState(input: FinalizeRunStateInput): Promise<FinalizeRunStateResult> {
      const recovered = await persistence.recoverRun(input.runId);
      if (recovered === undefined) {
        throw new Error(`Missing durable finalization authority: ${input.runId}`);
      }
      const status = recovered.run.state === 'COMPLETED' ? 'completed' : 'failed';
      await persistence.updateRunState(input.runId, recovered.run.state === 'COMPLETED' ? 'COMPLETED' : 'FAILED');
      return { runId: input.runId, status };
    }
  };

  return {
    forgeActivities,
    async close() {
      await persistence.close?.();
    }
  };
}
