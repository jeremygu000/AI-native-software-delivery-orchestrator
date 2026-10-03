import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TestWorkflowEnvironment } from '@temporalio/testing';
import type { PredictedTaskImpact } from '@ai-native-software-delivery-orchestrator/domain';
import {
  authorityConfigurationFingerprint,
  DrizzleSqliteOrchestrationPersistence,
  JsonFilePlanArtifactStore
} from '@ai-native-software-delivery-orchestrator/persistence';
import {
  migratePostgresAuthoritySchema,
  PostgresOrchestrationPersistence
} from '@ai-native-software-delivery-orchestrator/postgres-persistence';
import {
  createPlanArtifact,
  type PreparedOrchestrationPlan
} from '@ai-native-software-delivery-orchestrator/planning';
import { analyzeRepository } from '@ai-native-software-delivery-orchestrator/repository-analysis';
import { GitRepositorySnapshotProvider } from '@ai-native-software-delivery-orchestrator/workspace-git';
import { beforeAll, describe, expect, it } from 'vitest';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const cliPath = join(workspaceRoot, 'apps/cli/dist/main.js');
const workerPath = join(workspaceRoot, 'apps/temporal-worker/dist/main.js');

const verificationPolicy = {
  version: 2,
  autonomousRules: ['package-script-required', 'free-form-command-forbidden'],
  packageScriptRunner: 'npm-from-pinned-node-image',
  executionProfile: {
    kind: 'docker-read-only',
    image: 'node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43',
    assurance: 'production-validation',
    network: 'deny',
    workspaceAccess: 'read-only',
    processTree: 'container',
    memoryBytes: 1_073_741_824,
    cpuCount: 2,
    pidLimit: 256
  }
} as const;

const codeReviewPolicy = {
  version: 1,
  reviewer: {
    implementation: 'pi-task-code-reviewer',
    agentBackend: 'pi',
    model: { provider: 'openai', id: 'gpt-4.1' },
    toolProfile: 'workspace-read-only-v1',
    outputSchemaVersion: 1,
    promptVersion: 'v1'
  }
} as const;

interface CapturedProcess {
  readonly child: ChildProcess;
  readonly output: () => string;
  readonly exited: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
}

interface AcceptanceFixture {
  readonly root: string;
  readonly repository: string;
  readonly planDirectory: string;
  readonly runDirectory: string;
  readonly databasePath: string;
  readonly queue: string;
  readonly artifactId: string;
  readonly approvalId: string;
  readonly runId: string;
  readonly env: NodeJS.ProcessEnv;
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((complete) => setTimeout(complete, milliseconds));

const freePort = async (): Promise<number> =>
  new Promise((complete, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('No PostgreSQL fixture port'));
        return;
      }
      server.close(() => complete(address.port));
    });
  });

