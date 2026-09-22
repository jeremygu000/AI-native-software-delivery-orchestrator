import { randomUUID } from 'node:crypto';

import {
  AgentToolRuntime,
  PiAgentRunner,
  PiCodingAgentGateway,
  PiTaskCodeReviewer,
  type CodeReviewModelResolver,
  type PiSessionGateway,
  type PiTaskCodeReviewGateway
} from '@ai-native-software-delivery-orchestrator/agent-runtime';
import type {
  AgentCommandSandbox,
  RepositoryGraph
} from '@ai-native-software-delivery-orchestrator/domain';
import { OrchestrationRuntime } from '@ai-native-software-delivery-orchestrator/orchestration-runtime/legacy';
import {
  RepairExecutionCoordinator,
  TaskCodeReviewCollector,
  TaskOutputAdmissionCoordinator,
  TaskRepairCoordinator
} from '@ai-native-software-delivery-orchestrator/orchestration-runtime';
import { DrizzleSqliteOrchestrationPersistence } from '@ai-native-software-delivery-orchestrator/persistence';
import { fingerprintPlanValue } from '@ai-native-software-delivery-orchestrator/planning';
import {
  codeReviewPolicyFingerprint,
  type CodeReviewPolicy
} from '@ai-native-software-delivery-orchestrator/planning';
import { InMemoryWriteGuard } from '@ai-native-software-delivery-orchestrator/runtime-guard';
import { DeterministicScheduler } from '@ai-native-software-delivery-orchestrator/scheduler';
import {
  GitWorkspaceChangeInspector,
  GitWorkspaceManager,
  GitRepositorySnapshotProvider
} from '@ai-native-software-delivery-orchestrator/workspace-git';

import type { RuntimeStarter } from './run-preparation.js';
import { RepositoryImpactReconciler } from './repository-impact-reconciler.js';
import { RepositoryResourceResolver } from './repository-resource-resolver.js';
import {
  SandboxedPackageScriptVerifier,
  type SandboxedVerificationPolicy
} from './sandboxed-package-script-verifier.js';
import { SnapshotTaskCodeReviewSubjectProvider } from './task-code-review-subject-provider.js';
import { TaskVerificationEvidenceFactory } from './task-verification-evidence-factory.js';

export interface LocalRuntimeStarterOptions {
  readonly graph: RepositoryGraph;
  readonly databasePath: string;
  readonly verificationPolicy: SandboxedVerificationPolicy;
  readonly codeReviewPolicy: CodeReviewPolicy;
  readonly verificationSandbox?: AgentCommandSandbox;
  readonly gateway?: PiSessionGateway;
  /** Test seam; production resolves the policy model through Pi's model registry. */
  readonly reviewGateway?: PiTaskCodeReviewGateway;
  /** Test seam; production resolves the policy model through Pi's model registry. */
  readonly reviewModelResolver?: CodeReviewModelResolver;
}

export class LocalRuntimeStarter implements RuntimeStarter {
  readonly #persistence: DrizzleSqliteOrchestrationPersistence;
  readonly #graph: RepositoryGraph;
  readonly #gateway: PiSessionGateway;
  readonly #verificationPolicy: SandboxedVerificationPolicy;
  readonly #codeReviewPolicy: CodeReviewPolicy;
  readonly #verificationSandbox: AgentCommandSandbox | undefined;
  readonly #reviewGateway: PiTaskCodeReviewGateway | undefined;
  readonly #reviewModelResolver: CodeReviewModelResolver | undefined;

  constructor(options: LocalRuntimeStarterOptions) {
    const persistence = new DrizzleSqliteOrchestrationPersistence(options.databasePath);
    this.#persistence = persistence;
    this.#graph = options.graph;
    this.#gateway = options.gateway ?? new PiCodingAgentGateway();
    this.#verificationPolicy = options.verificationPolicy;
    this.#codeReviewPolicy = options.codeReviewPolicy;
    this.#verificationSandbox = options.verificationSandbox;
    this.#reviewGateway = options.reviewGateway;
    this.#reviewModelResolver = options.reviewModelResolver;
  }

