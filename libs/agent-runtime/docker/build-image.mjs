import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [base, tag] = process.argv.slice(2);
if (!base || !/@sha256:[a-f0-9]{64}$/.test(base) || !tag) {
  throw new Error('Usage: node build-image.mjs <digest-pinned-node-image> <local-image-tag>');
}
const directory = fileURLToPath(new URL('.', import.meta.url));
const context = await mkdtemp(join(tmpdir(), 'forge-pi-image-'));
try {
  for (const name of ['Dockerfile', 'package.json', 'package-lock.json', 'entrypoint.mjs']) {
    await copyFile(join(directory, name), join(context, name));
  }
  await build({
    entryPoints: [fileURLToPath(new URL('../src/lib/isolated-pi-session.ts', import.meta.url))],
    outfile: join(context, 'isolated-pi-session.mjs'),
    bundle: true,
    packages: 'external',
    platform: 'node',
    target: 'node24',
    format: 'esm'
  });
  execFileSync('docker', ['build', '--build-arg', `NODE_IMAGE=${base}`, '-t', tag, context], {
    stdio: 'inherit'
  });
} finally {
  await rm(context, { recursive: true, force: true });
}
