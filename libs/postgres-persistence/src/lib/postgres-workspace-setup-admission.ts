import { createHash, createPublicKey, randomBytes } from 'node:crypto';

import postgres from 'postgres';
import {
  fingerprintPlanValue,
  verifyWorkspaceSetupAuthorization,
  workspaceSetupAuthorizationSchema,
  type PlanApproval,
  type PlanArtifact,
  type WorkspaceSetupApproval,
  type WorkspaceSetupAuthorization
} from '@ai-native-software-delivery-orchestrator/planning';
import {
  taskLeasePlanFingerprint,
  type PersistedTaskExecutionBinding
} from '@ai-native-software-delivery-orchestrator/domain';

import type { PostgresEvidenceStoreConfiguration } from './postgres-evidence-store.js';
import { assertPostgresAuthorityLogin } from './postgres-authority-schema.js';

type Sql = ReturnType<typeof postgres>;

/** Only the independently authenticated signing service may hold these credentials. */
export class PostgresWorkspaceSetupAdmission {
  readonly #sql: Sql;
  readonly #schema: string;

  private constructor(sql: Sql, schema: string) {
    this.#sql = sql;
    this.#schema = `"${schema}"`;
  }

  static async connect(
    configuration: PostgresEvidenceStoreConfiguration
  ): Promise<PostgresWorkspaceSetupAdmission> {
    assertPostgresAuthorityLogin(configuration);
    const sql = postgres(configuration.connectionString, {
      onnotice: () => undefined,
      connection: { application_name: 'forge-setup-admission' }
    });
    try {
      const identity = await sql`select current_user as name, session_user as session_name,
        rolsuper, rolcreatedb, rolcreaterole,
        exists(select 1 from pg_auth_members m where m.roleid=current_user::regrole::oid or m.member=current_user::regrole::oid) as membership,
        has_database_privilege(current_user,current_database(),'CREATE') as create_database,
        has_database_privilege(current_user,current_database(),'TEMP') as create_temp
        from pg_roles where rolname=current_user`;
      const fn =
        await sql`select p.prosecdef as security_definer, p.proowner::regrole::text as owner,
        obj_description(p.oid,'pg_proc') as designated,
        has_function_privilege(current_user,p.oid,'EXECUTE') as can_execute,
        has_function_privilege('public',p.oid,'EXECUTE') as public_execute,
        has_function_privilege(current_user,p.oid,'EXECUTE WITH GRANT OPTION') as can_grant
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname=${configuration.schema} and p.proname='forge_setup_admit'`;
      const otherFunctions = await sql`select p.proname as name,
        has_function_privilege(current_user,p.oid,'EXECUTE') as can_execute
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname=${configuration.schema} and p.proname not in ('forge_setup_admit','forge_setup_arm','forge_workspace_permit_begin','forge_workspace_permit_finish')
         order by p.proname`;
      const armFunction = await sql`select p.prosecdef as security_definer,
         p.proowner::regrole::text as owner, obj_description(p.oid,'pg_proc') as designated,
         has_function_privilege(current_user,p.oid,'EXECUTE') as can_execute,
         has_function_privilege('public',p.oid,'EXECUTE') as public_execute,
         has_function_privilege(current_user,p.oid,'EXECUTE WITH GRANT OPTION') as can_grant
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname=${configuration.schema} and p.proname='forge_setup_arm'`;
      const permitFunction = await sql`select p.prosecdef as security_definer,
          p.proowner::regrole::text as owner, obj_description(p.oid,'pg_proc') as designated,
          has_function_privilege(current_user,p.oid,'EXECUTE') as can_execute,
          has_function_privilege('public',p.oid,'EXECUTE') as public_execute,
          has_function_privilege(current_user,p.oid,'EXECUTE WITH GRANT OPTION') as can_grant
          from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname=${configuration.schema} and p.proname='forge_workspace_permit_begin'`;
      const finishFunction = await sql`select p.prosecdef as security_definer,
          p.proowner::regrole::text as owner, obj_description(p.oid,'pg_proc') as designated,
          has_function_privilege(current_user,p.oid,'EXECUTE') as can_execute,
          has_function_privilege('public',p.oid,'EXECUTE') as public_execute,
          has_function_privilege(current_user,p.oid,'EXECUTE WITH GRANT OPTION') as can_grant
          from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname=${configuration.schema} and p.proname='forge_workspace_permit_finish'`;
      const direct =
        await sql`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname=${configuration.schema} and c.relkind in ('r','p') and (
          has_table_privilege(current_user,c.oid,'INSERT') or has_table_privilege(current_user,c.oid,'UPDATE') or
          has_table_privilege(current_user,c.oid,'DELETE') or has_table_privilege(current_user,c.oid,'TRUNCATE') or
          has_table_privilege(current_user,c.oid,'REFERENCES') or has_table_privilege(current_user,c.oid,'TRIGGER') or
          has_any_column_privilege(current_user,c.oid,'INSERT') or has_any_column_privilege(current_user,c.oid,'UPDATE') or
          has_any_column_privilege(current_user,c.oid,'REFERENCES')) limit 1`;
      const schemaCreate = await sql`select 1 from pg_namespace n
        where has_schema_privilege(current_user,n.oid,'CREATE') limit 1`;
      const keyRead =
        await sql`select has_table_privilege(current_user,${configuration.schema}::text || '.forge_global_trust_keys','SELECT') as allowed`;
      if (
        identity.length !== 1 ||
        identity[0]?.name !== configuration.role ||
        identity[0].session_name !== configuration.role ||
        identity[0].rolsuper !== false ||
        identity[0].rolcreatedb !== false ||
        identity[0].rolcreaterole !== false ||
        identity[0].membership !== false ||
        identity[0].create_database !== false ||
        identity[0].create_temp !== false ||
        fn.length !== 1 ||
        fn[0]?.security_definer !== true ||
        fn[0].owner === configuration.role ||
        fn[0].designated !== configuration.role ||
        fn[0].can_execute !== true ||
        fn[0].public_execute !== false ||
        fn[0].can_grant !== false ||
        armFunction.length !== 1 ||
        armFunction[0]?.security_definer !== true ||
        armFunction[0].owner !== fn[0].owner ||
        armFunction[0].designated !== configuration.role ||
        armFunction[0].can_execute !== true ||
        armFunction[0].public_execute !== false ||
        armFunction[0].can_grant !== false ||
        permitFunction.length !== 1 ||
        permitFunction[0]?.security_definer !== true ||
        permitFunction[0].owner !== fn[0].owner ||
        permitFunction[0].designated !== configuration.role ||
        permitFunction[0].can_execute !== true ||
        permitFunction[0].public_execute !== false ||
        permitFunction[0].can_grant !== false ||
        finishFunction.length !== 1 ||
        finishFunction[0]?.security_definer !== true ||
        finishFunction[0].owner !== fn[0].owner ||
        finishFunction[0].designated !== configuration.role ||
        finishFunction[0].can_execute !== true ||
        finishFunction[0].public_execute !== false ||
        finishFunction[0].can_grant !== false ||
        otherFunctions.length !== 2 ||
        otherFunctions[0]?.name !== 'forge_generation_write' ||
        otherFunctions[0].can_execute !== false ||
        otherFunctions[1]?.name !== 'forge_trust_write' ||
        otherFunctions[1].can_execute !== false ||
        direct.length !== 0 ||
        schemaCreate.length !== 0 ||
        keyRead[0]?.allowed !== true
      ) {
        throw new Error('PostgreSQL setup admission requires its restricted signing-service login');
      }
      return new PostgresWorkspaceSetupAdmission(sql, configuration.schema);
    } catch (error) {
      await sql.end({ timeout: 5 });
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.#sql.end({ timeout: 5 });
  }

  /** The definer repeats current trust and persisted identity checks inside the grant transaction. */
  async admit(request: {
    readonly scopeId: string;
    readonly runId: string;
    readonly attemptId: string;
    readonly parentClaimId: string;
    readonly workspaceId: string;
    readonly artifact: PlanArtifact;
    readonly executionApproval: PlanApproval;
    readonly setupApproval: WorkspaceSetupApproval;
    readonly authorization: WorkspaceSetupAuthorization;
    readonly binding: PersistedTaskExecutionBinding;
  }): Promise<{ status: 'blocked' } | { status: 'granted'; token: number }> {
    const authorization = workspaceSetupAuthorizationSchema.parse(request.authorization);
    const keyRows = await this.#sql.unsafe(
      `select public_key from ${this.#schema}.forge_global_trust_keys where key_id=$1`,
      [authorization.keyId]
    );
    const pem = keyRows[0]?.public_key;
    if (typeof pem !== 'string' || createPublicKey(pem).asymmetricKeyType !== 'ed25519') {
      throw new Error('Unregistered Git workspace setup signing key');
    }
    const setup = verifyWorkspaceSetupAuthorization({
      ...request,
      authorization,
      trustedPublicKeys: new Map([[authorization.keyId, pem]])
    });
    if (
      request.binding.runId !== request.runId ||
      request.binding.taskId !== setup.taskId ||
      request.binding.workspace.id !== request.workspaceId ||
      request.binding.workspace.integrationRepositoryPath !== setup.repositoryRoot
    ) {
      throw new Error('Workspace setup binding does not match approved run and workspace');
    }
    const values = [
      request.scopeId,
      request.parentClaimId,
      request.runId,
      setup.taskId,
      request.attemptId,
      request.binding.agentId,
      request.workspaceId,
      setup.repositoryId,
      setup.artifactId,
      setup.executionApprovalId,
      setup.executionApprovalFingerprint,
      setup.planFingerprint,
      setup.setupApprovalFingerprint.slice(7),
      fingerprintPlanValue(authorization).slice(7),
      authorization.keyId,
      fingerprintPlanValue(request.binding.leasePlan).slice(7),
      String(setup.artifactRevision),
      setup.repositoryRoot,
      setup.baseCommit,
      pem,
      taskLeasePlanFingerprint(request.binding.leasePlan)
    ];
    const rows = await this.#sql.unsafe(
      `select ${this.#schema}.forge_setup_admit(${values.map((_, index) => `$${index + 1}`).join(',')}) as result`,
      values
    );
    const result = rows[0]?.result;
    if (result === 'BLOCKED') {
      return { status: 'blocked' };
    }
    if (typeof result !== 'string' || !/^GRANTED:[1-9][0-9]*$/.test(result)) {
      throw new Error('Unexpected workspace setup admission result');
    }
    const token = Number(result.slice('GRANTED:'.length));
    if (!Number.isSafeInteger(token)) {
      throw new Error('Workspace setup token exceeds safe JavaScript range');
    }
    return { status: 'granted', token };
  }

  /** Arming never starts Git: a distinct one-lineage permit remains required. */
  async arm(request: {
    readonly scopeId: string;
    readonly runId: string;
    readonly attemptId: string;
    readonly parentClaimId: string;
    readonly workspaceId: string;
    readonly generationId: string;
    readonly artifact: PlanArtifact;
    readonly executionApproval: PlanApproval;
    readonly setupApproval: WorkspaceSetupApproval;
    readonly authorization: WorkspaceSetupAuthorization;
    readonly binding: PersistedTaskExecutionBinding;
  }): Promise<void> {
    const authorization = workspaceSetupAuthorizationSchema.parse(request.authorization);
    const keyRows = await this.#sql.unsafe(
      `select public_key from ${this.#schema}.forge_global_trust_keys where key_id=$1`,
      [authorization.keyId]
    );
    const pem = keyRows[0]?.public_key;
    if (typeof pem !== 'string' || createPublicKey(pem).asymmetricKeyType !== 'ed25519') {
      throw new Error('Unregistered Git workspace setup signing key');
    }
    const setup = verifyWorkspaceSetupAuthorization({
      ...request,
      authorization,
      trustedPublicKeys: new Map([[authorization.keyId, pem]])
    });
    if (
      request.binding.runId !== request.runId ||
      request.binding.taskId !== setup.taskId ||
      request.binding.workspace.id !== request.workspaceId ||
      request.binding.workspace.integrationRepositoryPath !== setup.repositoryRoot
    ) {
      throw new Error('Workspace setup binding does not match approved run and workspace');
    }
    const values = [
      request.scopeId,
      request.parentClaimId,
      request.runId,
      setup.taskId,
      request.attemptId,
      request.binding.agentId,
      request.workspaceId,
      request.generationId,
      setup.setupApprovalFingerprint.slice(7),
      fingerprintPlanValue(request.binding.leasePlan).slice(7),
      authorization.keyId,
      fingerprintPlanValue(authorization).slice(7),
      pem,
      setup.artifactId,
      String(setup.artifactRevision),
      setup.executionApprovalId,
      setup.executionApprovalFingerprint,
      setup.planFingerprint,
      setup.repositoryId,
      setup.repositoryRoot,
      setup.baseCommit,
      taskLeasePlanFingerprint(request.binding.leasePlan)
    ];
    const rows = await this.#sql.unsafe(
      `select ${this.#schema}.forge_setup_arm(${values.map((_, index) => `$${index + 1}`).join(',')}) as result`,
      values
    );
    if (rows[0]?.result !== 'ARMED') {
      throw new Error('Unexpected workspace setup arming result');
    }
  }

  /** The signing service alone owns this capability. It is not a generic mutation permit. */
  async beginWorkspaceCreationPermit(request: {
    readonly scopeId: string;
    readonly runId: string;
    readonly attemptId: string;
    readonly parentClaimId: string;
    readonly workspaceId: string;
    readonly generationId: string;
    readonly supervisorId: string;
    readonly token: number;
    readonly version: number;
    readonly artifact: PlanArtifact;
    readonly executionApproval: PlanApproval;
    readonly setupApproval: WorkspaceSetupApproval;
    readonly authorization: WorkspaceSetupAuthorization;
    readonly binding: PersistedTaskExecutionBinding;
  }): Promise<{ readonly id: string; readonly completionSecret: string }> {
    if (!Number.isSafeInteger(request.token) || !Number.isSafeInteger(request.version)) {
      throw new Error('Invalid workspace Git parent token or version');
    }
    const authorization = workspaceSetupAuthorizationSchema.parse(request.authorization);
    const keyRows = await this.#sql.unsafe(
      `select public_key from ${this.#schema}.forge_global_trust_keys where key_id=$1`,
      [authorization.keyId]
    );
    const pem = keyRows[0]?.public_key;
    if (typeof pem !== 'string' || createPublicKey(pem).asymmetricKeyType !== 'ed25519') {
      throw new Error('Unregistered Git workspace setup signing key');
    }
    const setup = verifyWorkspaceSetupAuthorization({
      ...request,
      authorization,
      trustedPublicKeys: new Map([[authorization.keyId, pem]])
    });
    if (
      request.binding.runId !== request.runId ||
      request.binding.taskId !== setup.taskId ||
      request.binding.workspace.id !== request.workspaceId ||
      request.binding.workspace.integrationRepositoryPath !== setup.repositoryRoot
    ) {
      throw new Error('Workspace setup binding does not match approved run and workspace');
    }
    const completionSecret = randomBytes(32).toString('hex');
    const verifier = createHash('sha256').update(completionSecret).digest('hex');
    const values = [
      request.scopeId,
      request.parentClaimId,
      request.runId,
      setup.taskId,
      request.attemptId,
      request.binding.agentId,
      request.workspaceId,
      request.generationId,
      request.supervisorId,
      String(request.token),
      String(request.version),
      verifier,
      setup.setupApprovalFingerprint.slice(7),
      fingerprintPlanValue(request.binding.leasePlan).slice(7),
      authorization.keyId,
      fingerprintPlanValue(authorization).slice(7),
      pem,
      setup.artifactId,
      String(setup.artifactRevision),
      setup.executionApprovalId,
      setup.executionApprovalFingerprint,
      setup.planFingerprint,
      setup.repositoryId,
      setup.repositoryRoot,
      setup.baseCommit,
      taskLeasePlanFingerprint(request.binding.leasePlan)
    ];
    const rows = await this.#sql.unsafe(
      `select ${this.#schema}.forge_workspace_permit_begin(${values.map((_, index) => `$${index + 1}`).join(',')}) as id`,
      values
    );
    if (typeof rows[0]?.id !== 'string') {
      throw new Error('Unexpected workspace Git permit result');
    }
    return { id: rows[0].id, completionSecret };
  }

  /** Persist HELD_UNCERTAIN and retire this exact secret in the same transaction. */
  async finishWorkspaceCreationPermit(
    permit: { readonly id: string; readonly completionSecret: string },
    uncertaintyEvidence: string
  ): Promise<void> {
    const rows = await this.#sql.unsafe(
      `select ${this.#schema}.forge_workspace_permit_finish($1,$2,$3) as result`,
      [permit.id, permit.completionSecret, uncertaintyEvidence]
    );
    if (rows[0]?.result !== 'UNCERTAIN') {
      throw new Error('Unexpected workspace Git completion result');
    }
  }

  /** Keep the single exact lineage unresolved if uncertainty cannot be recorded. */
  async executeWorkspaceCreation<T>(
    request: Parameters<PostgresWorkspaceSetupAdmission['beginWorkspaceCreationPermit']>[0],
    createWorkspace: () => Promise<T>,
    uncertaintyEvidence: (error?: unknown) => string
  ): Promise<T> {
    const permit = await this.beginWorkspaceCreationPermit(request);
    let result: T;
    try {
      result = await createWorkspace();
    } catch (error) {
      await this.finishWorkspaceCreationPermit(permit, uncertaintyEvidence(error));
      throw error;
    }
    await this.finishWorkspaceCreationPermit(permit, uncertaintyEvidence());
    return result;
  }
}