  async startOrResumeRun(request: Parameters<RuntimeStarter['startOrResumeRun']>[0]) {
    if (
      fingerprintPlanValue(this.#verificationPolicy) !==
      request.run.authority.verificationPolicyFingerprint
    ) {
      throw new Error('Runtime verification policy does not match durable execution authority');
    }
    if (
      codeReviewPolicyFingerprint(this.#codeReviewPolicy) !==
      request.run.authority.codeReviewPolicyFingerprint
    ) {
      throw new Error('Runtime code review policy does not match durable execution authority');
    }
    const recovered = await this.#persistence.recoverRun(request.run.id);
    const writeGuard = new InMemoryWriteGuard({
      initialLeases: recovered?.leases
        .map(({ lease }) => lease)
        .filter((lease) => lease.state === 'ACTIVE')
    });
    const resources = new RepositoryResourceResolver(this.#graph);
    const workspaceManager = new GitWorkspaceManager();
    const verifier = new SandboxedPackageScriptVerifier({
      policy: this.#verificationPolicy,
      graph: this.#graph,
      ...(this.#verificationSandbox === undefined ? {} : { sandbox: this.#verificationSandbox })
    });
    const agentRunner = new PiAgentRunner({
      gateway: this.#gateway,
      createTools: (agentRequest) =>
        new AgentToolRuntime({
          runId: agentRequest.runId,
          taskId: agentRequest.taskId,
          attemptId: agentRequest.attempt.id,
          agentId: agentRequest.attempt.agentId,
          workspacePath: agentRequest.workspace.workspacePath,
          resolveResource: (path) => resources.resolve(path),
          resolveFileId: (path) => resources.fileId(path),
          persistence: this.#persistence,
          writeGuard
        })
    });
    const snapshots = new GitRepositorySnapshotProvider();
    const subjects = new SnapshotTaskCodeReviewSubjectProvider();
    const evidenceFactory = new TaskVerificationEvidenceFactory();
    const reviews = new TaskCodeReviewCollector({
      reviewer: new PiTaskCodeReviewer({
        policy: this.#codeReviewPolicy,
        ...(this.#reviewGateway === undefined ? {} : { gateway: this.#reviewGateway }),
        ...(this.#reviewModelResolver === undefined
          ? {}
          : { modelResolver: this.#reviewModelResolver }),
        createTools: ({ workspace }) => {
          const tools = new AgentToolRuntime({
            runId: request.run.id,
            taskId: 'code-review',
            attemptId: 'code-review',
            agentId: 'code-review',
            workspacePath: workspace.workspacePath,
            resolveResource: (path) => resources.resolve(path),
            resolveFileId: (path) => resources.fileId(path),
            persistence: this.#persistence,
            writeGuard
          });
          return {
            read: (path) => tools.read(path),
            list: (path) => tools.list(path),
            find: (path, text) => tools.find(path, text)
          };
        }
      }),
      store: this.#persistence
    });
    const admission = new TaskOutputAdmissionCoordinator({
      snapshots,
      subjects,
      reviews,
      reviewStore: this.#persistence,
      verificationEvidence: this.#persistence,
      createVerificationEvidence: (evidence) => evidenceFactory.create(evidence),
      createEvidenceId: randomUUID
    });
    const repairs = new TaskRepairCoordinator({
      store: this.#persistence,
      reviews: this.#persistence,
      maxRepairs: 1,
      createId: randomUUID
    });
    const repairExecution = new RepairExecutionCoordinator({
      repairs,
      runner: agentRunner,
      reconciler: new RepositoryImpactReconciler({
        changes: new GitWorkspaceChangeInspector(),
        resources
      }),
      verifier,
      snapshots,
      subjects,
      reviews,
      verificationEvidence: this.#persistence,
      writeGuard,
      persistence: this.#persistence,
      feedback: { leaseBlocked: async () => undefined, scopeExpanded: async () => undefined },
      createEvidenceId: randomUUID,
      createVerificationEvidence: (evidence) => evidenceFactory.create(evidence)
    });
    return new OrchestrationRuntime({
      scheduler: new DeterministicScheduler(),
      persistence: this.#persistence,
      workspaceManager,
      impactReconciler: new RepositoryImpactReconciler({
        changes: new GitWorkspaceChangeInspector(),
        resources
      }),
      writeGuard,
      agentRunner,
      verifier,
      repairAttempts: this.#persistence,
      repairWorkItems: this.#persistence,
      outputReview: { admission, repairs, repairExecution, repository: this.#graph }
    }).startOrResumeRun(request);
  }

  close(): void {
    this.#persistence.close();
  }
}
