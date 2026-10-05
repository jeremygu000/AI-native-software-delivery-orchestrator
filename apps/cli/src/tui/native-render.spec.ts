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

it.for(['direct', 'comparison', 'narrow'])(
  'renders the production compiled CLI through %s launch and preserves repository routing before planning',
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
        const repository = join(directory, '.local/canonical-repository');
        await mkdir(repository, { recursive: true });
        await writeFile(join(repository, 'pnpm-workspace.yaml'), 'packages: []\n');
        await writeFile(
          join(repository, 'package.json'),
          JSON.stringify({ name: 'repository-fixture', private: true, type: 'module' })
        );
        await writeFile(
          join(repository, 'tsconfig.json'),
          JSON.stringify({
            compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' },
            files: ['index.ts']
          })
        );
        await writeFile(join(repository, 'index.ts'), 'export const fixture = true;\n');
        const execute = promisify(execFile);
        await execute('git', ['init', '--initial-branch=main', repository]);
        await execute('git', ['-C', repository, 'add', '.']);
        await execute('git', [
          '-C',
          repository,
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '-m',
          'Repository fixture'
        ]);
        await symlink(repository, join(directory, '.local/neon-comparison-deepseek'), 'dir');
      }
      const initialFiles = await readdir(directory);
      const childArguments =
        launch !== 'comparison'
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
            ...(launch === 'narrow'
              ? { FORGE_TEST_TUI_ROWS: '24', FORGE_TEST_TUI_COLUMNS: '40' }
              : {}),
            ...(launch === 'comparison'
              ? { FORGE_COMPARISON_ENV_FILE: comparisonFile, FORGE_TEST_TUI_CONTINUE_TO_TASK: '1' }
              : {})
          }
        }
      );
      expect(result.stdout).toContain('Compiled Forge CLI initial render');
      if (launch === 'comparison') {
        expect(result.stdout).toContain('Deployment-bound repository reached task input');
      }
      expect(await readdir(directory)).toEqual(initialFiles);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);
