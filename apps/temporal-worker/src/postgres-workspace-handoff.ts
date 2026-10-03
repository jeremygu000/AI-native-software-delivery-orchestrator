import { createPublicKey } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import type postgres from 'postgres';
import type { SupervisedWorkspaceGeneration } from '@ai-native-software-delivery-orchestrator/workspace-git';
import type { PostgresEvidenceStoreConfiguration } from '@ai-native-software-delivery-orchestrator/postgres-persistence';
import {
  assertPostgresAuthorityLogin,
  openPostgresConnection
} from '@ai-native-software-delivery-orchestrator/postgres-persistence';

import {
  verifyWorkspaceRecoveryAttestation,
  type WorkspaceRecoveryAttestation
} from './workspace-recovery-attestation.js';
import { PostgresWorkspaceRecoveryObserver } from './postgres-workspace-recovery.js';

type Sql = ReturnType<typeof postgres>;

/** The recovery login belongs only to the independent supervisor process. */
export class PostgresWorkspaceHandoff {
  private constructor(
    private readonly sql: Sql,
    private readonly schema: string,
    private readonly observer: PostgresWorkspaceRecoveryObserver,
    private readonly keyId: string,
    private readonly publicKey: string
  ) {}

  static async connect(configuration: {
    readonly recovery: PostgresEvidenceStoreConfiguration;
    readonly runtime: PostgresEvidenceStoreConfiguration;
    readonly issuer: PostgresEvidenceStoreConfiguration;
    readonly observer: PostgresWorkspaceRecoveryObserver;
    readonly keyId: string;
    readonly publicKey: string;
  }): Promise<PostgresWorkspaceHandoff> {
    const { recovery, runtime, issuer } = configuration;
    assertPostgresAuthorityLogin(recovery);
    if (
      recovery.schema !== runtime.schema ||
      recovery.schema !== issuer.schema ||
      new Set([recovery.role, runtime.role, issuer.role]).size !== 3 ||
      !configuration.keyId.trim() ||
      createPublicKey(configuration.publicKey).asymmetricKeyType !== 'ed25519'
    ) {
      throw new Error('Recovery must use a separate Ed25519-authorized restricted login');
    }
    const sql = openPostgresConnection(recovery, {
      onnotice: () => undefined,
      connection: { application_name: 'forge-workspace-recovery' }
    });
    try {
      const [identity] = await sql`select current_user as name, session_user as session_name,
        rolsuper, rolcreatedb, rolcreaterole,
        exists (select 1 from pg_auth_members m where m.member=current_user::regrole::oid
          or m.roleid=current_user::regrole::oid) as membership,
        has_database_privilege(current_user,current_database(),'CREATE') as create_database,
        has_database_privilege(current_user,current_database(),'TEMP') as create_temp
        from pg_roles where rolname=current_user`;
      const functions = await sql`select proname as name,
        obj_description(p.oid,'pg_proc') as designated,
        p.prosecdef as security_definer,
        has_function_privilege(current_user,p.oid,'EXECUTE') as executable,
        has_function_privilege(current_user,p.oid,'EXECUTE WITH GRANT OPTION') as grantable,
        has_function_privilege('public',p.oid,'EXECUTE') as public_execute
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname=${recovery.schema} order by proname`;
      const writes = await sql`select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname=${recovery.schema} and c.relkind in ('r','p') and (
          has_table_privilege(current_user,c.oid,'INSERT') or
          has_table_privilege(current_user,c.oid,'UPDATE') or
          has_table_privilege(current_user,c.oid,'DELETE') or
          has_table_privilege(current_user,c.oid,'TRUNCATE') or
          has_table_privilege(current_user,c.oid,'REFERENCES') or
          has_table_privilege(current_user,c.oid,'TRIGGER') or
          has_any_column_privilege(current_user,c.oid,'INSERT') or
          has_any_column_privilege(current_user,c.oid,'UPDATE') or
          has_any_column_privilege(current_user,c.oid,'REFERENCES')) limit 1`;
      const schemas = await sql`select 1 from pg_namespace n
        where has_schema_privilege(current_user,n.oid,'CREATE') limit 1`;
      if (
        identity?.name !== recovery.role ||
        identity.session_name !== recovery.role ||
        identity.rolsuper !== false ||
        identity.rolcreatedb !== false ||
        identity.rolcreaterole !== false ||
        identity.membership !== false ||
        identity.create_database !== false ||
        identity.create_temp !== false ||
        writes.length !== 0 ||
        schemas.length !== 0 ||
        functions.length !== 9 ||
        functions.some((fn) => {
          const allowed =
            fn.name === 'forge_workspace_recovery_abandon' ||
            fn.name === 'forge_workspace_recovery_settle' ||
            fn.name === 'forge_workspace_recovery_handoff';
          return (
            ![
              'forge_generation_write',
              'forge_setup_admit',
              'forge_setup_arm',
              'forge_trust_write',
              'forge_workspace_permit_begin',
              'forge_workspace_permit_finish',
              'forge_workspace_recovery_abandon',
              'forge_workspace_recovery_handoff',
              'forge_workspace_recovery_settle'
            ].includes(String(fn.name)) ||
            fn.executable !== allowed ||
            fn.grantable !== false ||
            fn.public_execute !== false ||
            fn.security_definer !== true ||
            (allowed && fn.designated !== recovery.role)
          );
        })
      ) {
        throw new Error('PostgreSQL recovery requires its isolated restricted principal');
      }
      return new PostgresWorkspaceHandoff(
        sql,
        `"${recovery.schema}"`,
        configuration.observer,
        configuration.keyId,
        configuration.publicKey
      );
    } catch (error) {
      await sql.end({ timeout: 5 });
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }

  async #assertCurrent(
    generation: SupervisedWorkspaceGeneration,
    attestation: WorkspaceRecoveryAttestation,
    pending: boolean
  ): Promise<void> {
    if (attestation.keyId !== this.keyId) {
      throw new Error('Recovery attestation signer is not the configured independent principal');
    }
    verifyWorkspaceRecoveryAttestation({
      attestation,
      trustedPublicKeys: new Map([[this.keyId, this.publicKey]])
    });
    const actual = pending
      ? await this.observer.observePendingPermit(generation)
      : await this.observer.observe(generation);
    const supplied = attestation.observation;
    if (
      JSON.stringify(attestation.generation) !== JSON.stringify(generation) ||
      JSON.stringify(actual) !== JSON.stringify(supplied) ||
      actual.authority.generation?.state !== 'REVOKED' ||
      actual.authority.permit?.completed !== !pending ||
      actual.authority.parentState !== (pending ? 'ACTIVE' : 'HELD_UNCERTAIN') ||
      actual.authority.phase !== (pending ? 'WORKSPACE_ARMED' : 'WORKSPACE_UNCERTAIN')
    ) {
      throw new Error('Signed recovery differs from the current stopped generation and Git state');
    }
  }

