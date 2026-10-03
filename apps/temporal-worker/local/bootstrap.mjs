import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import postgres from 'postgres';
import {
  migratePostgresAuthoritySchema,
  POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION,
  PostgresGlobalMutationAuthority,
  PostgresTrustRegistryAdmin
} from '@ai-native-software-delivery-orchestrator/postgres-persistence';
import { authorityConfigurationFingerprint } from '@ai-native-software-delivery-orchestrator/persistence';
import { GitRepositorySnapshotProvider } from '@ai-native-software-delivery-orchestrator/workspace-git';

const root = resolve(import.meta.dirname, '../../..');
const envPath = resolve(root, '.env.local');
const action = process.argv[2];
const roles = {
  LOCAL_FORGE_OWNER_PASSWORD: 'forge_owner',
  LOCAL_FORGE_RUNTIME_PASSWORD: 'forge_runtime',
  LOCAL_FORGE_TRUST_PASSWORD: 'forge_trust',
  LOCAL_FORGE_ISSUER_PASSWORD: 'forge_issuer',
  LOCAL_FORGE_SETUP_PASSWORD: 'forge_setup',
  LOCAL_FORGE_RECOVERY_PASSWORD: 'forge_recovery'
};
const connection = (role, password, database = 'forge') => {
  const url = new URL(`postgres://127.0.0.1:54329/${database}`);
  url.username = role;
  url.password = password;
  return url.toString();
};
const literal = (value) => `'${value.replaceAll("'", "''")}'`;

