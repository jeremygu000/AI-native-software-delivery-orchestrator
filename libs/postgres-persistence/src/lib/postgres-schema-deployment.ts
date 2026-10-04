import type postgres from 'postgres';

import {
  openPostgresConnection,
  type PostgresConnectionConfiguration
} from './postgres-connection.js';
import { resolvePostgresAuthorityServerMajor } from './postgres-server-version.js';

type Sql = ReturnType<typeof postgres> | postgres.TransactionSql;

export const assertComparisonSchemaName = (schema: string): void => {
  if (!/^forge_comparison_[a-z0-9_]+$/.test(schema) || schema.length > 63) {
    throw new Error('Supply a forge_comparison_* schema name of at most 63 bytes');
  }
};

/** Read-only fresh-install boundary. It never adopts, clears or repairs existing objects. */
export const assertEmptyPostgresAuthoritySchema = async (
  sql: Sql,
  schema: string,
  ownerRole: string
): Promise<void> => {
  const rows = await sql`select n.oid, n.nspowner::pg_catalog.regrole::text as owner,
    exists(select 1 from pg_catalog.aclexplode(coalesce(n.nspacl,
      pg_catalog.acldefault('n',n.nspowner))) a where a.grantee <> n.nspowner) as external_grants,
    exists(select 1 from pg_catalog.pg_depend d
      where d.refclassid='pg_catalog.pg_namespace'::pg_catalog.regclass
        and d.refobjid=n.oid) as objects
    from pg_catalog.pg_namespace n where n.nspname=${schema}`;
  if (rows.length !== 1 || rows[0]?.owner !== ownerRole) {
    throw new Error('Fresh authority requires an existing schema owned by the migration role');
  }
  if (rows[0].objects || rows[0].external_grants) {
    throw new Error('Fresh authority requires an empty schema with owner-only privileges');
  }
};

/** Deployment owner creates only a new empty schema; database/PUBLIC privileges are untouched. */
export const preparePostgresAuthoritySchema = async (
  configuration: PostgresConnectionConfiguration & {
    readonly database: string;
    readonly schema: string;
    readonly ownerRole: string;
  }
): Promise<{ readonly database: string; readonly schema: string; readonly ownerRole: string }> => {
  assertComparisonSchemaName(configuration.schema);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(configuration.ownerRole)) {
    throw new Error('Migration owner must be a PostgreSQL role identifier');
  }
  const sql = openPostgresConnection(configuration, { max: 1, onnotice: () => undefined });
  try {
    return await sql.begin(async (tx) => {
      const identity = await tx`select current_database() as database, current_user as role,
        session_user as login, pg_catalog.pg_get_userbyid(datdba) as owner,
        current_setting('server_version_num')::integer as version
        from pg_catalog.pg_database where datname=current_database()`;
      const row = identity[0];
      if (
        row?.database !== configuration.database ||
        row.role !== row.owner ||
        row.login !== row.owner ||
        row.role === configuration.ownerRole
      ) {
        throw new Error('Schema preparation requires the actual owner login of the named database');
      }
      resolvePostgresAuthorityServerMajor(Number(row.version));
      const owners = await tx`select rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
        rolreplication, rolbypassrls,
        pg_catalog.has_database_privilege(oid,current_database(),'CREATE') as database_create,
        exists(select 1 from pg_catalog.pg_auth_members m
          where m.member=r.oid) as membership
        from pg_catalog.pg_roles r where rolname=${configuration.ownerRole}`;
      const owner = owners[0];
      if (
        owners.length !== 1 ||
        owner?.rolcanlogin !== true ||
        owner.rolsuper ||
        owner.rolcreatedb ||
        owner.rolcreaterole ||
        owner.rolreplication ||
        owner.rolbypassrls ||
        owner.database_create ||
        owner.membership
      ) {
        throw new Error(
          'Shared deployment requires an unprivileged schema owner without database CREATE'
        );
      }
      await tx`select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(${`forge-schema:${configuration.schema}`}))`;
      const existing =
        await tx`select 1 from pg_catalog.pg_namespace where nspname=${configuration.schema}`;
      if (existing.length !== 0) {
        throw new Error('Comparison schema already exists; refusing reuse');
      }
      await tx.unsafe(
        `create schema "${configuration.schema}" authorization "${configuration.ownerRole}"`
      );
      await assertEmptyPostgresAuthoritySchema(tx, configuration.schema, configuration.ownerRole);
      return {
        database: configuration.database,
        schema: configuration.schema,
        ownerRole: configuration.ownerRole
      };
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
};