const waitFor = async (predicate: () => Promise<boolean>, description: string): Promise<void> => {
  for (let attempts = 0; attempts < 300; attempts++) {
    if (await predicate()) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${description}`);
};

const git = (cwd: string, args: readonly string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

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

const stop = async (
  process: CapturedProcess,
  signal: NodeJS.Signals = 'SIGTERM'
): Promise<void> => {
  if (process.child.exitCode !== null || process.child.signalCode !== null) {
    return;
  }
  process.child.kill(signal);
  const stopped = await Promise.race([
    process.exited.then(() => true),
    sleep(5_000).then(() => false)
  ]);
  if (!stopped) {
    process.child.kill('SIGKILL');
    await Promise.race([process.exited, sleep(1_000)]);
  }
};

const invokeCli = async (fixture: AcceptanceFixture, args: readonly string[]): Promise<unknown> => {
  const cliProcess = capture(globalThis.process.execPath, [cliPath, ...args], fixture.env);
  const exited = await Promise.race([
    cliProcess.exited,
    sleep(10_000).then(async () => {
      await stop(cliProcess, 'SIGKILL');
      throw new Error(`CLI timed out: ${args.join(' ')}\n${cliProcess.output()}`);
    })
  ]);
  if (exited.code !== 0) {
    throw new Error(`CLI failed (${exited.code}): ${cliProcess.output()}`);
  }
  return JSON.parse(cliProcess.output()) as unknown;
};

const status = async (fixture: AcceptanceFixture): Promise<{ readonly state: string }> => {
  const result = await invokeCli(fixture, [
    'status',
    '--run-id',
    fixture.runId,
    '--run-directory',
    fixture.runDirectory
  ]);
  if (
    typeof result !== 'object' ||
    result === null ||
    !('state' in result) ||
    typeof result.state !== 'string'
  ) {
    throw new Error('CLI status did not return a state');
  }
  return { state: result.state };
};

const preparedPlan = (projectId: string, fileId: string): PreparedOrchestrationPlan => {
  const impact: PredictedTaskImpact = {
    taskId: 'task-1',
    projectsRead: new Set(),
    projectsWritten: new Set([projectId]),
    explicitProjectsWritten: new Set([projectId]),
    filesRead: new Set(),
    filesWritten: new Set([fileId]),
    explicitFilesWritten: new Set([fileId]),
    globFilesWritten: new Set(),
    symbolDerivedFilesWritten: new Set(),
    symbolsRead: new Set(),
    symbolsWritten: new Set(),
    sharedResources: new Set(),
    sharedResourceAccesses: [],
    downstreamProjects: new Set(),
    riskSignals: []
  };
  return {
    attempts: 1,
    specification: {
      tasks: [
        {
          id: 'task-1',
          title: 'Complete the acceptance task',
          goal: 'Replace the fixture value with completed.',
          dependencies: [],
          expectedReads: [],
          expectedWrites: [{ type: 'file', value: fileId }],
          sharedResources: [],
          verification: [{ type: 'package-script', packageName: projectId, script: 'test' }]
        }
      ]
    },
    impacts: [impact],
    hardConflicts: [],
    riskConflicts: [],
    executionPlan: { waves: [{ index: 0, taskIds: ['task-1'] }] },
    schedule: { maxConcurrency: 1 },
    semanticReview: {
      recommendation: 'accept',
      summary: 'The acceptance fixture covers the requested change.',
      requirements: [
        {
          requirement: 'Replace the fixture value with completed.',
          status: 'covered',
          taskIds: ['task-1'],
          detail: 'The single task owns the fixture file.'
        }
      ]
    }
  };
};

const createFixture = async (
  environment: TestWorkflowEnvironment,
  suffix: string
): Promise<AcceptanceFixture> => {
  const root = await mkdtemp(join(tmpdir(), 'forge-m311-process-'));
  const repository = join(root, 'repository');
  const planDirectory = join(root, 'plans');
  const runDirectory = join(root, 'runs');
  const databasePath = join(root, 'authority.sqlite');
  const artifactId = `plan-${suffix}`;
  const approvalId = `approval-${suffix}`;
  const runId = `run-${suffix}`;
  const queue = `forge-m311-${suffix}`;
  mkdirSync(join(repository, 'src'), { recursive: true });
  mkdirSync(planDirectory, { recursive: true });
  mkdirSync(runDirectory, { recursive: true });
  git(repository, ['init', '--initial-branch=main']);
  git(repository, ['config', 'user.email', 'acceptance@example.test']);
  git(repository, ['config', 'user.name', 'Acceptance Test']);
  writeFileSync(
    join(repository, 'package.json'),
    JSON.stringify({
      name: 'acceptance',
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
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'fixture']);

  const [analysis, snapshot] = await Promise.all([
    analyzeRepository(repository),
    new GitRepositorySnapshotProvider().capture({ repositoryPath: repository })
  ]);
  const project = [...analysis.graph.projects.values()][0];
  const file = [...analysis.graph.files.values()].find(
    (candidate) => candidate.path === 'src/index.ts'
  );
  if (project === undefined || file === undefined) {
    throw new Error('Acceptance repository analysis did not find its project and fixture file');
  }
  const artifact = createPlanArtifact({
    artifactId,
    revision: 1,
    createdAt: new Date().toISOString(),
    source: { type: 'user-request', content: 'Replace the fixture value with completed.' },
    repository: analysis.graph,
    repositorySnapshot: snapshot,
    sharedResourcePolicy: [],
    verificationPolicy,
    codeReviewPolicy,
    preparedPlan: preparedPlan(project.id, file.id)
  });
  await new JsonFilePlanArtifactStore(planDirectory, repository).save(artifact);
  const env = {
    ...process.env,
    FORGE_WORKER_DATABASE_PATH: databasePath,
    FORGE_WORKER_REPOSITORY_PATH: repository,
    FORGE_WORKER_COMPOSITION: 'acceptance',
    FORGE_WORKER_REVIEW_PROVIDER: codeReviewPolicy.reviewer.model.provider,
    FORGE_WORKER_REVIEW_MODEL: codeReviewPolicy.reviewer.model.id,
    TEMPORAL_SERVER_URL: `http://${environment.address}`,
    TEMPORAL_NAMESPACE: 'default',
    TEMPORAL_TASK_QUEUE: queue
  };
  return {
    root,
    repository,
    planDirectory,
    runDirectory,
    databasePath,
    queue,
    artifactId,
    approvalId,
    runId,
    env
  };
};

