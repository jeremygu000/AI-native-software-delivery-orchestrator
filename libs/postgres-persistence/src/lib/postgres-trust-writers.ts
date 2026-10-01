import postgres from 'postgres';
import { createPublicKey } from 'node:crypto';

import type { PostgresEvidenceStoreConfiguration } from './postgres-evidence-store.js';
import { assertPostgresAuthorityLogin } from './postgres-authority-schema.js';

type Sql = ReturnType<typeof postgres>;

const requireText = (value: string, name: string): string => {
  if (!value.trim()) {
    throw new Error(`${name} must not be empty`);
  }
  return value;
};

const connectWriter = async (
  configuration: PostgresEvidenceStoreConfiguration,
  functionName: 'forge_trust_write' | 'forge_generation_write'
): Promise<Sql> => {
  assertPostgresAuthorityLogin(configuration);
  const sql = postgres(configuration.connectionString, {
    connection: {
      application_name:
        functionName === 'forge_trust_write' ? 'forge-trust-admin' : 'forge-generation-issuer'
    },
    onnotice: () => undefined
  });
  try {
    const identity = await sql`select current_user as name, session_user as session_name,
      rolsuper, rolcreatedb, rolcreaterole,
      exists (select 1 from pg_roles other where other.oid <> current_user::regrole
        and pg_has_role(current_user::regrole::oid,other.oid,'MEMBER')) as membership,
      has_database_privilege(current_user,current_database(),'CREATE') as create_database,
      has_database_privilege(current_user,current_database(),'TEMP') as create_temp
      from pg_roles where rolname=current_user`;
    const principal = identity[0];
    if (
      principal?.name !== configuration.role ||
      principal.session_name !== configuration.role ||
      principal.rolsuper !== false ||
      principal.rolcreatedb !== false ||
      principal.rolcreaterole !== false ||
      principal.membership !== false ||
      principal.create_database !== false ||
      principal.create_temp !== false
    ) {
      throw new Error('PostgreSQL authority writer must use a restricted login');
    }
    const rows = await sql`select n.nspowner::regrole::text as owner,
      has_schema_privilege(current_user,n.oid,'USAGE') as usage,
      has_schema_privilege(current_user,n.oid,'CREATE') as create_schema,
      p.proowner::regrole::text as function_owner, p.prosecdef as security_definer,
      has_function_privilege(current_user,p.oid,'EXECUTE') as execute,
      has_function_privilege('public',p.oid,'EXECUTE') as public_execute,
      has_function_privilege(current_user,p.oid,'EXECUTE WITH GRANT OPTION') as grant_execute
      from pg_namespace n join pg_proc p on p.pronamespace=n.oid
      where n.nspname=${configuration.schema} and p.proname=${functionName}`;
    const row = rows[0];
    if (
      rows.length !== 1 ||
      row?.owner === configuration.role ||
      row?.owner !== row.function_owner ||
      row?.usage !== true ||
      row.create_schema !== false ||
      row.security_definer !== true ||
      row.execute !== true ||
      row.public_execute !== false ||
      row.grant_execute !== false
    ) {
      throw new Error('PostgreSQL restricted authority writer is not installed');
    }
    const tables =
      await sql`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname=${configuration.schema} and c.relname like 'forge_global_%'
        and c.relkind='r' and (
          has_table_privilege(current_user,c.oid,'INSERT') or
          has_table_privilege(current_user,c.oid,'UPDATE') or
          has_table_privilege(current_user,c.oid,'DELETE') or
          has_table_privilege(current_user,c.oid,'TRUNCATE') or
          has_table_privilege(current_user,c.oid,'REFERENCES') or
          has_table_privilege(current_user,c.oid,'TRIGGER') or
          has_any_column_privilege(current_user,c.oid,'INSERT') or
          has_any_column_privilege(current_user,c.oid,'UPDATE') or
          has_any_column_privilege(current_user,c.oid,'REFERENCES'))`;
    if (tables.length !== 0) {
      throw new Error('PostgreSQL restricted writer has direct table mutation privileges');
    }
    const other =
      functionName === 'forge_trust_write' ? 'forge_generation_write' : 'forge_trust_write';
    const unwanted =
      await sql`select has_function_privilege(current_user,p.oid,'EXECUTE') as allowed
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname=${configuration.schema} and p.proname=${other}`;
    if (unwanted.length !== 1 || unwanted[0]?.allowed !== false) {
      throw new Error('PostgreSQL restricted writer has another authority function');
    }
    return sql;
  } catch (error) {
    await sql.end({ timeout: 5 });
    throw error;
  }
};

