import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  GitIntegrationCheckoutError,
  GitIntegrationCheckoutProvisioner
} from './git-integration-checkout-provisioner.js';

const directories: string[] = [];

const git = (cwd: string, args: readonly string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const createRepository = (): { repositoryPath: string; commit: string } => {
  const repositoryPath = mkdtempSync(join(tmpdir(), 'forge-integration-source-'));
  directories.push(repositoryPath);
  git(repositoryPath, ['init', '--initial-branch=main']);
  git(repositoryPath, ['config', 'user.email', 'test@example.com']);
  git(repositoryPath, ['config', 'user.name', 'Test User']);
  writeFileSync(join(repositoryPath, 'value.txt'), 'approved\n');
  git(repositoryPath, ['add', 'value.txt']);
  git(repositoryPath, ['commit', '-m', 'approved']);
  return { repositoryPath, commit: git(repositoryPath, ['rev-parse', 'HEAD']) };
};

const createCheckoutRoot = (): string => {
  const checkoutRoot = mkdtempSync(join(tmpdir(), 'forge-runs-'));
  directories.push(checkoutRoot);
  return checkoutRoot;
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('GitIntegrationCheckoutProvisioner', () => {
  it('creates and idempotently reuses an isolated checkout at the approved commit', async () => {
    const { repositoryPath, commit } = createRepository();
    const checkoutRoot = createCheckoutRoot();
    const provisioner = new GitIntegrationCheckoutProvisioner(checkoutRoot);
    const request = { runId: 'run-1', sourceRepositoryPath: repositoryPath, baseCommit: commit };

    const first = await provisioner.provision(request);
    writeFileSync(join(first.repositoryPath, 'integrated.txt'), 'task output\n');
    git(first.repositoryPath, ['add', 'integrated.txt']);
    git(first.repositoryPath, [
      'commit',
      '-m',
      'integrated task',
      '-m',
      'Forge-Run-Id: run-1\nForge-Task-Id: task-1'
    ]);
    const second = await provisioner.provision(request);

    expect(second).toEqual(first);
    expect(first.repositoryPath).toBe(realpathSync(join(checkoutRoot, 'run-1', 'integration')));
    expect(git(first.repositoryPath, ['merge-base', '--is-ancestor', commit, 'HEAD'])).toBe('');
    expect(git(first.repositoryPath, ['branch', '--show-current'])).toBe('forge/integration/run-1');
  });

  it('rejects a dirty existing integration checkout', async () => {
    const { repositoryPath, commit } = createRepository();
    const checkoutRoot = createCheckoutRoot();
    const provisioner = new GitIntegrationCheckoutProvisioner(checkoutRoot);
    const request = { runId: 'run-1', sourceRepositoryPath: repositoryPath, baseCommit: commit };
    const checkout = await provisioner.provision(request);
    writeFileSync(join(checkout.repositoryPath, 'dirty.txt'), 'dirty\n');

    await expect(provisioner.provision(request)).rejects.toThrow(
      'Existing integration checkout is dirty'
    );
  });

  it('rejects a clean commit that is not marked as output from the requested run', async () => {
    const { repositoryPath, commit } = createRepository();
    const checkoutRoot = createCheckoutRoot();
    const provisioner = new GitIntegrationCheckoutProvisioner(checkoutRoot);
    const request = { runId: 'run-1', sourceRepositoryPath: repositoryPath, baseCommit: commit };
    const checkout = await provisioner.provision(request);
    writeFileSync(join(checkout.repositoryPath, 'unrelated.txt'), 'unrelated\n');
    git(checkout.repositoryPath, ['add', 'unrelated.txt']);
    git(checkout.repositoryPath, ['commit', '-m', 'unrelated commit']);

    await expect(provisioner.provision(request)).rejects.toThrow(
      'contains a commit not owned by the requested run'
    );
  });

  it('rejects reuse when the approved commit belongs to unrelated history', async () => {
    const { repositoryPath, commit } = createRepository();
    const checkoutRoot = createCheckoutRoot();
    const provisioner = new GitIntegrationCheckoutProvisioner(checkoutRoot);
    const request = { runId: 'run-1', sourceRepositoryPath: repositoryPath, baseCommit: commit };
    const checkout = await provisioner.provision(request);
    git(checkout.repositoryPath, ['checkout', '--orphan', 'unrelated']);
    git(checkout.repositoryPath, ['rm', '-rf', '.']);
    writeFileSync(join(checkout.repositoryPath, 'unrelated.txt'), 'unrelated\n');
    git(checkout.repositoryPath, ['add', 'unrelated.txt']);
    git(checkout.repositoryPath, ['commit', '-m', 'unrelated', '-m', 'Forge-Run-Id: run-1']);
    git(checkout.repositoryPath, ['branch', '-M', 'forge/integration/run-1']);

    await expect(provisioner.provision(request)).rejects.toBeInstanceOf(
      GitIntegrationCheckoutError
    );
  });

  it('rejects reuse when the existing checkout no longer matches its authority', async () => {
    const { repositoryPath, commit } = createRepository();
    const checkoutRoot = createCheckoutRoot();
    const provisioner = new GitIntegrationCheckoutProvisioner(checkoutRoot);
    const request = { runId: 'run-1', sourceRepositoryPath: repositoryPath, baseCommit: commit };
    const checkout = await provisioner.provision(request);
    git(checkout.repositoryPath, ['switch', '--detach']);

    await expect(provisioner.provision(request)).rejects.toThrow(
      'Existing integration checkout does not match'
    );
  });

  it('rejects invalid identities and checkout roots inside the approved source', async () => {
    const { repositoryPath, commit } = createRepository();

    await expect(
      new GitIntegrationCheckoutProvisioner(join(repositoryPath, '.forge')).provision({
        runId: 'run-1',
        sourceRepositoryPath: repositoryPath,
        baseCommit: commit
      })
    ).rejects.toThrow('outside the approved source repository');
    await expect(
      new GitIntegrationCheckoutProvisioner(createCheckoutRoot()).provision({
        runId: '../escape',
        sourceRepositoryPath: repositoryPath,
        baseCommit: commit
      })
    ).rejects.toBeInstanceOf(GitIntegrationCheckoutError);
  });

  it('rejects a symlinked run directory that escapes the checkout root', async () => {
    const { repositoryPath, commit } = createRepository();
    const checkoutRoot = createCheckoutRoot();
    const escapeRoot = createCheckoutRoot();
    symlinkSync(escapeRoot, join(checkoutRoot, 'run-1'));

    await expect(
      new GitIntegrationCheckoutProvisioner(checkoutRoot).provision({
        runId: 'run-1',
        sourceRepositoryPath: repositoryPath,
        baseCommit: commit
      })
    ).rejects.toThrow('escapes checkout root');
    expect(existsSync(join(escapeRoot, 'integration'))).toBe(false);
  });

  it('rejects an existing integration checkout reached through an escaping symlink', async () => {
    const { repositoryPath, commit } = createRepository();
    const checkoutRoot = createCheckoutRoot();
    const escapeRoot = createCheckoutRoot();
    const escapedCheckout = join(escapeRoot, 'integration');
    git(escapeRoot, ['clone', repositoryPath, 'integration']);
    git(escapedCheckout, ['switch', '-c', 'forge/integration/run-1']);
    symlinkSync(escapeRoot, join(checkoutRoot, 'run-1'));

    await expect(
      new GitIntegrationCheckoutProvisioner(checkoutRoot).provision({
        runId: 'run-1',
        sourceRepositoryPath: repositoryPath,
        baseCommit: commit
      })
    ).rejects.toThrow('Existing integration checkout escapes checkout root');
  });
});
