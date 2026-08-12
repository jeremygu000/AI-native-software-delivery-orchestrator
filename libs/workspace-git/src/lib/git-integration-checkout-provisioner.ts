import { execFile } from 'node:child_process';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
}

interface IntegrationCheckoutProvisionRequest {
  readonly runId: string;
  readonly sourceRepositoryPath: string;
  readonly baseCommit: string;
}

interface ProvisionedIntegrationCheckout {
  readonly repositoryPath: string;
  readonly baseCommit: string;
  readonly integrationRef: string;
}

export interface IntegrationCheckoutCommandRunner {
  run(cwd: string, args: readonly string[]): Promise<GitResult>;
}

class NativeIntegrationCheckoutCommandRunner implements IntegrationCheckoutCommandRunner {
  run(cwd: string, args: readonly string[]): Promise<GitResult> {
    return new Promise((complete, reject) => {
      execFile('git', args, { cwd, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error !== null) {
          reject(new GitIntegrationCheckoutError(args, stderr));
          return;
        }
        complete({ stdout, stderr });
      });
    });
  }
}

export class GitIntegrationCheckoutError extends Error {
  readonly command: readonly string[];

  constructor(command: readonly string[], detail: string) {
    super(detail.trim() || `Git integration checkout command failed: git ${command.join(' ')}`);
    this.name = 'GitIntegrationCheckoutError';
    this.command = command;
  }
}

const isWithin = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
};

const hasRunTrailer = (message: string, runId: string): boolean =>
  message.split(/\r?\n/u).some((line) => line.trim() === `Forge-Run-Id: ${runId}`);

export class GitIntegrationCheckoutProvisioner {
  readonly #checkoutRoot: string;
  readonly #runner: IntegrationCheckoutCommandRunner;

  constructor(
    checkoutRoot: string,
    runner: IntegrationCheckoutCommandRunner = new NativeIntegrationCheckoutCommandRunner()
  ) {
    this.#checkoutRoot = resolve(checkoutRoot);
    this.#runner = runner;
  }

  async provision(
    request: IntegrationCheckoutProvisionRequest
  ): Promise<ProvisionedIntegrationCheckout> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(request.runId)) {
      throw new GitIntegrationCheckoutError([], `Invalid run ID: ${request.runId}`);
    }
    if (!/^[0-9a-f]{40,64}$/.test(request.baseCommit)) {
      throw new GitIntegrationCheckoutError([], `Invalid base commit: ${request.baseCommit}`);
    }
    const sourceRepositoryPath = await realpath(request.sourceRepositoryPath);
    await mkdir(this.#checkoutRoot, { recursive: true });
    const checkoutRoot = await realpath(this.#checkoutRoot);
    if (isWithin(sourceRepositoryPath, checkoutRoot)) {
      throw new GitIntegrationCheckoutError(
        [],
        'Integration checkout root must be outside the approved source repository'
      );
    }
    const runRoot = join(checkoutRoot, request.runId);
    const repositoryPath = join(runRoot, 'integration');
    const integrationRef = `forge/integration/${request.runId}`;
    if (await pathExists(repositoryPath)) {
      const resolvedRepositoryPath = await realpath(repositoryPath);
      if (!isWithin(checkoutRoot, resolvedRepositoryPath)) {
        throw new GitIntegrationCheckoutError(
          [],
          'Existing integration checkout escapes checkout root'
        );
      }
      const [branch, status] = await Promise.all([
        this.#runner.run(resolvedRepositoryPath, ['branch', '--show-current']),
        this.#runner.run(resolvedRepositoryPath, ['status', '--porcelain=v1', '-z'])
      ]);
      if (branch.stdout.trim() !== integrationRef) {
        throw new GitIntegrationCheckoutError(
          ['branch', '--show-current'],
          'Existing integration checkout does not match the requested run'
        );
      }
      if (status.stdout.length > 0) {
        throw new GitIntegrationCheckoutError(
          ['status', '--porcelain=v1', '-z'],
          'Existing integration checkout is dirty'
        );
      }
      await this.#runner.run(resolvedRepositoryPath, [
        'merge-base',
        '--is-ancestor',
        request.baseCommit,
        'HEAD'
      ]);
      const history = await this.#runner.run(resolvedRepositoryPath, [
        'log',
        '--format=%B%x00',
        `${request.baseCommit}..HEAD`
      ]);
      const messages = history.stdout.split('\0').filter((message) => message.trim().length > 0);
      if (messages.some((message) => !hasRunTrailer(message, request.runId))) {
        throw new GitIntegrationCheckoutError(
          ['log', '--format=%B%x00', `${request.baseCommit}..HEAD`],
          'Existing integration checkout contains a commit not owned by the requested run'
        );
      }
      return {
        repositoryPath: resolvedRepositoryPath,
        baseCommit: request.baseCommit,
        integrationRef
      };
    }
    await mkdir(runRoot, { recursive: true });
    const resolvedRunRoot = await realpath(runRoot);
    if (!isWithin(checkoutRoot, resolvedRunRoot)) {
      throw new GitIntegrationCheckoutError([], 'Integration checkout path escapes checkout root');
    }
    await this.#runner.run(sourceRepositoryPath, [
      'worktree',
      'add',
      '-b',
      integrationRef,
      repositoryPath,
      request.baseCommit
    ]);
    const head = (await this.#runner.run(repositoryPath, ['rev-parse', 'HEAD'])).stdout.trim();
    if (head !== request.baseCommit) {
      throw new GitIntegrationCheckoutError(
        ['rev-parse', 'HEAD'],
        'Provisioned integration checkout does not match the requested base commit'
      );
    }
    const resolvedRepositoryPath = await realpath(repositoryPath);
    if (!isWithin(resolvedRunRoot, resolvedRepositoryPath)) {
      throw new GitIntegrationCheckoutError(
        [],
        'Provisioned integration checkout escaped run root'
      );
    }
    return {
      repositoryPath: resolvedRepositoryPath,
      baseCommit: request.baseCommit,
      integrationRef
    };
  }
}
