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
  TaskWorkspace,
  TaskVerificationEvidence,
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
  ReevaluateRunResult,
} from '@ai-native-software-delivery-orchestrator/temporal-runtime';
import { SandboxedPackageScriptVerifier } from '../../../libs/run-preparation/src/lib/local-runtime-starter.js';
import { agentCommandPolicyFingerprint } from '@ai-native-software-delivery-orchestrator/domain';
import { taskLeasePlanFingerprint } from '@ai-native-software-delivery-orchestrator/domain';
import { ForgeRunFinalizationService } from '../../../libs/orchestration-runtime/src/lib/forge-run-finalization-service.js';
import { ForgeRunReevaluationService } from '../../../libs/orchestration-runtime/src/lib/forge-run-reevaluation-service.js';

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

  const reevaluation = new ForgeRunReevaluationService({ persistence });
  const finalization = new ForgeRunFinalizationService({ persistence });

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

  const recoverReviewById = async (runId: string, taskId: string, reviewId: string) => {
    const reviews = await persistence.recoverReviews(runId);
    const iterationRaw = reviewId.includes(':') ? reviewId.split(':').at(-1) : reviewId;
    const iteration = Number(iterationRaw);
    if (!Number.isInteger(iteration) || iteration < 1) {
      throw new Error(`Invalid review reference: ${reviewId}`);
    }
    const review = reviews.find((candidate) => candidate.taskId === taskId && candidate.iteration === iteration);
    if (review === undefined) {
      throw new Error(`Missing persisted review authority: ${runId}/${reviewId}`);
    }
    return review;
  };

  const assertBuilderTuple = (
    binding: NonNullable<Awaited<ReturnType<typeof persistence.recoverTaskBinding>>>,
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

  const forgeActivities: ForgeActivities = {
    async reevaluateRun(input: ReevaluateRunInput): Promise<ReevaluateRunResult> {
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
      const context = await recoverTaskContext(input.runId, input.taskId, input.attemptId);
      if (context.binding === undefined || context.task === undefined || context.attempt === undefined) {
        throw new Error(`Missing durable builder authority: ${input.runId}/${input.taskId}`);
      }
      if (context.attempt.id !== input.attemptId || context.attempt.state !== 'PREPARING') {
        throw new Error(`Builder attempt authority mismatch: ${input.runId}/${input.taskId}/${input.attemptId}`);
      }
      assertBuilderTuple(context.binding, context.attempt);
      await builderExecution.execute({
        runId: input.runId,
        task: context.task,
        binding: context.binding,
        attempt: context.attempt
      });
      const refreshed = await persistence.recoverRun(input.runId);
      if (refreshed === undefined) {
        throw new Error(`Missing persisted builder outputs: ${input.runId}/${input.taskId}`);
      }
      const impact = refreshed.impacts.find((impact) => impact.taskId === input.taskId)?.impact;
      const workspace = refreshed.workspaces.find((entry) => entry.workspace.taskId === input.taskId)?.workspace;
      if (workspace === undefined || impact === undefined) {
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
        impact:
          context.recoveredRun?.impacts.find((impact) => impact.taskId === input.taskId)?.impact ??
          (() => {
            throw new Error(`Missing persisted builder impact: ${input.runId}/${input.taskId}`);
          })(),
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
        reviewId: String(reviewRecord.iteration)
      };
    },
    async admitRepair(input: AdmitRepairInput): Promise<AdmitRepairResult> {
      const review = await recoverReviewById(input.runId, input.taskId, input.reviewId);
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
      const review = await recoverReviewById(input.runId, input.taskId, input.reviewId);
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
        impact:
          context.recoveredRun?.impacts.find((impact) => impact.taskId === input.taskId)?.impact ??
          (() => {
            throw new Error(`Missing persisted repair impact: ${input.runId}/${input.taskId}`);
          })(),
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
        reviewId: String(review.iteration)
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
      const status = await finalization.finalize(input.runId);
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
