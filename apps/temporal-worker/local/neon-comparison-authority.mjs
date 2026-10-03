import { execFile } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { parseEnv } from 'node:util';
import postgres from 'postgres';
import {
  migratePostgresAuthoritySchema,
  POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION,
  PostgresGlobalMutationAuthority,
  PostgresTrustRegistryAdmin,
  resolvePostgresAuthorityServerMajor
} from '@ai-native-software-delivery-orchestrator/postgres-persistence';
import { authorityConfigurationFingerprint } from '@ai-native-software-delivery-orchestrator/persistence';
import { GitRepositorySnapshotProvider } from '@ai-native-software-delivery-orchestrator/workspace-git';

const runGit = promisify(execFile);
const root = resolve(import.meta.dirname, '../../..');
const [action, argument] = process.argv.slice(2);
const privateEnvPath = resolve(root, '.local/neon-comparison.env');
const evidencePath = resolve(root, '.local/neon-comparison-authority.json');
if (action !== 'prepare' && action !== 'register') {
  throw new Error('Usage: neon-comparison-authority.mjs prepare SCHEMA|register CANDIDATE');
}
const local = parseEnv(await readFile(resolve(root, '.env.local'), 'utf8'));
const roles = {
  forge_owner: 'FORGE_OWNER_CONNECTION_STRING',
  forge_runtime: 'FORGE_RUNTIME_CONNECTION_STRING',
  forge_trust: 'FORGE_TRUST_CONNECTION_STRING',
  forge_issuer: 'FORGE_ISSUER_CONNECTION_STRING',
  forge_setup: 'FORGE_SETUP_CONNECTION_STRING',
  forge_recovery: 'FORGE_RECOVERY_CONNECTION_STRING'
};
const urls = Object.fromEntries(
  Object.entries(roles).map(([role, key]) => {
    if (!local[key]) {
      throw new Error(`Missing private Neon connection for ${role}`);
    }
    const url = new URL(local[key]);
    if (url.username !== role || !['postgres:', 'postgresql:'].includes(url.protocol)) {
      throw new Error(`Neon connection role mismatch for ${role}`);
    }
    return [role, url];
  })
);
const ownerUrl = urls.forge_owner;
if (
  Object.values(urls).some(
    (url) => url.host !== ownerUrl.host || url.pathname !== ownerUrl.pathname
  )
) {
  throw new Error('Neon roles must target the same endpoint and database');
}
if (Object.values(urls).some((url) => url.searchParams.size !== 0)) {
  throw new Error(
    'Neon authority role URLs must be query-free; configure TLS with PGSSL=verify-full'
  );
}
if (process.env.PGSSL !== 'verify-full') {
  throw new Error('Neon comparison bootstrap requires verified TLS through PGSSL=verify-full');
}
const configuration = (role, schema) => ({
  connectionString: urls[role].toString(),
  schema,
  role
});
const candidates = ['deepseek', 'copilot', 'codex'];
const repository = new GitRepositorySnapshotProvider();
const snapshot = async (candidate) => {
  if (!candidates.includes(candidate)) {
    throw new Error('Unknown comparison candidate');
  }
  const path = resolve(root, `.local/neon-comparison-${candidate}`);
  const [status, head, captured] = await Promise.all([
    runGit('git', ['-C', path, 'status', '--porcelain']),
    runGit('git', ['-C', path, 'rev-parse', 'HEAD']),
    repository.capture({ repositoryPath: path })
  ]);
  if (status.stdout.trim() !== '') {
    throw new Error(`Neon ${candidate} comparison checkout is dirty`);
  }
  return { head: head.stdout.trim(), repositoryId: captured.repositoryId };
};

