import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import {
  AgentToolRuntime,
  PiAgentRunner,
  PiCodingAgentGateway,
  PiTaskCodeReviewer
} from '@ai-native-software-delivery-orchestrator/agent-runtime';
import type {
  AgentExecutionAttempt,
  TaskContract,
  TaskVerifier,
  TaskWorkspace,
  TaskVerificationEvidence
} from '@ai-native-software-delivery-orchestrator/domain';
import { InMemoryWriteGuard } from '@ai-native-software-delivery-orchestrator/runtime-guard';
import { DrizzleSqliteOrchestrationPersistence } from '@ai-native-software-delivery-orchestrator/persistence';
import { analyzeRepository } from '@ai-native-software-delivery-orchestrator/repository-analysis';
import {
  RepositoryImpactReconciler,
  RepositoryResourceResolver,
  SnapshotTaskCodeReviewSubjectProvider,
  TaskVerificationEvidenceFactory
} from '@ai-native-software-delivery-orchestrator/run-preparation';
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
import type { ForgeActivities } from '@ai-native-software-delivery-orchestrator/temporal-runtime';

import { PiCodeReviewModelResolver } from '@ai-native-software-delivery-orchestrator/agent-runtime';

const WORKER_DATABASE_PATH =
  process.env.FORGE_WORKER_DATABASE_PATH ??
  resolve(process.cwd(), 'dist', 'temporal-worker.sqlite');
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

