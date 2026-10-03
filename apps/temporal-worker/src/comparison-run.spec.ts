import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const wrapper = resolve('apps/temporal-worker/local/comparison-run.mjs');

describe('comparison CLI candidate profiles', () => {
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