export class PostgresTrustRegistryAdmin {
  readonly #sql: Sql;
  readonly #schema: string;

  private constructor(sql: Sql, schema: string) {
    this.#sql = sql;
    this.#schema = `"${schema}"`;
  }

  static async connect(
    configuration: PostgresEvidenceStoreConfiguration
  ): Promise<PostgresTrustRegistryAdmin> {
    return new PostgresTrustRegistryAdmin(
      await connectWriter(configuration, 'forge_trust_write'),
      configuration.schema
    );
  }

  async close(): Promise<void> {
    await this.#sql.end({ timeout: 5 });
  }

  async #write(action: string, identity: string, detail: string): Promise<number> {
    const rows = await this.#sql.unsafe(
      `select ${this.#schema}.forge_trust_write($1,$2,$3) as revision`,
      [action, requireText(identity, 'Trust identity'), requireText(detail, 'Trust detail')]
    );
    const revision = BigInt(String(rows[0]?.revision));
    if (revision > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('Trust revision exceeds the safe JavaScript range');
    }
    return Number(revision);
  }

  registerKey(keyId: string, publicKey: string): Promise<number> {
    const key = createPublicKey(publicKey);
    if (key.asymmetricKeyType !== 'ed25519' || key.type !== 'public') {
      throw new Error('Trust registry requires an Ed25519 public key');
    }
    return this.#write('REGISTER_KEY', keyId, publicKey);
  }

  retireKey(keyId: string, publicKey: string): Promise<number> {
    return this.#write('RETIRE_KEY', keyId, publicKey);
  }

  revokeKey(keyId: string, publicKey: string): Promise<number> {
    return this.#write('REVOKE_KEY', keyId, publicKey);
  }

  revokeDecision(digest: string): Promise<number> {
    return this.#write('REVOKE_DECISION', digest, digest);
  }

  revokeAuthorization(digest: string): Promise<number> {
    return this.#write('REVOKE_AUTHORIZATION', digest, digest);
  }

  setPolicyVersion(version: string): Promise<number> {
    return this.#write('SET_POLICY', 'policy', version);
  }
}

export type GenerationBinding = {
  generationId: string;
  scopeId: string;
  parentClaimId: string;
  runId: string;
  taskId: string;
  attemptId: string;
  workspaceId: string;
  supervisorId: string;
  setupPlanDigest: string;
  executionPlanDigest: string;
};

export class PostgresExecutionGenerationIssuer {
  readonly #sql: Sql;
  readonly #schema: string;

  private constructor(sql: Sql, schema: string) {
    this.#sql = sql;
    this.#schema = `"${schema}"`;
  }

  static async connect(
    configuration: PostgresEvidenceStoreConfiguration
  ): Promise<PostgresExecutionGenerationIssuer> {
    return new PostgresExecutionGenerationIssuer(
      await connectWriter(configuration, 'forge_generation_write'),
      configuration.schema
    );
  }

  async close(): Promise<void> {
    await this.#sql.end({ timeout: 5 });
  }

  async issue(binding: GenerationBinding): Promise<void> {
    const values = [
      binding.generationId,
      binding.scopeId,
      binding.parentClaimId,
      binding.runId,
      binding.taskId,
      binding.attemptId,
      binding.workspaceId,
      binding.supervisorId,
      binding.setupPlanDigest,
      binding.executionPlanDigest
    ].map((value) => requireText(value, 'Generation binding'));
    await this.#sql.unsafe(
      `select ${this.#schema}.forge_generation_write('ISSUE',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      values
    );
  }

  async revoke(generationId: string, scopeId: string): Promise<void> {
    await this.#sql.unsafe(
      `select ${this.#schema}.forge_generation_write('REVOKE',$1,$2,null,null,null,null,null,null,null,null)`,
      [requireText(generationId, 'Generation ID'), requireText(scopeId, 'Scope ID')]
    );
  }
}