if (action === 'env') {
  let existing;
  try {
    existing = await readFile(envPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
  if (existing !== undefined) {
    throw new Error('Local environment already exists; refusing overwrite');
  }
  const passwords = Object.fromEntries(
    ['LOCAL_DBA_PASSWORD', 'LOCAL_TEMPORAL_PASSWORD', ...Object.keys(roles)].map((name) => [
      name,
      randomBytes(24).toString('hex')
    ])
  );
  let template = await readFile(resolve(root, '.env.local.example'), 'utf8');
  for (const [name, value] of Object.entries(passwords)) {
    template = template.replace(`${name}=\n`, `${name}=${value}\n`);
  }
  const authority = {
    backend: 'postgres',
    connectionString: connection('forge_runtime', passwords.LOCAL_FORGE_RUNTIME_PASSWORD),
    schema: 'forge',
    role: 'forge_runtime'
  };
  template = template
    .replace('postgres://forge_runtime:REPLACE@127.0.0.1:54329/forge', authority.connectionString)
    .replace(
      'FORGE_AUTHORITY_ID=\n',
      `FORGE_AUTHORITY_ID=${authorityConfigurationFingerprint(authority)}\n`
    );
  await writeFile(envPath, template, { flag: 'wx', mode: 0o600 });
  console.log(
    'Created ignored .env.local with unique local database passwords; add the host model key and approved Pi image.'
  );
} else if (action === 'databases' || action === 'authority') {
  const env = { ...parseEnv(await readFile(envPath, 'utf8')), ...process.env };
  for (const name of ['LOCAL_DBA_PASSWORD', 'LOCAL_TEMPORAL_PASSWORD', ...Object.keys(roles)]) {
    if (!env[name]) {
      throw new Error(`Missing ${name}`);
    }
  }
  const dba = postgres(connection('local_dba', env.LOCAL_DBA_PASSWORD, 'postgres'), { max: 1 });
  try {
    if (action === 'databases') {
      for (const [role, password] of [
        ['temporal_service', env.LOCAL_TEMPORAL_PASSWORD],
        ...Object.entries(roles).map(([name, roleName]) => [roleName, env[name]])
      ]) {
        const found = await dba`select 1 from pg_roles where rolname=${role}`;
        if (found.length === 0) {
          await dba.unsafe(
            `create role ${role} login password ${literal(password)} nosuperuser nocreatedb nocreaterole noinherit`
          );
        }
      }
      for (const [database, owner] of [
        ['temporal', 'temporal_service'],
        ['temporal_visibility', 'temporal_service'],
        ['forge', 'forge_owner']
      ]) {
        const found =
          await dba`select datname, datdba::regrole::text as owner from pg_database where datname=${database}`;
        if (found.length === 0) {
          await dba.unsafe(
            `create database ${database} owner ${owner} template template0 lc_collate 'C' lc_ctype 'C'`
          );
        } else if (found[0].owner !== owner) {
          throw new Error('Existing database owner differs; operator repair required');
        }
        await dba.unsafe(`revoke all on database ${database} from public`);
      }
      await dba.unsafe(`grant connect on database forge to ${Object.values(roles).join(',')}`);
      const forgeDba = postgres(connection('local_dba', env.LOCAL_DBA_PASSWORD), { max: 1 });
      try {
        await forgeDba.unsafe('revoke create on schema public from public');
      } finally {
        await forgeDba.end();
      }
      console.log('Provisioned separate Forge and Temporal databases and isolated service logins.');
    } else {
      const config = (role, password) => ({
        connectionString: connection(role, password),
        schema: 'forge',
        role
      });
      await migratePostgresAuthoritySchema(
        config('forge_owner', env.LOCAL_FORGE_OWNER_PASSWORD),
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
        config('forge_runtime', env.LOCAL_FORGE_RUNTIME_PASSWORD)
      );
      const trust = await PostgresTrustRegistryAdmin.connect(
        config('forge_trust', env.LOCAL_FORGE_TRUST_PASSWORD)
      );
      try {
        const snapshot = await new GitRepositorySnapshotProvider().capture({
          repositoryPath: env.FORGE_WORKER_REPOSITORY_PATH
        });
        const scopeId = await authority.registerScope(snapshot.repositoryId);
        const ownerControl = postgres(connection('forge_owner', env.LOCAL_FORGE_OWNER_PASSWORD));
        let control;
        try {
          control = await ownerControl.unsafe('select state from forge.forge_global_control');
        } finally {
          await ownerControl.end();
        }
        if (control[0].state === 'LEGACY_ALLOWED') {
          const owner = postgres(connection('forge_owner', env.LOCAL_FORGE_OWNER_PASSWORD));
          try {
            const runs = await owner.unsafe('select count(*)::int as count from forge.forge_runs');
            if (runs[0].count !== 0) {
              throw new Error(
                'Local cutover requires an empty authority; independently stop/recover old writers first'
              );
            }
          } finally {
            await owner.end();
          }
          await authority.beginLegacyCutover();
          await authority.completeLegacyCutover(
            'Fresh local database has no persisted runs; no worker started before cutover'
          );
        } else if (control[0].state !== 'GLOBAL_READY') {
          throw new Error('Cutover already in progress; independent recovery required');
        }
        await authority.activateScope(scopeId);
        await mkdir(resolve(root, '.local'), { recursive: true, mode: 0o700 });
        let publicKey;
        try {
          publicKey = await readFile(resolve(root, '.local/setup-public.pem'), 'utf8');
        } catch (error) {
          if (error.code !== 'ENOENT') {
            throw error;
          }
          const pair = generateKeyPairSync('ed25519');
          publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
          await writeFile(
            resolve(root, '.local/setup-private.pem'),
            pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
            { flag: 'wx', mode: 0o600 }
          );
          await writeFile(resolve(root, '.local/setup-public.pem'), publicKey, {
            flag: 'wx',
            mode: 0o600
          });
        }
        await trust.registerKey('local-setup', publicKey);
        await trust.setPolicyVersion('git-workspace-setup-v1');
        await writeFile(
          resolve(root, '.local/authority.json'),
          JSON.stringify(
            {
              repositoryId: snapshot.repositoryId,
              scopeId,
              schemaVersion: POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION
            },
            null,
            2
          ),
          { mode: 0o600 }
        );
        console.log(
          'Existing migrations installed; registered local scope is GLOBAL_READY. Worker receives runtime credentials only.'
        );
      } finally {
        await authority.close();
        await trust.close();
      }
    }
  } finally {
    await dba.end();
  }
} else {
  throw new Error('Usage: bootstrap.mjs env|databases|authority');
}
