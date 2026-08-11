import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { CreateTaskWorkspaceRequest } from '@ai-native-software-delivery-orchestrator/domain';
import { afterEach, describe, expect, it } from 'vitest';

import {
  GitWorkspaceError,
  GitWorkspaceManager,
  type GitCommandRunner
} from './git-workspace-manager.js';

const directories: string[] = [];

const git = (cwd: string, args: readonly string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const createRepository = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'orchestration-workspace-'));
  directories.push(directory);
  git(directory, ['init', '--initial-branch=main']);
  git(directory, ['config', 'user.email', 'test@example.com']);
  git(directory, ['config', 'user.name', 'Test User']);
  writeFileSync(join(directory, 'value.txt'), 'base\n');
  git(directory, ['add', 'value.txt']);
  git(directory, ['commit', '-m', 'base']);
  return directory;
};

const request = (repositoryPath: string, taskId = 'task-1'): CreateTaskWorkspaceRequest => ({
  id: `workspace-${taskId}`,
  runId: 'run-1',
  taskId,
  repositoryPath,
  workspacePath: join(repositoryPath, '..', `${basename(repositoryPath)}-${taskId}-workspace`),
  branchName: `orchestrator/run-1/${taskId}`,
  baseRef: 'main',
  integrationRef: 'main'
});

const fixtureWorkspace = {
  id: 'workspace-1',
  runId: 'run-1',
  taskId: 'task-1',
  repositoryPath: '/repository',
  workspacePath: '/workspace',
  branchName: 'orchestrator/run-1/task-1',
  baseRef: 'main',
  integrationRef: 'main',
  revision: 1,
  phase: 'READY_TO_INTEGRATE'
} as const;

class FakeGitRunner implements GitCommandRunner {
  readonly calls: Array<{ cwd: string; args: readonly string[] }> = [];
  readonly failures = new Map<string, string>();
  readonly outputs = new Map<string, string>();
  readonly missingWorkspacePaths = new Set<string>();

  workspacePathExists(path: string): boolean {
    return !this.missingWorkspacePaths.has(path);
  }

