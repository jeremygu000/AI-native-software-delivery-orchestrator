import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const wrapper = resolve('apps/temporal-worker/local/comparison-run.mjs');

describe('comparison CLI candidate profiles', () => {
  it.each([
    ['cli', [], 'apps/cli/dist/main.js', []],
    ['cli', ['--help'], 'apps/cli/dist/main.js', ['--help']],
    ['worker', [], 'apps/temporal-worker/dist/main.js', []],
    ['preflight', [], 'apps/temporal-worker/dist/main.js', ['--preflight']],
    [
      'register',
      [],
      'apps/temporal-worker/local/neon-comparison-authority.mjs',
      ['register', 'deepseek']
    ]
  ])(
    'preserves %s child arguments and isolates interactive FFI',
    async (command, args, entry, expectedArgs) => {
      const node = process.env.FORGE_TEST_TUI_NODE ?? process.execPath;
      const version = spawnSync(node, ['-p', 'process.versions.node'], { encoding: 'utf8' });
      expect(version.status, version.stderr).toBe(0);
      const [major, minor] = version.stdout.trim().split('.').map(Number);
      const supported = major > 26 || (major === 26 && minor >= 4);
      const directory = await realpath(await mkdtemp(join(tmpdir(), 'comparison-argv-')));
      try {
        await mkdir(join(directory, 'apps/cli/dist'), { recursive: true });
        await mkdir(join(directory, 'apps/temporal-worker/dist'), { recursive: true });
        await mkdir(join(directory, 'apps/temporal-worker/local'), { recursive: true });
        await writeFile(
          join(directory, '.env.local'),
          'TEMPORAL_TASK_QUEUE=wrong\nFORGE_MODEL_REASONING_EFFORT=off\nFORGE_OWNER_CONNECTION_STRING=test-only\nFORGE_TRUST_CONNECTION_STRING=test-only\nFORGE_ISSUER_CONNECTION_STRING=test-only\nFORGE_SETUP_CONNECTION_STRING=test-only\nFORGE_RECOVERY_CONNECTION_STRING=test-only\nLOCAL_DBA_PASSWORD=test-only\nFORGE_DATABASE_OWNER_CONNECTION_STRING=test-only\nFORGE_DATABASE_HARDENING_ENV_FILE=test-only\n'
        );
        const comparison = join(directory, 'comparison.env');
        await writeFile(comparison, 'FORGE_POSTGRES_SCHEMA=fixture_schema\n');
        await writeFile(
          join(directory, entry),
          `console.log(JSON.stringify({execArgv:process.execArgv,args:process.argv.slice(2),provider:process.env.FORGE_WORKER_REVIEW_PROVIDER,model:process.env.FORGE_WORKER_REVIEW_MODEL,effort:process.env.FORGE_MODEL_REASONING_EFFORT,queue:process.env.TEMPORAL_TASK_QUEUE,repository:process.env.FORGE_WORKER_REPOSITORY_PATH,schema:process.env.FORGE_POSTGRES_SCHEMA,privileged:['FORGE_OWNER_CONNECTION_STRING','FORGE_TRUST_CONNECTION_STRING','FORGE_ISSUER_CONNECTION_STRING','FORGE_SETUP_CONNECTION_STRING','FORGE_RECOVERY_CONNECTION_STRING','LOCAL_DBA_PASSWORD'].some(key=>process.env[key]!==undefined),databaseOwner:process.env.FORGE_DATABASE_OWNER_CONNECTION_STRING!==undefined||process.env.FORGE_DATABASE_HARDENING_ENV_FILE!==undefined}));`
        );
        // Even a parent FFI flag must not be forwarded to worker/operator commands.
        const parentFlags = supported && command !== 'cli' ? ['--experimental-ffi'] : [];
        const result = spawnSync(node, [...parentFlags, wrapper, 'deepseek', command, ...args], {
          cwd: directory,
          encoding: 'utf8',
          env: { ...process.env, FORGE_COMPARISON_ENV_FILE: comparison }
        });
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
          execArgv:
            supported && command === 'cli' && args.length === 0 ? ['--experimental-ffi'] : [],
          args: expectedArgs,
          provider: 'deepseek',
          model: 'deepseek-flash',
          effort: 'high',
          queue: 'forge-neon-comparison-deepseek',
          repository: join(directory, '.local/neon-comparison-deepseek'),
          schema: 'fixture_schema',
          privileged: command === 'register',
          databaseOwner: false
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it('retains the compiled CLI unsupported-runtime message without passing an unknown Node option', async (context) => {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major > 26 || (major === 26 && minor >= 4)) {
      context.skip();
      return;
    }
    const directory = await mkdtemp(join(tmpdir(), 'comparison-legacy-node-'));
    try {
      await mkdir(join(directory, 'apps/cli'), { recursive: true });
      await symlink(resolve('apps/cli/dist'), join(directory, 'apps/cli/dist'), 'dir');
      await writeFile(join(directory, '.env.local'), '');
      const result = spawnSync(process.execPath, [wrapper, 'deepseek', 'cli'], {
        cwd: directory,
        encoding: 'utf8',
        env: { PATH: process.env.PATH }
      });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(
        'Interactive Forge requires Node >=26.4.0 with --experimental-ffi'
      );
      expect(result.stderr).not.toContain('bad option');
      expect(result.stderr).not.toContain('not allowed in NODE_OPTIONS');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['copilot', ['plan', '--review-provider', 'deepseek', '--review-model', 'deepseek-flash']],
    ['codex', ['run', '--review-provider', 'github-copilot', '--review-model', 'gpt-6.1-sol']],
    ['copilot', ['plan', '--review-provider=github-copilot', '--review-model=wrong-model']],
    ['copilot', ['plan', '--review-provider', 'github-copilot']],
    ['copilot', ['run', '--review-model', 'gpt-6.1-sol']],
    [
      'copilot',
      [
        'plan',
        '--review-provider=github-copilot',
        '--review-provider=github-copilot',
        '--review-model=gpt-6.1-sol'
      ]
    ],
    [
      'copilot',
      [
        'run',
        '--review-provider=github-copilot',
        '--review-model=gpt-6.1-sol',
        '--review-model=gpt-6.1-sol'
      ]
    ],
    ['copilot', ['plan', '--', '--review-provider=github-copilot', '--review-model=gpt-6.1-sol']]
  ])(
    'rejects invalid %s arguments before environment access or child spawn: %j',
    async (candidate, args) => {
      const directory = await mkdtemp(join(tmpdir(), 'comparison-rejected-'));
      try {
        // No environment or CLI exists: reaching either would produce a different failure.
        const result = spawnSync(process.execPath, [wrapper, candidate, 'cli', ...args], {
          cwd: directory,
          encoding: 'utf8'
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('Comparison CLI requires');
        expect(result.stderr).not.toContain('ENOENT');
        expect(result.stderr).not.toContain('MODULE_NOT_FOUND');
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it.each([
    ['copilot', 'github-copilot', 'gpt-6.1-sol', 'medium', false],
    ['codex', 'openai-codex', 'gpt-6.1-sol', 'medium', true],
    ['deepseek', 'deepseek', 'deepseek-flash', 'high', false]
  ])(
    'passes only the canonical %s profile to the child',
    async (candidate, provider, model, effort, equals) => {
      const directory = await mkdtemp(join(tmpdir(), 'comparison-allowed-'));
      try {
        await mkdir(join(directory, 'apps/cli/dist'), { recursive: true });
        await writeFile(
          join(directory, '.env.local'),
          'TEMPORAL_TASK_QUEUE=wrong\nFORGE_MODEL_REASONING_EFFORT=off\nLOCAL_DBA_PASSWORD=test-only\nFORGE_MODEL_API_KEY=test-only\nFORGE_DATABASE_OWNER_CONNECTION_STRING=test-only\nFORGE_DATABASE_HARDENING_ENV_FILE=test-only\nFORGE_OWNER_CONNECTION_STRING=test-only\nFORGE_SETUP_CONNECTION_STRING=test-only\n'
        );
        await writeFile(
          join(directory, 'apps/cli/dist/main.js'),
          `console.log(JSON.stringify({args:process.argv.slice(2),provider:process.env.FORGE_WORKER_REVIEW_PROVIDER,model:process.env.FORGE_WORKER_REVIEW_MODEL,effort:process.env.FORGE_MODEL_REASONING_EFFORT,queue:process.env.TEMPORAL_TASK_QUEUE,privileged:process.env.LOCAL_DBA_PASSWORD!==undefined||process.env.FORGE_DATABASE_OWNER_CONNECTION_STRING!==undefined||process.env.FORGE_DATABASE_HARDENING_ENV_FILE!==undefined||process.env.FORGE_OWNER_CONNECTION_STRING!==undefined||process.env.FORGE_SETUP_CONNECTION_STRING!==undefined,apiKey:process.env.FORGE_MODEL_API_KEY!==undefined}));`
        );
        const args = equals
          ? ['run', `--review-provider=${provider}`, `--review-model=${model}`]
          : ['plan', '--review-provider', provider, '--review-model', model];
        const result = spawnSync(process.execPath, [wrapper, candidate, 'cli', ...args], {
          cwd: directory,
          encoding: 'utf8'
        });
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
          args,
          provider,
          model,
          effort,
          queue: `forge-comparison-${candidate}`,
          privileged: false,
          apiKey: candidate === 'deepseek'
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
});
