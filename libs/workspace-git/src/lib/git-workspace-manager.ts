import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  CreateTaskWorkspaceRequest,
  DisposeTaskWorkspaceRequest,
  DisposeTaskWorkspaceResult,
  IntegrateTaskWorkspaceResult,
  TaskWorkspace,
  WorkspaceManager
} from '@ai-native-software-delivery-orchestrator/domain';
import {
  createTaskWorkspaceRequestSchema,
  disposeTaskWorkspaceRequestSchema,
  taskWorkspaceSchema
} from '@ai-native-software-delivery-orchestrator/domain';

const comparePaths = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitCommandRunner {
  run(cwd: string, args: readonly string[]): GitResult;
}

class NativeGitCommandRunner implements GitCommandRunner {
  run(cwd: string, args: readonly string[]): GitResult {
    try {
      const stdout = execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      });
      return { stdout, stderr: '' };
    } catch (error) {
      const stderr =
        typeof error === 'object' && error !== null && 'stderr' in error
          ? this.#stderr(Reflect.get(error, 'stderr'))
          : '';
      throw new GitWorkspaceError(args, stderr);
    }
  }

  #stderr(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }
}

export class GitWorkspaceError extends Error {
  readonly command: readonly string[];
  readonly stderr: string;

  constructor(command: readonly string[], stderr: string) {
    super(stderr || `Git command failed: git ${command.join(' ')}`);
    this.name = 'GitWorkspaceError';
    this.command = command;
    this.stderr = stderr;
  }
}

export class GitWorkspaceManager implements WorkspaceManager {
  readonly #runner: GitCommandRunner;

  constructor(runner: GitCommandRunner = new NativeGitCommandRunner()) {
    this.#runner = runner;
  }

