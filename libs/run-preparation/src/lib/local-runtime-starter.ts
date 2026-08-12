import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';

import {
  AgentToolRuntime,
  PiAgentRunner,
  PiCodingAgentGateway,
  type PiSessionGateway
} from '@ai-native-software-delivery-orchestrator/agent-runtime';
import { defaultAgentCommandTrustedPath } from '@ai-native-software-delivery-orchestrator/domain';
import type {
  RepositoryGraph,
  FileNode,
  TaskVerifier,
  WritableResource
} from '@ai-native-software-delivery-orchestrator/domain';
import { OrchestrationRuntime } from '@ai-native-software-delivery-orchestrator/orchestration-runtime';
import { DrizzleSqliteOrchestrationPersistence } from '@ai-native-software-delivery-orchestrator/persistence';
import { InMemoryWriteGuard } from '@ai-native-software-delivery-orchestrator/runtime-guard';
import { DeterministicScheduler } from '@ai-native-software-delivery-orchestrator/scheduler';
import { GitWorkspaceManager } from '@ai-native-software-delivery-orchestrator/workspace-git';

import type { RuntimeStarter } from './run-preparation.js';

const portable = (path: string): string => path.split(sep).join('/');
const verificationTrustedPath = [
  dirname(process.execPath),
  join(homedir(), 'Library', 'pnpm'),
  join(homedir(), '.local', 'share', 'pnpm'),
  join(homedir(), '.local', 'bin'),
  defaultAgentCommandTrustedPath
].join(':');

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

export class PnpmTaskVerifier implements TaskVerifier {
  async verify(request: Parameters<TaskVerifier['verify']>[0]) {
    for (const rule of request.task.verification) {
      if (rule.type !== 'package-script') {
        return {
          status: 'failed' as const,
          detail: 'Autonomous runtime accepts only package-script verification rules'
        };
      }
      const result = await new Promise<{ readonly exitCode: number; readonly stderr: string }>(
        (complete) => {
          execFile(
            'pnpm',
            ['--filter', rule.packageName, 'run', rule.script],
            {
              cwd: request.workspace.workspacePath,
              encoding: 'utf8',
              timeout: 600_000,
              maxBuffer: 1024 * 1024,
              env: { CI: '1', PATH: verificationTrustedPath }
            },
            (error, _stdout, stderr) =>
              complete({
                exitCode: error === null ? 0 : typeof error.code === 'number' ? error.code : 1,
                stderr
              })
          );
        }
      );
      if (result.exitCode !== 0) {
        return {
          status: 'failed' as const,
          detail: `Verification failed for ${rule.packageName}:${rule.script}: ${result.stderr.trim()}`
        };
      }
    }
    return { status: 'passed' as const };
  }
}

export interface LocalRuntimeStarterOptions {
  readonly graph: RepositoryGraph;
  readonly databasePath: string;
  readonly gateway?: PiSessionGateway;
}

export class LocalRuntimeStarter implements RuntimeStarter {
  readonly #persistence: DrizzleSqliteOrchestrationPersistence;
  readonly #graph: RepositoryGraph;
  readonly #gateway: PiSessionGateway;

  constructor(options: LocalRuntimeStarterOptions) {
    const persistence = new DrizzleSqliteOrchestrationPersistence(options.databasePath);
    this.#persistence = persistence;
    this.#graph = options.graph;
    this.#gateway = options.gateway ?? new PiCodingAgentGateway();
  }

  async startOrResumeRun(request: Parameters<RuntimeStarter['startOrResumeRun']>[0]) {
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
      verifier: new PnpmTaskVerifier()
    }).startOrResumeRun(request);
  }

  close(): void {
    this.#persistence.close();
  }
}
