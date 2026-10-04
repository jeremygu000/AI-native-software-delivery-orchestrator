import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

it('renders and handles real OpenTUI keyboard input under the explicitly supported Node runtime', async (context) => {
  const node = process.env.FORGE_TEST_TUI_NODE;
  if (node === undefined) {
    context.skip();
    return;
  }
  const directory = await mkdtemp(resolve('apps/cli/test-fixtures/.opentui-'));
  try {
    const entry = join(directory, 'acceptance.mjs');
    await build({
      entryPoints: ['apps/cli/test-fixtures/opentui-acceptance.mjs'],
      outfile: entry,
      bundle: true,
      packages: 'external',
      platform: 'node',
      format: 'esm',
      target: 'node26',
      jsx: 'automatic',
      jsxImportSource: '@opentui/react'
    });
    const result = await promisify(execFile)(node, ['--experimental-ffi', entry], {
      timeout: 30000
    });
    expect(result.stdout).toContain('OpenTUI native rendering');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 45000);

it.for(['direct', 'comparison'])(
  'renders the production compiled CLI through %s launch and cancels before application work',
  { timeout: 45000 },
  async (launch, context) => {
    const node = process.env.FORGE_TEST_TUI_NODE;
    if (node === undefined) {
      context.skip();
      return;
    }
    const directory = await mkdtemp(join(tmpdir(), 'forge-compiled-tui-'));
    try {
      const comparisonFile = join(directory, 'comparison.env');
      if (launch === 'comparison') {
        await mkdir(join(directory, 'apps/cli'), { recursive: true });
        await symlink(resolve('apps/cli/dist'), join(directory, 'apps/cli/dist'), 'dir');
        await writeFile(join(directory, '.env.local'), 'FORGE_WORKER_AUTHORITY_MODE=global\n');
        await writeFile(comparisonFile, 'FORGE_POSTGRES_SCHEMA=fixture_only\n');
      }
      const initialFiles = await readdir(directory);
      const childArguments =
        launch === 'direct'
          ? ['--experimental-ffi', resolve('apps/cli/dist/main.js')]
          : [resolve('apps/temporal-worker/local/comparison-run.mjs'), 'deepseek', 'cli'];
      const result = await promisify(execFile)(
        'python3',
        [resolve('apps/cli/test-fixtures/compiled-tui-acceptance.py'), node, ...childArguments],
        {
          cwd: directory,
          timeout: 30000,
          env: {
            ...process.env,
            ...(launch === 'comparison' ? { FORGE_COMPARISON_ENV_FILE: comparisonFile } : {})
          }
        }
      );
      expect(result.stdout).toContain('Compiled Forge CLI initial render');
      expect(await readdir(directory)).toEqual(initialFiles);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);
