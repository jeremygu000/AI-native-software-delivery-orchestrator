import { createHash } from 'node:crypto';

import postgres from 'postgres';

import {
  assertPostgresEvidenceStoreConfiguration,
  type PostgresEvidenceStoreConfiguration
} from './postgres-evidence-store.js';

type Sql = ReturnType<typeof postgres>;
type TransactionSql = postgres.TransactionSql;

const migrations = [
  {
    version: 1,
    statements: [
      `create table {schema}.forge_runs (
        id text primary key, state text not null, payload text not null
      )`,
      `create table {schema}.forge_records (
        run_id text not null references {schema}.forge_runs(id),
        kind text not null, key text not null, payload text not null,
        primary key (run_id, kind, key)
      )`
    ]
  },
  {
    version: 2,
    statements: ['create index forge_records_kind_run_idx on {schema}.forge_records (kind, run_id)']
  }
] as const;

export const POSTGRES_AUTHORITY_SCHEMA_VERSION = 2;
export type PostgresAuthoritySchemaVersion = 1 | typeof POSTGRES_AUTHORITY_SCHEMA_VERSION;

const checksum = (statements: readonly string[]): string =>
  createHash('sha256').update(statements.join('\n')).digest('hex');
const quote = (identifier: string): string => `"${identifier}"`;

const expectedColumns = {
  forge_schema_migrations: [
    ['version', 'integer', true],
    ['checksum', 'text', true],
    ['applied_at', 'timestamp with time zone', true]
  ],
  forge_runs: [
    ['id', 'text', true],
    ['state', 'text', true],
    ['payload', 'text', true]
  ],
  forge_records: [
    ['run_id', 'text', true],
    ['kind', 'text', true],
    ['key', 'text', true],
    ['payload', 'text', true]
  ]
} as const;

const assertAuthorityShape = async (
  sql: TransactionSql | Sql,
  schema: string,
  version: number
): Promise<void> => {
  const tables: (keyof typeof expectedColumns)[] =
    version >= 1
      ? ['forge_schema_migrations', 'forge_runs', 'forge_records']
      : ['forge_schema_migrations'];
  const columns = await sql`select c.relname as table_name, a.attname as column_name,
    format_type(a.atttypid, a.atttypmod) as data_type, a.attnotnull as not_null
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid
    where n.nspname = ${schema} and c.relname in ('forge_schema_migrations','forge_runs','forge_records')
      and c.relkind in ('r','p') and a.attnum > 0 and not a.attisdropped
    order by c.relname, a.attnum`;
  const actual = columns.map((row) => [
    row.table_name,
    row.column_name,
    row.data_type,
    row.not_null
  ]);
  const expected = tables.flatMap((table) => {
    const columnsForTable = expectedColumns[table];
    return columnsForTable.map(([name, type, notNull]) => [table, name, type, notNull]);
  });
  if (
    JSON.stringify(actual) !==
    JSON.stringify(expected.toSorted(([a], [b]) => String(a).localeCompare(String(b))))
  ) {
    throw new Error('PostgreSQL authority table columns are incompatible');
  }
  const constraints = await sql`select c.relname as table_name, con.contype as kind,
    pg_get_constraintdef(con.oid) as definition
    from pg_constraint con join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schema} and c.relname in ('forge_schema_migrations','forge_runs','forge_records')
    order by c.relname, con.contype`;
  const actualConstraints = constraints.map((row) => [row.table_name, row.kind, row.definition]);
  const expectedConstraints =
    version >= 1
      ? [
          ['forge_records', 'f', `FOREIGN KEY (run_id) REFERENCES ${schema}.forge_runs(id)`],
          ['forge_records', 'p', 'PRIMARY KEY (run_id, kind, key)'],
          ['forge_runs', 'p', 'PRIMARY KEY (id)'],
          ['forge_schema_migrations', 'p', 'PRIMARY KEY (version)']
        ]
      : [['forge_schema_migrations', 'p', 'PRIMARY KEY (version)']];
  if (JSON.stringify(actualConstraints) !== JSON.stringify(expectedConstraints)) {
    throw new Error('PostgreSQL authority table constraints are incompatible');
  }
  const indexes = await sql`select c.relname as table_name, i.relname as index_name,
    pg_get_indexdef(i.oid) as definition
    from pg_index x join pg_class c on c.oid = x.indrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_class i on i.oid = x.indexrelid
    where n.nspname = ${schema} and i.relname = 'forge_records_kind_run_idx'`;
  const expectedIndex = `CREATE INDEX forge_records_kind_run_idx ON ${schema}.forge_records USING btree (kind, run_id)`;
  if (
    version >= 2 &&
    (indexes.length !== 1 ||
      indexes[0]?.table_name !== 'forge_records' ||
      indexes[0].definition !== expectedIndex)
  ) {
    throw new Error(
      'PostgreSQL authority schema is missing required index or its definition is incompatible'
    );
  }
  if (version < 2 && indexes.length !== 0) {
    throw new Error('PostgreSQL authority schema contains an unexpected future index');
  }
};

