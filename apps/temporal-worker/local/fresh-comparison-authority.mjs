import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import postgres from 'postgres';
import { authorityConfigurationFingerprint } from '@ai-native-software-delivery-orchestrator/persistence';

const database = process.argv[2];
if (!database || !/^forge_comparison_[a-z0-9_]+$/.test(database)) {
  throw new Error('Supply a new forge_comparison_* database name');
}
const root = process.cwd();
const path = resolve(root, '.env.local');
const original = await readFile(path, 'utf8');
const env = parseEnv(original);
const dbaUrl = new URL(env.FORGE_POSTGRES_CONNECTION_STRING);
dbaUrl.pathname = '/postgres';
dbaUrl.username = 'local_dba';
dbaUrl.password = env.LOCAL_DBA_PASSWORD;
const dba = postgres(dbaUrl.toString(), { max: 1 });
try {
  if ((await dba`select 1 from pg_database where datname=${database}`).length !== 0) {
    throw new Error('Comparison database already exists; refusing reuse or overwrite');
  }
} finally {
  await dba.end();
}
await mkdir(resolve(root, '.local/history'), { recursive: true, mode: 0o700 });
await writeFile(resolve(root, `.local/history/${database}-previous.env`), original, {
  flag: 'wx',
  mode: 0o600
});
const url = new URL(env.FORGE_POSTGRES_CONNECTION_STRING);
url.pathname = `/${database}`;
const authority = {
  backend: 'postgres',
  connectionString: url.toString(),
  schema: env.FORGE_POSTGRES_SCHEMA,
  role: env.FORGE_POSTGRES_ROLE
};
const deployment = {
  ...process.env,
  ...env,
  LOCAL_FORGE_DATABASE: database,
  FORGE_POSTGRES_CONNECTION_STRING: url.toString(),
  FORGE_AUTHORITY_ID: authorityConfigurationFingerprint(authority)
};
for (const action of ['databases', 'authority']) {
  const result = spawnSync(process.execPath, ['apps/temporal-worker/local/bootstrap.mjs', action], {
    env: deployment,
    stdio: 'inherit'
  });
  if (result.status !== 0) {
    throw new Error('Fresh authority bootstrap failed; previous environment remains unchanged');
  }
}
let updated = original;
for (const key of ['FORGE_POSTGRES_CONNECTION_STRING', 'FORGE_AUTHORITY_ID']) {
  updated = updated.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${deployment[key]}`);
}
updated += `\nLOCAL_FORGE_DATABASE=${database}\n`;
await writeFile(path, updated, { mode: 0o600 });
console.log(
  'Fresh comparison authority ready; old database and previous private environment preserved.'
);