  async settle(
    generation: SupervisedWorkspaceGeneration,
    attestation: WorkspaceRecoveryAttestation
  ): Promise<void> {
    const snapshot = attestation.observation.authority;
    if (snapshot.permit === undefined) {
      throw new Error('Recovery requires an exact Git permit lineage');
    }
    await this.#assertCurrent(generation, attestation, !snapshot.permit?.completed);
    const rows = await this.sql.unsafe(
      `select ${this.schema}.forge_workspace_recovery_settle(${Array.from({ length: 12 }, (_, i) => `$${i + 1}`).join(',')}) as outcome`,
      [
        snapshot.scopeId,
        snapshot.parentClaimId,
        snapshot.permit.id,
        snapshot.owner.runId,
        generation.generationId,
        String(snapshot.token),
        attestation.id,
        attestation.digest,
        snapshot.signingKey,
        snapshot.setupPlanDigest,
        snapshot.authorizationDigest,
        snapshot.workspaceId
      ]
    );
    if (rows[0]?.outcome !== 'SETTLED') {
      throw new Error('Unexpected Git permit settlement outcome');
    }
  }

  async abandon(
    generation: SupervisedWorkspaceGeneration,
    attestation: WorkspaceRecoveryAttestation
  ): Promise<void> {
    await this.#assertCurrent(generation, attestation, false);
    const snapshot = attestation.observation.authority;
    const args = [
      snapshot.scopeId,
      snapshot.parentClaimId,
      snapshot.owner.runId,
      generation.generationId,
      String(snapshot.token),
      attestation.id,
      attestation.digest,
      snapshot.signingKey,
      snapshot.setupPlanDigest,
      snapshot.authorizationDigest,
      snapshot.workspaceId
    ];
    const [row] = await this.sql.unsafe(
      `select ${this.schema}.forge_workspace_recovery_abandon(${args.map((_, i) => `$${i + 1}`).join(',')}) as outcome`,
      args
    );
    if (row?.outcome !== 'ABANDONED') {
      throw new Error('Unexpected workspace abandonment outcome');
    }
  }