/** Installer-only operation. Never invoke it from an activity or runtime connection. */
export const migratePostgresAuthoritySchema = async (
  configuration: PostgresEvidenceStoreConfiguration,
  runtimeRole: string,
  targetVersion: PostgresAuthoritySchemaVersion = POSTGRES_AUTHORITY_SCHEMA_VERSION
): Promise<void> => {
  assertPostgresEvidenceStoreConfiguration(configuration);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(runtimeRole) || runtimeRole === configuration.role) {
    throw new Error('PostgreSQL migration owner and runtime roles must be distinct identifiers');
  }
  const sql = postgres(configuration.connectionString);
  const schema = quote(configuration.schema);
  try {
    await sql.begin(async (tx) => {
      const identity = await tx`select current_user as name`;
      if (identity[0]?.name !== configuration.role) {
        throw new Error('PostgreSQL migration owner role mismatch');
      }
      await tx`select pg_advisory_xact_lock(hashtext(${`forge-schema:${configuration.schema}`}))`;
      const existing = await tx`select 1 from pg_namespace where nspname = ${configuration.schema}`;
      if (existing.length === 0) {
        await tx.unsafe(`create schema ${schema}`);
      }
      const owners =
        await tx`select nspowner::regrole::text as name from pg_namespace where nspname = ${configuration.schema}`;
      if (owners[0]?.name !== configuration.role) {
        throw new Error('PostgreSQL migration role does not own the authority schema');
      }
      const objects =
        await tx`select relname from pg_class where relnamespace = ${configuration.schema}::regnamespace and relkind in ('r','p')`;
      const hasLedger = objects.some((row) => row.relname === 'forge_schema_migrations');
      if (!hasLedger && objects.length !== 0) {
        throw new Error('PostgreSQL authority schema has objects but no migration ledger');
      }
      if (!hasLedger) {
        await tx.unsafe(`create table ${schema}.forge_schema_migrations (
          version integer primary key, checksum text not null,
          applied_at timestamptz not null default now()
        )`);
      }
      const applied = await tx.unsafe(
        `select version, checksum from ${schema}.forge_schema_migrations order by version`
      );
      const installedObjects =
        await tx`select relname from pg_class where relnamespace = ${configuration.schema}::regnamespace and relkind in ('r','p')`;
      const expectedTables =
        applied.length === 0
          ? ['forge_schema_migrations']
          : ['forge_schema_migrations', 'forge_runs', 'forge_records'];
      if (
        installedObjects.length !== expectedTables.length ||
        expectedTables.some((name) => !installedObjects.some((row) => row.relname === name))
      ) {
        throw new Error('PostgreSQL authority schema has unexpected or missing tables');
      }
      for (let index = 0; index < applied.length; index++) {
        const migration = migrations[index];
        if (
          migration === undefined ||
          applied[index]?.version !== migration.version ||
          applied[index]?.checksum !== checksum(migration.statements)
        ) {
          throw new Error('PostgreSQL authority migration ledger is incompatible');
        }
      }
      if (applied.length > targetVersion) {
        throw new Error('PostgreSQL authority migrations cannot downgrade a schema');
      }
      await assertAuthorityShape(tx, configuration.schema, applied.length);
      for (const migration of migrations.slice(applied.length, targetVersion)) {
        for (const statement of migration.statements) {
          const qualified = statement.replaceAll('{schema}', schema);
          await tx.unsafe(qualified);
        }
        await tx.unsafe(
          `insert into ${schema}.forge_schema_migrations (version, checksum) values ($1,$2)`,
          [migration.version, checksum(migration.statements)]
        );
      }
      await assertAuthorityShape(tx, configuration.schema, targetVersion);
      await grantRuntimePrivileges(tx, schema, runtimeRole);
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
};

const grantRuntimePrivileges = async (
  tx: TransactionSql,
  schema: string,
  runtimeRole: string
): Promise<void> => {
  const role = quote(runtimeRole);
  await tx.unsafe(`revoke all on schema ${schema} from public`);
  await tx.unsafe(`revoke all on schema ${schema} from ${role}`);
  await tx.unsafe(`grant usage on schema ${schema} to ${role}`);
  await tx.unsafe(`revoke all on ${schema}.forge_schema_migrations from public`);
  await tx.unsafe(`revoke all on ${schema}.forge_schema_migrations from ${role}`);
  await tx.unsafe(`grant select on ${schema}.forge_schema_migrations to ${role}`);
  await tx.unsafe(
    `grant select, insert, update, delete on ${schema}.forge_runs, ${schema}.forge_records to ${role}`
  );
};

/** Read-only startup gate: schema installation is exclusively a migration-owner operation. */
export const assertPostgresAuthoritySchema = async (
  sql: Sql,
  configuration: PostgresEvidenceStoreConfiguration
): Promise<void> => {
  const schema = quote(configuration.schema);
  const identity = await sql`select current_user as name`;
  if (identity[0]?.name !== configuration.role) {
    throw new Error('PostgreSQL authority role mismatch');
  }
  const metadata =
    await sql`select nspowner::regrole::text as owner from pg_namespace where nspname = ${configuration.schema}`;
  if (metadata.length !== 1 || metadata[0]?.owner === configuration.role) {
    throw new Error('PostgreSQL authority schema does not exist or runtime role owns it');
  }
  const identityPrivileges = await sql`select
    rolsuper, rolcreatedb, rolcreaterole,
    pg_has_role(current_user, ${metadata[0].owner}::name, 'MEMBER') as migration_member,
    has_database_privilege(current_user, current_database(), 'CREATE') as create_database,
    has_database_privilege(current_user, current_database(), 'TEMP') as create_temp
    from pg_roles where rolname = current_user`;
  if (
    identityPrivileges[0]?.rolsuper !== false ||
    identityPrivileges[0].rolcreatedb !== false ||
    identityPrivileges[0].rolcreaterole !== false ||
    identityPrivileges[0].migration_member !== false ||
    identityPrivileges[0].create_database !== false ||
    identityPrivileges[0].create_temp !== false
  ) {
    throw new Error('PostgreSQL authority runtime role is not least privileged');
  }
  const createSchemas = await sql`select nspname from pg_namespace
    where nspname !~ '^pg_' and nspname <> 'information_schema'
      and has_schema_privilege(current_user, oid, 'CREATE')`;
  if (createSchemas.length > 0) {
    throw new Error('PostgreSQL authority runtime role can create objects in an accessible schema');
  }
  const objects =
    await sql`select relname, relowner::regrole::text as owner from pg_class where relnamespace = ${configuration.schema}::regnamespace and relkind in ('r','p')`;
  for (const name of ['forge_schema_migrations', 'forge_runs', 'forge_records']) {
    const object = objects.find((row) => row.relname === name);
    if (object === undefined || object.owner === configuration.role) {
      throw new Error(`PostgreSQL authority object is missing or runtime-owned: ${name}`);
    }
  }
  if (objects.length !== 3 || objects.some((object) => object.owner !== metadata[0]?.owner)) {
    throw new Error('PostgreSQL authority object ownership or table set is incompatible');
  }
  const applied = await sql.unsafe(
    `select version, checksum from ${schema}.forge_schema_migrations order by version`
  );
  if (applied.length !== POSTGRES_AUTHORITY_SCHEMA_VERSION) {
    throw new Error('PostgreSQL authority schema version is incompatible');
  }
  for (let index = 0; index < applied.length; index++) {
    const migration = migrations[index];
    if (
      migration === undefined ||
      applied[index]?.version !== migration.version ||
      applied[index]?.checksum !== checksum(migration.statements)
    ) {
      throw new Error('PostgreSQL authority migration ledger is incompatible');
    }
  }
  const privileges = await sql`select
    has_schema_privilege(current_user, ${configuration.schema}, 'USAGE') as usage,
    has_schema_privilege(current_user, ${configuration.schema}, 'CREATE') as create_schema,
    has_table_privilege(current_user, ${`${configuration.schema}.forge_schema_migrations`}, 'SELECT') as ledger_read,
    has_table_privilege(current_user, ${`${configuration.schema}.forge_schema_migrations`}, 'INSERT') as ledger_insert,
    has_table_privilege(current_user, ${`${configuration.schema}.forge_schema_migrations`}, 'UPDATE') as ledger_update,
    has_table_privilege(current_user, ${`${configuration.schema}.forge_schema_migrations`}, 'DELETE') as ledger_delete,
    has_table_privilege(current_user, ${`${configuration.schema}.forge_runs`}, 'SELECT') as runs_select,
    has_table_privilege(current_user, ${`${configuration.schema}.forge_runs`}, 'INSERT') as runs_insert,
    has_table_privilege(current_user, ${`${configuration.schema}.forge_runs`}, 'UPDATE') as runs_update,
    has_table_privilege(current_user, ${`${configuration.schema}.forge_runs`}, 'DELETE') as runs_delete,
    has_table_privilege(current_user, ${`${configuration.schema}.forge_records`}, 'SELECT') as records_select,
    has_table_privilege(current_user, ${`${configuration.schema}.forge_records`}, 'INSERT') as records_insert,
    has_table_privilege(current_user, ${`${configuration.schema}.forge_records`}, 'UPDATE') as records_update,
    has_table_privilege(current_user, ${`${configuration.schema}.forge_records`}, 'DELETE') as records_delete`;
  const p = privileges[0];
  if (
    p?.usage !== true ||
    p.create_schema === true ||
    p.ledger_read !== true ||
    p.ledger_insert === true ||
    p.ledger_update === true ||
    p.ledger_delete === true ||
    p.runs_select !== true ||
    p.runs_insert !== true ||
    p.runs_update !== true ||
    p.runs_delete !== true ||
    p.records_select !== true ||
    p.records_insert !== true ||
    p.records_update !== true ||
    p.records_delete !== true
  ) {
    throw new Error('PostgreSQL authority runtime privileges are incompatible');
  }
  await assertAuthorityShape(sql, configuration.schema, POSTGRES_AUTHORITY_SCHEMA_VERSION);
};
