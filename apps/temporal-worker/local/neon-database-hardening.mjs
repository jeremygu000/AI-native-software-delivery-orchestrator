import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import {
  resolvePostgresAuthorityServerMajor,
  openPostgresConnection,
  resolvePostgresConnectionSsl,
  preparePostgresAuthoritySchema,
  assertComparisonSchemaName
} from '@ai-native-software-delivery-orchestrator/postgres-persistence';

const [action, expectedDatabase, acknowledgement, schema] = process.argv.slice(2);
if (
  !['inspect', 'apply'].includes(action) ||
  !expectedDatabase ||
  (action === 'apply' &&
    !['--dedicated-forge-database', '--shared-database'].includes(acknowledgement))
) {
  throw new Error(
    'Usage: neon-database-hardening.mjs inspect DATABASE|apply DATABASE --shared-database SCHEMA|apply DATABASE --dedicated-forge-database'
  );
}
if (acknowledgement === '--shared-database') {
  assertComparisonSchemaName(schema ?? '');
}
const local = parseEnv(
  await readFile(
    process.env.FORGE_DATABASE_HARDENING_ENV_FILE ??
      resolve(import.meta.dirname, '../../../.env.local'),
    'utf8'
  )
);
const keys = {
  forge_owner: 'FORGE_OWNER_CONNECTION_STRING',
  forge_runtime: 'FORGE_RUNTIME_CONNECTION_STRING',
  forge_trust: 'FORGE_TRUST_CONNECTION_STRING',
  forge_issuer: 'FORGE_ISSUER_CONNECTION_STRING',
  forge_setup: 'FORGE_SETUP_CONNECTION_STRING',
  forge_recovery: 'FORGE_RECOVERY_CONNECTION_STRING'
};
const privateConnection = (key) => {
  try {
    return new URL(local[key] ?? '');
  } catch {
    // URL parsing errors may include their input, which contains private credentials.
    throw new Error(`Invalid private connection for ${key}`);
  }
};
const databaseOwner = privateConnection('FORGE_DATABASE_OWNER_CONNECTION_STRING');
if (
  !['postgres:', 'postgresql:'].includes(databaseOwner.protocol) ||
  decodeURIComponent(databaseOwner.pathname.slice(1)) !== expectedDatabase
) {
  throw new Error('Database owner connection must target the explicitly named database');
}
for (const [role, key] of Object.entries(keys)) {
  const url = privateConnection(key);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.searchParams.size !== 0 ||
    decodeURIComponent(url.username) !== role ||
    url.host !== databaseOwner.host ||
    url.pathname !== databaseOwner.pathname
  ) {
    throw new Error(`Database hardening connection mismatch for ${role}`);
  }
}
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const restricted = Object.keys(keys).filter((role) => role !== 'forge_owner');
const ssl = resolvePostgresConnectionSsl(
  process.env.FORGE_POSTGRES_SSL ?? local.FORGE_POSTGRES_SSL
);
const sql = openPostgresConnection(
  { connectionString: databaseOwner.toString(), ssl },
  { max: 1, onnotice: () => undefined }
);
const inspect = async (tx) => {
  const identity = await tx`select current_database() as database, current_user as role,
    session_user as login, pg_get_userbyid(datdba) as owner,
    current_setting('server_version_num')::integer as version
    from pg_database where datname=current_database()`;
  const current = identity[0];
  if (
    current.database !== expectedDatabase ||
    current.role !== current.owner ||
    current.login !== current.owner
  ) {
    throw new Error('Database hardening requires the actual database owner login');
  }
  const major = resolvePostgresAuthorityServerMajor(Number(current.version));
  const roles = await tx`select rolname as role, rolcanlogin as login,
    rolsuper as superuser, rolcreatedb as create_database, rolcreaterole as create_role,
    rolreplication as replication, rolbypassrls as bypass_rls,
    has_database_privilege(oid,current_database(),'CONNECT') as connect,
    has_database_privilege(oid,current_database(),'CREATE') as create_schema,
    has_database_privilege(oid,current_database(),'TEMP') as create_temp,
    has_schema_privilege(oid,'public','CREATE') as create_public
    from pg_roles where rolname = any(${tx.array(Object.keys(keys))}::text[]) order by rolname`;
  if (
    roles.length !== Object.keys(keys).length ||
    roles.some(
      (role) =>
        !role.login ||
        role.superuser ||
        role.create_database ||
        role.create_role ||
        role.replication ||
        role.bypass_rls
    )
  ) {
    throw new Error(
      'Forge requires six existing unprivileged login roles; role definitions were not changed'
    );
  }
  const schemas = await tx`select nspname as schema from pg_namespace
    where nspname not like 'pg_%' and nspname <> 'information_schema' order by nspname`;
  return {
    database: current.database,
    databaseOwner: current.owner,
    serverMajor: major,
    schemas,
    roles
  };
};
try {
  const before = await sql.begin('read only', inspect);
  console.log(JSON.stringify({ action: 'inspect', ...before }, null, 2));
  if (action === 'apply' && acknowledgement === '--shared-database') {
    const prepared = await preparePostgresAuthoritySchema({
      connectionString: databaseOwner.toString(),
      ssl,
      database: expectedDatabase,
      schema,
      ownerRole: 'forge_owner'
    });
    console.log(
      JSON.stringify({ action: 'schema-prepared', mode: 'shared', ...prepared }, null, 2)
    );
  } else if (action === 'apply') {
    const after = await sql.begin(async (tx) => {
      // This is an explicit deployment-owner operation on a dedicated database.
      // No authority schemas, migration ledgers, role definitions or persisted rows are changed.
      await inspect(tx);
      const database = quote(expectedDatabase);
      await tx.unsafe(`revoke temporary, create on database ${database} from public`);
      await tx.unsafe('revoke create on schema public from public');
      for (const role of Object.keys(keys)) {
        await tx.unsafe(`grant connect on database ${database} to ${quote(role)}`);
        await tx.unsafe(`revoke create on schema public from ${quote(role)}`);
      }
      for (const role of restricted) {
        await tx.unsafe(`revoke temporary, create on database ${database} from ${quote(role)}`);
      }
      await tx.unsafe(`grant create on database ${database} to "forge_owner"`);
      const result = await inspect(tx);
      if (
        result.roles.some(
          (role) =>
            !role.connect ||
            role.create_public ||
            (role.role !== 'forge_owner' && (role.create_temp || role.create_schema))
        ) ||
        !result.roles.find((role) => role.role === 'forge_owner').create_schema
      ) {
        throw new Error(
          'Database privileges remain incompatible; hardening transaction was rolled back'
        );
      }
      return result;
    });
    console.log(JSON.stringify({ action: 'applied', ...after }, null, 2));
  }
} finally {
  await sql.end();
}