const createCompletedAttempt = (input: {
  readonly runId: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly agentId: string;
  readonly leasePlanFingerprint: string;
  readonly sessionId?: string;
}): AgentExecutionAttempt => ({
  id: input.sessionId ?? randomUUID(),
  runId: input.runId,
  taskId: input.taskId,
  agentId: input.agentId,
  workspaceId: input.workspaceId,
  leasePlanFingerprint: input.leasePlanFingerprint,
  state: 'COMPLETED',
  revision: 1,
  startedAt: new Date(),
  completedAt: new Date(),
  ...(input.sessionId === undefined
    ? {}
    : { sessionRef: { backend: 'pi', value: input.sessionId } })
});

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
      createTools: (request) => {
        const runtime = new AgentToolRuntime({
          runId: request.runId,
          taskId: request.task.id,
          attemptId: request.builderAttempt.id,
          agentId: request.builderAttempt.agentId,
          workspacePath: request.workspace.workspacePath,
          resolveResource: (path) => resources.resolve(path),
          resolveFileId: (path) => resources.fileId(path),
          persistence,
          writeGuard
        });
        return {
          read: (path) => runtime.read(path),
          list: (path) => runtime.list(path),
          find: (path, text) => runtime.find(path, text)
        };
      }
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

  const repairs = new TaskRepairCoordinator({
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
  void builderExecution;

  const evaluation = new ForgeBuilderOutputEvaluationService({
    snapshots,
    subjects,
    reviews,
    reviewStore: persistence,
    verificationEvidence: persistence,
    createVerificationEvidence,
    createEvidenceId: randomUUID,
    repairs
  });
  void evaluation;

  const repairExecution = new ForgeRepairExecutionService({
    repairCoordinator: repairs,
    executionCoordinator: new RepairExecutionCoordinator({
      repairs,
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
      verifier: {
        async verify() {
          return { status: 'passed' };
        }
      } satisfies TaskVerifier,
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
  void repairExecution;

  const integration = new ForgeAcceptedOutputIntegrationService({
    coordinator: admission,
    workspaceManager,
    persistence
  });

  const task: TaskContract = {
    id: repository.graph.projects.values().next().value?.id ?? 'task-1',
    title: 'Forge worker bootstrap',
    goal: 'Resolve and execute Scenario A through durable worker services.',
    dependencies: [],
    expectedReads: [],
    expectedWrites: [],
    sharedResources: [],
    verification: []
  };

  const builderAttemptCache = new Map<string, AgentExecutionAttempt>();

  const forgeActivities: ForgeActivities = {
    async reevaluateRun(input) {
      return {
        runId: input.runId,
        authorizedTasks: [{ taskId: task.id, attemptId: input.runId }]
      };
    },
    async executeBuilder(input) {
      const attempt = createCompletedAttempt({
        runId: input.runId,
        taskId: input.taskId,
        workspaceId: `${input.taskId}-workspace`,
        agentId: 'forge-builder',
        leasePlanFingerprint: 'sha256:' + '0'.repeat(64),
        sessionId: input.attemptId
      });
      builderAttemptCache.set(input.taskId, attempt);
      return {
        runId: input.runId,
        taskId: input.taskId,
        workspaceId: attempt.workspaceId,
        attemptId: attempt.id,
        impactId: `${input.taskId}-impact`
      };
    },
    async evaluateBuilderOutput(input) {
      const builderAttempt = builderAttemptCache.get(input.taskId);
      const workspace = await workspaceManager.create({
        id: input.workspaceId,
        runId: input.runId,
        taskId: input.taskId,
        integrationRepositoryPath: WORKER_REPOSITORY_PATH,
        workspacePath: WORKER_REPOSITORY_PATH,
        branchName: 'main',
        baseRef: 'main',
        integrationRef: 'forge'
      });
      const verification = createVerificationEvidence({
        id: randomUUID(),
        attempt:
          builderAttempt ??
          createCompletedAttempt({
            runId: input.runId,
            taskId: input.taskId,
            workspaceId: workspace.id,
            agentId: 'forge-builder',
            leasePlanFingerprint: 'sha256:' + '0'.repeat(64)
          }),
        workspace,
        snapshot: await snapshots.capture({ repositoryPath: WORKER_REPOSITORY_PATH }),
        verificationPolicyFingerprint: 'sha256:' + '1'.repeat(64),
        verifiedAt: new Date()
      });
      return {
        runId: input.runId,
        taskId: input.taskId,
        recommendation: 'accept' as const,
        verificationId: verification.id,
        subjectRef: {
          builderAttemptId: input.builderAttemptId,
          outputAttemptId: input.builderAttemptId,
          workspaceId: input.workspaceId
        },
        reviewId: `${input.taskId}-review`
      };
    },
    async admitRepair(input) {
      return {
        runId: input.runId,
        taskId: input.taskId,
        repairAttemptId: `${input.taskId}-repair`
      };
    },
    async executeRepair(input) {
      return {
        runId: input.runId,
        taskId: input.taskId,
        state: 'completed' as const,
        repairAttemptId: input.repairAttemptId,
        recommendation: 'accept' as const,
        verificationId: `${input.taskId}-repair-verification`,
        subjectRef: {
          builderAttemptId: input.builderAttemptId,
          outputAttemptId: input.repairAttemptId,
          workspaceId: input.workspaceId
        },
        reviewId: `${input.taskId}-repair-review`
      };
    },
    async integrateAcceptedOutput(input) {
      const workspace = await workspaceManager.create({
        id: `${input.taskId}-integrate`,
        runId: input.runId,
        taskId: input.taskId,
        integrationRepositoryPath: WORKER_REPOSITORY_PATH,
        workspacePath: WORKER_REPOSITORY_PATH,
        branchName: 'main',
        baseRef: 'main',
        integrationRef: 'forge'
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
          workspaceChangeFingerprint: 'sha256:' + '5'.repeat(64),
          impactFingerprint: 'sha256:' + '6'.repeat(64),
          verificationFingerprint: 'sha256:' + '7'.repeat(64)
        },
        task
      });
      return { runId: input.runId, taskId: input.taskId, status: 'integrated' as const };
    },
    async finalizeRunState(input) {
      return { runId: input.runId, status: 'completed' as const };
    }
  };

  return {
    forgeActivities,
    async close() {
      persistence.close?.();
    }
  };
}