const approveAndRun = async (fixture: AcceptanceFixture): Promise<void> => {
  await invokeCli(fixture, [
    'approve',
    fixture.artifactId,
    '--revision',
    '1',
    '--approved-by',
    'acceptance@example.test',
    '--approval-id',
    fixture.approvalId,
    '--repository',
    fixture.repository,
    '--plan-directory',
    fixture.planDirectory
  ]);
  await invokeCli(fixture, [
    'run',
    fixture.artifactId,
    '--revision',
    '1',
    '--approval',
    fixture.approvalId,
    '--run-id',
    fixture.runId,
    '--repository',
    fixture.repository,
    '--plan-directory',
    fixture.planDirectory,
    '--run-directory',
    fixture.runDirectory,
    '--review-provider',
    'openai',
    '--review-model',
    'gpt-4.1'
  ]);
};

const worker = (fixture: AcceptanceFixture): CapturedProcess =>
  capture(process.execPath, [workerPath], fixture.env);

const recover = async (fixture: AcceptanceFixture) => {
  const persistence = new DrizzleSqliteOrchestrationPersistence(fixture.databasePath);
  try {
    return await persistence.recoverRun(fixture.runId);
  } finally {
    persistence.close();
  }
};

beforeAll(() => {
  execFileSync('pnpm', ['build'], { cwd: workspaceRoot, stdio: 'inherit', timeout: 180_000 });
  if (!existsSync(cliPath) || !existsSync(workerPath)) {
    throw new Error('M3.11 acceptance requires compiled CLI and worker outputs');
  }
}, 210_000);

