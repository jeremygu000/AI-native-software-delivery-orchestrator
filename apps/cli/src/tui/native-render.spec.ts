import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
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
