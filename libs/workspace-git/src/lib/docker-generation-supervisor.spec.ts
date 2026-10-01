import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import {
  DockerGenerationSupervisorError,
  DockerWorkspaceGenerationSupervisor
} from './docker-generation-supervisor.js';
import { GitWorkspaceManager } from './git-workspace-manager.js';

it('rejects unpinned images before any container is created', () => {
  expect(
    () =>
      new DockerWorkspaceGenerationSupervisor({ supervisorId: 'supervisor', image: 'node:latest' })
  ).toThrow(DockerGenerationSupervisorError);
});

it('rejects missing supervisor identity, commands, and non-directory workspaces before Docker', async () => {
  expect(
    () =>
      new DockerWorkspaceGenerationSupervisor({
        supervisorId: ' ',
        image: 'node@sha256:' + 'a'.repeat(64)
      })
  ).toThrow(DockerGenerationSupervisorError);
  const supervisor = new DockerWorkspaceGenerationSupervisor({
    supervisorId: 'independent',
    image: 'node@sha256:' + 'a'.repeat(64),
    dockerExecutable: 'a-nonexistent-docker-executable'
  });
  const directory = mkdtempSync(join(tmpdir(), 'forge-supervisor-input-'));
  const file = join(directory, 'not-a-workspace');
  writeFileSync(file, 'not a directory');
  const request = {
    scopeId: 'scope',
    parentClaimId: 'parent',
    generationId: 'generation',
    workspaceId: 'workspace',
    workspacePath: directory
  };
  try {
    await expect(supervisor.launch({ ...request, command: [] })).rejects.toThrow(
      'An explicit worker command is required'
    );
    await expect(supervisor.launch({ ...request, command: [' '] })).rejects.toThrow(
      'An explicit worker command is required'
    );
    await expect(
      supervisor.launch({ ...request, workspacePath: file, command: ['node'] })
    ).rejects.toThrow('Supervised workspace must be a directory');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// A real daemon and an explicitly pinned, locally available image are required.
// CI without Docker still runs the deterministic validation above.
it.skipIf(!process.env['FORGE_TEST_DOCKER_IMAGE'])(
  'stops the isolated writer and its descendants and does not relaunch the same generation',
  async () => {
    const image = process.env['FORGE_TEST_DOCKER_IMAGE'];
    if (!image) {
      throw new Error('A pinned Docker test image is required');
    }
    const integration = mkdtempSync(join(tmpdir(), 'forge-supervised-integration-'));
    const directory = `${integration}-worktree`;
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: integration, encoding: 'utf8' }).trim();
    git('init', '--initial-branch=main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test User');
    git('commit', '--allow-empty', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    const workspace = await new GitWorkspaceManager().create({
      id: 'workspace',
      runId: 'run',
      taskId: 'task',
      integrationRepositoryPath: integration,
      workspacePath: directory,
      branchName: 'forge/run/task',
      baseRef: 'main',
      integrationRef: 'main'
    });
    chmodSync(directory, 0o777);
    const supervisor = new DockerWorkspaceGenerationSupervisor({
      supervisorId: 'independent',
      image
    });
    let containerId: string | undefined;
    try {
      const generation = await supervisor.launch({
        scopeId: 'scope',
        parentClaimId: 'parent',
        generationId: 'generation',
        workspaceId: 'workspace',
        workspacePath: directory,
        command: [
          'node',
          '-e',
          "require('node:child_process').spawn(process.execPath,['-e',\"setInterval(()=>require('node:fs').appendFileSync('/workspace/descendant','x'),20)\"],{stdio:'ignore'});setInterval(()=>{},1000)"
        ]
      });
      containerId = generation.containerId;
      await expect(supervisor.assertStopped(generation)).rejects.toThrow(
        DockerGenerationSupervisorError
      );
      const outputPath = join(directory, 'descendant');
      for (let attempt = 0; attempt < 50 && !existsSync(outputPath); attempt += 1) {
        await new Promise((complete) => setTimeout(complete, 100));
      }
      expect(existsSync(outputPath)).toBe(true);
      await supervisor.stopAndVerify(generation);
      await supervisor.assertStopped(generation);
      const observed = readFileSync(outputPath, 'utf8');
      await new Promise((complete) => setTimeout(complete, 150));
      expect(readFileSync(outputPath, 'utf8')).toBe(observed);
      await expect(
        new DockerWorkspaceGenerationSupervisor({ supervisorId: 'another', image }).assertStopped(
          generation
        )
      ).rejects.toThrow(DockerGenerationSupervisorError);
      rmSync(outputPath);
      await expect(
        supervisor.inspectStoppedWorkspace(generation, {
          workspace,
          approvedRepositoryRoot: integration,
          approvedBaseCommit: base
        })
      ).resolves.toMatchObject({ workspaceId: 'workspace', headCommit: base, clean: true });
      await expect(
        supervisor.inspectStoppedWorkspace(
          { ...generation, workspaceId: 'wrong' },
          { workspace, approvedRepositoryRoot: integration, approvedBaseCommit: base }
        )
      ).rejects.toThrow(DockerGenerationSupervisorError);
      await expect(
        supervisor.launch({
          scopeId: 'scope',
          parentClaimId: 'parent',
          generationId: 'generation',
          workspaceId: 'workspace',
          workspacePath: directory,
          command: ['node', '-e', 'process.exit(0)']
        })
      ).rejects.toThrow(DockerGenerationSupervisorError);
      rmSync(directory, { recursive: true });
      await expect(supervisor.assertStopped(generation)).rejects.toThrow();
    } finally {
      if (containerId) {
        execFileSync('docker', ['rm', '-f', containerId]);
      }
      rmSync(directory, { recursive: true, force: true });
      rmSync(integration, { recursive: true, force: true });
    }
  },
  30_000
);
