import { randomUUID } from 'node:crypto';

import {
  AgentToolRuntime,
  type TaskCodeReviewTools
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
  fingerprintPlanValue,
  type CodeReviewPolicy
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
  BlockedIntegrationContinuationActivities,
  IntegrateAcceptedOutputInput,
  IntegrateAcceptedOutputResult,
  ReevaluateRunInput,
  ReevaluateRunResult,
  ResumeBlockedRepairInput,
  ResumeBlockedRepairResult,
  ResumeBlockedIntegrationInput,
  ResumeBlockedIntegrationResult
} from '@ai-native-software-delivery-orchestrator/forge-runtime-contracts';
import { SandboxedPackageScriptVerifier } from '@ai-native-software-delivery-orchestrator/run-preparation';
import { agentCommandPolicyFingerprint } from '@ai-native-software-delivery-orchestrator/domain';
import { taskLeasePlanFingerprint } from '@ai-native-software-delivery-orchestrator/domain';
import {
  ForgeRunFinalizationService,
  ForgeRunProgressionService,
  ForgeRunReevaluationService
} from '@ai-native-software-delivery-orchestrator/orchestration-runtime';

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

const createVerificationEvidence = (request: {
  readonly id: string;
  readonly attempt: AgentExecutionAttempt;
  readonly workspace: TaskWorkspace;
  readonly snapshot: Awaited<ReturnType<GitRepositorySnapshotProvider['capture']>>;
  readonly verificationPolicyFingerprint: string;
  readonly verifiedAt: Date;
}): TaskVerificationEvidence => new TaskVerificationEvidenceFactory().create(request);

export interface ForgeRuntimeComposition {
  readonly forgeActivities: ForgeActivities & BlockedIntegrationContinuationActivities;
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
 * Test-only injection seams. Production callers provide explicit deployment inputs. Adapter
 * seams keep the production Forge services in place while substituting
 * external Git, agent, verification, and model effects. Whole-service seams remain for
 * focused activity tests that isolate a single worker boundary.
 */
export interface ForgeRuntimeCompositionOverrides {
  readonly persistence?: ForgeWorkerPersistence;
  readonly workspaceManager?: WorkspaceManager;
  readonly snapshots?: RepositorySnapshotProvider;
  readonly reviewer?: TaskCodeReviewer;
  /**
   * Application-owned adapter factory. It receives only durable review authority and
   * read-only task tools; provider/model selection remains outside this composition.
   */
  readonly reviewerFactory?: (input: {
    readonly policy: CodeReviewPolicy;
    readonly createTools: (
      request: Parameters<TaskCodeReviewer['review']>[0]
    ) => TaskCodeReviewTools;
  }) => TaskCodeReviewer;
  /** Explicit provider-neutral review authority selected by the application boundary. */
  readonly codeReviewPolicy?: CodeReviewPolicy;
  readonly verifier?: TaskVerifier;
  readonly builderAgentRunner?: AgentRunner;
  /** Application-owned factory shared by builder and repair coding execution. */
  readonly agentRunnerFactory?: (input: {
    readonly createTools: (request: Parameters<AgentRunner['run']>[0]) => AgentToolRuntime;
  }) => AgentRunner;
  readonly repairRunner?: TaskRepairRunner;
  readonly reconciler?: TaskImpactReconciler;
  readonly builderExecution?: Pick<ForgeBuilderExecutionService, 'execute'>;
  readonly evaluation?: Pick<ForgeBuilderOutputEvaluationService, 'evaluate'>;
  readonly repairExecution?: Pick<ForgeRepairExecutionService, 'execute'>;
  readonly integration?: Pick<ForgeAcceptedOutputIntegrationService, 'integrate'>;
  readonly repositoryGraph?: Awaited<ReturnType<typeof analyzeRepository>>['graph'];
  readonly onWriteGuardHydrated?: (
    runId: string,
    leases: readonly PersistedWriteLease['lease'][],
    guard: InMemoryWriteGuard
  ) => void;
}

export interface ActivityExecutionContext {
  readonly cancellationSignal?: AbortSignal;
}

export interface ForgeRuntimeCompositionOptions {
  readonly getActivityExecutionContext?: () => ActivityExecutionContext | undefined;
  readonly databasePath?: string;
  readonly repositoryPath?: string;
}

export async function createForgeRuntimeComposition(
  overrides: ForgeRuntimeCompositionOverrides = {},
  options: ForgeRuntimeCompositionOptions = {}
): Promise<ForgeRuntimeComposition> {
  const activeCodeReviewPolicy = overrides.codeReviewPolicy;
  if (activeCodeReviewPolicy === undefined) {
    throw new Error('Forge runtime composition requires an explicit code review policy');
  }
  const activeReviewPolicyFingerprint = codeReviewPolicyFingerprint(activeCodeReviewPolicy);
  const currentActivityCancellationSignal = () =>
    options.getActivityExecutionContext?.()?.cancellationSignal;
  const repository = await (overrides.repositoryGraph === undefined
    ? (() => {
        if (options.repositoryPath === undefined) {
          throw new Error('Forge runtime composition requires an explicit repository path');
        }
        return analyzeRepository(options.repositoryPath);
      })()
    : { graph: overrides.repositoryGraph });
  const persistence =
    overrides.persistence ??
    (() => {
      if (options.databasePath === undefined) {
        throw new Error('Forge runtime composition requires an explicit database path');
      }
      return new DrizzleSqliteOrchestrationPersistence(options.databasePath);
    })();
  const writeGuards = new Map<string, InMemoryWriteGuard>();
  const writeGuardHydrations = new Map<string, Promise<InMemoryWriteGuard>>();
  const writeGuardForRunSync = (runId: string): InMemoryWriteGuard => {
    const existing = writeGuards.get(runId);
    if (existing !== undefined) {
      return existing;
    }
    const guard = new InMemoryWriteGuard();
    writeGuards.set(runId, guard);
    writeGuardHydrations.set(runId, Promise.resolve(guard));
    return guard;
  };
  const writeGuardForRun = async (runId: string): Promise<InMemoryWriteGuard> => {
    const existing = writeGuards.get(runId);
    if (existing !== undefined) {
      const recovered = await persistence.recoverRun(runId);
      await existing.reconcileDurableLeases(recovered?.leases.map(({ lease }) => lease) ?? []);
      return existing;
    }
    const priorHydration = writeGuardHydrations.get(runId);
    if (priorHydration !== undefined) {
      return priorHydration;
    }
    const hydration = (async () => {
      const recovered = await persistence.recoverRun(runId);
      // Released and stale leases do not block acquisition, but their IDs and versions
      // must survive activity reconstruction so a new lease cannot regress persisted history.
      const recoveredLeases = recovered?.leases.map(({ lease }) => lease) ?? [];
      const guard = new InMemoryWriteGuard({ initialLeases: recoveredLeases });
      overrides.onWriteGuardHydrated?.(runId, recoveredLeases, guard);
      writeGuards.set(runId, guard);
      return guard;
    })();
    writeGuardHydrations.set(runId, hydration);
    return hydration;
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

  const createReviewTools = (request: Parameters<TaskCodeReviewer['review']>[0]) =>
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
    });
  const reviewer =
    overrides.reviewer ??
    overrides.reviewerFactory?.({ policy: activeCodeReviewPolicy, createTools: createReviewTools });
  if (reviewer === undefined) {
    throw new Error('Forge runtime composition requires an explicit task code reviewer');
  }
  const reviewCollector = new TaskCodeReviewCollector({ reviewer, store: persistence });

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

