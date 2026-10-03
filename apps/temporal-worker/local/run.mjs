import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
const root = resolve(import.meta.dirname, '../../..');
const local = parseEnv(await readFile(resolve(root, '.env.local'), 'utf8'));
const command = process.argv[2];
const entries = {
  worker: 'apps/temporal-worker/dist/main.js',
  preflight: 'apps/temporal-worker/dist/main.js',
  cli: 'apps/cli/dist/main.js'
};
if (!(command in entries)) {
  throw new Error('Usage: run.mjs worker|preflight|cli [arguments]');
}
// Privileged bootstrap credentials and signing files are never passed to workers/CLI.
const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (
    name.startsWith('LOCAL_') ||
    [
      'FORGE_OWNER_CONNECTION_STRING',
      'FORGE_TRUST_CONNECTION_STRING',
      'FORGE_ISSUER_CONNECTION_STRING',
      'FORGE_SETUP_CONNECTION_STRING',
      'FORGE_RECOVERY_CONNECTION_STRING'
    ].includes(name)
  ) {
    delete env[name];
  }
}
for (const [name, value] of Object.entries(local)) {
  if (
    !name.startsWith('LOCAL_') &&
    ![
      'FORGE_OWNER_CONNECTION_STRING',
      'FORGE_TRUST_CONNECTION_STRING',
      'FORGE_ISSUER_CONNECTION_STRING',
      'FORGE_SETUP_CONNECTION_STRING',
      'FORGE_RECOVERY_CONNECTION_STRING'
    ].includes(name)
  ) {
    env[name] = value;
  }
}
const child = spawn(
  process.execPath,
  [
    resolve(root, entries[command]),
    ...(command === 'preflight' ? ['--preflight'] : []),
    ...process.argv.slice(3)
  ],
  { cwd: root, env, stdio: 'inherit' }
);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