  async create(request: CreateTaskWorkspaceRequest): Promise<TaskWorkspace> {
    const parsed = createTaskWorkspaceRequestSchema.parse(request);
    const repositoryPath = resolve(parsed.repositoryPath);
    const workspacePath = resolve(parsed.workspacePath);
    if (existsSync(workspacePath)) {
      throw new GitWorkspaceError(
        ['worktree', 'add', workspacePath],
        'Workspace path already exists.'
      );
    }
    this.#git(repositoryPath, ['rev-parse', '--verify', parsed.baseRef]);
    this.#git(repositoryPath, ['rev-parse', '--verify', parsed.integrationRef]);
    this.#git(repositoryPath, [
      'worktree',
      'add',
      '--no-checkout',
      '-b',
      parsed.branchName,
      workspacePath,
      parsed.baseRef
    ]);
    try {
      this.#git(workspacePath, ['checkout']);
    } catch (error) {
      this.#tryGit(repositoryPath, ['worktree', 'remove', '--force', workspacePath]);
      this.#tryGit(repositoryPath, ['branch', '-D', parsed.branchName]);
      throw error;
    }
    return {
      ...parsed,
      repositoryPath,
      workspacePath,
      revision: 1,
      phase: 'READY_TO_INTEGRATE'
    };
  }

  async integrate(workspace: TaskWorkspace): Promise<IntegrateTaskWorkspaceResult> {
    return this.#integrate(taskWorkspaceSchema.parse(workspace));
  }

  async resumeIntegration(workspace: TaskWorkspace): Promise<IntegrateTaskWorkspaceResult> {
    const parsed = taskWorkspaceSchema.parse(workspace);
    if (parsed.phase !== 'INTEGRATION_BLOCKED') {
      throw new GitWorkspaceError(
        ['rebase', '--continue'],
        'Workspace is not integration blocked.'
      );
    }
    if (parsed.blocker.type !== 'rebase-conflict') {
      return this.#integrate(this.#readyWorkspace(parsed, false));
    }
    const rebaseResult = this.#tryGit(parsed.workspacePath, [
      '-c',
      'core.editor=true',
      'rebase',
      '--continue'
    ]);
    if (rebaseResult === undefined) {
      return this.#blockedWorkspace(parsed, 'rebase-conflict', 'Rebase remains blocked.');
    }
    return this.#fastForwardIntegration(this.#readyWorkspace(parsed, false));
  }

  async abortIntegration(workspace: TaskWorkspace): Promise<TaskWorkspace> {
    const parsed = taskWorkspaceSchema.parse(workspace);
    if (parsed.phase !== 'INTEGRATION_BLOCKED') {
      return parsed;
    }
    if (parsed.blocker.type === 'rebase-conflict') {
      this.#git(parsed.workspacePath, ['rebase', '--abort']);
    }
    return this.#readyWorkspace(parsed);
  }

  async dispose(request: DisposeTaskWorkspaceRequest): Promise<DisposeTaskWorkspaceResult> {
    const parsed = disposeTaskWorkspaceRequestSchema.parse(request);
    const dirtyPaths = this.#dirtyPaths(parsed.workspace.workspacePath);
    if (dirtyPaths.length > 0 && !parsed.force) {
      return { status: 'dirty', paths: dirtyPaths };
    }
    this.#git(parsed.workspace.repositoryPath, [
      'worktree',
      'remove',
      ...(parsed.force ? ['--force'] : []),
      parsed.workspace.workspacePath
    ]);
    this.#git(parsed.workspace.repositoryPath, ['branch', '-D', parsed.workspace.branchName]);
    return { status: 'disposed' };
  }

  async #integrate(workspace: TaskWorkspace): Promise<IntegrateTaskWorkspaceResult> {
    if (workspace.phase === 'INTEGRATED') {
      return { status: 'integrated', workspace };
    }
    if (workspace.phase === 'INTEGRATION_BLOCKED') {
      return { status: 'blocked', workspace };
    }
    const rebase = this.#tryGit(workspace.workspacePath, ['rebase', workspace.integrationRef]);
    if (rebase === undefined) {
      return this.#blockedWorkspace(
        workspace,
        'rebase-conflict',
        'Rebase onto integration ref conflicted.'
      );
    }
    return this.#fastForwardIntegration(workspace);
  }

  #fastForwardIntegration(workspace: TaskWorkspace): IntegrateTaskWorkspaceResult {
    const integrationRepositoryPath = this.#integrationRepositoryPath(workspace);
    const dirtyPaths = this.#dirtyPaths(integrationRepositoryPath);
    if (dirtyPaths.length > 0) {
      return {
        status: 'blocked',
        workspace: {
          id: workspace.id,
          runId: workspace.runId,
          taskId: workspace.taskId,
          repositoryPath: workspace.repositoryPath,
          workspacePath: workspace.workspacePath,
          branchName: workspace.branchName,
          baseRef: workspace.baseRef,
          integrationRef: workspace.integrationRef,
          revision: workspace.revision + 1,
          phase: 'INTEGRATION_BLOCKED',
          blocker: {
            type: 'repository-dirty',
            detail: 'Integration repository has uncommitted changes.',
            conflictPaths: [...dirtyPaths]
          }
        }
      };
    }
    const checkout = this.#tryGit(integrationRepositoryPath, ['switch', workspace.integrationRef]);
    if (checkout === undefined) {
      return this.#blockedWorkspace(
        workspace,
        'fast-forward-failed',
        'Integration repository cannot switch to integration ref.'
      );
    }
    const result = this.#tryGit(integrationRepositoryPath, [
      'merge',
      '--ff-only',
      workspace.branchName
    ]);
    if (result === undefined) {
      return this.#blockedWorkspace(
        workspace,
        'fast-forward-failed',
        'Integration ref cannot fast-forward to task branch.'
      );
    }
    const integrationCommit = this.#git(integrationRepositoryPath, [
      'rev-parse',
      'HEAD'
    ]).stdout.trim();
    return {
      status: 'integrated',
      workspace: {
        id: workspace.id,
        runId: workspace.runId,
        taskId: workspace.taskId,
        repositoryPath: workspace.repositoryPath,
        workspacePath: workspace.workspacePath,
        branchName: workspace.branchName,
        baseRef: workspace.baseRef,
        integrationRef: workspace.integrationRef,
        revision: workspace.revision + 1,
        phase: 'INTEGRATED',
        integrationCommit
      }
    };
  }

  #blockedWorkspace(
    workspace: TaskWorkspace,
    type: 'rebase-conflict' | 'fast-forward-failed',
    detail: string
  ): IntegrateTaskWorkspaceResult {
    return {
      status: 'blocked',
      workspace: {
        id: workspace.id,
        runId: workspace.runId,
        taskId: workspace.taskId,
        repositoryPath: workspace.repositoryPath,
        workspacePath: workspace.workspacePath,
        branchName: workspace.branchName,
        baseRef: workspace.baseRef,
        integrationRef: workspace.integrationRef,
        revision: workspace.revision + 1,
        phase: 'INTEGRATION_BLOCKED',
        blocker: { type, detail, conflictPaths: [...this.#conflictPaths(workspace.workspacePath)] }
      }
    };
  }

  #integrationRepositoryPath(workspace: TaskWorkspace): string {
    return workspace.repositoryPath;
  }

  #readyWorkspace(workspace: TaskWorkspace, advanceRevision = true): TaskWorkspace {
    return {
      id: workspace.id,
      runId: workspace.runId,
      taskId: workspace.taskId,
      repositoryPath: workspace.repositoryPath,
      workspacePath: workspace.workspacePath,
      branchName: workspace.branchName,
      baseRef: workspace.baseRef,
      integrationRef: workspace.integrationRef,
      revision: workspace.revision + (advanceRevision ? 1 : 0),
      phase: 'READY_TO_INTEGRATE'
    };
  }

  #dirtyPaths(workspacePath: string): readonly string[] {
    return this.#git(workspacePath, ['status', '--porcelain=v1'])
      .stdout.split('\n')
      .filter((line) => line.length > 3)
      .map((line) => line.slice(3))
      .toSorted(comparePaths);
  }

  #conflictPaths(workspacePath: string): readonly string[] {
    const result = this.#tryGit(workspacePath, ['diff', '--name-only', '--diff-filter=U']);
    return result === undefined
      ? []
      : result.stdout.split('\n').filter(Boolean).toSorted(comparePaths);
  }

  #tryGit(cwd: string, args: readonly string[]): GitResult | undefined {
    try {
      return this.#git(cwd, args);
    } catch (error) {
      if (error instanceof GitWorkspaceError) {
        return undefined;
      }
      throw error;
    }
  }

  #git(cwd: string, args: readonly string[]): GitResult {
    return this.#runner.run(cwd, args);
  }
}
