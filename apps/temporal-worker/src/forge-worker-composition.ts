import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Context } from '@temporalio/activity';

import {
  AgentToolRuntime,
  PiAgentRunner,
  PiCodingAgentGateway,
  PiTaskCodeReviewer,
  PiCodeReviewModelResolver
} from '@ai-native-software-delivery-orchestrator/agent-runtime';
import type {
  ActiveMutationClaimPersistence,
  IntegrationMutationClaimPersistence,
  AgentExecutionAttempt,
  AgentRunner,
  CancellationPersistence,
  OrchestrationPersistence,
  PersistedTaskExecutionBinding,
  PersistedWriteLease,
  TaskCodeReviewStore,
  TaskCodeReviewer,
  RepositorySnapshotProvider,
  TaskImpactReconciler,
  TaskRepairRunner,
  TaskVerifier,
  TaskRepairAdmissionStore,
  TaskRepairResumeStore,
  TaskRepairWorkItemStore,
  TaskVerificationEvidenceStore,
  TaskWorkspace,
  TaskVerificationEvidence,
  WorkspaceManager
} from '@ai-native-software-delivery-orchestrator/domain';
import { DrizzleSqliteOrchestrationPersistence } from '@ai-native-software-delivery-orchestrator/persistence';
import { analyzeRepository } from '@ai-native-software-delivery-orchestrator/repository-analysis';
import {
  codeReviewPolicyFingerprint,
  fingerprintPlanValue
} from '@ai-native-software-delivery-orchestrator/planning';
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
  FinalizeRunCancellationInput,
  FinalizeRunCancellationResult,
  FinalizeRunStateInput,
  FinalizeRunStateResult,
  ForgeActivities,
  IntegrateAcceptedOutputInput,
  IntegrateAcceptedOutputResult,
  ReevaluateRunInput,
  ReevaluateRunResult,
  ResumeBlockedRepairInput,
  ResumeBlockedRepairResult
} from '@ai-native-software-delivery-orchestrator/temporal-runtime';
import { SandboxedPackageScriptVerifier } from '../../../libs/run-preparation/src/lib/local-runtime-starter.js';
import { agentCommandPolicyFingerprint } from '@ai-native-software-delivery-orchestrator/domain';
import { taskLeasePlanFingerprint } from '@ai-native-software-delivery-orchestrator/domain';
import {
  ForgeRunFinalizationService,
  ForgeRunProgressionService,
  ForgeRunReevaluationService
} from '../../../libs/orchestration-runtime/src/index.js';

const WORKER_DATABASE_PATH =
  process.env.FORGE_WORKER_DATABASE_PATH ??
  resolve(process.cwd(), 'dist', 'temporal-worker.sqlite');
const WORKER_REPOSITORY_PATH = process.env.FORGE_WORKER_REPOSITORY_PATH ?? process.cwd();

const currentActivityCancellationSignal = () => {
  try {
    return Context.current().cancellationSignal;
  } catch {
    // Composition tests invoke activities directly, outside Temporal's activity context.
    return undefined;
  }
};

const assertBuilderTuple = (
  binding: PersistedTaskExecutionBinding,
  attempt: AgentExecutionAttempt
): void => {
  if (attempt.runId !== binding.runId || attempt.taskId !== binding.taskId) {
    throw new Error(`Builder attempt does not belong to binding: ${attempt.id}`);
  }
  if (attempt.agentId !== binding.agentId) {
    throw new Error(`Builder agent authority mismatch: ${attempt.id}`);
  }
  if (attempt.workspaceId !== binding.workspace.id) {
    throw new Error(`Builder workspace authority mismatch: ${attempt.id}`);
  }
  if (attempt.leasePlanFingerprint !== taskLeasePlanFingerprint(binding.leasePlan)) {
    throw new Error(`Builder lease authority mismatch: ${attempt.id}`);
  }
  if (attempt.commandPolicyFingerprint !== agentCommandPolicyFingerprint(binding.commandPolicy)) {
    throw new Error(`Builder command authority mismatch: ${attempt.id}`);
  }
};

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

