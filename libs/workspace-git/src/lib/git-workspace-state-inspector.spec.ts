import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { GitWorkspaceManager } from './git-workspace-manager.js';
import {
  GitWorkspaceInspectionError,
  GitWorkspaceStateInspector
} from './git-workspace-state-inspector.js';

const directories: string[] = [];
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const fixture = async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-workspace-observation-'));
  directories.push(directory);
  git(directory, 'init', '--initial-branch=main');
  git(directory, 'config', 'user.email', 'test@example.com');
  git(directory, 'config', 'user.name', 'Test User');
  writeFileSync(join(directory, 'file.txt'), 'initial\n');
  git(directory, 'add', 'file.txt');
  git(directory, 'commit', '-m', 'base');
  const baseCommit = git(directory, 'rev-parse', 'HEAD');
  const workspace = await new GitWorkspaceManager().create({
    id: 'workspace-1',
    runId: 'run-1',
    taskId: 'task-1',
    integrationRepositoryPath: directory,
    workspacePath: `${directory}-worktree`,
    branchName: 'forge/run-1/task-1',
    baseRef: 'main',
    integrationRef: 'main'
  });
  directories.push(workspace.workspacePath);
  return { directory, workspace, baseCommit };
};

afterEach(() => {
  for (const directory of directories.splice(0).toReversed()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('GitWorkspaceStateInspector', () => {
  it('observes the actual linked worktree, pinned base, symbolic branch and clean status', async () => {
    const { directory, workspace, baseCommit } = await fixture();
    await expect(
      new GitWorkspaceStateInspector().inspect({
        workspace,
        approvedRepositoryRoot: directory,
        approvedBaseCommit: baseCommit
      })
    ).resolves.toMatchObject({
      workspaceId: 'workspace-1',
      workspaceRevision: 1,
      worktreePath: realpathSync(workspace.workspacePath),
      integrationRepositoryPath: realpathSync(directory),
      headCommit: baseCommit,
      baseCommit,
      branchRef: 'refs/heads/forge/run-1/task-1',
      branchCommit: baseCommit,
      clean: true
    });
  });

  it('rejects changed base, branch, dirty worktree, and a different Git repository', async () => {
    const { directory, workspace, baseCommit } = await fixture();
    const inspector = new GitWorkspaceStateInspector();
    const request = {
      workspace,
      approvedRepositoryRoot: directory,
      approvedBaseCommit: baseCommit
    };
    await expect(
      inspector.inspect({ ...request, approvedBaseCommit: '0'.repeat(40) })
    ).rejects.toThrow(GitWorkspaceInspectionError);
    await expect(
      inspector.inspect({ ...request, workspace: { ...workspace, branchName: 'other' } })
    ).rejects.toThrow(GitWorkspaceInspectionError);
    writeFileSync(join(workspace.workspacePath, 'untracked.txt'), 'untracked\n');
    await expect(inspector.inspect(request)).rejects.toThrow(GitWorkspaceInspectionError);
    rmSync(join(workspace.workspacePath, 'untracked.txt'));
    const otherRepository = mkdtempSync(join(tmpdir(), 'forge-unrelated-repository-'));
    directories.push(otherRepository);
    git(otherRepository, 'init', '--initial-branch=main');
    await expect(
      inspector.inspect({ ...request, approvedRepositoryRoot: otherRepository })
    ).rejects.toThrow(GitWorkspaceInspectionError);
  });

  it('rejects nested paths and progressed workspace records as initial setup evidence', async () => {
    const { directory, workspace, baseCommit } = await fixture();
    const inspector = new GitWorkspaceStateInspector();
    const request = {
      workspace,
      approvedRepositoryRoot: directory,
      approvedBaseCommit: baseCommit
    };
    await expect(
      inspector.inspect({
        ...request,
        workspace: { ...workspace, workspacePath: join(directory, 'subdir') }
      })
    ).rejects.toThrow();
    await expect(
      inspector.inspect({ ...request, workspace: { ...workspace, revision: 2 } })
    ).rejects.toThrow(GitWorkspaceInspectionError);
  });

  it('rejects a foreign Git repository placed at the approved worktree path', async () => {
    const { directory, workspace, baseCommit } = await fixture();
    git(directory, 'worktree', 'remove', '--force', workspace.workspacePath);
    mkdirSync(workspace.workspacePath);
    git(workspace.workspacePath, 'init', '--initial-branch=main');
    await expect(
      new GitWorkspaceStateInspector().inspect({
        workspace,
        approvedRepositoryRoot: directory,
        approvedBaseCommit: baseCommit
      })
    ).rejects.toThrow(GitWorkspaceInspectionError);
  });

  it('rejects ignored files and a detached or moved Git HEAD', async () => {
    const { directory, workspace, baseCommit } = await fixture();
    const inspector = new GitWorkspaceStateInspector();
    const request = {
      workspace,
      approvedRepositoryRoot: directory,
      approvedBaseCommit: baseCommit
    };
    writeFileSync(join(workspace.workspacePath, '.gitignore'), 'ignored.txt\n');
    writeFileSync(join(workspace.workspacePath, 'ignored.txt'), 'unexpected\n');
    await expect(inspector.inspect(request)).rejects.toThrow(GitWorkspaceInspectionError);
    rmSync(join(workspace.workspacePath, 'ignored.txt'));
    rmSync(join(workspace.workspacePath, '.gitignore'));
    git(workspace.workspacePath, 'checkout', '--detach', 'HEAD');
    await expect(inspector.inspect(request)).rejects.toThrow(GitWorkspaceInspectionError);
    git(workspace.workspacePath, 'checkout', workspace.branchName);
    writeFileSync(join(workspace.workspacePath, 'file.txt'), 'changed\n');
    git(workspace.workspacePath, 'add', 'file.txt');
    git(workspace.workspacePath, 'commit', '-m', 'moved');
    await expect(inspector.inspect(request)).rejects.toThrow(GitWorkspaceInspectionError);
  });
});
