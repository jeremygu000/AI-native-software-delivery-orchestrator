import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  CreateTaskWorkspaceRequest,
  CommitTaskWorkspaceRequest,
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
  run(cwd: string, args: readonly string[]): Promise<GitResult>;
  workspacePathExists?(path: string): boolean;
}

class NativeGitCommandRunner implements GitCommandRunner {
  run(cwd: string, args: readonly string[]): Promise<GitResult> {
    return new Promise((complete, reject) => {
      execFile('git', args, { cwd, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error !== null) {
          reject(new GitWorkspaceError(args, stderr));
          return;
        }
        complete({ stdout, stderr });
      });
    });
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
    const integrationRepositoryPath = resolve(parsed.integrationRepositoryPath);
    const workspacePath = resolve(parsed.workspacePath);
    if (this.#workspacePathExists(workspacePath)) {
      if (
        await this.#isMatchingWorktree(integrationRepositoryPath, workspacePath, parsed.branchName)
      ) {
        return {
          ...parsed,
          integrationRepositoryPath,
          workspacePath,
          revision: 1,
          phase: 'READY_TO_INTEGRATE'
        };
      }
      throw new GitWorkspaceError(
        ['worktree', 'add', workspacePath],
        'Workspace path already exists.'
      );
    }
    await this.#git(integrationRepositoryPath, ['rev-parse', '--verify', parsed.baseRef]);
    await this.#git(integrationRepositoryPath, ['rev-parse', '--verify', parsed.integrationRef]);
    await this.#git(integrationRepositoryPath, [
      'worktree',
      'add',
      '-b',
      parsed.branchName,
      workspacePath,
      parsed.baseRef
    ]);
    return {
      ...parsed,
      integrationRepositoryPath,
      workspacePath,
      revision: 1,
      phase: 'READY_TO_INTEGRATE'
    };
  }

  async integrate(workspace: TaskWorkspace): Promise<IntegrateTaskWorkspaceResult> {
    return this.#integrate(taskWorkspaceSchema.parse(workspace));
  }

  async commit(request: CommitTaskWorkspaceRequest): Promise<TaskWorkspace> {
    const workspace = taskWorkspaceSchema.parse(request.workspace);
    if (request.message.trim().length === 0) {
      throw new GitWorkspaceError(['commit'], 'Workspace commit message must not be empty.');
    }
    await this.#git(workspace.workspacePath, ['add', '--all']);
    const status = await this.#git(workspace.workspacePath, ['status', '--porcelain=v1', '-z']);
    if (status.stdout.length === 0) {
      return workspace;
    }
    await this.#git(workspace.workspacePath, ['commit', '-m', request.message]);
    return workspace;
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
    const rebaseResult = await this.#tryGit(parsed.workspacePath, [
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
      await this.#git(parsed.workspacePath, ['rebase', '--abort']);
    }
    return this.#readyWorkspace(parsed);
  }

  async dispose(request: DisposeTaskWorkspaceRequest): Promise<DisposeTaskWorkspaceResult> {
    const parsed = disposeTaskWorkspaceRequestSchema.parse(request);
    if (this.#workspacePathExists(parsed.workspace.workspacePath)) {
      const dirtyPaths = await this.#dirtyPaths(parsed.workspace.workspacePath);
      if (dirtyPaths.length > 0 && !parsed.force) {
        return { status: 'dirty', paths: dirtyPaths };
      }
      await this.#git(parsed.workspace.integrationRepositoryPath, [
        'worktree',
        'remove',
        ...(parsed.force ? ['--force'] : []),
        parsed.workspace.workspacePath
      ]);
    }
    if (
      await this.#branchExists(
        parsed.workspace.integrationRepositoryPath,
        parsed.workspace.branchName
      )
    ) {
      await this.#git(parsed.workspace.integrationRepositoryPath, [
        'branch',
        '-D',
        parsed.workspace.branchName
      ]);
    }
    return { status: 'disposed' };
  }

  async #integrate(workspace: TaskWorkspace): Promise<IntegrateTaskWorkspaceResult> {
    if (workspace.phase === 'INTEGRATED') {
      return { status: 'integrated', workspace };
    }
    if (workspace.phase === 'INTEGRATION_BLOCKED') {
      return { status: 'blocked', workspace };
    }
    const rebase = await this.#tryGit(workspace.workspacePath, [
      'rebase',
      workspace.integrationRef
    ]);
    if (rebase === undefined) {
      return this.#blockedWorkspace(
        workspace,
        'rebase-conflict',
        'Rebase onto integration ref conflicted.'
      );
    }
    return this.#fastForwardIntegration(workspace);
  }

  async #fastForwardIntegration(workspace: TaskWorkspace): Promise<IntegrateTaskWorkspaceResult> {
    const integrationRepositoryPath = this.#integrationRepositoryPath(workspace);
    const dirtyPaths = await this.#dirtyPaths(integrationRepositoryPath);
    if (dirtyPaths.length > 0) {
      return {
        status: 'blocked',
        workspace: {
          id: workspace.id,
          runId: workspace.runId,
          taskId: workspace.taskId,
          integrationRepositoryPath: workspace.integrationRepositoryPath,
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
    const checkout = await this.#tryGit(integrationRepositoryPath, [
      'switch',
      workspace.integrationRef
    ]);
    if (checkout === undefined) {
      return this.#blockedWorkspace(
        workspace,
        'fast-forward-failed',
        'Integration repository cannot switch to integration ref.'
      );
    }
    const result = await this.#tryGit(integrationRepositoryPath, [
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
    const integrationCommit = (
      await this.#git(integrationRepositoryPath, ['rev-parse', 'HEAD'])
    ).stdout.trim();
    return {
      status: 'integrated',
      workspace: {
        id: workspace.id,
        runId: workspace.runId,
        taskId: workspace.taskId,
        integrationRepositoryPath: workspace.integrationRepositoryPath,
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

  async #blockedWorkspace(
    workspace: TaskWorkspace,
    type: 'rebase-conflict' | 'fast-forward-failed',
    detail: string
  ): Promise<IntegrateTaskWorkspaceResult> {
    return {
      status: 'blocked',
      workspace: {
        id: workspace.id,
        runId: workspace.runId,
        taskId: workspace.taskId,
        integrationRepositoryPath: workspace.integrationRepositoryPath,
        workspacePath: workspace.workspacePath,
        branchName: workspace.branchName,
        baseRef: workspace.baseRef,
        integrationRef: workspace.integrationRef,
        revision: workspace.revision + 1,
        phase: 'INTEGRATION_BLOCKED',
        blocker: {
          type,
          detail,
          conflictPaths: [...(await this.#conflictPaths(workspace.workspacePath))]
        }
      }
    };
  }

  #integrationRepositoryPath(workspace: TaskWorkspace): string {
    return workspace.integrationRepositoryPath;
  }

  async #isMatchingWorktree(
    integrationRepositoryPath: string,
    workspacePath: string,
    branchName: string
  ): Promise<boolean> {
    const worktree = await this.#tryGit(workspacePath, ['rev-parse', '--is-inside-work-tree']);
    const branch = await this.#tryGit(workspacePath, ['branch', '--show-current']);
    const head = await this.#tryGit(workspacePath, ['rev-parse', 'HEAD']);
    const expectedHead = await this.#tryGit(integrationRepositoryPath, [
      'rev-parse',
      '--verify',
      branchName
    ]);
    if (
      worktree?.stdout.trim() !== 'true' ||
      branch?.stdout.trim() !== branchName ||
      head === undefined ||
      expectedHead === undefined
    ) {
      return false;
    }
    return head.stdout.trim() === expectedHead.stdout.trim();
  }

  async #branchExists(integrationRepositoryPath: string, branchName: string): Promise<boolean> {
    return (
      (await this.#tryGit(integrationRepositoryPath, [
        'rev-parse',
        '--verify',
        `refs/heads/${branchName}`
      ])) !== undefined
    );
  }

  #workspacePathExists(path: string): boolean {
    return this.#runner.workspacePathExists?.(path) ?? existsSync(path);
  }

  #readyWorkspace(workspace: TaskWorkspace, advanceRevision = true): TaskWorkspace {
    return {
      id: workspace.id,
      runId: workspace.runId,
      taskId: workspace.taskId,
      integrationRepositoryPath: workspace.integrationRepositoryPath,
      workspacePath: workspace.workspacePath,
      branchName: workspace.branchName,
      baseRef: workspace.baseRef,
      integrationRef: workspace.integrationRef,
      revision: workspace.revision + (advanceRevision ? 1 : 0),
      phase: 'READY_TO_INTEGRATE'
    };
  }

  async #dirtyPaths(workspacePath: string): Promise<readonly string[]> {
    const entries = (await this.#git(workspacePath, ['status', '--porcelain=v1', '-z'])).stdout
      .split('\0')
      .filter(Boolean);
    const paths: string[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry === undefined || entry.length < 4) {
        continue;
      }
      paths.push(entry.slice(3));
      if (entry[0] === 'R' || entry[1] === 'R' || entry[0] === 'C' || entry[1] === 'C') {
        const previousPath = entries[index + 1];
        if (previousPath !== undefined) {
          paths.push(previousPath);
          index += 1;
        }
      }
    }
    return paths.toSorted(comparePaths);
  }

  async #conflictPaths(workspacePath: string): Promise<readonly string[]> {
    const result = await this.#tryGit(workspacePath, [
      'diff',
      '--name-only',
      '--diff-filter=U',
      '-z'
    ]);
    return result === undefined
      ? []
      : result.stdout.split('\0').filter(Boolean).toSorted(comparePaths);
  }

  async #tryGit(cwd: string, args: readonly string[]): Promise<GitResult | undefined> {
    try {
      return await this.#git(cwd, args);
    } catch (error) {
      if (error instanceof GitWorkspaceError) {
        return undefined;
      }
      throw error;
    }
  }

  #git(cwd: string, args: readonly string[]): Promise<GitResult> {
    return this.#runner.run(cwd, args);
  }
}
