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
  TaskContract,
  TaskImpact,
  TaskVerifier,
  TaskWorkspace,
  TaskVerificationEvidence,
} from '@ai-native-software-delivery-orchestrator/domain';
import { DrizzleSqliteOrchestrationPersistence } from '@ai-native-software-delivery-orchestrator/persistence';
import { analyzeRepository } from '@ai-native-software-delivery-orchestrator/repository-analysis';
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
  dockerImage: 'ghcr.io/ai-native-software-delivery-orchestrator/forge-worker:latest'
} as const;

const createVerificationEvidence = (request: {
  readonly id: string;
  readonly attempt: AgentExecutionAttempt;
  readonly workspace: TaskWorkspace;
  readonly snapshot: Awaited<ReturnType<GitRepositorySnapshotProvider['capture']>>;
  readonly verificationPolicyFingerprint: string;
  readonly verifiedAt: Date;
}): TaskVerificationEvidence => new TaskVerificationEvidenceFactory().create(request);

const createStubTaskVerifier = (): TaskVerifier => ({
  async verify() {
    return { status: 'passed' as const };
  }
});

const buildBootstrapTask = (repositoryTaskId: string): TaskContract => ({
  id: repositoryTaskId,
  title: 'Forge worker bootstrap',
  goal: 'Resolve and execute Scenario A through durable worker services.',
  dependencies: [],
  expectedReads: [],
  expectedWrites: [],
  sharedResources: [],
  verification: []
});

const createReadyWorkspace = (request: {
  readonly id: string;
  readonly runId: string;
  readonly taskId: string;
}): TaskWorkspace => ({
  id: request.id,
  runId: request.runId,
  taskId: request.taskId,
  integrationRepositoryPath: WORKER_REPOSITORY_PATH,
  workspacePath: WORKER_REPOSITORY_PATH,
  branchName: 'main',
  baseRef: 'main',
  integrationRef: 'forge',
  revision: 1,
  phase: 'READY_TO_INTEGRATE'
});

const createIntegratedWorkspace = (request: {
  readonly id: string;
  readonly runId: string;
  readonly taskId: string;
}): TaskWorkspace => ({
  ...createReadyWorkspace(request),
  revision: 2,
  phase: 'INTEGRATED',
  integrationCommit: `${request.taskId}-integrated-commit`
});