export const verificationPolicyFingerprint = fingerprintPlanValue(verificationPolicy);
export const reviewPolicyFingerprint = codeReviewPolicyFingerprint(codeReviewPolicy);

const createVerificationEvidence = (request: {
  readonly id: string;
  readonly attempt: AgentExecutionAttempt;
  readonly workspace: TaskWorkspace;
  readonly snapshot: Awaited<ReturnType<GitRepositorySnapshotProvider['capture']>>;
  readonly verificationPolicyFingerprint: string;
  readonly verifiedAt: Date;
}): TaskVerificationEvidence => new TaskVerificationEvidenceFactory().create(request);

export interface ForgeWorkerComposition {
  readonly forgeActivities: ForgeActivities;
  close(): Promise<void>;
}

type ForgeWorkerPersistence = OrchestrationPersistence &
  CancellationPersistence &
  ActiveMutationClaimPersistence &
  IntegrationMutationClaimPersistence &
  TaskCodeReviewStore &
  TaskVerificationEvidenceStore &
  TaskRepairAdmissionStore &
  TaskRepairResumeStore &
  TaskRepairWorkItemStore & {
    close?(): Promise<void> | void;
  };

/**
 * Test-only injection seams. Production callers pass nothing and get real adapters and
 * services. Adapter seams keep the production Forge services in place while substituting
 * external Git, agent, verification, and model effects. Whole-service seams remain for
 * focused activity tests that isolate a single worker boundary.
 */
export interface ForgeWorkerCompositionOverrides {
  readonly persistence?: ForgeWorkerPersistence;
  readonly workspaceManager?: WorkspaceManager;
  readonly snapshots?: RepositorySnapshotProvider;
  readonly reviewer?: TaskCodeReviewer;
  readonly verifier?: TaskVerifier;
  readonly builderAgentRunner?: AgentRunner;
  readonly repairRunner?: TaskRepairRunner;
  readonly reconciler?: TaskImpactReconciler;
  readonly builderExecution?: Pick<ForgeBuilderExecutionService, 'execute'>;
  readonly evaluation?: Pick<ForgeBuilderOutputEvaluationService, 'evaluate'>;
  readonly repairExecution?: Pick<ForgeRepairExecutionService, 'execute'>;
  readonly integration?: Pick<ForgeAcceptedOutputIntegrationService, 'integrate'>;
  readonly repositoryGraph?: Awaited<ReturnType<typeof analyzeRepository>>['graph'];
  readonly onWriteGuardHydrated?: (
    runId: string,
    leases: readonly PersistedWriteLease['lease'][]
  ) => void;
}

