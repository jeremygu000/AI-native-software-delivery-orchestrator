import { randomUUID } from 'node:crypto';
import { sep } from 'node:path';

import {
  AgentToolRuntime,
  DockerReadOnlyCommandSandbox,
  PiAgentRunner,
  PiCodingAgentGateway,
  type PiSessionGateway
} from '@ai-native-software-delivery-orchestrator/agent-runtime';
import { defaultAgentCommandTrustedPath } from '@ai-native-software-delivery-orchestrator/domain';
import type {
  AgentCommandSandbox,
  AgentCommandSandboxProfile,
  RepositoryGraph,
  FileNode,
  TaskVerifier,
  WritableResource
} from '@ai-native-software-delivery-orchestrator/domain';
import { OrchestrationRuntime } from '@ai-native-software-delivery-orchestrator/orchestration-runtime';
import { DrizzleSqliteOrchestrationPersistence } from '@ai-native-software-delivery-orchestrator/persistence';
import { fingerprintPlanValue } from '@ai-native-software-delivery-orchestrator/planning';
import { InMemoryWriteGuard } from '@ai-native-software-delivery-orchestrator/runtime-guard';
import { DeterministicScheduler } from '@ai-native-software-delivery-orchestrator/scheduler';
import {
  GitWorkspaceChangeInspector,
  GitWorkspaceManager
} from '@ai-native-software-delivery-orchestrator/workspace-git';

import type { RuntimeStarter } from './run-preparation.js';
import { RepositoryImpactReconciler } from './repository-impact-reconciler.js';

const portable = (path: string): string => path.split(sep).join('/');

type DockerVerificationProfile = Extract<
  AgentCommandSandboxProfile,
  { readonly kind: 'docker-read-only' }
>;

interface SandboxedVerificationPolicy {
  readonly version: 2;
  readonly autonomousRules: readonly ['package-script-required', 'free-form-command-forbidden'];
  readonly packageScriptRunner: 'npm-from-pinned-node-image';
  readonly executionProfile: DockerVerificationProfile;
}

const dockerDigestImage = /^.+@sha256:[a-f0-9]{64}$/;

export class RepositoryResourceResolver {
  readonly #graph: RepositoryGraph;
  readonly #filesByPath: ReadonlyMap<string, FileNode>;

  constructor(graph: RepositoryGraph) {
    this.#graph = graph;
    this.#filesByPath = new Map([...graph.files.values()].map((file) => [file.path, file]));
  }

  resolve(path: string): Extract<WritableResource, { readonly type: 'file' }> {
    const normalizedPath = portable(path);
    const file = this.#filesByPath.get(normalizedPath);
    if (file !== undefined) {
      return { type: 'file', projectId: file.projectId, fileId: file.id };
    }
    const project = [...this.#graph.projects.values()]
      .filter((candidate) => {
        const root = candidate.root === '.' ? '' : candidate.root.replace(/\/$/, '');
        return root === '' || normalizedPath === root || normalizedPath.startsWith(`${root}/`);
      })
      .toSorted((left, right) => right.root.length - left.root.length)[0];
    if (project === undefined) {
      throw new Error(`Workspace path does not belong to an approved project: ${normalizedPath}`);
    }
    return {
      type: 'file',
      projectId: project.id,
      fileId: `${project.id}:${normalizedPath}`
    };
  }

  fileId(path: string): string {
    return this.resolve(path).fileId;
  }
}

export class SandboxedPackageScriptVerifier implements TaskVerifier {
  readonly #policy: SandboxedVerificationPolicy;
  readonly #sandbox: AgentCommandSandbox;
  readonly #projectRoots: ReadonlyMap<string, string>;

  constructor(options: {
    readonly policy: SandboxedVerificationPolicy;
    readonly graph: RepositoryGraph;
    readonly sandbox?: AgentCommandSandbox;
  }) {
    if (!dockerDigestImage.test(options.policy.executionProfile.image)) {
      throw new Error('Verification Docker image must use a sha256 digest');
    }
    this.#policy = options.policy;
    this.#sandbox = options.sandbox ?? new DockerReadOnlyCommandSandbox();
    this.#projectRoots = new Map(
      [...options.graph.projects.values()].flatMap((project) => [
        [project.id, project.root],
        [project.name, project.root]
      ])
    );
  }

