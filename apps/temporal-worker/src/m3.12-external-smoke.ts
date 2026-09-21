import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TestWorkflowEnvironment } from '@temporalio/testing';

import { resolveM312ExternalSmokeConfig } from './m3.12-external-smoke-config.js';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const cliPath = join(workspaceRoot, 'apps/cli/dist/main.js');
const workerPath = join(workspaceRoot, 'apps/temporal-worker/dist/main.js');

interface CapturedProcess {
  readonly child: ChildProcess;
  readonly output: () => string;
  readonly exited: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((complete) => setTimeout(complete, milliseconds));

const capture = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv
): CapturedProcess => {
  const child = spawn(command, args, {
    cwd: workspaceRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  return {
    child,
    output: () => output,
    exited: new Promise((complete) => {
      child.once('exit', (code, signal) => complete({ code, signal }));
    })
  };
};

const stop = async (process: CapturedProcess): Promise<void> => {
  if (process.child.exitCode !== null || process.child.signalCode !== null) {
    return;
  }
  process.child.kill('SIGTERM');
  if (!(await Promise.race([process.exited.then(() => true), sleep(5_000).then(() => false)]))) {
    process.child.kill('SIGKILL');
    await Promise.race([process.exited, sleep(1_000)]);
  }
};

const invokeCli = async (args: readonly string[], env: NodeJS.ProcessEnv): Promise<unknown> => {
  const process = capture(globalThis.process.execPath, [cliPath, ...args], env);
  const exited = await Promise.race([
    process.exited,
    sleep(10 * 60_000).then(async () => {
      await stop(process);
      throw new Error(`CLI timed out: ${args.join(' ')}\n${process.output()}`);
    })
  ]);
  if (exited.code !== 0) {
    throw new Error(`CLI failed (${exited.code}): ${process.output()}`);
  }
  return JSON.parse(process.output()) as unknown;
};

const artifactId = (result: unknown): string => {
  if (typeof result !== 'object' || result === null || !('artifactId' in result)) {
    throw new Error('forge plan did not return an artifactId');
  }
  if (typeof result.artifactId !== 'string') {
    throw new Error('forge plan returned a non-string artifactId');
  }
  return result.artifactId;
};

const status = async (
  runId: string,
  runDirectory: string,
  env: NodeJS.ProcessEnv
): Promise<string> => {
  const result = await invokeCli(
    ['status', '--run-id', runId, '--run-directory', runDirectory],
    env
  );
  if (typeof result !== 'object' || result === null || !('state' in result)) {
    throw new Error('forge status did not return a state');
  }
  if (typeof result.state !== 'string') {
    throw new Error('forge status returned a non-string state');
  }
  return result.state;
};

const waitForCompletion = async (
  runId: string,
  runDirectory: string,
  env: NodeJS.ProcessEnv,
  worker: CapturedProcess
): Promise<void> => {
  for (let attempt = 0; attempt < 1_800; attempt++) {
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
      throw new Error(`Worker exited before completion: ${worker.output()}`);
    }
    const state = await status(runId, runDirectory, env);
    if (state === 'COMPLETED') {
      return;
    }
    if (state === 'FAILED' || state === 'UNKNOWN' || state === 'CANCELLED') {
      throw new Error(`External smoke reached terminal ${state}`);
    }
    await sleep(1_000);
  }
  throw new Error('Timed out waiting for external smoke completion');
};

const git = (cwd: string, args: readonly string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const ensurePrerequisites = (): void => {
  if (!existsSync(cliPath) || !existsSync(workerPath)) {
    throw new Error('M3.12 external smoke requires pnpm build before execution');
  }
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
      stdio: 'ignore',
      timeout: 10_000
    });
  } catch {
    throw new Error('M3.12 external smoke requires a reachable Docker daemon');
  }
};

