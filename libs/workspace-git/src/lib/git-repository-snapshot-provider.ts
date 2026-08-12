import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import type {
  RepositoryContext,
  RepositorySnapshot,
  RepositorySnapshotProvider
} from '@ai-native-software-delivery-orchestrator/domain';

interface GitSnapshotCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitSnapshotCommandRunner {
  run(cwd: string, args: readonly string[]): Promise<GitSnapshotCommandResult>;
}

class NativeGitSnapshotCommandRunner implements GitSnapshotCommandRunner {
  run(cwd: string, args: readonly string[]): Promise<GitSnapshotCommandResult> {
    return new Promise((complete, reject) => {
      execFile(
        'git',
        args,
        { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error !== null) {
            reject(new GitRepositorySnapshotError(args, stderr));
            return;
          }
          complete({ stdout, stderr });
        }
      );
    });
  }
}

export class GitRepositorySnapshotError extends Error {
  readonly command: readonly string[];
  readonly stderr: string;

  constructor(command: readonly string[], stderr: string) {
    super(stderr || `Git snapshot command failed: git ${command.join(' ')}`);
    this.name = 'GitRepositorySnapshotError';
    this.command = command;
    this.stderr = stderr;
  }
}

const digest = (value: string): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;

const updateFramed = (hash: ReturnType<typeof createHash>, value: string | Buffer): void => {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  hash.update(String(bytes.length));
  hash.update(':');
  hash.update(bytes);
  hash.update('\0');
};

const listedPaths = (output: string): readonly string[] =>
  output
    .split('\0')
    .filter((path) => path.length > 0)
    .toSorted();

const assertPortablePathIdentities = (paths: readonly string[]): void => {
  const identities = new Map<string, string>();
  for (const path of paths) {
    const identity = path.normalize('NFD').toLowerCase();
    const existing = identities.get(identity);
    if (existing !== undefined && existing !== path) {
      throw new GitRepositorySnapshotError(
        ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
        `Repository contains paths that collide on a case-insensitive filesystem: ${existing}, ${path}`
      );
    }
    identities.set(identity, path);
  }
};

const errorCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;

export class GitRepositorySnapshotProvider implements RepositorySnapshotProvider {
  readonly #runner: GitSnapshotCommandRunner;

  constructor(runner: GitSnapshotCommandRunner = new NativeGitSnapshotCommandRunner()) {
    this.#runner = runner;
  }

  async capture(repository: RepositoryContext): Promise<RepositorySnapshot> {
    const requestedPath = resolve(repository.repositoryPath);
    const rootResult = await this.#runner.run(requestedPath, ['rev-parse', '--show-toplevel']);
    const repositoryRoot = await realpath(rootResult.stdout.trim());
    const baseCommit = (
      await this.#runner.run(repositoryRoot, ['rev-parse', '--verify', 'HEAD^{commit}'])
    ).stdout.trim();
    if (!/^[0-9a-f]{40,64}$/i.test(baseCommit)) {
      throw new GitRepositorySnapshotError(
        ['rev-parse', '--verify', 'HEAD^{commit}'],
        `Git returned an invalid base commit: ${baseCommit}`
      );
    }

    const repositoryIdentity = await this.#repositoryIdentity(repositoryRoot);
    const [trackedFiles, stagedEntries, status] = await Promise.all([
      this.#runner.run(repositoryRoot, [
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '-z'
      ]),
      this.#runner.run(repositoryRoot, ['ls-files', '--stage', '-z']),
      this.#runner.run(repositoryRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    ]);
    if (stagedEntries.stdout.split('\0').some((entry) => entry.startsWith('160000 '))) {
      throw new GitRepositorySnapshotError(
        ['ls-files', '--stage', '-z'],
        'Git submodules are not supported by repository snapshot fingerprinting'
      );
    }

    const paths = listedPaths(trackedFiles.stdout);
    assertPortablePathIdentities(paths);
    return {
      repositoryId: digest(repositoryIdentity),
      repositoryRoot,
      baseCommit: baseCommit.toLowerCase(),
      workingTreeFingerprint: await this.#workingTreeFingerprint(repositoryRoot, paths),
      dirty: status.stdout.length > 0
    };
  }

  async #repositoryIdentity(repositoryRoot: string): Promise<string> {
    try {
      const remote = await this.#runner.run(repositoryRoot, ['remote', 'get-url', 'origin']);
      const url = remote.stdout.trim();
      if (url.length > 0) {
        return `origin\0${url}`;
      }
    } catch (error) {
      if (!(error instanceof GitRepositorySnapshotError)) {
        throw error;
      }
    }
    return `local-root\0${repositoryRoot}`;
  }

  async #workingTreeFingerprint(repositoryRoot: string, paths: readonly string[]): Promise<string> {
    const hash = createHash('sha256');
    updateFramed(hash, 'forge-working-tree-v1');
    for (const path of paths) {
      updateFramed(hash, path);
      const absolutePath = resolve(repositoryRoot, path);
      try {
        const metadata = await lstat(absolutePath);
        updateFramed(hash, String(metadata.mode));
        if (metadata.isSymbolicLink()) {
          updateFramed(hash, 'symlink');
          updateFramed(hash, await readlink(absolutePath));
        } else if (metadata.isFile()) {
          updateFramed(hash, 'file');
          updateFramed(hash, await readFile(absolutePath));
        } else {
          updateFramed(hash, 'other');
        }
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') {
          throw error;
        }
        updateFramed(hash, 'missing');
      }
    }
    return `sha256:${hash.digest('hex')}`;
  }
}