  async verify(request: Parameters<TaskVerifier['verify']>[0]) {
    for (const rule of request.task.verification) {
      if (rule.type !== 'package-script') {
        return {
          status: 'failed' as const,
          detail: 'Autonomous runtime accepts only package-script verification rules'
        };
      }
      const projectRoot = this.#projectRoots.get(rule.packageName);
      if (projectRoot === undefined) {
        return {
          status: 'failed' as const,
          detail: `Verification package is not present in approved Repository Facts: ${rule.packageName}`
        };
      }
      const result = await this.#sandbox.execute({
        profile: this.#policy.executionProfile,
        executable: 'npm',
        args: ['--prefix', projectRoot, 'run', rule.script],
        cwd: request.workspace.workspacePath,
        environment: { CI: '1', HOME: '/tmp', npm_config_cache: '/tmp/npm-cache' },
        trustedPath: defaultAgentCommandTrustedPath,
        timeoutMs: 600_000,
        maxOutputBytes: 1024 * 1024,
        containerName: `forge-verify-${randomUUID()}`
      });
      if (result.status !== 'completed' || result.exitCode !== 0) {
        const detail =
          result.status === 'completed'
            ? result.stderr.trim()
            : result.status === 'failed'
              ? result.detail
              : result.status;
        return {
          status: 'failed' as const,
          detail: `Verification failed for ${rule.packageName}:${rule.script}: ${detail}`
        };
      }
    }
    return { status: 'passed' as const };
  }
}

export interface LocalRuntimeStarterOptions {
  readonly graph: RepositoryGraph;
  readonly databasePath: string;
  readonly verificationPolicy: SandboxedVerificationPolicy;
  readonly verificationSandbox?: AgentCommandSandbox;
  readonly gateway?: PiSessionGateway;
}

export class LocalRuntimeStarter implements RuntimeStarter {
  readonly #persistence: DrizzleSqliteOrchestrationPersistence;
  readonly #graph: RepositoryGraph;
  readonly #gateway: PiSessionGateway;
  readonly #verificationPolicy: SandboxedVerificationPolicy;
  readonly #verificationSandbox: AgentCommandSandbox | undefined;

  constructor(options: LocalRuntimeStarterOptions) {
    const persistence = new DrizzleSqliteOrchestrationPersistence(options.databasePath);
    this.#persistence = persistence;
    this.#graph = options.graph;
    this.#gateway = options.gateway ?? new PiCodingAgentGateway();
    this.#verificationPolicy = options.verificationPolicy;
    this.#verificationSandbox = options.verificationSandbox;
  }

  async startOrResumeRun(request: Parameters<RuntimeStarter['startOrResumeRun']>[0]) {
    if (
      fingerprintPlanValue(this.#verificationPolicy) !==
      request.run.authority.verificationPolicyFingerprint
    ) {
      throw new Error('Runtime verification policy does not match durable execution authority');
    }
    const recovered = await this.#persistence.recoverRun(request.run.id);
    const writeGuard = new InMemoryWriteGuard({
      initialLeases: recovered?.leases
        .map(({ lease }) => lease)
        .filter((lease) => lease.state === 'ACTIVE')
    });
    const resources = new RepositoryResourceResolver(this.#graph);
    return new OrchestrationRuntime({
      scheduler: new DeterministicScheduler(),
      persistence: this.#persistence,
      workspaceManager: new GitWorkspaceManager(),
      impactReconciler: new RepositoryImpactReconciler({
        changes: new GitWorkspaceChangeInspector(),
        resources
      }),
      writeGuard,
      agentRunner: new PiAgentRunner({
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
      }),
      verifier: new SandboxedPackageScriptVerifier({
        policy: this.#verificationPolicy,
        graph: this.#graph,
        ...(this.#verificationSandbox === undefined ? {} : { sandbox: this.#verificationSandbox })
      })
    }).startOrResumeRun(request);
  }

  close(): void {
    this.#persistence.close();
  }
}