const main = async (): Promise<void> => {
  const configuration = resolveM312ExternalSmokeConfig();
  ensurePrerequisites();
  const root = await mkdtemp(join(tmpdir(), 'forge-m312-external-'));
  const repository = join(root, 'repository');
  const planDirectory = join(root, 'plans');
  const runDirectory = join(root, 'runs');
  const databasePath = join(root, 'authority.sqlite');
  const specification = join(root, 'request.md');
  const runId = 'm312-external-smoke';
  const approvalId = 'm312-external-approval';
  const queue = `forge-m312-${Date.now()}`;
  let environment: TestWorkflowEnvironment | undefined;
  let worker: CapturedProcess | undefined;
  const keepFixture = process.env.FORGE_M312_KEEP_FIXTURE === '1';
  try {
    mkdirSync(join(repository, 'src'), { recursive: true });
    mkdirSync(planDirectory, { recursive: true });
    mkdirSync(runDirectory, { recursive: true });
    git(repository, ['init', '--initial-branch=main']);
    git(repository, ['config', 'user.email', 'm312-smoke@example.test']);
    git(repository, ['config', 'user.name', 'M3.12 Smoke']);
    writeFileSync(
      join(repository, 'package.json'),
      JSON.stringify({
        name: 'm312-external-smoke',
        private: true,
        scripts: { test: 'node -e "process.exit(0)"' }
      })
    );
    writeFileSync(join(repository, 'pnpm-workspace.yaml'), 'packages:\n  - .\n');
    writeFileSync(
      join(repository, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext' } })
    );
    writeFileSync(join(repository, 'src/index.ts'), 'export const value = "pending";\n');
    writeFileSync(
      specification,
      [
        '# M3.12 external smoke request',
        '',
        'Change `src/index.ts` so its exported `value` is exactly `"completed"`.',
        'Do not change any other file.',
        'Run the existing `test` package script to verify the result.'
      ].join('\n')
    );
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'm3.12 smoke fixture']);

    environment = await TestWorkflowEnvironment.createLocal();
    const env = {
      ...process.env,
      FORGE_WORKER_DATABASE_PATH: databasePath,
      FORGE_WORKER_REPOSITORY_PATH: repository,
      TEMPORAL_SERVER_URL: `http://${environment.address}`,
      TEMPORAL_NAMESPACE: 'default',
      TEMPORAL_TASK_QUEUE: queue
    };
    worker = capture(globalThis.process.execPath, [workerPath], env);
    const planResult = await invokeCli(
      [
        'plan',
        specification,
        '--repository',
        repository,
        '--plan-directory',
        planDirectory,
        '--semantic-review',
        '--review-provider',
        configuration.provider,
        '--review-model',
        configuration.model
      ],
      env
    );
    const planId = artifactId(planResult);
    await invokeCli(
      [
        'approve',
        planId,
        '--revision',
        '1',
        '--approved-by',
        'm312-external-smoke@example.test',
        '--approval-id',
        approvalId,
        '--repository',
        repository,
        '--plan-directory',
        planDirectory
      ],
      env
    );
    await invokeCli(
      [
        'run',
        planId,
        '--revision',
        '1',
        '--approval',
        approvalId,
        '--run-id',
        runId,
        '--repository',
        repository,
        '--plan-directory',
        planDirectory,
        '--run-directory',
        runDirectory,
        '--review-provider',
        configuration.provider,
        '--review-model',
        configuration.model
      ],
      env
    );
    await waitForCompletion(runId, runDirectory, env, worker);
    const integration = join(runDirectory, runId, 'integration', 'src/index.ts');
    const changedFiles = git(join(runDirectory, runId, 'integration'), [
      'diff',
      '--name-only',
      'HEAD'
    ])
      .split('\n')
      .filter((path) => path.length > 0);
    if (
      !existsSync(integration) ||
      readFileSync(integration, 'utf8') !== 'export const value = "completed";\n' ||
      JSON.stringify(changedFiles) !== JSON.stringify(['src/index.ts'])
    ) {
      throw new Error('External smoke completed without the expected integrated fixture change');
    }
    process.stdout.write(
      `${JSON.stringify({ status: 'COMPLETED', runId, fixture: keepFixture ? root : undefined })}\n`
    );
  } finally {
    if (worker !== undefined) {
      await stop(worker);
    }
    if (environment !== undefined) {
      await environment.teardown();
    }
    if (!keepFixture) {
      await rm(root, { recursive: true, force: true });
    }
  }
};

void main().catch((error: unknown) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${detail}\n`);
  process.exitCode = 1;
});
