import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { authorityConfigurationFingerprint } from '@ai-native-software-delivery-orchestrator/persistence';
import { beforeAll, expect, it } from 'vitest';

const entry = resolve('apps/run-inspector/dist/main.js');
const execute = promisify(execFile);
// Compile the actual entry and its workspace dependencies on clean checkouts too.
beforeAll(async () => {
  await execute('pnpm', ['exec', 'tsc', '-b', 'libs/run-inspection/tsconfig.lib.json', '--force']);
  await execute(process.execPath, ['apps/run-inspector/build.mjs']);
}, 60000);
const authority = {
  backend: 'postgres' as const,
  connectionString: 'postgresql://forge_runtime:private-fixture@fixture.invalid/neondb',
  schema: 'forge_comparison_fixture',
  role: 'forge_runtime',
  ssl: 'verify-full' as const
};
const fields = {
  FORGE_WORKER_AUTHORITY_MODE: 'global',
  FORGE_POSTGRES_CONNECTION_STRING: authority.connectionString,
  FORGE_POSTGRES_SCHEMA: authority.schema,
  FORGE_POSTGRES_ROLE: authority.role,
  FORGE_POSTGRES_SSL: authority.ssl,
  FORGE_AUTHORITY_ID: authorityConfigurationFingerprint(authority)
};
const deployment = {
  FORGE_AUTHORITY_BACKEND: 'postgres',
  TEMPORAL_SERVER_URL: 'http://localhost:7233',
  TEMPORAL_NAMESPACE: 'default'
};
const envText = (values: Record<string, string>) =>
  Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

it('runs the compiled help entry without importing a TUI or selecting an environment', async () => {
  const result = await execute(process.execPath, [entry, '--help']);
  expect(result.stdout).toContain('Forge Run Inspector (read-only)');
  expect(result.stdout).toContain('--deployment-env-file');
  expect(result.stderr).toBe('');
});

it('refuses bare invocation even when the shell contains valid authority configuration', async () => {
  await expect(
    execute(process.execPath, [entry], { env: { ...process.env, ...fields, ...deployment } })
  ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('No fallback environment') });
});

it.each(['FORGE_POSTGRES_CONNECTION_STRING', 'FORGE_POSTGRES_SCHEMA', 'FORGE_AUTHORITY_ID'])(
  'never fills missing %s from the deployment file or shell',
  async (key) => {
    const root = await mkdtemp(join(tmpdir(), 'forge-inspector-compiled-'));
    try {
      const selected = Object.fromEntries(Object.entries(fields).filter(([name]) => name !== key));
      await writeFile(join(root, 'selected.env'), envText(selected));
      await writeFile(join(root, 'deployment.env'), envText({ ...fields, ...deployment }));
      await expect(
        execute(
          process.execPath,
          [
            entry,
            '--env-file',
            join(root, 'selected.env'),
            '--deployment-env-file',
            join(root, 'deployment.env'),
            '--repository',
            root,
            '--task-queue',
            'fixture-queue',
            '--label',
            'Compiled fixture'
          ],
          { env: { ...process.env, ...fields, ...deployment } }
        )
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('No fallback environment')
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);

it('starts the compiled loopback bridge with explicit files and exposes only public metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-inspector-compiled-'));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await writeFile(join(root, 'selected.env'), envText(fields));
    await writeFile(join(root, 'deployment.env'), envText(deployment));
    const port = 40000 + Math.floor(Math.random() * 10000);
    child = spawn(
      process.execPath,
      [
        entry,
        '--env-file',
        join(root, 'selected.env'),
        '--deployment-env-file',
        join(root, 'deployment.env'),
        '--repository',
        root,
        '--operator-root',
        root,
        '--task-queue',
        'fixture-queue',
        '--label',
        'Compiled fixture — not live Neon',
        '--port',
        String(port)
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const active = child;
    await new Promise<void>((complete, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error('Compiled bridge did not start')), 10000);
      active.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes('Forge Run Inspector:')) {
          clearTimeout(timeout);
          expect(output).not.toContain('private-fixture');
          complete();
        }
      });
      active.once('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`Compiled bridge exited early: ${code}`));
      });
      active.once('error', reject);
    });
    const response = await fetch(`http://127.0.0.1:${port}/api/environment`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('Compiled fixture');
    expect(text).toContain('fixture-queue');
    expect(text).not.toContain('private-fixture');
    const page = await fetch(`http://127.0.0.1:${port}/`);
    expect(await page.text()).toContain('/app.js');
  } finally {
    if (child !== undefined && child.exitCode === null) {
      const closed = new Promise<void>((complete) => child?.once('exit', () => complete()));
      child.kill('SIGTERM');
      await closed;
    }
    await rm(root, { recursive: true, force: true });
  }
});