  const createAgentTools = (runId: string) => (request: Parameters<AgentRunner['run']>[0]) =>
    new AgentToolRuntime({
      runId: request.runId,
      taskId: request.taskId,
      attemptId: request.attempt.id,
      agentId: request.attempt.agentId,
      workspacePath: request.workspace.workspacePath,
      resolveResource: (path) => resources.resolve(path),
      resolveFileId: (path) => resources.fileId(path),
      persistence,
      writeGuard: writeGuardForRunSync(runId)
    });
  const createAgentRunner = (runId: string): AgentRunner => {
    if (overrides.agentRunnerFactory === undefined) {
      throw new Error('Forge runtime composition requires an explicit coding agent runner');
    }
    return overrides.agentRunnerFactory({ createTools: createAgentTools(runId) });
  };
  const createBuilderExecution = (runId: string) =>
    new ForgeBuilderExecutionService({
      persistence,
      workspaceManager,
      writeGuard: writeGuardForRunSync(runId),
      agentRunner: overrides.builderAgentRunner ?? createAgentRunner(runId),
      reconciler,
      claimStart: async ({ attempt, leases }) =>
        persistence.claimBuilderStart({ runId, attempt, leases }),
      leaseReleased: async ({ taskId, lease }) => {
        await progression.advance(runId, {
          type: 'lease-released',
          taskId,
          leaseId: lease.id
        });
      },
      scopeExpanded: async (request) => {
        await progression.recordRuntimeScopeExpansion(request);
      }
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
        runner: overrides.repairRunner ?? createAgentRunner(runId),
        reconciler,
        verifier,
        snapshots,
        subjects,
        reviews: reviewCollector,
        verificationEvidence: persistence,
        writeGuard: writeGuardForRunSync(runId),
        persistence,
        feedback: {
          leaseBlocked: async () => undefined,
          scopeExpanded: async (request) => {
            await progression.recordRuntimeScopeExpansion(request);
          }
        },
        createEvidenceId: randomUUID,
        createVerificationEvidence
      })
    });
  const repairExecution = overrides.repairExecution ?? {
    execute: (request: Parameters<ForgeRepairExecutionService['execute']>[0]) =>
      createRepairExecution(request.runId).execute(request)
  };

  const acceptedOutputIntegration = new ForgeAcceptedOutputIntegrationService({
    coordinator: admission,
    workspaceManager,
    persistence
  });
  const integration = overrides.integration ?? acceptedOutputIntegration;

  const recoverTaskContext = async (runId: string, taskId: string, attemptId?: string) => {
    const binding = await persistence.recoverTaskBinding(runId, taskId);
    const recoveredRun = await persistence.recoverRun(runId);
    if (recoveredRun !== undefined) {
      if (
        recoveredRun.run.authority.verificationPolicyFingerprint !==
          verificationPolicyFingerprint ||
        recoveredRun.run.authority.codeReviewPolicyFingerprint !== activeReviewPolicyFingerprint
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

  const forgeActivities: ForgeActivities & BlockedIntegrationContinuationActivities = {
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
      await writeGuardForRun(input.runId);
      let outcome: Awaited<ReturnType<typeof builderExecution.execute>>;
      try {
        outcome = await builderExecution.execute({
          runId: input.runId,
          task: context.task,
          binding: context.binding,
          attempt: context.attempt,
          cancellationSignal: currentActivityCancellationSignal()
        });
      } catch (error) {
        const attempt = (await persistence.recoverAttempts(input.runId)).find(
          (entry) => entry.attempt.id === input.attemptId
        )?.attempt;
        if (attempt?.state === 'UNKNOWN') {
          // Match legacy: unresolved external work retains its task/lease but
          // closes the run to additional mutation authority.
          await persistence.updateRunState(input.runId, 'FAILED');
        }
        throw error;
      }
      if (outcome.status === 'blocked') {
        await progression.advance(input.runId, {
          type: 'lease-blocked',
          taskId: input.taskId,
          leaseId: outcome.blockerLeaseId
        });
        return {
          status: 'blocked',
          runId: input.runId,
          taskId: input.taskId,
          attemptId: input.attemptId,
          blockerLeaseId: outcome.blockerLeaseId
        };
      }
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
        status: 'completed',
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
          codeReviewPolicyFingerprint: activeReviewPolicyFingerprint
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
      // Ensure this composition has hydrated its stable per-run guard before
      // executing a repair that SQLite has authorized to resume.
      await writeGuardForRun(input.runId);
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
        if (result.state !== 'blocked' && result.state !== 'unknown') {
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
      await progression.advance(input.runId, {
        type: 'verification-completed',
        taskId: input.taskId,
        state: 'INTEGRATING'
      });
      if (result.status === 'integrated') {
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
    async resumeBlockedIntegration(
      input: ResumeBlockedIntegrationInput
    ): Promise<ResumeBlockedIntegrationResult> {
      await assertRunAcceptsMutations(input.runId);
      const context = await recoverTaskContext(input.runId, input.taskId);
      if (
        context.task === undefined ||
        context.workspace === undefined ||
        context.workspace.id !== input.workspaceId
      ) {
        return { runId: input.runId, taskId: input.taskId, status: 'ignored', detail: 'not-found' };
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
      if (acceptedReview?.subject === undefined) {
        return {
          runId: input.runId,
          taskId: input.taskId,
          status: 'ignored',
          detail: 'admission-invalid'
        };
      }
      const subject = acceptedReview.subject;
      const integrationClaim = {
        runId: input.runId,
        taskId: input.taskId,
        workspaceId: subject.workspaceId,
        outputAttemptId: subject.outputAttemptId
      };
      if (context.workspace.phase === 'INTEGRATED') {
        return { runId: input.runId, taskId: input.taskId, status: 'integrated' };
      }
      if (context.workspace.phase !== 'INTEGRATION_BLOCKED') {
        return {
          runId: input.runId,
          taskId: input.taskId,
          status: 'ignored',
          detail: 'not-blocked'
        };
      }
      await persistence.claimIntegrationStart(integrationClaim);
      const result = await acceptedOutputIntegration.resume({
        runId: input.runId,
        taskId: input.taskId,
        workspace: context.workspace,
        subject
      });
      await persistence.releaseIntegrationClaim(integrationClaim);
      if (result.status === 'integrated') {
        await progression.advance(input.runId, {
          type: 'workspace-integrated',
          taskId: input.taskId,
          state: 'COMPLETED'
        });
      }
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
      // A wake is only a hint. Ensure this composition has hydrated its stable
      // per-run guard before testing or issuing continuation authority.
      await writeGuardForRun(input.runId);
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