describe('compiled CLI and Temporal worker process boundary', () => {
  it('completes through independent compiled processes and pre-migrated PostgreSQL authority', async () => {
    const environment = await TestWorkflowEnvironment.createLocal();
    const fixture = await createFixture(environment, 'postgres');
    const data = join(fixture.root, 'postgres-data');
    const port = await freePort();
    const role = `forge_m41d_runtime_${process.pid}`;
    const owner = `forge_m41d_owner_${process.pid}`;
    const schema = 'forge_m41d';
    const adminUrl = `postgresql://127.0.0.1:${port}/postgres`;
    const ownerUrl = `postgresql://${owner}@127.0.0.1:${port}/postgres`;
    const runtimeUrl = `postgresql://${role}@127.0.0.1:${port}/postgres`;
    let databaseStarted = false;
    let workerProcess: CapturedProcess | undefined;
    let cancellationFixture: AcceptanceFixture | undefined;
    let cancellationWorker: CapturedProcess | undefined;
    try {
      execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions'], { stdio: 'pipe' });
      execFileSync(
        'pg_ctl',
        [
          '-D',
          data,
          '-l',
          join(fixture.root, 'postgres.log'),
          '-o',
          `-h 127.0.0.1 -p ${port}`,
          '-w',
          'start'
        ],
        { stdio: 'pipe' }
      );
      databaseStarted = true;
      const psql = (statement: string) =>
        execFileSync('psql', [adminUrl, '-v', 'ON_ERROR_STOP=1', '-c', statement], {
          stdio: 'pipe'
        });
      psql(`create role "${owner}" login`);
      psql(`create role "${role}" login`);
      psql('revoke create, temporary on database postgres from public');
      psql('revoke create on schema public from public');
      psql(`grant create on database postgres to "${owner}"`);
      await migratePostgresAuthoritySchema(
        { connectionString: ownerUrl, schema, role: owner },
        role
      );
      const configuration = {
        backend: 'postgres' as const,
        connectionString: runtimeUrl,
        schema,
        role
      };
      const env = {
        ...fixture.env,
        FORGE_AUTHORITY_BACKEND: 'postgres',
        FORGE_POSTGRES_CONNECTION_STRING: runtimeUrl,
        FORGE_POSTGRES_SCHEMA: schema,
        FORGE_POSTGRES_ROLE: role,
        FORGE_AUTHORITY_ID: authorityConfigurationFingerprint(configuration),
        FORGE_WORKER_DATABASE_PATH: undefined
      };
      const routed = { ...fixture, env };
      const preflight = capture(process.execPath, [workerPath, '--preflight'], env);
      expect((await preflight.exited).code).toBe(0);
      expect(JSON.parse(preflight.output())).toMatchObject({
        status: 'ready',
        mode: 'legacy',
        authorityId: env.FORGE_AUTHORITY_ID,
        checks: [
          { name: 'repository', status: 'passed' },
          { name: 'authority', status: 'passed' },
          { name: 'temporal', status: 'passed' }
        ]
      });
      const untouched = await PostgresOrchestrationPersistence.connect(configuration);
      try {
        expect(await untouched.recoverRun(routed.runId)).toBeUndefined();
      } finally {
        await untouched.close();
      }
      const missingNamespace = capture(process.execPath, [workerPath, '--preflight'], {
        ...env,
        TEMPORAL_NAMESPACE: 'missing-preflight-namespace'
      });
      expect((await missingNamespace.exited).code).toBe(1);
      expect(JSON.parse(missingNamespace.output())).toMatchObject({
        status: 'not-ready',
        checks: expect.arrayContaining([
          { name: 'authority', status: 'passed' },
          { name: 'temporal', status: 'failed' }
        ])
      });
      expect(missingNamespace.output()).not.toContain(runtimeUrl);
      // Composition opens the real PostgreSQL pool before Temporal connects.
      // A failed normal startup must exit even while that pool has live handles.
      const failedStartup = capture(process.execPath, [workerPath], {
        ...env,
        TEMPORAL_SERVER_URL: `http://127.0.0.1:${await freePort()}`
      });
      try {
        const exited = await Promise.race([
          failedStartup.exited,
          sleep(20_000).then(() => {
            throw new Error(`Failed worker startup did not exit: ${failedStartup.output()}`);
          })
        ]);
        expect(exited).toEqual({ code: 1, signal: null });
        expect(failedStartup.output()).toContain('Worker failed to start:');
      } finally {
        await stop(failedStartup);
      }
      workerProcess = worker(routed);
      await approveAndRun(routed);
      await waitFor(
        async () => (await status(routed)).state === 'COMPLETED',
        'PostgreSQL durable completion'
      );
      const persistence = await PostgresOrchestrationPersistence.connect(configuration);
      try {
        const recovered = await persistence.recoverRun(routed.runId);
        expect(recovered?.run.state).toBe('COMPLETED');
        expect(recovered?.attempts).toHaveLength(1);
        expect(recovered?.events.filter(({ event }) => event.type === 'run-started')).toHaveLength(
          1
        );
      } finally {
        await persistence.close();
      }
      const terminalCancel = capture(
        process.execPath,
        [cliPath, 'cancel', '--run-id', routed.runId, '--run-directory', routed.runDirectory],
        env
      );
      expect((await terminalCancel.exited).code).toBe(1);
      expect(terminalCancel.output()).toContain('Cannot cancel run');
      expect(terminalCancel.output()).toContain('COMPLETED');
      const next = await createFixture(environment, 'postgres-cancellation');
      cancellationFixture = next;
      const routedCancellation = {
        ...next,
        env: {
          ...env,
          FORGE_WORKER_REPOSITORY_PATH: next.repository,
          TEMPORAL_TASK_QUEUE: next.queue
        }
      };
      await approveAndRun(routedCancellation);
      await invokeCli(routedCancellation, [
        'cancel',
        '--run-id',
        next.runId,
        '--run-directory',
        next.runDirectory
      ]);
      expect((await status(routedCancellation)).state).toBe('CANCEL_REQUESTED');
      const cancellationAuthority = await PostgresOrchestrationPersistence.connect(configuration);
      try {
        expect((await cancellationAuthority.recoverRun(next.runId))?.run.state).toBe(
          'CANCEL_REQUESTED'
        );
      } finally {
        await cancellationAuthority.close();
      }
      cancellationWorker = worker(routedCancellation);
      await waitFor(
        async () => (await status(routedCancellation)).state === 'CANCELLED',
        'PostgreSQL durable cancellation'
      );
      const mismatchedSchema = { ...routed, env: { ...env, FORGE_POSTGRES_SCHEMA: 'wrong' } };
      const mismatch = capture(
        process.execPath,
        [cliPath, 'status', '--run-id', routed.runId, '--run-directory', routed.runDirectory],
        mismatchedSchema.env
      );
      const exited = await mismatch.exited;
      expect(exited.code).toBe(1);
      expect(mismatch.output()).toContain('FORGE_AUTHORITY_ID does not match');
      const sqliteMismatch = {
        ...routed,
        env: {
          ...env,
          FORGE_AUTHORITY_BACKEND: 'sqlite',
          FORGE_WORKER_DATABASE_PATH: routed.databasePath,
          FORGE_POSTGRES_CONNECTION_STRING: undefined,
          FORGE_POSTGRES_SCHEMA: undefined,
          FORGE_POSTGRES_ROLE: undefined
        }
      };
      const wrongBackend = capture(process.execPath, [workerPath], sqliteMismatch.env);
      const stopped = await wrongBackend.exited;
      expect(stopped.code).toBe(1);
      expect(wrongBackend.output()).toContain('FORGE_AUTHORITY_ID does not match');
    } finally {
      if (cancellationWorker !== undefined) {
        await stop(cancellationWorker);
      }
      if (workerProcess !== undefined) {
        await stop(workerProcess);
      }
      if (databaseStarted) {
        execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
      }
      await environment.teardown();
      await rm(fixture.root, { recursive: true, force: true });
      if (cancellationFixture !== undefined) {
        await rm(cancellationFixture.root, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it('rejects a relative authority database before connecting the worker', async () => {
    const invalidWorker = capture(globalThis.process.execPath, [workerPath], {
      ...globalThis.process.env,
      FORGE_WORKER_DATABASE_PATH: 'authority.sqlite',
      FORGE_WORKER_REPOSITORY_PATH: workspaceRoot,
      TEMPORAL_SERVER_URL: 'http://127.0.0.1:1',
      TEMPORAL_NAMESPACE: 'default',
      TEMPORAL_TASK_QUEUE: 'forge-m311-invalid'
    });
    const exited = await Promise.race([
      invalidWorker.exited,
      sleep(10_000).then(async () => {
        await stop(invalidWorker, 'SIGKILL');
        throw new Error(`Worker did not reject relative database path: ${invalidWorker.output()}`);
      })
    ]);

    expect(exited.code).toBe(1);
    expect(invalidWorker.output()).toContain(
      'SQLite authority requires an absolute FORGE_WORKER_DATABASE_PATH'
    );
  });

  it('completes one run through independent compiled CLI and worker processes', async () => {
    const environment = await TestWorkflowEnvironment.createLocal();
    const fixture = await createFixture(environment, 'normal');
    fixture.env.FORGE_AUTHORITY_BACKEND = 'sqlite';
    fixture.env.FORGE_AUTHORITY_ID = authorityConfigurationFingerprint({
      backend: 'sqlite',
      databasePath: fixture.databasePath
    });
    const wrongSqliteWorker = capture(globalThis.process.execPath, [workerPath], {
      ...fixture.env,
      FORGE_WORKER_DATABASE_PATH: join(fixture.root, 'wrong.sqlite'),
      TEMPORAL_SERVER_URL: 'http://127.0.0.1:1'
    });
    expect((await wrongSqliteWorker.exited).code).toBe(1);
    expect(wrongSqliteWorker.output()).toContain('FORGE_AUTHORITY_ID does not match');
    const process = worker(fixture);
    try {
      await approveAndRun(fixture);
      await waitFor(
        async () => (await status(fixture)).state === 'COMPLETED',
        'durable completion'
      );
      const recovered = await recover(fixture);
      expect(recovered?.run.state).toBe('COMPLETED');
      expect(recovered?.attempts).toHaveLength(1);
      expect(recovered?.attempts[0]?.attempt.state).toBe('COMPLETED');
      expect(recovered?.events.filter(({ event }) => event.type === 'run-started')).toHaveLength(1);
    } finally {
      await stop(process);
      await environment.teardown();
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 120_000);

  it('recovers a lost evaluator response without repeating review authority', async () => {
    const environment = await TestWorkflowEnvironment.createLocal();
    const fixture = await createFixture(environment, 'restart');
    const pausePath = join(fixture.root, 'pause-evaluation-result');
    const readyPath = join(fixture.root, 'evaluation-result-ready');
    const reviewCallsPath = join(fixture.root, 'review-calls');
    writeFileSync(pausePath, 'pause\n');
    fixture.env.FORGE_ACCEPTANCE_EVALUATION_RESULT_PAUSE_PATH = pausePath;
    fixture.env.FORGE_ACCEPTANCE_EVALUATION_RESULT_READY_PATH = readyPath;
    fixture.env.FORGE_ACCEPTANCE_REVIEW_CALLS_PATH = reviewCallsPath;
    const first = worker(fixture);
    let second: CapturedProcess | undefined;
    try {
      await approveAndRun(fixture);
      await waitFor(async () => existsSync(readyPath), 'worker A evaluation pause');
      await stop(first, 'SIGKILL');
      unlinkSync(pausePath);
      const restartedWorker = worker(fixture);
      second = restartedWorker;
      let latestState = 'unknown';
      for (let attempts = 0; attempts < 30; attempts++) {
        if (restartedWorker.child.exitCode !== null || restartedWorker.child.signalCode !== null) {
          throw new Error(`Worker B exited before recovery: ${restartedWorker.output()}`);
        }
        latestState = (await status(fixture)).state;
        if (latestState === 'COMPLETED') {
          break;
        }
        if (latestState === 'FAILED' || latestState === 'UNKNOWN') {
          throw new Error(`Worker restart reached terminal ${latestState}`);
        }
        await sleep(100);
      }
      if (latestState !== 'COMPLETED') {
        throw new Error(`Worker restart remained ${latestState}: ${restartedWorker.output()}`);
      }
      const recovered = await recover(fixture);
      expect(recovered?.attempts).toHaveLength(1);
      expect(recovered?.attempts[0]?.attempt.state).toBe('COMPLETED');
      expect(recovered?.events.filter(({ event }) => event.type === 'run-started')).toHaveLength(1);
      expect(recovered?.workspaces).toHaveLength(1);
      expect(readFileSync(reviewCallsPath, 'utf8').trim().split('\n')).toEqual(['review']);
    } finally {
      if (existsSync(pausePath)) {
        unlinkSync(pausePath);
      }
      if (second !== undefined) {
        await stop(second);
      }
      await stop(first);
      await environment.teardown();
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 120_000);

  it('persists cancellation through CLI exit and worker restart', async () => {
    const environment = await TestWorkflowEnvironment.createLocal();
    const fixture = await createFixture(environment, 'cancel');
    const pausePath = join(fixture.root, 'pause-evaluation');
    const readyPath = join(fixture.root, 'evaluation-ready');
    writeFileSync(pausePath, 'pause\n');
    fixture.env.FORGE_ACCEPTANCE_EVALUATION_PAUSE_PATH = pausePath;
    fixture.env.FORGE_ACCEPTANCE_EVALUATION_READY_PATH = readyPath;
    const first = worker(fixture);
    let second: CapturedProcess | undefined;
    try {
      await approveAndRun(fixture);
      await waitFor(async () => existsSync(readyPath), 'worker A evaluation pause');
      await stop(first, 'SIGKILL');
      await invokeCli(fixture, [
        'cancel',
        '--run-id',
        fixture.runId,
        '--run-directory',
        fixture.runDirectory
      ]);
      expect((await status(fixture)).state).toBe('CANCEL_REQUESTED');
      unlinkSync(pausePath);
      second = worker(fixture);
      await waitFor(
        async () => (await status(fixture)).state === 'CANCELLED',
        'cancelled completion'
      );
      expect((await recover(fixture))?.run.state).toBe('CANCELLED');
    } finally {
      if (existsSync(pausePath)) {
        unlinkSync(pausePath);
      }
      if (second !== undefined) {
        await stop(second);
      }
      await stop(first);
      await environment.teardown();
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 120_000);
});
