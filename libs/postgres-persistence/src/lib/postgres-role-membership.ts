import type postgres from 'postgres';

import { resolvePostgresAuthorityServerMajor } from './postgres-server-version.js';

/** Audit only: never grant, revoke or repair role memberships. */
export const assertRestrictedPostgresRoleMemberships = async (
  sql: ReturnType<typeof postgres> | postgres.TransactionSql,
  roles: readonly string[],
  message: string,
  serverMajor?: number
): Promise<void> => {
  if (serverMajor === undefined) {
    const version = await sql`select current_setting('server_version_num')::integer as version`;
    serverMajor = resolvePostgresAuthorityServerMajor(Number(version[0]?.version));
  }
  const principals = sql.array([...roles]);
  // ADMIN can grant SET/INHERIT, including back to its holder. This exception trusts
  // the actual database owner as a deployment principal; ADMIN is not non-escalating.
  // PG14/15 lack per-membership SET/INHERIT options and retain strict rejection.
  const result =
    serverMajor < 16
      ? await sql`select exists(select 1 from pg_catalog.pg_auth_members m
          where m.member = any(${principals}::text[]::regrole[])
             or m.roleid = any(${principals}::text[]::regrole[])) as incompatible`
      : await sql`select exists(select 1 from pg_catalog.pg_auth_members m
          where m.member = any(${principals}::text[]::regrole[])
             or (m.roleid = any(${principals}::text[]::regrole[]) and (
               m.member is distinct from (select datdba from pg_catalog.pg_database
                 where datname = current_database())
               or m.admin_option is not true
               or m.inherit_option is not false
               or m.set_option is not false))) as incompatible`;
  if (result[0]?.incompatible !== false) {
    throw new Error(message);
  }
};
