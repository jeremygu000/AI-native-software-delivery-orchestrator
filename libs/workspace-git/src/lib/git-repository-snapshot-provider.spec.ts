import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  GitRepositorySnapshotError,
  GitRepositorySnapshotProvider,
  type GitSnapshotCommandRunner
} from './git-repository-snapshot-provider.js';

const directories: string[] = [];

const git = (cwd: string, args: readonly string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const createRepository = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-snapshot-'));
  directories.push(directory);
  git(directory, ['init', '--initial-branch=main']);
  git(directory, ['config', 'user.email', 'test@example.com']);
  git(directory, ['config', 'user.name', 'Test User']);
  writeFileSync(join(directory, 'tracked.txt'), 'base\n');
  writeFileSync(join(directory, '.gitignore'), 'ignored.txt\n');
  git(directory, ['add', '.gitignore', 'tracked.txt']);
  git(directory, ['commit', '-m', 'base']);
  return directory;
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('GitRepositorySnapshotProvider', () => {
  it('captures commit, repository identity, and exact clean working-tree content', async () => {
    const repositoryPath = createRepository();
    const snapshot = await new GitRepositorySnapshotProvider().capture({ repositoryPath });

    expect(snapshot).toEqual({
      repositoryId: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      repositoryRoot: realpathSync(repositoryPath),
      baseCommit: git(repositoryPath, ['rev-parse', 'HEAD']),
      workingTreeFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      dirty: false
    });
  });

  it('changes the content fingerprint for tracked edits, untracked files, deletion, and symlink targets', async () => {
    const repositoryPath = createRepository();
    const provider = new GitRepositorySnapshotProvider();
    const clean = await provider.capture({ repositoryPath });

    writeFileSync(join(repositoryPath, 'tracked.txt'), 'changed\n');
    const modified = await provider.capture({ repositoryPath });
    writeFileSync(join(repositoryPath, 'untracked.txt'), 'new\n');
    const untracked = await provider.capture({ repositoryPath });
    rmSync(join(repositoryPath, 'tracked.txt'));
    const deleted = await provider.capture({ repositoryPath });
    symlinkSync('first-target', join(repositoryPath, 'alias'));
    const firstLink = await provider.capture({ repositoryPath });
    rmSync(join(repositoryPath, 'alias'));
    symlinkSync('second-target', join(repositoryPath, 'alias'));
    const secondLink = await provider.capture({ repositoryPath });

    expect(
      new Set(
        [clean, modified, untracked, deleted, firstLink, secondLink].map(
          (item) => item.workingTreeFingerprint
        )
      ).size
    ).toBe(6);
    expect([modified, untracked, deleted, firstLink, secondLink].every((item) => item.dirty)).toBe(
      true
    );
  });

  it('excludes ignored build state from the source snapshot', async () => {
    const repositoryPath = createRepository();
    const provider = new GitRepositorySnapshotProvider();
    const before = await provider.capture({ repositoryPath });
    writeFileSync(join(repositoryPath, 'ignored.txt'), 'local cache\n');
    const after = await provider.capture({ repositoryPath });

    expect(after.workingTreeFingerprint).toBe(before.workingTreeFingerprint);
    expect(after.dirty).toBe(false);
  });

  it('uses origin identity when available so clones share a repository ID', async () => {
    const firstPath = createRepository();
    const secondPath = createRepository();
    git(firstPath, ['remote', 'add', 'origin', 'git@example.com:owner/repository.git']);
    git(secondPath, ['remote', 'add', 'origin', 'git@example.com:owner/repository.git']);

    const provider = new GitRepositorySnapshotProvider();
    expect((await provider.capture({ repositoryPath: firstPath })).repositoryId).toBe(
      (await provider.capture({ repositoryPath: secondPath })).repositoryId
    );
  });

  it('fails closed when Git does not return a valid commit identity', async () => {
    const runner: GitSnapshotCommandRunner = {
      run: async (_cwd, args) => ({
        stdout: args.includes('--show-toplevel') ? '/tmp\n' : 'not-a-commit\n',
        stderr: ''
      })
    };

    await expect(
      new GitRepositorySnapshotProvider(runner).capture({ repositoryPath: '/tmp' })
    ).rejects.toBeInstanceOf(GitRepositorySnapshotError);
  });

  it('fails closed instead of claiming to fingerprint mutable submodule contents', async () => {
    const repositoryPath = createRepository();
    const baseCommit = git(repositoryPath, ['rev-parse', 'HEAD']);
    const runner: GitSnapshotCommandRunner = {
      run: async (_cwd, args) => {
        const command = args.join(' ');
        if (command === 'rev-parse --show-toplevel') {
          return { stdout: `${repositoryPath}\n`, stderr: '' };
        }
        if (command === 'rev-parse --verify HEAD^{commit}') {
          return { stdout: `${baseCommit}\n`, stderr: '' };
        }
        if (command === 'remote get-url origin') {
          throw new GitRepositorySnapshotError(args, 'no remote');
        }
        if (command === 'ls-files --stage -z') {
          return { stdout: `160000 ${'a'.repeat(40)} 0\tvendor/library\0`, stderr: '' };
        }
        return { stdout: '', stderr: '' };
      }
    };

    await expect(
      new GitRepositorySnapshotProvider(runner).capture({ repositoryPath })
    ).rejects.toThrow('Git submodules are not supported');
  });

  it('fails closed when repository paths collide after portable normalization and lowercasing', async () => {
    const repositoryPath = createRepository();
    const baseCommit = git(repositoryPath, ['rev-parse', 'HEAD']);
    const runner: GitSnapshotCommandRunner = {
      run: async (_cwd, args) => {
        const command = args.join(' ');
        if (command === 'rev-parse --show-toplevel') {
          return { stdout: `${repositoryPath}\n`, stderr: '' };
        }
        if (command === 'rev-parse --verify HEAD^{commit}') {
          return { stdout: `${baseCommit}\n`, stderr: '' };
        }
        if (command === 'remote get-url origin') {
          throw new GitRepositorySnapshotError(args, 'no remote');
        }
        if (command === 'ls-files --cached --others --exclude-standard -z') {
          return { stdout: 'src/File.ts\0src/file.ts\0', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      }
    };

    await expect(
      new GitRepositorySnapshotProvider(runner).capture({ repositoryPath })
    ).rejects.toThrow('collide on a case-insensitive filesystem');
  });

  it('accepts distinct paths that remain distinct after portable normalization and lowercasing', async () => {
    const repositoryPath = createRepository();
    const baseCommit = git(repositoryPath, ['rev-parse', 'HEAD']);
    const runner: GitSnapshotCommandRunner = {
      run: async (_cwd, args) => {
        const command = args.join(' ');
        if (command === 'rev-parse --show-toplevel') {
          return { stdout: `${repositoryPath}\n`, stderr: '' };
        }
        if (command === 'rev-parse --verify HEAD^{commit}') {
          return { stdout: `${baseCommit}\n`, stderr: '' };
        }
        if (command === 'remote get-url origin') {
          throw new GitRepositorySnapshotError(args, 'no remote');
        }
        if (command === 'ls-files --cached --others --exclude-standard -z') {
          return { stdout: 'src/Alpha.ts\0src/beta.ts\0', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      }
    };

    await expect(
      new GitRepositorySnapshotProvider(runner).capture({ repositoryPath })
    ).resolves.toMatchObject({
      repositoryRoot: realpathSync(repositoryPath),
      baseCommit
    });
  });
});