const createSyntheticImpact = (taskId: string): TaskImpact => ({
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
    createEvidenceId: randomUUID,
    repairs: repairCoordinator
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
      verifier: createStubTaskVerifier(),
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

  const bootstrapTask = buildBootstrapTask(repository.graph.projects.values().next().value?.id ?? 'task-1');

  const forgeActivities: ForgeActivities = {
    async reevaluateRun(input: ReevaluateRunInput): Promise<ReevaluateRunResult> {
      const recovered = await persistence.recoverRun(input.runId);
      if (recovered === undefined) {
        return { runId: input.runId, authorizedTasks: [] };
      }
      const bindings = await persistence.recoverTaskBindings(input.runId);
      return {
        runId: input.runId,
        authorizedTasks: bindings.map((binding) => ({
          taskId: binding.taskId,
          attemptId: binding.taskId
        }))
      };
    },
    async executeBuilder(input: ExecuteBuilderInput): Promise<ExecuteBuilderResult> {
      await builderExecution.execute({
        runId: input.runId,
        task: bootstrapTask,
        binding: {
          taskId: input.taskId,
          agentId: `${input.taskId}-agent`,
          leasePlan: { taskId: input.taskId, predictedResources: [], source: 'manual' },
          workspace: createReadyWorkspace({
            id: `${input.taskId}-workspace`,
            runId: input.runId,
            taskId: input.taskId
          })
        },
        attempt: {
          id: input.attemptId,
          runId: input.runId,
          taskId: input.taskId,
          agentId: `${input.taskId}-agent`,
          workspaceId: `${input.taskId}-workspace`,
          leasePlanFingerprint: `lease:${input.taskId}`,
          state: 'PREPARING',
          revision: 1,
          startedAt: new Date()
        }
      });
      return {
        runId: input.runId,
        taskId: input.taskId,
        workspaceId: `${input.taskId}-workspace`,
        attemptId: input.attemptId,
        impactId: `${input.taskId}-impact`
      };
    },
    async evaluateBuilderOutput(input: EvaluateBuilderOutputInput): Promise<EvaluateBuilderOutputResult> {
      const workspace = createReadyWorkspace({
        id: input.workspaceId,
        runId: input.runId,
        taskId: input.taskId
      });
      const builderAttempt: AgentExecutionAttempt = {
        id: input.builderAttemptId,
        runId: input.runId,
        taskId: input.taskId,
        agentId: `${input.taskId}-agent`,
        workspaceId: input.workspaceId,
        leasePlanFingerprint: `lease:${input.taskId}`,
        state: 'COMPLETED',
        revision: 2,
        startedAt: new Date(),
        completedAt: new Date()
      };
      const result = await evaluation.evaluate({
        runId: input.runId,
        task: bootstrapTask,
        builderAttempt,
        workspace,
        impact: createSyntheticImpact(input.taskId),
        verificationPolicyFingerprint: `verification:${verificationPolicy.version}`,
        repository: { files: repository.graph.files, symbols: repository.graph.symbols }
      });
      return {
        runId: input.runId,
        taskId: input.taskId,
        recommendation: result.recommendation,
        verificationId: result.verification.id,
        subjectRef: {
          builderAttemptId: result.subject.builderAttemptId,
          outputAttemptId: result.subject.outputAttemptId,
          workspaceId: result.subject.workspaceId
        },
        reviewId: `${input.taskId}-review`
      };
    },
    async admitRepair(input: AdmitRepairInput): Promise<AdmitRepairResult> {
      const repair = await repairCoordinator.prepare({
        runId: input.runId,
        taskId: input.taskId,
        agentId: `${input.taskId}-agent`,
        workspaceId: input.subjectRef.workspaceId,
        reviewIteration: 1,
        review: {
          recommendation: 'repair',
          summary: `Repair required for ${input.taskId}`,
          findings: []
        },
        subject: {
          builderAttemptId: input.subjectRef.builderAttemptId,
          outputAttemptId: input.subjectRef.outputAttemptId,
          workspaceId: input.subjectRef.workspaceId,
          workspaceRevision: 1,
          workspaceChangeFingerprint: `lease:${input.taskId}`,
          impactFingerprint: `impact:${input.taskId}`,
          verificationFingerprint: `verification:${verificationPolicy.version}`
        }
      });
      const prepared = await repairCoordinator.markStarting(repair);
      return {
        runId: input.runId,
        taskId: input.taskId,
        repairAttemptId: prepared.id
      };
    },
    async executeRepair(input: ExecuteRepairInput): Promise<ExecuteRepairResult> {
      const repair = await repairCoordinator.prepare({
        runId: input.runId,
        taskId: input.taskId,
        agentId: `${input.taskId}-agent`,
        workspaceId: input.workspaceId,
        reviewIteration: 1,
        review: {
          recommendation: 'repair',
          summary: `Repair required for ${input.taskId}`,
          findings: []
        },
        subject: {
          builderAttemptId: input.builderAttemptId,
          outputAttemptId: input.reviewId,
          workspaceId: input.workspaceId,
          workspaceRevision: 1,
          workspaceChangeFingerprint: `lease:${input.taskId}`,
          impactFingerprint: `impact:${input.taskId}`,
          verificationFingerprint: `verification:${verificationPolicy.version}`
        }
      });
      const workspace = createReadyWorkspace({
        id: input.workspaceId,
        runId: input.runId,
        taskId: input.taskId
      });
      const result = await repairExecution.execute({
        runId: input.runId,
        agentId: `${input.taskId}-agent`,
        builderAttempt: {
          id: input.builderAttemptId,
          runId: input.runId,
          taskId: input.taskId,
          agentId: `${input.taskId}-agent`,
          workspaceId: input.workspaceId,
          leasePlanFingerprint: `lease:${input.taskId}`,
          state: 'COMPLETED',
          revision: 2,
          startedAt: new Date(),
          completedAt: new Date()
        },
        task: bootstrapTask,
        workspace,
        impact: {
          predicted: createSyntheticImpact(input.taskId).predicted
        },
        leases: [],
        verificationPolicyFingerprint: `verification:${verificationPolicy.version}`,
        repository: { files: repository.graph.files, symbols: repository.graph.symbols },
        reviewIteration: 1,
        review: {
          recommendation: 'repair',
          summary: `Repair required for ${input.taskId}`,
          findings: []
        },
        subject: {
          builderAttemptId: input.builderAttemptId,
          outputAttemptId: input.reviewId,
          workspaceId: input.workspaceId,
          workspaceRevision: 1,
          workspaceChangeFingerprint: `lease:${input.taskId}`,
          impactFingerprint: `impact:${input.taskId}`,
          verificationFingerprint: `verification:${verificationPolicy.version}`
        },
        maxRepairs: 2,
        preCreatedRepairAttempt: repair
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
      const repairReview = await reviews.collect({
        runId: input.runId,
        task: bootstrapTask,
        workspace,
        impact: createSyntheticImpact(input.taskId),
        builderAttempt: {
          id: input.builderAttemptId,
          runId: input.runId,
          taskId: input.taskId,
          agentId: `${input.taskId}-agent`,
          workspaceId: input.workspaceId,
          leasePlanFingerprint: `lease:${input.taskId}`,
          state: 'COMPLETED',
          revision: 2,
          startedAt: new Date(),
          completedAt: new Date()
        },
        subject: result.reviewSubject,
        repository: { files: repository.graph.files, symbols: repository.graph.symbols },
        iteration: 1
      });
      return {
        runId: input.runId,
        taskId: input.taskId,
        state: 'completed',
        repairAttemptId: result.attempt.id,
        recommendation: result.recommendation,
        verificationId: result.verification.id,
        subjectRef: {
          builderAttemptId: result.reviewSubject.builderAttemptId,
          outputAttemptId: result.reviewSubject.outputAttemptId,
          workspaceId: result.reviewSubject.workspaceId
        },
        reviewId: `${input.taskId}-repair-review-${repairReview.recommendation}`
      };
    },
    async integrateAcceptedOutput(input: IntegrateAcceptedOutputInput): Promise<IntegrateAcceptedOutputResult> {
      const workspace = createIntegratedWorkspace({
        id: input.workspaceId,
        runId: input.runId,
        taskId: input.taskId
      });
      await integration.integrate({
        runId: input.runId,
        taskId: input.taskId,
        workspace,
        subject: {
          builderAttemptId: input.subjectRef.builderAttemptId,
          outputAttemptId: input.subjectRef.outputAttemptId,
          workspaceId: input.subjectRef.workspaceId,
          workspaceRevision: 1,
          workspaceChangeFingerprint: `lease:${input.taskId}`,
          impactFingerprint: `impact:${input.taskId}`,
          verificationFingerprint: `verification:${verificationPolicy.version}`
        },
        task: bootstrapTask
      });
      return { runId: input.runId, taskId: input.taskId, status: 'integrated' };
    },
    async finalizeRunState(input: FinalizeRunStateInput): Promise<FinalizeRunStateResult> {
      const recovered = await persistence.recoverRun(input.runId);
      const status = recovered?.run.state === 'FAILED' ? 'failed' : 'completed';
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