if (action === 'prepare') {
  const schema = argument;
  if (!schema || !/^forge_comparison_[a-z0-9_]+$/.test(schema)) {
    throw new Error('Supply a new forge_comparison_* schema name');
  }
  for (const path of [privateEnvPath, evidencePath]) {
    try {
      await access(path);
      throw new Error('Neon comparison private configuration already exists');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
  const snapshots = await Promise.all(candidates.map(snapshot));
  if (
    snapshots.some(
      (item) => item.head !== snapshots[0].head || item.repositoryId !== snapshots[0].repositoryId
    )
  ) {
    throw new Error('Neon comparison checkouts do not share a clean baseline');
  }
  const owner = postgres(urls.forge_owner.toString(), { max: 1 });
  try {
    const version = await owner`select current_setting('server_version_num')::integer as version`;
    resolvePostgresAuthorityServerMajor(Number(version[0].version));
    for (const role of Object.keys(roles).filter((name) => name !== 'forge_owner')) {
      const privileges =
        await owner`select has_database_privilege(${role},current_database(),'TEMP') as create_temp`;
      if (privileges[0].create_temp) {
        throw new Error(`Neon ${role} has database TEMP privilege; no schema was created`);
      }
    }
    const existing = await owner`select 1 from pg_namespace where nspname=${schema}`;
    if (existing.length !== 0) {
      throw new Error('Neon comparison schema already exists; refusing reuse');
    }
  } finally {
    await owner.end();
  }
  await migratePostgresAuthoritySchema(
    configuration('forge_owner', schema),
    'forge_runtime',
    POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION,
    {
      trustAdminRole: 'forge_trust',
      generationIssuerRole: 'forge_issuer',
      setupAdmissionRole: 'forge_setup',
      recoveryRole: 'forge_recovery'
    }
  );
  const authority = await PostgresGlobalMutationAuthority.connect(
    configuration('forge_runtime', schema)
  );
  const trust = await PostgresTrustRegistryAdmin.connect(configuration('forge_trust', schema));
  let scopeId;
  try {
    await authority.beginLegacyCutover();
    await authority.completeLegacyCutover(
      'New isolated Neon schema has no persisted runs or prior writers'
    );
    scopeId = await authority.registerScope(snapshots[0].repositoryId);
    await authority.activateScope(scopeId);
    const publicKey = await readFile(resolve(root, '.local/setup-public.pem'), 'utf8');
    await trust.registerKey('local-setup', publicKey);
    await trust.setPolicyVersion('git-workspace-setup-v1');
  } finally {
    await trust.close();
    await authority.close();
  }
  const runtime = configuration('forge_runtime', schema);
  const privateEnv = [
    'PGSSL=verify-full',
    `FORGE_POSTGRES_CONNECTION_STRING=${runtime.connectionString}`,
    `FORGE_POSTGRES_SCHEMA=${schema}`,
    'FORGE_POSTGRES_ROLE=forge_runtime',
    `FORGE_AUTHORITY_ID=${authorityConfigurationFingerprint({ backend: 'postgres', ...runtime })}`,
    'FORGE_WORKER_AUTHORITY_MODE=global',
    'FORGE_OTEL_INSTRUMENTATION=1'
  ].join('\n');
  await writeFile(privateEnvPath, `${privateEnv}\n`, { flag: 'wx', mode: 0o600 });
  await writeFile(
    evidencePath,
    JSON.stringify(
      {
        schema,
        baseline: snapshots[0].head,
        repositoryId: snapshots[0].repositoryId,
        scopeId,
        schemaVersion: POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION
      },
      null,
      2
    ),
    { flag: 'wx', mode: 0o600 }
  );
  console.log(`Fresh Neon comparison authority ${schema} is GLOBAL_READY on ${snapshots[0].head}`);
} else {
  const candidate = argument;
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  const current = await snapshot(candidate);
  if (current.head !== evidence.baseline || current.repositoryId !== evidence.repositoryId) {
    throw new Error('Comparison checkout no longer matches the approved Neon baseline');
  }
  const authority = await PostgresGlobalMutationAuthority.connect(
    configuration('forge_runtime', evidence.schema)
  );
  try {
    const scopeId = await authority.registerScope(current.repositoryId);
    if (scopeId !== evidence.scopeId) {
      throw new Error('Neon comparison scope differs from bootstrap evidence');
    }
    await authority.activateScope(scopeId);
  } finally {
    await authority.close();
  }
  console.log(`Neon ${candidate} comparison scope is active`);
}