export async function createForgeWorkerComposition(
  overrides: ForgeWorkerCompositionOverrides = {}
): Promise<ForgeWorkerComposition> {
  const repository =
    overrides.repositoryGraph === undefined
      ? await analyzeRepository(WORKER_REPOSITORY_PATH)
      : { graph: overrides.repositoryGraph };
  const persistence =
    overrides.persistence ?? new DrizzleSqliteOrchestrationPersistence(WORKER_DATABASE_PATH);
  const writeGuards = new Map<string, InMemoryWriteGuard>();
  const writeGuardForRunSync = (runId: string): InMemoryWriteGuard => {
    const existing = writeGuards.get(runId);
    if (existing !== undefined) {
      return existing;
    }
    const guard = new InMemoryWriteGuard();
    writeGuards.set(runId, guard);
    return guard;
  };
  const writeGuardForRun = async (runId: string, refresh = false): Promise<InMemoryWriteGuard> => {
    const existing = writeGuards.get(runId);
    if (existing !== undefined && !refresh) {
      return existing;
    }
    const recovered = await persistence.recoverRun(runId);
    const initialLeases =
      recovered?.leases.map(({ lease }) => lease).filter((lease) => lease.state === 'ACTIVE') ?? [];
    overrides.onWriteGuardHydrated?.(runId, initialLeases);
    const guard = new InMemoryWriteGuard({ initialLeases });
    writeGuards.set(runId, guard);
    return guard;
  };
  const workspaceManager = overrides.workspaceManager ?? new GitWorkspaceManager();
  const snapshots = overrides.snapshots ?? new GitRepositorySnapshotProvider();
  const resources = new RepositoryResourceResolver(repository.graph);
  const reconciler =
    overrides.reconciler ??
    new RepositoryImpactReconciler({
      changes: new GitWorkspaceChangeInspector(),
      resources
    });
  const subjects = new SnapshotTaskCodeReviewSubjectProvider();

  const reviewCollector = new TaskCodeReviewCollector({
    reviewer:
      overrides.reviewer ??
      new PiTaskCodeReviewer({
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
            writeGuard: writeGuardForRunSync(request.runId)
          })
      }),
    store: persistence
  });

  const verifier =
    overrides.verifier ??
    new SandboxedPackageScriptVerifier({
      policy: verificationPolicy,
      graph: repository.graph
    });

  const progression = new ForgeRunProgressionService({ persistence });
  const reevaluation = new ForgeRunReevaluationService({ progression });
  const finalization = new ForgeRunFinalizationService({ progression });

  const admission = new TaskOutputAdmissionCoordinator({
    snapshots,
    subjects,
    reviews: reviewCollector,
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

  const createBuilderExecution = (runId: string) =>
    new ForgeBuilderExecutionService({
      persistence,
      workspaceManager,
      writeGuard: writeGuardForRunSync(runId),
      agentRunner:
        overrides.builderAgentRunner ??
        new PiAgentRunner({
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
              writeGuard: writeGuardForRunSync(request.runId)
            })
        }),
      reconciler
    });
  const builderExecution = overrides.builderExecution ?? {
    execute: (request: Parameters<ForgeBuilderExecutionService['execute']>[0]) =>
      createBuilderExecution(request.runId).execute(request)
  };

  const evaluation =
    overrides.evaluation ??
    new ForgeBuilderOutputEvaluationService({
      snapshots,
      subjects,
      reviews: reviewCollector,
      reviewStore: persistence,
      verificationEvidence: persistence,
      createVerificationEvidence,
      createEvidenceId: randomUUID
    });

  const createRepairExecution = (runId: string) =>
    new ForgeRepairExecutionService({
      repairCoordinator,
      executionCoordinator: new RepairExecutionCoordinator({
        repairs: repairCoordinator,
        runner:
          overrides.repairRunner ??
          new PiAgentRunner({
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
                writeGuard: writeGuardForRunSync(request.runId)
              })
          }),
        reconciler,
        verifier,
        snapshots,
        subjects,
        reviews: reviewCollector,
        verificationEvidence: persistence,
        writeGuard: writeGuardForRunSync(runId),
        persistence,
        feedback: { leaseBlocked: async () => undefined, scopeExpanded: async () => undefined },
        createEvidenceId: randomUUID,
        createVerificationEvidence
      })
    });
  const repairExecution = overrides.repairExecution ?? {
    execute: (request: Parameters<ForgeRepairExecutionService['execute']>[0]) =>
      createRepairExecution(request.runId).execute(request)
  };

  const integration =
    overrides.integration ??
    new ForgeAcceptedOutputIntegrationService({
      coordinator: admission,
      workspaceManager,
      persistence
    });

  const recoverTaskContext = async (runId: string, taskId: string, attemptId?: string) => {
    const binding = await persistence.recoverTaskBinding(runId, taskId);
    const recoveredRun = await persistence.recoverRun(runId);
    if (recoveredRun !== undefined) {
      if (
        recoveredRun.run.authority.verificationPolicyFingerprint !==
          verificationPolicyFingerprint ||
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
        : recoveredRun?.workspaces.find((candidate) => candidate.workspace.id === workspaceId)
            ?.workspace;
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

  const recoverReviewById = async (runId: string, taskId: string, reviewId: string) => {
    const reviews = await persistence.recoverReviews(runId);
    const iterationRaw = reviewId.includes(':') ? reviewId.split(':').at(-1) : reviewId;
    const iteration = Number(iterationRaw);
    if (!Number.isInteger(iteration) || iteration < 1) {
      throw new Error(`Invalid review reference: ${reviewId}`);
    }
    const review = reviews.find(
      (candidate) => candidate.taskId === taskId && candidate.iteration === iteration
    );
    if (review === undefined) {
      throw new Error(`Missing persisted review authority: ${runId}/${reviewId}`);
    }
    return review;
  };

  const assertRunAcceptsMutations = async (runId: string): Promise<void> => {
    const recovered = await persistence.recoverRun(runId);
    if (recovered === undefined) {
      throw new Error(`Run not found: ${runId}`);
    }
    if (recovered.run.state !== 'ACTIVE') {
      throw new Error(`Run does not accept mutations: ${runId}/${recovered.run.state}`);
    }
  };

  const forgeActivities: ForgeActivities = {
    async reevaluateRun(input: ReevaluateRunInput): Promise<ReevaluateRunResult> {
      const recovered = await persistence.recoverRun(input.runId);
      if (recovered?.run.state === 'CANCEL_REQUESTED') {
        return { runId: input.runId, authorizedTasks: [] };
      }
      const authorizations: readonly { taskId: string; attemptId: string }[] =
        await reevaluation.recoverAuthorizations(input.runId);
      return {
        runId: input.runId,
        authorizedTasks: authorizations.map((authorization) => ({
          taskId: authorization.taskId,
          attemptId: authorization.attemptId
        }))
      };
    },
    async executeBuilder(input: ExecuteBuilderInput): Promise<ExecuteBuilderResult> {
      await assertRunAcceptsMutations(input.runId);
      const context = await recoverTaskContext(input.runId, input.taskId, input.attemptId);
      if (
        context.binding === undefined ||
        context.task === undefined ||
        context.attempt === undefined
      ) {
        throw new Error(`Missing durable builder authority: ${input.runId}/${input.taskId}`);
      }
      if (context.attempt.id !== input.attemptId || context.attempt.state !== 'PREPARING') {
        throw new Error(
          `Builder attempt authority mismatch: ${input.runId}/${input.taskId}/${input.attemptId}`
        );
      }
      assertBuilderTuple(context.binding, context.attempt);
      await writeGuardForRun(input.runId, true);
      const claimedAttempt = await persistence.claimBuilderStart({
        runId: input.runId,
        attempt: {
          ...context.attempt,
          state: 'STARTING',
          revision: context.attempt.revision + 1,
          startedAt: new Date()
        }
      });
      await builderExecution.execute({
        runId: input.runId,
        task: context.task,
        binding: context.binding,
        attempt: claimedAttempt,
        cancellationSignal: currentActivityCancellationSignal()
      });
      await progression.advance(input.runId, {
        type: 'agent-completed',
        taskId: input.taskId,
        state: 'VERIFYING'
      });
      const refreshed = await persistence.recoverRun(input.runId);
      if (refreshed === undefined) {
        throw new Error(`Missing persisted builder outputs: ${input.runId}/${input.taskId}`);
      }
      const taskImpact = refreshed.impacts.find((entry) => entry.taskId === input.taskId)?.impact;
      const workspace = refreshed.workspaces.find(
        (entry) => entry.workspace.taskId === input.taskId
      )?.workspace;
      if (workspace === undefined || taskImpact === undefined) {
        throw new Error(`Missing persisted builder outputs: ${input.runId}/${input.taskId}`);
      }
      return {
        runId: input.runId,
        taskId: input.taskId,
        workspaceId: workspace.id,
        attemptId: input.attemptId,
        impactId: input.attemptId
      };
    },
    async evaluateBuilderOutput(
      input: EvaluateBuilderOutputInput
    ): Promise<EvaluateBuilderOutputResult> {
      await assertRunAcceptsMutations(input.runId);
      const context = await recoverTaskContext(input.runId, input.taskId, input.builderAttemptId);
      if (
        context.task === undefined ||
        context.workspace === undefined ||
        context.attempt === undefined
      ) {
        throw new Error(`Missing durable evaluation authority: ${input.runId}/${input.taskId}`);
      }
      if (context.attempt.id !== input.builderAttemptId) {
        throw new Error(
          `Builder attempt mismatch: ${input.runId}/${input.taskId}/${input.builderAttemptId}`
        );
      }
      await writeGuardForRun(input.runId);
      const result = await evaluation.evaluate({
        runId: input.runId,
        task: context.task,
        builderAttempt: context.attempt,
        workspace: context.workspace,
        impact:
          context.recoveredRun?.impacts.find((impact) => impact.taskId === input.taskId)?.impact ??
          (() => {
            throw new Error(`Missing persisted builder impact: ${input.runId}/${input.taskId}`);
          })(),
        verificationPolicyFingerprint,
        repository: { files: repository.graph.files, symbols: repository.graph.symbols }
      });
      const recoveredReviews = await persistence.recoverReviews(input.runId);
      const reviewRecord = recoveredReviews
        .toReversed()
        .find((record) => record.taskId === input.taskId);
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
      await assertRunAcceptsMutations(input.runId);
      const review = await recoverReviewById(input.runId, input.taskId, input.reviewId);
      const context = await recoverTaskContext(
        input.runId,
        input.taskId,
        review.subject?.builderAttemptId
      );
      if (
        context.binding === undefined ||
        context.task === undefined ||
        context.workspace === undefined ||
        context.attempt === undefined ||
        review.subject === undefined
      ) {
        throw new Error(
          `Missing durable repair admission authority: ${input.runId}/${input.taskId}`
        );
      }
      const binding = context.binding;
      const builderAttempt = context.attempt;
      const reviewSubject = review.subject;
      const repair = await repairCoordinator.prepare({
        runId: input.runId,
        taskId: input.taskId,
        agentId: binding.agentId,
        workspaceId: context.workspace.id,
        reviewIteration: review.iteration,
        review: review.review,
        subject: reviewSubject,
        createWorkItem: (attempt) => ({
          runId: attempt.runId,
          taskId: attempt.taskId,
          repairAttemptId: attempt.id,
          builderAttemptId: builderAttempt.id,
          workspaceId: attempt.workspaceId,
          leasePlanFingerprint: taskLeasePlanFingerprint(binding.leasePlan),
          impactFingerprint: reviewSubject.impactFingerprint,
          parentReviewIteration: attempt.parentReviewIteration,
          reviewIteration: review.iteration + 1,
          verificationPolicyFingerprint,
          codeReviewPolicyFingerprint: reviewPolicyFingerprint
        })
      });
      return {
        runId: input.runId,
        taskId: input.taskId,
        repairAttemptId: repair.id
      };
    },
    async executeRepair(input: ExecuteRepairInput): Promise<ExecuteRepairResult> {
      await assertRunAcceptsMutations(input.runId);
      const repairAttempts = await persistence.recoverRepairAttempts(input.runId);
      const admittedRepair = repairAttempts.find(
        (attempt) => attempt.attempt.id === input.repairAttemptId
      )?.attempt;
      if (admittedRepair === undefined) {
        throw new Error(`Repair attempt not admitted: ${input.repairAttemptId}`);
      }
      const review = await recoverReviewById(input.runId, input.taskId, input.reviewId);
      const context = await recoverTaskContext(input.runId, input.taskId, input.builderAttemptId);
      if (
        context.binding === undefined ||
        context.task === undefined ||
        context.workspace === undefined ||
        context.attempt === undefined ||
        review.subject === undefined
      ) {
        throw new Error(
          `Missing durable repair execution authority: ${input.runId}/${input.taskId}`
        );
      }
      if (context.attempt.id !== input.builderAttemptId) {
        throw new Error(
          `Builder attempt authority mismatch: ${input.runId}/${input.taskId}/${input.builderAttemptId}`
        );
      }
      if (
        admittedRepair.state !== 'PREPARING' ||
        admittedRepair.runId !== input.runId ||
        admittedRepair.taskId !== input.taskId ||
        admittedRepair.workspaceId !== context.workspace.id ||
        admittedRepair.parentReviewIteration !== review.iteration ||
        admittedRepair.parentReviewSubject.builderAttemptId !== review.subject.builderAttemptId ||
        admittedRepair.parentReviewSubject.outputAttemptId !== review.subject.outputAttemptId ||
        admittedRepair.parentReviewSubject.workspaceId !== review.subject.workspaceId
      ) {
        throw new Error(`Repair attempt lineage mismatch: ${input.repairAttemptId}`);
      }
      // Lease state is durable and may have changed since a previous wake.
      // Refresh before executing so an old ACTIVE lease cannot re-block a
      // repair that SQLite has already authorized to resume.
      await writeGuardForRun(input.runId, true);
      const claimedRepair = await persistence.claimRepairStart({
        runId: input.runId,
        attempt: {
          ...admittedRepair,
          state: 'STARTING',
          revision: admittedRepair.revision + 1,
          startedAt: new Date()
        }
      });
      const result = await repairExecution.execute({
        runId: input.runId,
        agentId: context.binding.agentId,
        builderAttempt: context.attempt,
        task: context.task,
        workspace: context.workspace,
        impact:
          context.recoveredRun?.impacts.find((impact) => impact.taskId === input.taskId)?.impact ??
          (() => {
            throw new Error(`Missing persisted repair impact: ${input.runId}/${input.taskId}`);
          })(),
        leases: (context.recoveredRun?.leases ?? [])
          .map(({ lease }) => lease)
          .filter((lease) => lease.taskId === input.taskId),
        verificationPolicyFingerprint,
        repository: { files: repository.graph.files, symbols: repository.graph.symbols },
        reviewIteration: review.iteration,
        review: review.review,
        subject: review.subject,
        maxRepairs: 2,
        preCreatedRepairAttempt: claimedRepair,
        cancellationSignal: currentActivityCancellationSignal()
      });
      if (result.state !== 'completed') {
        if (result.state !== 'blocked') {
          await progression.advance(input.runId, {
            type: 'task-failed',
            taskId: input.taskId,
            state: 'FAILED'
          });
        }
        return {
          runId: input.runId,
          taskId: input.taskId,
          state: result.state,
          repairAttemptId: result.attempt.id,
          blockerLeaseId: result.state === 'blocked' ? result.blockerLeaseId : undefined,
          detail: result.state === 'unknown' ? result.detail : undefined
        };
      }
      const persistedRepairReview = await progression.recoverCompletedRepairReview({
        runId: input.runId,
        taskId: input.taskId,
        parentReviewIteration: review.iteration,
        subject: result.reviewSubject,
        review: result.review
      });
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
        reviewId: `${input.taskId}:${persistedRepairReview.iteration}`
      };
    },
    async integrateAcceptedOutput(
      input: IntegrateAcceptedOutputInput
    ): Promise<IntegrateAcceptedOutputResult> {
      await assertRunAcceptsMutations(input.runId);
      const context = await recoverTaskContext(input.runId, input.taskId);
      if (context.task === undefined || context.workspace === undefined) {
        throw new Error(`Missing durable integration authority: ${input.runId}/${input.taskId}`);
      }
      const recoveredReviews = await persistence.recoverReviews(input.runId);
      const acceptedReview = recoveredReviews.find(
        (candidate) =>
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
      const integrationClaim = {
        runId: input.runId,
        taskId: input.taskId,
        workspaceId: acceptedSubject.workspaceId,
        outputAttemptId: acceptedSubject.outputAttemptId
      };
      await persistence.claimIntegrationStart(integrationClaim);
      const result = await integration.integrate({
        runId: input.runId,
        taskId: input.taskId,
        workspace: context.workspace,
        subject: acceptedSubject,
        task: context.task
      });
      await persistence.releaseIntegrationClaim(integrationClaim);
      if (result.status === 'integrated') {
        await progression.advance(input.runId, {
          type: 'verification-completed',
          taskId: input.taskId,
          state: 'INTEGRATING'
        });
        await progression.advance(input.runId, {
          type: 'workspace-integrated',
          taskId: input.taskId,
          state: 'COMPLETED'
        });
      }
      // A blocked integration is recoverable/non-terminal: the workspace stays in
      // INTEGRATION_BLOCKED and the task is not marked FAILED.
      return { runId: input.runId, taskId: input.taskId, status: result.status };
    },
    async finalizeRunState(input: FinalizeRunStateInput): Promise<FinalizeRunStateResult> {
      const status = await finalization.finalize(input.runId);
      return { runId: input.runId, status };
    },
    async finalizeRunCancellation(
      input: FinalizeRunCancellationInput
    ): Promise<FinalizeRunCancellationResult> {
      const recovered = await persistence.recoverRun(input.runId);
      if (recovered === undefined) {
        throw new Error(`Run not found: ${input.runId}`);
      }
      if (recovered.run.state !== 'CANCEL_REQUESTED') {
        throw new Error(
          `Cancellation was not requested for run: ${input.runId} (${recovered.run.state})`
        );
      }
      if (recovered.leases.some(({ lease }) => lease.state === 'ACTIVE')) {
        return { runId: input.runId, status: 'pending' };
      }
      if (await persistence.hasActiveIntegrationClaim(input.runId)) {
        return { runId: input.runId, status: 'pending' };
      }
      const repairAttempts = await persistence.recoverRepairAttempts(input.runId);
      const liveBuilder = recovered.attempts.find(
        ({ attempt }) =>
          attempt.state === 'STARTING' || attempt.state === 'RUNNING' || attempt.state === 'UNKNOWN'
      );
      if (liveBuilder !== undefined) {
        return { runId: input.runId, status: 'pending' };
      }
      const liveRepair = repairAttempts.find(
        ({ attempt }) =>
          attempt.state === 'STARTING' || attempt.state === 'RUNNING' || attempt.state === 'UNKNOWN'
      );
      if (liveRepair !== undefined) {
        return { runId: input.runId, status: 'pending' };
      }
      const cancellationFinalization = await persistence.finalizeCancellation(input.runId);
      if (cancellationFinalization.status !== 'cancelled') {
        throw new Error(
          `Cancellation finalization lost authority for run: ${input.runId} (${cancellationFinalization.state})`
        );
      }
      return { runId: input.runId, status: 'cancelled' };
    },
    async resumeBlockedRepair(input: ResumeBlockedRepairInput): Promise<ResumeBlockedRepairResult> {
      await assertRunAcceptsMutations(input.runId);
      const repairAttempts = await persistence.recoverRepairAttempts(input.runId);
      const repairRecord = repairAttempts.find(
        (record) => record.attempt.id === input.repairAttemptId
      );
      if (repairRecord === undefined) {
        return {
          runId: input.runId,
          repairAttemptId: input.repairAttemptId,
          status: 'ignored',
          detail: 'not-found'
        };
      }
      // A wake is only a hint. Reconcile the cached guard with durable leases
      // before testing or issuing continuation authority.
      await writeGuardForRun(input.runId, true);
      const repair = repairRecord.attempt;
      const priorDispatches = await persistence.recoverRepairResumeDispatches(input.runId);
      const priorDispatch = priorDispatches.find(
        (dispatch) =>
          dispatch.repairAttemptId === repair.id && dispatch.repairRevision === repair.revision
      );
      if (repair.state === 'PREPARING' && priorDispatch !== undefined) {
        return {
          runId: input.runId,
          repairAttemptId: repair.id,
          status: 'resumed',
          taskId: repair.taskId
        };
      }
      if (repair.state !== 'BLOCKED' || repair.blocker?.type !== 'lease') {
        return {
          runId: input.runId,
          repairAttemptId: input.repairAttemptId,
          status: 'ignored',
          detail: 'not-blocked'
        };
      }
      const workItems = await persistence.recoverRepairWorkItems(input.runId);
      const workItem = workItems.find((item) => item.repairAttemptId === repair.id);
      const binding = await persistence.recoverTaskBinding(input.runId, repair.taskId);
      const recoveredRun = await persistence.recoverRun(input.runId);
      const builderAttempt = recoveredRun?.attempts.find(
        (record) => record.attempt.id === workItem?.builderAttemptId
      )?.attempt;
      const persistedReviews = await persistence.recoverReviews(input.runId);
      const parentReview = persistedReviews.find(
        (review) =>
          review.taskId === repair.taskId && review.iteration === repair.parentReviewIteration
      );
      if (
        workItem === undefined ||
        binding === undefined ||
        recoveredRun === undefined ||
        builderAttempt === undefined ||
        parentReview?.subject === undefined ||
        builderAttempt.runId !== input.runId ||
        builderAttempt.taskId !== repair.taskId ||
        builderAttempt.workspaceId !== workItem.workspaceId ||
        builderAttempt.state !== 'COMPLETED' ||
        builderAttempt.id !== workItem.builderAttemptId ||
        binding.workspace.id !== workItem.workspaceId ||
        repair.agentId !== binding.agentId ||
        repair.workspaceId !== workItem.workspaceId ||
        taskLeasePlanFingerprint(binding.leasePlan) !== workItem.leasePlanFingerprint ||
        workItem.runId !== repair.runId ||
        workItem.taskId !== repair.taskId ||
        workItem.repairAttemptId !== repair.id ||
        workItem.verificationPolicyFingerprint !==
          recoveredRun.run.authority.verificationPolicyFingerprint ||
        workItem.codeReviewPolicyFingerprint !==
          recoveredRun.run.authority.codeReviewPolicyFingerprint ||
        repair.parentReviewIteration !== workItem.parentReviewIteration ||
        workItem.reviewIteration !== repair.parentReviewIteration + 1 ||
        workItem.impactFingerprint !== parentReview.subject.impactFingerprint ||
        parentReview.review.recommendation !== 'repair' ||
        parentReview.subject.builderAttemptId !== repair.parentReviewSubject.builderAttemptId ||
        parentReview.subject.outputAttemptId !== repair.parentReviewSubject.outputAttemptId ||
        parentReview.subject.workspaceId !== repair.parentReviewSubject.workspaceId ||
        parentReview.subject.impactFingerprint !== repair.parentReviewSubject.impactFingerprint ||
        parentReview.subject.workspaceRevision !== repair.parentReviewSubject.workspaceRevision ||
        parentReview.subject.workspaceChangeFingerprint !==
          repair.parentReviewSubject.workspaceChangeFingerprint ||
        parentReview.subject.verificationFingerprint !==
          repair.parentReviewSubject.verificationFingerprint
      ) {
        throw new Error(`Blocked repair continuation evidence mismatch: ${repair.id}`);
      }
      const dispatchId = `resume:${repair.id}:${repair.revision + 1}`;
      const authorizedAt = new Date().toISOString();
      const resumed = await repairCoordinator.tryResume(repair, {
        dispatch: {
          taskId: repair.taskId,
          dispatchId,
          authorizedAt
        }
      });
      if (resumed === undefined) {
        const recoveredAttempts = await persistence.recoverRepairAttempts(input.runId);
        const winner = recoveredAttempts.find((record) => record.attempt.id === repair.id)?.attempt;
        const winnerDispatches = await persistence.recoverRepairResumeDispatches(input.runId);
        const winnerDispatch = winnerDispatches.find(
          (dispatch) =>
            dispatch.repairAttemptId === repair.id && dispatch.repairRevision === winner?.revision
        );
        if (winner?.state === 'PREPARING' && winnerDispatch !== undefined) {
          return {
            runId: input.runId,
            repairAttemptId: winner.id,
            status: 'resumed',
            taskId: winner.taskId
          };
        }
        return {
          runId: input.runId,
          repairAttemptId: input.repairAttemptId,
          status: 'ignored',
          detail: 'resume-failed'
        };
      }
      return {
        runId: input.runId,
        repairAttemptId: resumed.id,
        status: 'resumed',
        taskId: resumed.taskId
      };
    }
  };

  return {
    forgeActivities,
    async close() {
      void persistence.close?.();
    }
  };
}