  async run(cwd: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
    this.calls.push({ cwd, args });
    const key = args.join('\u0000');
    const failure = this.failures.get(key);
    if (failure !== undefined) {
      throw new GitWorkspaceError(args, failure);
    }
    return { stdout: this.outputs.get(key) ?? '', stderr: '' };
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('GitWorkspaceManager', () => {
  it('creates an isolated worktree, rebases, fast-forwards integration, and disposes it', async () => {
    const repositoryPath = createRepository();
    const manager = new GitWorkspaceManager();
    const workspace = await manager.create(request(repositoryPath));

    writeFileSync(join(workspace.workspacePath, 'task.txt'), 'task output\n');
    git(workspace.workspacePath, ['add', 'task.txt']);
    git(workspace.workspacePath, ['commit', '-m', 'task change']);

    const integration = await manager.integrate(workspace);

    expect(integration.status).toBe('integrated');
    if (integration.status !== 'integrated') {
      throw new Error('Expected integrated workspace');
    }
    expect(integration.workspace.phase).toBe('INTEGRATED');
    expect(readFileSync(join(repositoryPath, 'task.txt'), 'utf8')).toBe('task output\n');
    await expect(
      manager.dispose({ workspace: integration.workspace, force: false })
    ).resolves.toEqual({
      status: 'disposed'
    });
  });

  it('preserves integration phase through rebase conflict, abort, resolve, and resume', async () => {
    const repositoryPath = createRepository();
    const manager = new GitWorkspaceManager();
    const workspace = await manager.create(request(repositoryPath));

    writeFileSync(join(workspace.workspacePath, 'value.txt'), 'task value\n');
    git(workspace.workspacePath, ['add', 'value.txt']);
    git(workspace.workspacePath, ['commit', '-m', 'task value']);
    writeFileSync(join(repositoryPath, 'value.txt'), 'integration value\n');
    git(repositoryPath, ['add', 'value.txt']);
    git(repositoryPath, ['commit', '-m', 'integration value']);

    const blocked = await manager.integrate(workspace);

    expect(blocked.status).toBe('blocked');
    if (blocked.status !== 'blocked') {
      throw new Error('Expected integration block');
    }
    expect(blocked.workspace).toMatchObject({
      phase: 'INTEGRATION_BLOCKED',
      blocker: { type: 'rebase-conflict', conflictPaths: ['value.txt'] }
    });
    const ready = await manager.abortIntegration(blocked.workspace);
    expect(ready.phase).toBe('READY_TO_INTEGRATE');

    const blockedAgain = await manager.integrate(ready);
    if (blockedAgain.status !== 'blocked') {
      throw new Error('Expected integration block');
    }
    writeFileSync(join(blockedAgain.workspace.workspacePath, 'value.txt'), 'resolved value\n');
    git(blockedAgain.workspace.workspacePath, ['add', 'value.txt']);
    const resumed = await manager.resumeIntegration(blockedAgain.workspace);

    expect(resumed.status).toBe('integrated');
    expect(readFileSync(join(repositoryPath, 'value.txt'), 'utf8')).toBe('resolved value\n');
  });

  it('blocks integration when the integration repository is dirty and protects dirty disposal', async () => {
    const repositoryPath = createRepository();
    const manager = new GitWorkspaceManager();
    const workspace = await manager.create(request(repositoryPath));
    writeFileSync(join(workspace.workspacePath, 'task.txt'), 'task output\n');
    git(workspace.workspacePath, ['add', 'task.txt']);
    git(workspace.workspacePath, ['commit', '-m', 'task change']);
    writeFileSync(join(repositoryPath, 'uncommitted.txt'), 'dirty\n');

    const blocked = await manager.integrate(workspace);

    expect(blocked).toMatchObject({
      status: 'blocked',
      workspace: {
        phase: 'INTEGRATION_BLOCKED',
        blocker: { type: 'repository-dirty', conflictPaths: ['uncommitted.txt'] }
      }
    });
    rmSync(join(repositoryPath, 'uncommitted.txt'));
    const resumed = await manager.resumeIntegration(blocked.workspace);
    expect(resumed.status).toBe('integrated');
    if (resumed.status !== 'integrated') {
      throw new Error('Expected integration after cleaning repository.');
    }
    writeFileSync(join(workspace.workspacePath, 'dirty.txt'), 'dirty\n');
    await expect(manager.dispose({ workspace: resumed.workspace, force: false })).resolves.toEqual({
      status: 'dirty',
      paths: ['dirty.txt']
    });
    await expect(
      manager.dispose({ workspace: resumed.workspace, force: true, reason: 'Discard task work.' })
    ).resolves.toEqual({
      status: 'disposed'
    });
  });

  it('rejects a workspace path that already exists', async () => {
    const repositoryPath = createRepository();
    const manager = new GitWorkspaceManager();
    const first = await manager.create(request(repositoryPath));
    const occupiedPath = join(
      repositoryPath,
      '..',
      `${basename(repositoryPath)}-occupied-workspace`
    );
    mkdirSync(occupiedPath);

    await expect(
      manager.create({ ...request(repositoryPath, 'task-2'), workspacePath: occupiedPath })
    ).rejects.toThrow(GitWorkspaceError);
    await manager.dispose({ workspace: first, force: true, reason: 'Test cleanup.' });
  });

  it('surfaces an existing task branch when the workspace target is clean', async () => {
    const repositoryPath = createRepository();
    const manager = new GitWorkspaceManager();
    const workspaceRequest = request(repositoryPath);
    git(repositoryPath, ['branch', workspaceRequest.branchName]);

    expect(existsSync(workspaceRequest.workspacePath)).toBe(false);
    await expect(manager.create(workspaceRequest)).rejects.toThrow(GitWorkspaceError);
    expect(existsSync(workspaceRequest.workspacePath)).toBe(false);
  });

  it('reuses a matching worktree after persistence is interrupted', async () => {
    const repositoryPath = createRepository();
    const manager = new GitWorkspaceManager();
    const first = await manager.create(request(repositoryPath));

    await expect(manager.create(request(repositoryPath))).resolves.toEqual(first);
    await manager.dispose({ workspace: first, force: true, reason: 'Test cleanup.' });
  });

  it('creates a materialized worktree in one Git command', async () => {
    const runner = new FakeGitRunner();
    runner.outputs.set(['rev-parse', '--verify', 'main'].join('\u0000'), 'commit\n');
    const manager = new GitWorkspaceManager(runner);
    const workspaceRequest = request('/repository');
    runner.missingWorkspacePaths.add(workspaceRequest.workspacePath);

    await expect(manager.create(workspaceRequest)).resolves.toMatchObject({
      workspacePath: workspaceRequest.workspacePath,
      revision: 1
    });
    expect(runner.calls.map(({ args }) => args)).toContainEqual([
      'worktree',
      'add',
      '-b',
      workspaceRequest.branchName,
      workspaceRequest.workspacePath,
      workspaceRequest.baseRef
    ]);
    expect(runner.calls.some(({ args }) => args.includes('--no-checkout'))).toBe(false);
    expect(runner.calls.some(({ args }) => args[0] === 'checkout')).toBe(false);
  });

  it('wraps native Git process failures in a stable adapter error', async () => {
    const manager = new GitWorkspaceManager();

    await expect(manager.create(request('/missing/repository'))).rejects.toThrow(GitWorkspaceError);
  });

  it('disposes a clean workspace without force through the adapter seam', async () => {
    const runner = new FakeGitRunner();
    runner.outputs.set(['status', '--porcelain=v1', '-z'].join('\u0000'), '');
    const manager = new GitWorkspaceManager(runner);

    await expect(manager.dispose({ workspace: fixtureWorkspace, force: false })).resolves.toEqual({
      status: 'disposed'
    });
    expect(runner.calls.map(({ args }) => args)).toContainEqual([
      'worktree',
      'remove',
      '/workspace'
    ]);
  });

  it('cleans a residual branch when a worktree was removed before disposal retry', async () => {
    const runner = new FakeGitRunner();
    runner.missingWorkspacePaths.add('/workspace');
    runner.outputs.set(
      ['rev-parse', '--verify', 'refs/heads/orchestrator/run-1/task-1'].join('\u0000'),
      'commit\n'
    );
    const manager = new GitWorkspaceManager(runner);

    await expect(manager.dispose({ workspace: fixtureWorkspace, force: false })).resolves.toEqual({
      status: 'disposed'
    });
    expect(runner.calls.map(({ args }) => args)).not.toContainEqual([
      'status',
      '--porcelain=v1',
      '-z'
    ]);
    expect(runner.calls.map(({ args }) => args)).not.toContainEqual([
      'worktree',
      'remove',
      '/workspace'
    ]);
    expect(runner.calls.map(({ args }) => args)).toContainEqual([
      'branch',
      '-D',
      'orchestrator/run-1/task-1'
    ]);
  });

  it('rejects forced disposal without a caller reason before removing a dirty workspace', async () => {
    const runner = new FakeGitRunner();
    runner.outputs.set(['status', '--porcelain=v1', '-z'].join('\u0000'), '?? dirty.txt\0');
    const manager = new GitWorkspaceManager(runner);

    await expect(manager.dispose({ workspace: fixtureWorkspace, force: true })).rejects.toThrow(
      'A force disposal requires a reason'
    );
    expect(runner.calls).toEqual([]);
  });

  it('returns dirty paths in stable order', async () => {
    const runner = new FakeGitRunner();
    runner.outputs.set(['status', '--porcelain=v1', '-z'].join('\u0000'), '?? z.txt\0?? a.txt\0');
    const manager = new GitWorkspaceManager(runner);

    await expect(manager.dispose({ workspace: fixtureWorkspace, force: false })).resolves.toEqual({
      status: 'dirty',
      paths: ['a.txt', 'z.txt']
    });
  });

  it('preserves spaces in dirty paths', async () => {
    const runner = new FakeGitRunner();
    runner.outputs.set(['status', '--porcelain=v1', '-z'].join('\u0000'), '?? my file.txt\0');
    const manager = new GitWorkspaceManager(runner);

    await expect(manager.dispose({ workspace: fixtureWorkspace, force: false })).resolves.toEqual({
      status: 'dirty',
      paths: ['my file.txt']
    });
  });

  it('preserves both paths from a renamed file', async () => {
    const repositoryPath = createRepository();
    const manager = new GitWorkspaceManager();
    const workspace = await manager.create(request(repositoryPath));
    git(workspace.workspacePath, ['mv', 'value.txt', 'renamed value.txt']);

    await expect(manager.dispose({ workspace, force: false })).resolves.toEqual({
      status: 'dirty',
      paths: ['renamed value.txt', 'value.txt']
    });
    await manager.dispose({ workspace, force: true, reason: 'Test cleanup.' });
  });

  it('records a rebase conflict without losing integration phase', async () => {
    const runner = new FakeGitRunner();
    runner.failures.set(['rebase', 'main'].join('\u0000'), 'conflict');
    const manager = new GitWorkspaceManager(runner);

    await expect(manager.integrate(fixtureWorkspace)).resolves.toEqual({
      status: 'blocked',
      workspace: {
        ...fixtureWorkspace,
        revision: 2,
        phase: 'INTEGRATION_BLOCKED',
        blocker: {
          type: 'rebase-conflict',
          detail: 'Rebase onto integration ref conflicted.',
          conflictPaths: []
        }
      }
    });
  });

  it('returns fast-forward and dirty integration evidence from Git failures and status', async () => {
    const runner = new FakeGitRunner();
    runner.outputs.set(['rebase', 'main'].join('\u0000'), '');
    runner.outputs.set(['status', '--porcelain=v1', '-z'].join('\u0000'), ' M dirty.txt\0');
    const manager = new GitWorkspaceManager(runner);

    const dirty = await manager.integrate(fixtureWorkspace);
    expect(dirty).toMatchObject({
      status: 'blocked',
      workspace: { blocker: { type: 'repository-dirty', conflictPaths: ['dirty.txt'] } }
    });

    runner.outputs.set(['status', '--porcelain=v1', '-z'].join('\u0000'), '');
    runner.failures.set(['switch', 'main'].join('\u0000'), 'switch failed');
    const fastForward = await manager.resumeIntegration(dirty.workspace);
    expect(fastForward).toMatchObject({
      status: 'blocked',
      workspace: { blocker: { type: 'fast-forward-failed' } }
    });
  });

  it('handles non-rebase integration blocks without running rebase commands', async () => {
    const runner = new FakeGitRunner();
    runner.outputs.set(['rebase', 'main'].join('\u0000'), '');
    runner.outputs.set(['status', '--porcelain=v1', '-z'].join('\u0000'), '');
    runner.outputs.set(['switch', 'main'].join('\u0000'), '');
    runner.outputs.set(['merge', '--ff-only', fixtureWorkspace.branchName].join('\u0000'), '');
    runner.outputs.set(['rev-parse', 'HEAD'].join('\u0000'), 'commit-1\n');
    const manager = new GitWorkspaceManager(runner);
    const blocked = {
      ...fixtureWorkspace,
      phase: 'INTEGRATION_BLOCKED' as const,
      blocker: { type: 'repository-dirty' as const, detail: 'Dirty.', conflictPaths: ['dirty.txt'] }
    };

    const resumed = await manager.resumeIntegration(blocked);
    expect(resumed).toMatchObject({
      status: 'integrated',
      workspace: { integrationCommit: 'commit-1' }
    });
    expect(runner.calls.some(({ args }) => args.includes('--continue'))).toBe(false);
    await expect(manager.abortIntegration(blocked)).resolves.toEqual({
      ...fixtureWorkspace,
      revision: 2
    });
  });

  it('keeps an unresolved rebase conflict phase-aware when continue fails', async () => {
    const runner = new FakeGitRunner();
    runner.failures.set(
      ['-c', 'core.editor=true', 'rebase', '--continue'].join('\u0000'),
      'still conflicted'
    );
    runner.failures.set(['diff', '--name-only', '--diff-filter=U', '-z'].join('\u0000'), 'no diff');
    const manager = new GitWorkspaceManager(runner);
    const blocked = {
      ...fixtureWorkspace,
      phase: 'INTEGRATION_BLOCKED' as const,
      blocker: {
        type: 'rebase-conflict' as const,
        detail: 'Conflict.',
        conflictPaths: ['value.txt']
      }
    };

    await expect(manager.resumeIntegration(blocked)).resolves.toMatchObject({
      status: 'blocked',
      workspace: {
        phase: 'INTEGRATION_BLOCKED',
        blocker: { type: 'rebase-conflict', conflictPaths: [] }
      }
    });
  });

  it('fails fast when a recorded rebase block has no active rebase to abort', async () => {
    const runner = new FakeGitRunner();
    runner.failures.set(['rebase', '--abort'].join('\u0000'), 'No rebase in progress.');
    const manager = new GitWorkspaceManager(runner);
    const blocked = {
      ...fixtureWorkspace,
      phase: 'INTEGRATION_BLOCKED' as const,
      blocker: {
        type: 'rebase-conflict' as const,
        detail: 'Conflict.',
        conflictPaths: ['value.txt']
      }
    };

    await expect(manager.abortIntegration(blocked)).rejects.toThrow('No rebase in progress.');
  });

  it('returns existing blocked workspace and records fast-forward merge failure', async () => {
    const runner = new FakeGitRunner();
    const manager = new GitWorkspaceManager(runner);
    const preBlocked = {
      ...fixtureWorkspace,
      phase: 'INTEGRATION_BLOCKED' as const,
      blocker: { type: 'fast-forward-failed' as const, detail: 'Blocked.', conflictPaths: [] }
    };
    await expect(manager.integrate(preBlocked)).resolves.toEqual({
      status: 'blocked',
      workspace: preBlocked
    });

    runner.outputs.set(['rebase', 'main'].join('\u0000'), '');
    runner.outputs.set(['status', '--porcelain=v1', '-z'].join('\u0000'), '');
    runner.outputs.set(['switch', 'main'].join('\u0000'), '');
    runner.failures.set(
      ['merge', '--ff-only', fixtureWorkspace.branchName].join('\u0000'),
      'merge failed'
    );
    await expect(manager.integrate(fixtureWorkspace)).resolves.toMatchObject({
      status: 'blocked',
      workspace: { blocker: { type: 'fast-forward-failed' } }
    });
  });

  it('rejects a missing integration reference before creating a worktree', async () => {
    const repositoryPath = createRepository();
    const manager = new GitWorkspaceManager();

    await expect(
      manager.create({ ...request(repositoryPath), integrationRef: 'missing-integration-ref' })
    ).rejects.toThrow(GitWorkspaceError);
  });

  it('preserves unexpected command-runner errors instead of treating them as Git integration blocks', async () => {
    const manager = new GitWorkspaceManager({
      run: async () => {
        throw new Error('Runner unavailable.');
      }
    });

    await expect(manager.integrate(fixtureWorkspace)).rejects.toThrow('Runner unavailable.');
  });

  it('uses a stable fallback message when a Git runner omits stderr', async () => {
    const runner = new FakeGitRunner();
    runner.failures.set(['rev-parse', '--verify', 'main'].join('\u0000'), '');
    const manager = new GitWorkspaceManager(runner);
    runner.missingWorkspacePaths.add(request('/repository').workspacePath);

    await expect(manager.create(request('/repository'))).rejects.toThrow(
      'Git command failed: git rev-parse --verify main'
    );
  });

  it('rejects missing base references before creating a worktree', async () => {
    const repositoryPath = createRepository();
    const manager = new GitWorkspaceManager();

    await expect(
      manager.create({ ...request(repositoryPath), baseRef: 'missing-ref' })
    ).rejects.toThrow(GitWorkspaceError);
  });

  it('keeps already integrated workspaces integrated and leaves ready workspaces unchanged on abort', async () => {
    const repositoryPath = createRepository();
    const manager = new GitWorkspaceManager();
    const workspace = await manager.create(request(repositoryPath));
    writeFileSync(join(workspace.workspacePath, 'task.txt'), 'task output\n');
    git(workspace.workspacePath, ['add', 'task.txt']);
    git(workspace.workspacePath, ['commit', '-m', 'task change']);
    const integration = await manager.integrate(workspace);
    if (integration.status !== 'integrated') {
      throw new Error('Expected integrated workspace.');
    }

    await expect(manager.integrate(integration.workspace)).resolves.toEqual(integration);
    await expect(manager.abortIntegration(workspace)).resolves.toEqual(workspace);
    await expect(manager.resumeIntegration(workspace)).rejects.toThrow(
      'Workspace is not integration blocked.'
    );
    await manager.dispose({ workspace: integration.workspace, force: false });
  });
});
