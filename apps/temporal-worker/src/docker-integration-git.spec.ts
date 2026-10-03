import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { GitWorkspaceManager } from '@ai-native-software-delivery-orchestrator/workspace-git';
import { DockerIntegrationGit } from './docker-integration-git.js';

it('requires an immutable Git image before any mutation', () => {
  expect(
    () =>
      new DockerIntegrationGit({
        image: 'alpine/git:latest',
        workspace: {
          id: 'workspace',
          runId: 'run',
          taskId: 'task',
          integrationRepositoryPath: '/repo',
          workspacePath: '/worktree',
          branchName: 'forge/task',
          baseRef: 'main',
          integrationRef: 'main',
          revision: 1,
          phase: 'READY_TO_INTEGRATE'
        }
      })
  ).toThrow('digest');
});

it.skipIf(process.env.FORGE_TEST_GIT_IMAGE === undefined)(
  'commits and integrates inside inspected networkless Git containers',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-container-git-'));
    const worktree = `${root}-worktree`;
    try {
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
      git('init', '--initial-branch=main');
      git('config', 'user.name', 'Forge Test');
      git('config', 'user.email', 'forge@example.test');
      writeFileSync(join(root, 'value.txt'), 'before');
      git('add', '.');
      git('commit', '-m', 'base');
      git('config', '--unset', 'user.name');
      git('config', '--unset', 'user.email');
      const workspace = await new GitWorkspaceManager().create({
        id: 'workspace',
        runId: 'run',
        taskId: 'task',
        integrationRepositoryPath: root,
        workspacePath: worktree,
        branchName: 'forge/task',
        baseRef: 'main',
        integrationRef: 'main'
      });
      writeFileSync(join(worktree, 'value.txt'), 'after');
      const runner = new DockerIntegrationGit({
        image: process.env.FORGE_TEST_GIT_IMAGE!,
        workspace,
        commitIdentity: { name: 'Forge Integration', email: 'forge-integration@example.test' }
      });
      const manager = new GitWorkspaceManager(runner);
      await expect(runner.run('/tmp', ['status'])).rejects.toThrow('outside');
      await expect(
        manager.commit({ workspace, message: 'approved change' })
      ).resolves.toBeDefined();
      expect((await manager.integrate(workspace)).workspace.phase).toBe('INTEGRATED');
      expect(git('show', 'main:value.txt')).toBe('after');
      expect(git('log', '-1', '--format=%an <%ae>')).toBe(
        'Forge Integration <forge-integration@example.test>'
      );
      expect(() => git('config', '--local', '--get', 'user.name')).toThrow();
      expect(() => git('config', '--local', '--get', 'user.email')).toThrow();
      expect(runner.confirmedStopEvidence()).toContain('Docker Git process trees exited');
    } finally {
      rmSync(worktree, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
  60_000
);