  async handoff(
    generation: SupervisedWorkspaceGeneration,
    attestation: WorkspaceRecoveryAttestation,
    attemptFingerprint: string
  ): Promise<{ readonly claimId: string; readonly token: number } | { readonly blocked: true }> {
    if (attestation.keyId !== this.keyId) {
      throw new Error('Recovery attestation signer is not the configured independent principal');
    }
    verifyWorkspaceRecoveryAttestation({
      attestation,
      trustedPublicKeys: new Map([[this.keyId, this.publicKey]])
    });
    const snapshot = attestation.observation.authority;
    const git = attestation.observation.git;
    let current: Awaited<ReturnType<PostgresWorkspaceRecoveryObserver['observe']>>;
    let committedReplay = false;
    try {
      current = await this.observer.observe(generation);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== 'Workspace recovery binding or phase disagrees with the parent'
      ) {
        throw error;
      }
      // A committed phase is intentionally unreadable through the pre-handoff
      // observer. Recheck actual stopped containment/Git and let the definer
      // establish whether this was the exact still-current committed child.
      await this.observer.verifyCommittedGit(generation, attestation.observation);
      current = attestation.observation;
      committedReplay = true;
      // The committed replay is established only by the locked SQL function;
      // the pre-handoff observer's failure itself never grants authority.
    }
    const normalized = {
      ...current,
      authority: {
        ...current.authority,
        parentState: snapshot.parentState,
        phase: snapshot.phase,
        version: snapshot.version,
        permit: snapshot.permit
      }
    };
    if (
      JSON.stringify(attestation.generation) !== JSON.stringify(generation) ||
      JSON.stringify(normalized) !== JSON.stringify(attestation.observation) ||
      (!committedReplay &&
        (current.authority.version !==
          snapshot.version + (snapshot.parentState === 'ACTIVE' ? 1 : 0) ||
          current.authority.parentState !== 'HELD_UNCERTAIN' ||
          current.authority.phase !== 'WORKSPACE_UNCERTAIN' ||
          current.authority.permit?.completed !== true)) ||
      snapshot.workspace?.revision !== 1 ||
      current.authority.workspace === undefined ||
      git.worktreePath !== (await realpath(resolve(current.authority.workspace.workspacePath))) ||
      git.headCommit !== git.baseCommit ||
      git.branchCommit !== git.baseCommit ||
      !git.clean ||
      !attemptFingerprint.trim()
    ) {
      throw new Error('Recovery Git identity or execution fingerprint is incompatible');
    }
    const args = [
      snapshot.scopeId,
      snapshot.parentClaimId,
      snapshot.owner.runId,
      generation.generationId,
      String(snapshot.token),
      attestation.id,
      attestation.digest,
      snapshot.signingKey,
      snapshot.setupPlanDigest,
      snapshot.authorizationDigest,
      snapshot.workspaceId,
      String(snapshot.workspace?.revision),
      snapshot.workspace?.workspacePath,
      snapshot.workspace?.branchName,
      git.baseCommit,
      attemptFingerprint
    ];
    const [row] = await this.sql.unsafe(
      `select ${this.schema}.forge_workspace_recovery_handoff(${args.map((_, i) => `$${i + 1}`).join(',')}) as outcome`,
      args
    );
    if (row?.outcome === 'BLOCKED') {
      return { blocked: true };
    }
    if (typeof row?.outcome !== 'string') {
      throw new Error('Unexpected recovery handoff outcome');
    }
    const match = /^GRANTED:(execution-[0-9a-f]{64}):([1-9][0-9]*)$/.exec(row.outcome);
    if (match === null) {
      throw new Error('Unexpected recovery child identity');
    }
    const token = Number(match[2]);
    if (!Number.isSafeInteger(token)) {
      throw new Error('Recovery child token exceeds the safe JavaScript range');
    }
    return { claimId: match[1] ?? '', token };
  }
}
