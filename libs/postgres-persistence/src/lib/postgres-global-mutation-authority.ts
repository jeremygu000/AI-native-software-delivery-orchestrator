import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

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
  agentExecutionAttemptSchema,
  areWritableResourcesConflicting,
  canonicalTaskLeaseResources,
  GlobalMutationInFlightError,
  isWritableResourceCoveredBy,
  persistedTaskExecutionBindingSchema,
  taskWorkspaceSchema,
  taskLeasePlanFingerprint,
  taskRepairAttemptSchema,
  taskRepairWorkItemSchema,
  writableResourceIdentity,
  writableResourceSchema,
  type AgentExecutionAttempt,
  type AgentSessionRef,
  type CurrentMutationTokenRequest,
  type FencedMutationExecutionPermit,
  type GlobalMutationAuthority,
  type GlobalMutationClaim,
  type GlobalMutationClaimResult,
  type GlobalMutationLease,
  type GlobalMutationOwner,
  type LegacyMutationOwner,
  type PersistedFencedMutationPermit,
  type TaskRepairAttempt,
  type TaskWorkspace,
  type WritableResource
} from '@ai-native-software-delivery-orchestrator/domain';

import type { PostgresEvidenceStoreConfiguration } from './postgres-evidence-store.js';
import {
  assertPostgresAuthorityLogin,
  assertPostgresGlobalAuthoritySchema
} from './postgres-authority-schema.js';

type Sql = ReturnType<typeof postgres>;
type Tx = postgres.TransactionSql;
type Query = Sql | Tx;
type Row = postgres.Row;

const required = (value: string, name: string): string => {
  if (!value.trim()) {
    throw new Error(`${name} must not be empty`);
  }
  return value;
};
const json = (value: unknown): unknown => JSON.parse(String(value));
const fields = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid persisted global authority payload');
  }
  return Object.fromEntries(Object.entries(value));
};
const runIdentity = (value: unknown): { id: string; repositoryId: string } => {
  const run = fields(fields(json(value)).run);
  if (typeof run.id !== 'string' || typeof run.repositoryId !== 'string') {
    throw new Error('Invalid historical run repository identity');
  }
  return { id: run.id, repositoryId: run.repositoryId };
};
const legacyOwner = (value: unknown): LegacyMutationOwner => {
  const item = fields(json(value));
  if (
    typeof item.key !== 'string' ||
    typeof item.runId !== 'string' ||
    typeof item.repositoryId !== 'string' ||
    !['run', 'lease', 'builder', 'repair', 'integration'].includes(String(item.kind))
  ) {
    throw new Error('Invalid historical mutation owner');
  }
  const kind = item.kind;
  if (
    kind !== 'run' &&
    kind !== 'lease' &&
    kind !== 'builder' &&
    kind !== 'repair' &&
    kind !== 'integration'
  ) {
    throw new Error('Invalid historical mutation owner kind');
  }
  return {
    key: item.key,
    runId: item.runId,
    repositoryId: item.repositoryId,
    kind,
    ...(item.resource === undefined
      ? {}
      : { resource: writableResourceSchema.parse(item.resource) })
  };
};
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const resource = (value: unknown): WritableResource => writableResourceSchema.parse(json(value));
const resourceKey = (value: WritableResource): string =>
  `${value.type}\u0000${writableResourceIdentity(value)}`;
const owner = (value: unknown): GlobalMutationOwner => {
  const item = fields(json(value));
  for (const key of ['runId', 'taskId', 'attemptId', 'agentId']) {
    if (typeof item[key] !== 'string') {
      throw new Error('Invalid persisted global mutation owner');
    }
  }
  if (item.workspaceId !== undefined && typeof item.workspaceId !== 'string') {
    throw new Error('Invalid persisted global mutation owner');
  }
  if (
    typeof item.runId !== 'string' ||
    typeof item.taskId !== 'string' ||
    typeof item.attemptId !== 'string' ||
    typeof item.agentId !== 'string'
  ) {
    throw new Error('Invalid persisted global mutation owner');
  }
  return {
    runId: item.runId,
    taskId: item.taskId,
    attemptId: item.attemptId,
    agentId: item.agentId,
    ...(typeof item.workspaceId === 'string' ? { workspaceId: item.workspaceId } : {})
  };
};
const safeInteger = (value: unknown): number => {
  const big = BigInt(String(value));
  if (big < 0n || big > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Global mutation integer exceeds the safe JavaScript range');
  }
  return Number(big);
};
const attemptJson = (value: unknown): unknown =>
  JSON.parse(String(value), (key: string, entry: unknown): unknown =>
    (key === 'startedAt' || key === 'completedAt') && typeof entry === 'string'
      ? new Date(entry)
      : entry
  );
const verifier = (secret: string): Buffer => createHash('sha256').update(secret).digest();

/** Inspection evidence only. It is not a claim, permit, or reusable authorization. */
export type WorkspaceSetupTrustInspection = {
  readonly registryRevision: number;
  readonly keyId: string;
  readonly decisionDigest: string;
  readonly authorizationDigest: string;
};

/** A consistent authority snapshot for independent recovery, never a quiescence attestation. */
export interface WorkspaceSetupRecoverySnapshot {
  readonly scopeId: string;
  readonly parentClaimId: string;
  readonly owner: GlobalMutationOwner;
  readonly token: number;
  readonly version: number;
  readonly parentState: 'ACTIVE' | 'HELD_UNCERTAIN';
  readonly phase: 'INITIAL_ADMITTED' | 'WORKSPACE_ARMED' | 'WORKSPACE_UNCERTAIN';
  readonly workspaceId: string;
  readonly setupPlanDigest: string;
  readonly executionPlanDigest: string;
  readonly signingKey: string;
  readonly authorizationDigest: string;
  readonly runState: string;
  readonly generation?: {
    readonly id: string;
    readonly state: 'ISSUED' | 'REVOKED';
    readonly supervisorId: string;
  };
  readonly permit?: { readonly id: string; readonly completed: boolean };
  readonly workspace?: {
    readonly revision: number;
    readonly workspacePath: string;
    readonly branchName: string;
  };
}

/** An execution child recovered from the committed handoff, not a new claim. */
export interface RecoveredExecutionChild {
  readonly scopeId: string;
  readonly claimId: string;
  readonly owner: GlobalMutationOwner;
  readonly token: number;
  readonly leases: readonly GlobalMutationLease[];
  readonly workspace: ReturnType<typeof taskWorkspaceSchema.parse>;
  readonly attemptRevision: number;
  readonly attemptState: 'STARTING' | 'RUNNING';
  readonly leasePlanFingerprint: string;
}

const workspaceSetupPolicy = 'git-workspace-setup-v1';

/** Runtime-only v4 authority; deployment transitions use gate -> scope -> run,
 * while steady-state transitions read the one-way ready gate and lock scope -> run. */
export class PostgresGlobalMutationAuthority implements GlobalMutationAuthority {
  readonly #sql: Sql;
  readonly #schema: string;

  private constructor(configuration: PostgresEvidenceStoreConfiguration) {
    this.#schema = `"${configuration.schema}"`;
    this.#sql = postgres(configuration.connectionString, {
      connection: { application_name: 'forge-global-authority' },
      onnotice: () => undefined
    });
  }

  static async connect(
    configuration: PostgresEvidenceStoreConfiguration
  ): Promise<PostgresGlobalMutationAuthority> {
    assertPostgresAuthorityLogin(configuration);
    const authority = new PostgresGlobalMutationAuthority(configuration);
    try {
      await assertPostgresGlobalAuthoritySchema(authority.#sql, configuration);
      return authority;
    } catch (error) {
      await authority.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.#sql.end({ timeout: 5 });
  }

  async #one(
    tx: Query,
    statement: string,
    parameters: postgres.ParameterOrJSON<never>[] = []
  ): Promise<Row | undefined> {
    return (await tx.unsafe(statement, parameters))[0];
  }

  async #deploymentLocked<T>(
    work: (tx: Tx, state: string) => Promise<T>,
    scopeId?: string,
    runId?: string
  ): Promise<T> {
    const result = await this.#sql.begin(async (tx) => {
      const control = await this.#one(
        tx,
        `select state from ${this.#schema}.forge_global_control where id=1 for update`
      );
      if (control === undefined) {
        throw new Error('Missing global authority control row');
      }
      if (scopeId !== undefined) {
        await this.#scope(tx, scopeId, true);
      }
      if (runId !== undefined) {
        const run = await this.#one(
          tx,
          `select id from ${this.#schema}.forge_runs where id=$1 for update`,
          [runId]
        );
        if (run === undefined) {
          throw new Error(`Unknown orchestration run: ${runId}`);
        }
      }
      return { value: await work(tx, String(control.state)) };
    });
    return result.value;
  }

  // GLOBAL_READY is a one-way cutover state. Once observed, only the scope row
  // (then the affected run row) serializes steady-state authority transitions.
  async #scopedLocked<T>(
    scopeId: string,
    work: (tx: Tx) => Promise<T>,
    runId?: string
  ): Promise<T> {
    const result = await this.#sql.begin(async (tx) => {
      // Runtime holds only SELECT on trust state; FOR SHARE would require
      // UPDATE privilege. Trust administration must use the matching exclusive
      // advisory transaction lock before changing registry rows.
      await tx`select pg_advisory_xact_lock_shared(hashtext(${`forge-trust:${this.#schema}`}))`;
      const registry = await this.#one(
        tx,
        `select revision from ${this.#schema}.forge_global_trust_registry where id=1`
      );
      if (registry === undefined) {
        throw new Error('Missing global trust registry row');
      }
      const control = await this.#one(
        tx,
        `select state from ${this.#schema}.forge_global_control where id=1`
      );
      if (control?.state !== 'GLOBAL_READY') {
        throw new Error('Global mutation claims are not active');
      }
      await this.#scope(tx, scopeId, true);
      if (runId !== undefined) {
        const run = await this.#one(
          tx,
          `select id from ${this.#schema}.forge_runs where id=$1 for update`,
          [runId]
        );
        if (run === undefined) {
          throw new Error(`Unknown orchestration run: ${runId}`);
        }
      }
      return { value: await work(tx) };
    });
    return result.value;
  }

  async #scope(tx: Query, scopeId: string, lock = false): Promise<string> {
    const row = await this.#one(
      tx,
      `select state from ${this.#schema}.forge_global_scopes where id=$1 ${lock ? 'for update' : ''}`,
      [scopeId]
    );
    if (row === undefined) {
      throw new Error(`Unknown repository scope: ${scopeId}`);
    }
    return String(row.state);
  }

  async #claim(tx: Query, scopeId: string, claimId: string): Promise<Row> {
    const row = await this.#one(
      tx,
      `select * from ${this.#schema}.forge_global_claims where scope_id=$1 and claim_id=$2`,
      [scopeId, claimId]
    );
    if (row === undefined) {
      throw new Error(`Unknown global mutation claim: ${scopeId}/${claimId}`);
    }
    return row;
  }

  async #assertOrdinaryClaim(tx: Query, scopeId: string, claimId: string): Promise<void> {
    const phase = await this.#one(
      tx,
      `select phase from ${this.#schema}.forge_global_workspace_phases where scope_id=$1 and parent_claim_id=$2`,
      [scopeId, claimId]
    );
    if (phase !== undefined) {
      throw new Error('Workspace setup parent forbids ordinary mutation authority');
    }
  }

  async #leases(tx: Query, scopeId: string, claimId?: string): Promise<GlobalMutationLease[]> {
    const rows = await tx.unsafe(
      `select c.*,l.lease_id,l.resource_json from ${this.#schema}.forge_global_claims c
       join ${this.#schema}.forge_global_leases l using (scope_id,claim_id)
       where c.scope_id=$1 ${claimId === undefined ? '' : 'and c.claim_id=$2'}
       order by c.token,c.claim_id,l.lease_id`,
      claimId === undefined ? [scopeId] : [scopeId, claimId]
    );
    return rows.map((row) => ({
      scopeId: String(row.scope_id),
      claimId: String(row.claim_id),
      leaseId: String(row.lease_id),
      token: safeInteger(row.token),
      version: safeInteger(row.version),
      resource: resource(row.resource_json),
      owner: owner(row.owner_json),
      state: this.#claimState(row.state),
      ...(row.evidence === null ? {} : { evidence: String(row.evidence) })
    }));
  }

  #claimState(value: unknown): GlobalMutationLease['state'] {
    if (value === 'ACTIVE' || value === 'HELD_UNCERTAIN' || value === 'RELEASED') {
      return value;
    }
    throw new Error('Invalid global mutation claim state');
  }

  async #nextToken(tx: Tx, scopeId: string): Promise<number> {
    const row = await this.#one(
      tx,
      `select next_token from ${this.#schema}.forge_global_scopes where id=$1`,
      [scopeId]
    );
    const next = BigInt(String(row?.next_token)) + 1n;
    if (next > BigInt(Number.MAX_SAFE_INTEGER) || next <= 0n) {
      throw new Error('Global mutation token exhausted');
    }
    await tx.unsafe(`update ${this.#schema}.forge_global_scopes set next_token=$2 where id=$1`, [
      scopeId,
      next.toString()
    ]);
    return Number(next);
  }

  /**
   * Inspect current trust and persisted run identity under trust -> scope -> run
   * serialization. The result cannot authorize a later transaction: admission
   * must repeat this check inside its own transaction before issuing a token.
   */
  async inspectCurrentWorkspaceSetupTrust(request: {
    readonly scopeId: string;
    readonly runId: string;
    readonly workspaceId: string;
    readonly artifact: PlanArtifact;
    readonly executionApproval: PlanApproval;
    readonly setupApproval: WorkspaceSetupApproval;
    readonly authorization: WorkspaceSetupAuthorization;
  }): Promise<WorkspaceSetupTrustInspection> {
    return this.#scopedLocked(
      request.scopeId,
      async (tx) => {
        if ((await this.#scope(tx, request.scopeId)) !== 'ACTIVE_FOR_GLOBAL_CLAIMS') {
          throw new Error('Workspace setup scope is not active');
        }
        const registry = await this.#one(
          tx,
          `select revision,policy_version from ${this.#schema}.forge_global_trust_registry where id=1`
        );
        if (registry?.policy_version !== workspaceSetupPolicy) {
          throw new Error('Workspace setup trust policy is not active');
        }
        const authorization = workspaceSetupAuthorizationSchema.parse(request.authorization);
        const key = await this.#one(
          tx,
          `select public_key,state from ${this.#schema}.forge_global_trust_keys where key_id=$1`,
          [authorization.keyId]
        );
        if (key?.state !== 'ACTIVE' || typeof key.public_key !== 'string') {
          throw new Error('Workspace setup signing key is not currently active');
        }
        const decisionDigest = request.setupApproval.setupApprovalFingerprint.slice(
          'sha256:'.length
        );
        const authorizationDigest = fingerprintPlanValue(authorization).slice('sha256:'.length);
        const revoked = await tx.unsafe(
          `select kind from ${this.#schema}.forge_global_trust_revocations
         where (kind='DECISION' and digest=$1) or (kind='AUTHORIZATION' and digest=$2)`,
          [decisionDigest, authorizationDigest]
        );
        if (revoked.length !== 0) {
          throw new Error('Workspace setup decision or authorization is revoked');
        }
        const setup = verifyWorkspaceSetupAuthorization({
          ...request,
          authorization,
          trustedPublicKeys: new Map([[authorization.keyId, key.public_key]])
        });
        const row = await this.#one(
          tx,
          `select r.state,r.payload,b.repository_id,b.scope_id,a.scope_id as alias_scope_id
         from ${this.#schema}.forge_runs r
         join ${this.#schema}.forge_global_run_bindings b on b.run_id=r.id
         join ${this.#schema}.forge_global_aliases a on a.repository_id=b.repository_id
         where r.id=$1`,
          [request.runId]
        );
        if (
          row?.state !== 'ACTIVE' ||
          row.scope_id !== request.scopeId ||
          row.alias_scope_id !== request.scopeId
        ) {
          throw new Error('Workspace setup run is not active and bound');
        }
        const persisted = fields(json(row.payload));
        const run = fields(persisted.run);
        const approved = fields(run.authority);
        if (
          run.id !== request.runId ||
          run.repositoryId !== setup.repositoryId ||
          row.repository_id !== setup.repositoryId ||
          approved.artifactId !== setup.artifactId ||
          approved.artifactRevision !== setup.artifactRevision ||
          approved.approvalId !== setup.executionApprovalId ||
          approved.planFingerprint !== setup.planFingerprint ||
          approved.approvalFingerprint !== setup.executionApprovalFingerprint ||
          approved.repositoryRoot !== setup.repositoryRoot ||
          approved.baseCommit !== setup.baseCommit
        ) {
          throw new Error('Workspace setup does not match persisted run approval');
        }
        const binding = await this.#record(tx, request.runId, 'binding', setup.taskId);
        if (binding === undefined) {
          throw new Error('Workspace setup has no approved task binding');
        }
        const task = persistedTaskExecutionBindingSchema.parse(json(binding));
        if (
          task.runId !== request.runId ||
          task.taskId !== setup.taskId ||
          task.workspace.id !== request.workspaceId ||
          task.workspace.integrationRepositoryPath !== setup.repositoryRoot
        ) {
          throw new Error('Workspace setup does not match approved workspace identity');
        }
        return {
          registryRevision: safeInteger(registry.revision),
          keyId: authorization.keyId,
          decisionDigest,
          authorizationDigest
        };
      },
      request.runId
    );
  }

  /** Holds the trust read prefix and scope/run locks while reading all recovery facts. */
  async recoverWorkspaceSetupEvidence(
    scopeId: string,
    parentClaimId: string
  ): Promise<WorkspaceSetupRecoverySnapshot> {
    const initial = await this.#claim(this.#sql, scopeId, parentClaimId);
    const runId = owner(initial.owner_json).runId;
    return this.#scopedLocked(
      scopeId,
      async (tx) => {
        const parent = await this.#claim(tx, scopeId, parentClaimId);
        const claimOwner = owner(parent.owner_json);
        if (claimOwner.runId !== runId || claimOwner.workspaceId === undefined) {
          throw new Error('Workspace recovery parent identity changed');
        }
        const phase = await this.#one(
          tx,
          `select * from ${this.#schema}.forge_global_workspace_phases where scope_id=$1 and parent_claim_id=$2`,
          [scopeId, parentClaimId]
        );
        const bindingRow = await this.#one(
          tx,
          `select payload from ${this.#schema}.forge_records where run_id=$1 and kind='binding' and key=$2`,
          [runId, claimOwner.taskId]
        );
        const run = await this.#one(
          tx,
          `select state,payload from ${this.#schema}.forge_runs where id=$1`,
          [runId]
        );
        if (phase === undefined || bindingRow === undefined || run === undefined) {
          throw new Error('Workspace recovery authority is incomplete');
        }
        const binding = persistedTaskExecutionBindingSchema.parse(json(bindingRow.payload));
        const identity = runIdentity(run.payload);
        const approvedRun = fields(fields(json(run.payload)).run);
        const approval = fields(approvedRun.authority);
        const attemptRow = await this.#one(
          tx,
          `select payload from ${this.#schema}.forge_records where run_id=$1 and kind='builder' and key=$2`,
          [runId, claimOwner.attemptId]
        );
        const attempt = attemptRow === undefined ? undefined : fields(json(attemptRow.payload));
        const registered = await this.#one(
          tx,
          `select b.scope_id,a.scope_id as alias_scope_id,b.repository_id from ${this.#schema}.forge_global_run_bindings b
           join ${this.#schema}.forge_global_aliases a on a.repository_id=b.repository_id where b.run_id=$1`,
          [runId]
        );
        if (
          registered?.scope_id !== scopeId ||
          registered.alias_scope_id !== scopeId ||
          registered.repository_id !== identity.repositoryId ||
          identity.id !== runId ||
          approvedRun.repositoryId !== identity.repositoryId ||
          approval.repositoryRoot !== binding.workspace.integrationRepositoryPath ||
          binding.runId !== runId ||
          binding.taskId !== claimOwner.taskId ||
          binding.agentId !== claimOwner.agentId ||
          binding.workspace.id !== claimOwner.workspaceId ||
          attempt?.runId !== runId ||
          attempt.taskId !== claimOwner.taskId ||
          attempt.id !== claimOwner.attemptId ||
          attempt.agentId !== claimOwner.agentId ||
          attempt.workspaceId !== claimOwner.workspaceId ||
          attempt.leasePlanFingerprint !== taskLeasePlanFingerprint(binding.leasePlan) ||
          attempt.state !== 'STARTING' ||
          phase.workspace_id !== claimOwner.workspaceId ||
          typeof phase.setup_plan_digest !== 'string' ||
          phase.execution_plan_digest !== fingerprintPlanValue(binding.leasePlan).slice(7) ||
          typeof phase.signing_key !== 'string' ||
          typeof phase.authorization_digest !== 'string' ||
          !['INITIAL_ADMITTED', 'WORKSPACE_ARMED', 'WORKSPACE_UNCERTAIN'].includes(
            String(phase.phase)
          ) ||
          (parent.state !== 'ACTIVE' && parent.state !== 'HELD_UNCERTAIN')
        ) {
          throw new Error('Workspace recovery binding or phase disagrees with the parent');
        }
        const leases = await this.#leases(tx, scopeId, parentClaimId);
        if (
          leases.length !== 1 ||
          leases[0]?.resource.type !== 'repository' ||
          leases[0].token !== safeInteger(parent.token)
        ) {
          throw new Error('Workspace recovery parent lacks its exact repository lease');
        }
        const generation =
          phase.execution_generation === null
            ? undefined
            : await this.#one(
                tx,
                `select * from ${this.#schema}.forge_global_generations where id=$1`,
                [phase.execution_generation]
              );
        if (
          (phase.execution_generation !== null && generation === undefined) ||
          (generation !== undefined &&
            (generation.scope_id !== scopeId ||
              generation.parent_claim_id !== parentClaimId ||
              generation.run_id !== runId ||
              generation.task_id !== claimOwner.taskId ||
              generation.attempt_id !== claimOwner.attemptId ||
              generation.workspace_id !== claimOwner.workspaceId ||
              generation.setup_plan_digest !== phase.setup_plan_digest ||
              generation.execution_plan_digest !== phase.execution_plan_digest ||
              (generation.state !== 'ISSUED' && generation.state !== 'REVOKED')))
        ) {
          throw new Error('Workspace recovery generation disagrees with the parent');
        }
        const permit = await this.#one(
          tx,
          `select * from ${this.#schema}.forge_global_workspace_permit_lineages
           where scope_id=$1 and parent_claim_id=$2`,
          [scopeId, parentClaimId]
        );
        if (
          (permit !== undefined &&
            (permit.owner_json !== parent.owner_json ||
              safeInteger(permit.token) !== safeInteger(parent.token) ||
              permit.generation_id !== phase.execution_generation ||
              permit.workspace_id !== claimOwner.workspaceId)) ||
          (phase.phase === 'INITIAL_ADMITTED' &&
            (parent.state !== 'ACTIVE' || permit !== undefined)) ||
          (phase.phase === 'WORKSPACE_ARMED' &&
            (parent.state !== 'ACTIVE' ||
              generation === undefined ||
              permit?.completed === true)) ||
          (phase.phase === 'WORKSPACE_UNCERTAIN' &&
            (parent.state !== 'HELD_UNCERTAIN' || permit?.completed !== true))
        ) {
          throw new Error('Workspace recovery phase and permit lineage disagree');
        }
        const saved = await this.#one(
          tx,
          `select payload from ${this.#schema}.forge_records where run_id=$1 and kind='workspace' and key=$2`,
          [runId, claimOwner.workspaceId]
        );
        const workspace =
          saved === undefined ? undefined : taskWorkspaceSchema.parse(json(saved.payload));
        if (
          workspace !== undefined &&
          (workspace.id !== claimOwner.workspaceId ||
            workspace.runId !== runId ||
            workspace.taskId !== claimOwner.taskId ||
            workspace.revision !== 1 ||
            workspace.phase !== 'READY_TO_INTEGRATE' ||
            workspace.integrationRepositoryPath !== binding.workspace.integrationRepositoryPath ||
            workspace.workspacePath !== binding.workspace.workspacePath ||
            workspace.branchName !== binding.workspace.branchName ||
            workspace.baseRef !== binding.workspace.baseRef ||
            workspace.integrationRef !== binding.workspace.integrationRef)
        ) {
          throw new Error('Workspace recovery saved Git identity is not initial and approved');
        }
        const phaseState = phase.phase;
        const parentState = parent.state;
        const setupPlanDigest = phase.setup_plan_digest;
        const executionPlanDigest = phase.execution_plan_digest;
        const signingKey = phase.signing_key;
        const authorizationDigest = phase.authorization_digest;
        if (
          (phaseState !== 'INITIAL_ADMITTED' &&
            phaseState !== 'WORKSPACE_ARMED' &&
            phaseState !== 'WORKSPACE_UNCERTAIN') ||
          (parentState !== 'ACTIVE' && parentState !== 'HELD_UNCERTAIN') ||
          typeof setupPlanDigest !== 'string' ||
          typeof executionPlanDigest !== 'string' ||
          typeof signingKey !== 'string' ||
          typeof authorizationDigest !== 'string'
        ) {
          throw new Error('Invalid workspace recovery state');
        }
        const generationState = generation?.state;
        if (
          generation !== undefined &&
          generationState !== 'ISSUED' &&
          generationState !== 'REVOKED'
        ) {
          throw new Error('Invalid workspace recovery generation state');
        }
        return {
          scopeId,
          parentClaimId,
          owner: claimOwner,
          token: safeInteger(parent.token),
          version: safeInteger(parent.version),
          parentState,
          phase: phaseState,
          workspaceId: claimOwner.workspaceId,
          setupPlanDigest,
          executionPlanDigest,
          signingKey,
          authorizationDigest,
          runState: String(run.state),
          ...(generation === undefined
            ? {}
            : {
                generation: {
                  id: String(generation.id),
                  state: generationState,
                  supervisorId: String(generation.supervisor_id)
                }
              }),
          ...(permit === undefined
            ? {}
            : { permit: { id: String(permit.permit_id), completed: permit.completed === true } }),
          ...(workspace === undefined
            ? {}
            : {
                workspace: {
                  revision: workspace.revision,
                  workspacePath: workspace.workspacePath,
                  branchName: workspace.branchName
                }
              })
        };
      },
      runId
    );
  }

  async registerScope(repositoryId: string): Promise<string> {
    required(repositoryId, 'Repository ID');
    return this.#deploymentLocked(async (tx) => {
      const existing = await this.#one(
        tx,
        `select scope_id from ${this.#schema}.forge_global_aliases where repository_id=$1`,
        [repositoryId]
      );
      if (existing !== undefined) {
        return String(existing.scope_id);
      }
      const scopeId = randomUUID();
      await tx.unsafe(
        `insert into ${this.#schema}.forge_global_scopes values ($1,'REGISTERING',0)`,
        [scopeId]
      );
      await tx.unsafe(`insert into ${this.#schema}.forge_global_aliases values ($1,$2)`, [
        repositoryId,
        scopeId
      ]);
      return scopeId;
    });
  }

  async registerAlias(scopeId: string, repositoryId: string): Promise<void> {
    required(repositoryId, 'Repository ID');
    await this.#deploymentLocked(async (tx) => {
      const existing = await this.#one(
        tx,
        `select scope_id from ${this.#schema}.forge_global_aliases where repository_id=$1`,
        [repositoryId]
      );
      if (existing !== undefined && existing.scope_id !== scopeId) {
        throw new Error('Alias scope conflict');
      }
      if (existing === undefined) {
        await tx.unsafe(`insert into ${this.#schema}.forge_global_aliases values ($1,$2)`, [
          repositoryId,
          scopeId
        ]);
      }
    }, scopeId);
  }

  async bindRun(runId: string, repositoryId: string): Promise<void> {
    const scopeId = await this.#boundScope(runId, repositoryId);
    await this.#deploymentLocked(
      async (tx) => {
        const row = await this.#one(
          tx,
          `select payload from ${this.#schema}.forge_runs where id=$1`,
          [runId]
        );
        const run = runIdentity(row?.payload);
        if (run.repositoryId !== repositoryId || run.id !== runId) {
          throw new Error('Run repository identity mismatch');
        }
        const old = await this.#one(
          tx,
          `select repository_id,scope_id from ${this.#schema}.forge_global_run_bindings where run_id=$1`,
          [runId]
        );
        const alias = await this.#one(
          tx,
          `select scope_id from ${this.#schema}.forge_global_aliases where repository_id=$1`,
          [repositoryId]
        );
        if (alias === undefined || alias.scope_id !== scopeId) {
          throw new Error('Unregistered repository alias or changed scope');
        }
        if (
          old !== undefined &&
          (old.repository_id !== repositoryId || old.scope_id !== alias.scope_id)
        ) {
          throw new Error('Run binding is immutable');
        }
        if (old === undefined) {
          await tx.unsafe(
            `insert into ${this.#schema}.forge_global_run_bindings values ($1,$2,$3)`,
            [runId, repositoryId, alias.scope_id]
          );
        }
      },
      scopeId,
      runId
    );
  }

  // Resolve identity before locking; the gate rechecks the alias inside the transaction.
  async #boundScope(runId: string, repositoryId: string): Promise<string> {
    const row = await this.#one(
      this.#sql,
      `select scope_id from ${this.#schema}.forge_global_aliases where repository_id=$1`,
      [repositoryId]
    );
    if (row === undefined) {
      throw new Error(`Unregistered repository alias for ${runId}`);
    }
    return String(row.scope_id);
  }

  async recoverGlobalRunScope(runId: string): Promise<string> {
    const rows = await this.#sql.unsafe(
      `select r.payload,b.repository_id,b.scope_id,a.scope_id as alias_scope_id
       from ${this.#schema}.forge_runs r
       left join ${this.#schema}.forge_global_run_bindings b on b.run_id=r.id
       left join ${this.#schema}.forge_global_aliases a on a.repository_id=b.repository_id
       where r.id=$1`,
      [runId]
    );
    const row = rows[0];
    if (
      row === undefined ||
      typeof row.repository_id !== 'string' ||
      typeof row.scope_id !== 'string' ||
      row.scope_id !== row.alias_scope_id
    ) {
      throw new Error(`Run has no matching durable global scope binding: ${runId}`);
    }
    const identity = runIdentity(row.payload);
    if (identity.id !== runId || identity.repositoryId !== row.repository_id) {
      throw new Error(`Run repository identity disagrees with its global scope binding: ${runId}`);
    }
    return row.scope_id;
  }

  async #inventory(tx: Tx): Promise<LegacyMutationOwner[]> {
    const runs = await tx.unsafe(
      `select id,state,payload from ${this.#schema}.forge_runs order by id`
    );
    const repositories = new Map<string, string>();
    const owners: LegacyMutationOwner[] = [];
    for (const row of runs) {
      const value = runIdentity(row.payload);
      if (value.id !== row.id) {
        throw new Error('Invalid historical run repository identity');
      }
      repositories.set(String(row.id), value.repositoryId);
      if (row.state === 'ACTIVE' || row.state === 'CANCEL_REQUESTED') {
        owners.push({
          key: `run:${row.id}`,
          runId: String(row.id),
          repositoryId: value.repositoryId,
          kind: 'run'
        });
      }
    }
    const records = await tx.unsafe(
      `select run_id,kind,key,payload from ${this.#schema}.forge_records
       where kind in ('lease','builder','repair','integration-claim') order by run_id,kind,key`
    );
    for (const row of records) {
      const repositoryId = repositories.get(String(row.run_id));
      if (repositoryId === undefined) {
        throw new Error('Historical owner run is missing');
      }
      if (row.kind === 'integration-claim') {
        owners.push({
          key: `integration:${row.run_id}:${row.key}`,
          runId: String(row.run_id),
          repositoryId,
          kind: 'integration'
        });
        continue;
      }
      const value = fields(json(row.payload));
      if (!['ACTIVE', 'STARTING', 'RUNNING', 'UNKNOWN', 'STALE'].includes(String(value.state))) {
        continue;
      }
      const kind = row.kind;
      if (kind !== 'lease' && kind !== 'builder' && kind !== 'repair') {
        throw new Error('Invalid historical mutation owner kind');
      }
      owners.push({
        key: `${kind}:${row.run_id}:${row.key}`,
        runId: String(row.run_id),
        repositoryId,
        kind,
        ...(value.resource === undefined
          ? {}
          : { resource: writableResourceSchema.parse(value.resource) })
      });
    }
    return owners;
  }

  async beginLegacyCutover(): Promise<void> {
    await this.#deploymentLocked(async (tx, state) => {
      if (state !== 'LEGACY_ALLOWED') {
        throw new Error('Legacy cutover already began');
      }
      await tx.unsafe(
        `update ${this.#schema}.forge_global_control set state='LEGACY_CUTOVER' where id=1`
      );
      for (const item of await this.#inventory(tx)) {
        await tx.unsafe(
          `insert into ${this.#schema}.forge_global_legacy_owners (key,owner_json) values ($1,$2)`,
          [item.key, JSON.stringify(item)]
        );
      }
    });
  }

  async recoverLegacyOwners(): Promise<readonly LegacyMutationOwner[]> {
    const rows = await this.#sql.unsafe(
      `select owner_json from ${this.#schema}.forge_global_legacy_owners order by key`
    );
    return rows.map((row) => legacyOwner(row.owner_json));
  }

  async settleLegacyOwner(key: string, quiescenceEvidence: string): Promise<void> {
    required(quiescenceEvidence, 'Quiescence evidence');
    await this.#deploymentLocked(async (tx) => {
      const row = await this.#one(
        tx,
        `select disposition from ${this.#schema}.forge_global_legacy_owners where key=$1`,
        [key]
      );
      if (row === undefined || row.disposition !== null) {
        throw new Error('Legacy owner is not unresolved');
      }
      await tx.unsafe(
        `update ${this.#schema}.forge_global_legacy_owners set disposition='SETTLED',evidence=$2 where key=$1`,
        [key, quiescenceEvidence]
      );
    });
  }

  async importLegacyOwner(
    key: string,
    scopeId: string,
    requested?: WritableResource
  ): Promise<void> {
    const runId = await this.#legacyRunId(key);
    await this.#deploymentLocked(
      async (tx) => {
        const row = await this.#one(
          tx,
          `select owner_json,disposition from ${this.#schema}.forge_global_legacy_owners where key=$1`,
          [key]
        );
        if (row === undefined || row.disposition !== null) {
          throw new Error('Legacy owner is not unresolved');
        }
        const historical = legacyOwner(row.owner_json);
        if (historical.runId !== runId) {
          throw new Error('Historical owner changed during classification');
        }
        const run = await this.#one(
          tx,
          `select payload from ${this.#schema}.forge_runs where id=$1`,
          [historical.runId]
        );
        const payload = runIdentity(run?.payload);
        if (payload.id !== historical.runId || payload.repositoryId !== historical.repositoryId) {
          throw new Error('Historical owner repository identity no longer matches its run');
        }
        const alias = await this.#one(
          tx,
          `select scope_id from ${this.#schema}.forge_global_aliases where repository_id=$1`,
          [historical.repositoryId]
        );
        if (alias !== undefined && alias.scope_id !== scopeId) {
          throw new Error('Legacy alias scope conflict');
        }
        if (alias === undefined) {
          await tx.unsafe(`insert into ${this.#schema}.forge_global_aliases values ($1,$2)`, [
            historical.repositoryId,
            scopeId
          ]);
        }
        const binding = await this.#one(
          tx,
          `select repository_id,scope_id from ${this.#schema}.forge_global_run_bindings where run_id=$1`,
          [historical.runId]
        );
        if (
          binding !== undefined &&
          (binding.repository_id !== historical.repositoryId || binding.scope_id !== scopeId)
        ) {
          throw new Error('Historical run scope binding conflict');
        }
        if (binding === undefined) {
          await tx.unsafe(
            `insert into ${this.#schema}.forge_global_run_bindings values ($1,$2,$3)`,
            [historical.runId, historical.repositoryId, scopeId]
          );
        }
        const leaseResource =
          historical.resource === undefined
            ? { type: 'repository' as const }
            : requested === undefined
              ? writableResourceSchema.parse(historical.resource)
              : writableResourceSchema.parse(requested);
        if (
          historical.resource !== undefined &&
          !isWritableResourceCoveredBy(leaseResource, historical.resource)
        ) {
          throw new Error('Imported authority cannot be narrower than historical evidence');
        }
        const token = await this.#nextToken(tx, scopeId);
        const claimId = `legacy:${key}`;
        const importedOwner: GlobalMutationOwner = {
          runId: historical.runId,
          taskId: 'legacy',
          attemptId: key,
          agentId: 'legacy'
        };
        await tx.unsafe(
          `insert into ${this.#schema}.forge_global_claims values ($1,$2,$3,$4,'HELD_UNCERTAIN',1,$5)`,
          [
            scopeId,
            claimId,
            JSON.stringify(importedOwner),
            token,
            'Historical owner imported during global cutover'
          ]
        );
        await tx.unsafe(`insert into ${this.#schema}.forge_global_leases values ($1,$2,$3,$4)`, [
          scopeId,
          claimId,
          randomUUID(),
          JSON.stringify(leaseResource)
        ]);
        await tx.unsafe(
          `update ${this.#schema}.forge_global_legacy_owners set disposition='IMPORTED',evidence=$2 where key=$1`,
          [key, scopeId]
        );
      },
      scopeId,
      runId
    );
  }

  async #legacyRunId(key: string): Promise<string> {
    const row = await this.#one(
      this.#sql,
      `select owner_json from ${this.#schema}.forge_global_legacy_owners where key=$1`,
      [key]
    );
    if (row === undefined) {
      throw new Error('Legacy owner is not unresolved');
    }
    return legacyOwner(row.owner_json).runId;
  }

  async completeLegacyCutover(verifiedOldWriterShutdownEvidence: string): Promise<void> {
    required(verifiedOldWriterShutdownEvidence, 'Old writer shutdown evidence');
    await this.#deploymentLocked(async (tx, state) => {
      if (state !== 'LEGACY_CUTOVER') {
        throw new Error('Legacy cutover not in progress');
      }
      const unresolved = await this.#one(
        tx,
        `select 1 from ${this.#schema}.forge_global_legacy_owners where disposition is null limit 1`
      );
      if (unresolved !== undefined) {
        throw new Error('Historical legacy owners remain unresolved');
      }
      await tx.unsafe(
        `update ${this.#schema}.forge_global_control set state='GLOBAL_READY' where id=1`
      );
      await this.#audit(
        tx,
        'complete-legacy-cutover',
        'deployment',
        verifiedOldWriterShutdownEvidence
      );
    });
  }

  async activateScope(scopeId: string): Promise<void> {
    await this.#deploymentLocked(async (tx, state) => {
      if (state !== 'GLOBAL_READY') {
        throw new Error('Deployment is not globally ready');
      }
      await tx.unsafe(
        `update ${this.#schema}.forge_global_scopes set state='ACTIVE_FOR_GLOBAL_CLAIMS' where id=$1`,
        [scopeId]
      );
    }, scopeId);
  }

  async #record(tx: Query, runId: string, kind: string, key: string): Promise<string | undefined> {
    const row = await this.#one(
      tx,
      `select payload from ${this.#schema}.forge_records where run_id=$1 and kind=$2 and key=$3`,
      [runId, kind, key]
    );
    return row === undefined ? undefined : String(row.payload);
  }

  async #authorizedAttempt(
    tx: Query,
    claim: GlobalMutationClaim,
    retry: boolean
  ): Promise<{
    kind: 'builder' | 'repair';
    attempt:
      | ReturnType<typeof agentExecutionAttemptSchema.parse>
      | ReturnType<typeof taskRepairAttemptSchema.parse>;
    previous: string;
  }> {
    const { runId, taskId, attemptId, agentId, workspaceId } = claim.owner;
    const run = await this.#one(
      tx,
      `select state,payload from ${this.#schema}.forge_runs where id=$1`,
      [runId]
    );
    const binding = await this.#one(
      tx,
      `select repository_id,scope_id from ${this.#schema}.forge_global_run_bindings where run_id=$1`,
      [runId]
    );
    const approved = fields(json(run?.payload));
    const identity = runIdentity(run?.payload);
    if (
      run?.state !== 'ACTIVE' ||
      binding?.scope_id !== claim.scopeId ||
      binding.repository_id !== identity.repositoryId ||
      identity.id !== runId
    ) {
      throw new Error('Claim run is not active in the approved repository scope');
    }
    if (
      !Array.isArray(approved.tasks) ||
      !approved.tasks.some((task: unknown) => fields(task).id === taskId)
    ) {
      throw new Error('Global mutation owner task is not in the approved run');
    }
    const record = await this.#record(tx, runId, 'binding', taskId);
    if (record === undefined) {
      throw new Error('Mutation attempt has no approved task execution binding');
    }
    const taskBinding = persistedTaskExecutionBindingSchema.parse(json(record));
    if (taskBinding.runId !== runId || taskBinding.taskId !== taskId) {
      throw new Error('Mutation attempt does not match its approved task binding');
    }
    const builder = await this.#record(tx, runId, 'builder', attemptId);
    const repair = await this.#record(tx, runId, 'repair', attemptId);
    if ((builder === undefined) === (repair === undefined)) {
      throw new Error('Global mutation owner needs one unambiguous persisted attempt');
    }
    const kind = builder === undefined ? 'repair' : 'builder';
    const previous = builder ?? repair;
    if (previous === undefined) {
      throw new Error('Missing persisted attempt');
    }
    const attempt =
      kind === 'builder'
        ? agentExecutionAttemptSchema.parse(attemptJson(previous))
        : taskRepairAttemptSchema.parse(attemptJson(previous));
    if (
      attempt.runId !== runId ||
      attempt.taskId !== taskId ||
      attempt.id !== attemptId ||
      attempt.agentId !== agentId ||
      (workspaceId !== undefined && attempt.workspaceId !== workspaceId) ||
      (retry ? !['STARTING', 'RUNNING'].includes(attempt.state) : attempt.state !== 'PREPARING')
    ) {
      throw new Error('Attempt lifecycle or owner does not authorize global mutation admission');
    }
    if (kind === 'builder') {
      if (
        taskBinding.agentId !== agentId ||
        taskBinding.workspace.id !== attempt.workspaceId ||
        taskLeasePlanFingerprint(taskBinding.leasePlan) !==
          agentExecutionAttemptSchema.parse(attempt).leasePlanFingerprint
      ) {
        throw new Error('Builder attempt does not match its approved task binding');
      }
    } else {
      const repairAttempt = taskRepairAttemptSchema.parse(attempt);
      const item = await this.#record(tx, runId, 'repair-item', attemptId);
      if (item === undefined) {
        throw new Error('Repair attempt has no admitted work item');
      }
      const work = taskRepairWorkItemSchema.parse(json(item));
      if (
        work.runId !== runId ||
        work.taskId !== taskId ||
        work.repairAttemptId !== attemptId ||
        work.workspaceId !== attempt.workspaceId ||
        work.parentReviewIteration !== repairAttempt.parentReviewIteration ||
        work.builderAttemptId !== repairAttempt.parentReviewSubject.builderAttemptId ||
        work.leasePlanFingerprint !== taskLeasePlanFingerprint(taskBinding.leasePlan)
      ) {
        throw new Error('Repair attempt does not match its admitted work item');
      }
    }
    if (
      claim.resources.some(
        (requested) =>
          !taskBinding.leasePlan.predictedResources.some((allowed) =>
            isWritableResourceCoveredBy(allowed, requested)
          )
      )
    ) {
      throw new Error('Global claim resource exceeds the approved lease plan');
    }
    return { kind, attempt, previous };
  }

  async claimGlobalMutation(claim: GlobalMutationClaim): Promise<GlobalMutationClaimResult> {
    return this.#scopedLocked(
      claim.scopeId,
      async (tx) => {
        if ((await this.#scope(tx, claim.scopeId)) !== 'ACTIVE_FOR_GLOBAL_CLAIMS') {
          throw new Error('Global mutation claims are not active');
        }
        required(claim.claimId, 'Claim ID');
        if (!claim.resources.length) {
          throw new Error('A global claim needs resources');
        }
        const resources = canonicalTaskLeaseResources(
          claim.resources.map((entry) => writableResourceSchema.parse(entry))
        );
        if (new Set(resources.map(resourceKey)).size !== resources.length) {
          throw new Error('Duplicate claim resource');
        }
        const request = { ...claim, resources };
        const old = await this.#one(
          tx,
          `select * from ${this.#schema}.forge_global_claims where scope_id=$1 and claim_id=$2`,
          [claim.scopeId, claim.claimId]
        );
        if (old !== undefined) {
          await this.#assertOrdinaryClaim(tx, claim.scopeId, claim.claimId);
          await this.#authorizedAttempt(tx, request, true);
          const existing = await this.#leases(tx, claim.scopeId, claim.claimId);
          if (
            old.state !== 'ACTIVE' ||
            !same(owner(old.owner_json), claim.owner) ||
            !same(
              existing.map((lease) => resourceKey(lease.resource)).toSorted(),
              resources.map(resourceKey).toSorted()
            )
          ) {
            throw new Error('Claim ID replay conflicts with durable authority');
          }
          return {
            status: 'granted',
            token: safeInteger(old.token),
            leases: existing
          };
        }
        const admitted = await this.#authorizedAttempt(tx, request, false);
        const blockers = (await this.#leases(tx, claim.scopeId)).filter(
          (lease) =>
            lease.state !== 'RELEASED' &&
            resources.some((entry) => areWritableResourcesConflicting(lease.resource, entry))
        );
        if (blockers.length) {
          return { status: 'blocked', blockers };
        }
        const token = await this.#nextToken(tx, claim.scopeId);
        await tx.unsafe(
          `insert into ${this.#schema}.forge_global_claims values ($1,$2,$3,$4,'ACTIVE',1,null)`,
          [claim.scopeId, claim.claimId, JSON.stringify(claim.owner), token]
        );
        for (const entry of resources) {
          await tx.unsafe(`insert into ${this.#schema}.forge_global_leases values ($1,$2,$3,$4)`, [
            claim.scopeId,
            claim.claimId,
            randomUUID(),
            JSON.stringify(entry)
          ]);
        }
        const started = {
          ...admitted.attempt,
          state: 'STARTING' as const,
          revision: admitted.attempt.revision + 1,
          startedAt: new Date()
        };
        if (admitted.kind === 'builder') {
          agentExecutionAttemptSchema.parse(started);
        } else {
          taskRepairAttemptSchema.parse(started);
          await tx.unsafe(
            `insert into ${this.#schema}.forge_records values ($1,'repair-history',$2,$3)`,
            [
              claim.owner.runId,
              `${claim.owner.attemptId}:${String(admitted.attempt.revision).padStart(8, '0')}`,
              admitted.previous
            ]
          );
        }
        await tx.unsafe(
          `update ${this.#schema}.forge_records set payload=$4 where run_id=$1 and kind=$2 and key=$3`,
          [claim.owner.runId, admitted.kind, claim.owner.attemptId, JSON.stringify(started)]
        );
        return {
          status: 'granted',
          token,
          leases: await this.#leases(tx, claim.scopeId, claim.claimId)
        };
      },
      claim.owner.runId
    );
  }

  async recoverRepositoryMutationAuthority(
    scopeId: string
  ): Promise<readonly GlobalMutationLease[]> {
    await this.#scope(this.#sql, scopeId);
    return this.#leases(this.#sql, scopeId);
  }

  /**
   * Attach to a child minted by the restricted handoff, without requesting a
   * second admission or inheriting its parent's repository-wide Git lease.
   * Recheck trust, run eligibility and the exact approved execution resources
   * under the same lock order used for permits and cancellation.
   */
  async recoverExecutionChild(
    scopeId: string,
    parentClaimId: string
  ): Promise<RecoveredExecutionChild> {
    const initial = await this.#one(
      this.#sql,
      `select owner_json from ${this.#schema}.forge_global_claims where scope_id=$1 and claim_id=$2`,
      [scopeId, parentClaimId]
    );
    if (initial === undefined) {
      throw new Error('Unknown execution handoff parent');
    }
    const runId = owner(initial.owner_json).runId;
    return this.#scopedLocked(
      scopeId,
      async (tx) => {
        const parent = await this.#claim(tx, scopeId, parentClaimId);
        const childOwner = owner(parent.owner_json);
        const phase = await this.#one(
          tx,
          `select * from ${this.#schema}.forge_global_workspace_phases where scope_id=$1 and parent_claim_id=$2`,
          [scopeId, parentClaimId]
        );
        const childId = phase?.child_claim_id;
        if (
          childOwner.runId !== runId ||
          childOwner.workspaceId === undefined ||
          parent.state !== 'RELEASED' ||
          phase?.phase !== 'HANDOFF_COMMITTED' ||
          typeof childId !== 'string' ||
          typeof phase.handoff_attestation_id !== 'string' ||
          typeof phase.handoff_attestation_digest !== 'string' ||
          phase.workspace_id !== childOwner.workspaceId ||
          typeof phase.execution_generation !== 'string'
        ) {
          throw new Error('Execution handoff is not committed for this parent');
        }
        const registry = await this.#one(
          tx,
          `select policy_version from ${this.#schema}.forge_global_trust_registry where id=1`
        );
        const signingKey = await this.#one(
          tx,
          `select state from ${this.#schema}.forge_global_trust_keys where key_id=$1`,
          [phase.signing_key]
        );
        const revocations = await tx.unsafe(
          `select kind from ${this.#schema}.forge_global_trust_revocations
         where (kind='DECISION' and digest=$1) or (kind='AUTHORIZATION' and digest=$2)`,
          [phase.setup_plan_digest, phase.authorization_digest]
        );
        if (
          registry?.policy_version !== workspaceSetupPolicy ||
          signingKey?.state !== 'ACTIVE' ||
          revocations.length !== 0
        ) {
          throw new Error('Execution handoff trust is no longer current');
        }
        const run = await this.#one(
          tx,
          `select state,payload from ${this.#schema}.forge_runs where id=$1`,
          [runId]
        );
        const bindingRow = await this.#one(
          tx,
          `select repository_id,scope_id from ${this.#schema}.forge_global_run_bindings where run_id=$1`,
          [runId]
        );
        const identity = runIdentity(run?.payload);
        const alias = await this.#one(
          tx,
          `select scope_id from ${this.#schema}.forge_global_aliases where repository_id=$1`,
          [identity.repositoryId]
        );
        const storedBinding = await this.#record(tx, runId, 'binding', childOwner.taskId);
        const storedAttempt = await this.#record(tx, runId, 'builder', childOwner.attemptId);
        const storedWorkspace = await this.#record(tx, runId, 'workspace', childOwner.workspaceId);
        const approvedTasks = fields(json(run?.payload)).tasks;
        const generation = await this.#one(
          tx,
          `select * from ${this.#schema}.forge_global_generations where id=$1`,
          [phase.execution_generation]
        );
        const lineage = await this.#one(
          tx,
          `select * from ${this.#schema}.forge_global_workspace_permit_lineages where scope_id=$1 and parent_claim_id=$2`,
          [scopeId, parentClaimId]
        );
        if (
          storedBinding === undefined ||
          storedAttempt === undefined ||
          storedWorkspace === undefined
        ) {
          throw new Error('Execution child is missing approved persisted records');
        }
        const binding = persistedTaskExecutionBindingSchema.parse(json(storedBinding));
        const attempt = agentExecutionAttemptSchema.parse(attemptJson(storedAttempt));
        const workspace = taskWorkspaceSchema.parse(json(storedWorkspace));
        const approvedRun = fields(fields(json(run?.payload)).run);
        const approval = fields(approvedRun.authority);
        if (
          run?.state !== 'ACTIVE' ||
          identity.id !== runId ||
          !Array.isArray(approvedTasks) ||
          !approvedTasks.some((task: unknown) => fields(task).id === childOwner.taskId) ||
          approvedRun.repositoryId !== identity.repositoryId ||
          approval.repositoryRoot !== binding.workspace.integrationRepositoryPath ||
          typeof approval.baseCommit !== 'string' ||
          bindingRow?.repository_id !== identity.repositoryId ||
          bindingRow.scope_id !== scopeId ||
          alias?.scope_id !== scopeId ||
          binding.runId !== runId ||
          binding.taskId !== childOwner.taskId ||
          binding.agentId !== childOwner.agentId ||
          binding.workspace.id !== childOwner.workspaceId ||
          binding.workspace.workspacePath !== workspace.workspacePath ||
          binding.workspace.integrationRepositoryPath !== workspace.integrationRepositoryPath ||
          binding.workspace.branchName !== workspace.branchName ||
          binding.workspace.baseRef !== workspace.baseRef ||
          binding.workspace.integrationRef !== workspace.integrationRef ||
          workspace.runId !== runId ||
          workspace.taskId !== childOwner.taskId ||
          workspace.revision !== 1 ||
          workspace.phase !== 'READY_TO_INTEGRATE' ||
          attempt.runId !== runId ||
          attempt.taskId !== childOwner.taskId ||
          attempt.id !== childOwner.attemptId ||
          attempt.agentId !== childOwner.agentId ||
          attempt.workspaceId !== childOwner.workspaceId ||
          (attempt.state !== 'STARTING' && attempt.state !== 'RUNNING') ||
          attempt.leasePlanFingerprint !== taskLeasePlanFingerprint(binding.leasePlan) ||
          phase.execution_plan_digest !== fingerprintPlanValue(binding.leasePlan).slice(7) ||
          generation?.state !== 'REVOKED' ||
          generation.scope_id !== scopeId ||
          generation.parent_claim_id !== parentClaimId ||
          generation.run_id !== runId ||
          generation.task_id !== childOwner.taskId ||
          generation.attempt_id !== childOwner.attemptId ||
          generation.workspace_id !== childOwner.workspaceId ||
          generation.execution_plan_digest !== phase.execution_plan_digest ||
          generation.setup_plan_digest !== phase.setup_plan_digest ||
          lineage?.completed !== true ||
          lineage.generation_id !== generation.id ||
          lineage.workspace_id !== childOwner.workspaceId ||
          lineage.token !== parent.token ||
          lineage.settlement_id !== phase.handoff_attestation_id ||
          lineage.settlement_digest !== phase.handoff_attestation_digest ||
          !same(owner(lineage.owner_json), childOwner)
        ) {
          throw new Error('Execution child no longer matches its approved run and workspace');
        }
        const child = await this.#claim(tx, scopeId, childId);
        const leases = await this.#leases(tx, scopeId, childId);
        const approved = canonicalTaskLeaseResources(binding.leasePlan.predictedResources);
        if (
          child.state !== 'ACTIVE' ||
          !same(owner(child.owner_json), childOwner) ||
          safeInteger(child.token) <= safeInteger(parent.token) ||
          leases.some(
            (lease) =>
              lease.token !== safeInteger(child.token) ||
              lease.claimId !== childId ||
              !same(lease.owner, childOwner)
          ) ||
          leases.length !== approved.length ||
          !same(
            leases.map((lease) => resourceKey(lease.resource)).toSorted(),
            approved.map(resourceKey).toSorted()
          ) ||
          leases.some((lease) => lease.state !== 'ACTIVE')
        ) {
          throw new Error('Execution child is not the active approved handoff claim');
        }
        return {
          scopeId,
          claimId: childId,
          owner: childOwner,
          token: safeInteger(child.token),
          leases,
          workspace,
          attemptRevision: attempt.revision,
          attemptState: attempt.state,
          leasePlanFingerprint: attempt.leasePlanFingerprint
        };
      },
      runId
    );
  }

  async #executionAttempt(
    tx: Query,
    request: {
      scopeId: string;
      parentClaimId: string;
      claimId: string;
      owner: GlobalMutationOwner;
      token: number;
    }
  ): Promise<AgentExecutionAttempt> {
    const phase = await this.#one(
      tx,
      `select phase,child_claim_id from ${this.#schema}.forge_global_workspace_phases where scope_id=$1 and parent_claim_id=$2`,
      [request.scopeId, request.parentClaimId]
    );
    const claim = await this.#claim(tx, request.scopeId, request.claimId);
    this.#assertOwner(claim, request.owner, request.token);
    const record = await this.#record(tx, request.owner.runId, 'builder', request.owner.attemptId);
    if (record === undefined) {
      throw new Error('Execution child has no persisted builder attempt');
    }
    const attempt = agentExecutionAttemptSchema.parse(attemptJson(record));
    if (
      phase?.phase !== 'HANDOFF_COMMITTED' ||
      phase.child_claim_id !== request.claimId ||
      (claim.state !== 'ACTIVE' && claim.state !== 'HELD_UNCERTAIN') ||
      attempt.runId !== request.owner.runId ||
      attempt.taskId !== request.owner.taskId ||
      attempt.agentId !== request.owner.agentId ||
      attempt.workspaceId !== request.owner.workspaceId
    ) {
      throw new Error('Builder lifecycle is not bound to the execution child');
    }
    return attempt;
  }

  /** A session is durable before the runner is allowed to dispatch tools. */
  async startExecutionChild(request: {
    scopeId: string;
    parentClaimId: string;
    claimId: string;
    owner: GlobalMutationOwner;
    token: number;
    expectedRevision: number;
    sessionRef: AgentSessionRef;
    previousSessionRef?: AgentSessionRef;
  }): Promise<AgentExecutionAttempt> {
    return this.#scopedLocked(
      request.scopeId,
      async (tx) => {
        const attempt = await this.#executionAttempt(tx, request);
        const lease = (await this.#leases(tx, request.scopeId, request.claimId))[0];
        if (lease === undefined) {
          throw new Error('Execution child has no execution resources');
        }
        await this.#assertCurrent(tx, { ...request, resource: lease.resource });
        if (
          attempt.state === 'RUNNING' &&
          attempt.revision === request.expectedRevision + 1 &&
          same(attempt.sessionRef, request.sessionRef)
        ) {
          return attempt;
        }
        if (
          attempt.revision !== request.expectedRevision ||
          (request.previousSessionRef === undefined
            ? attempt.state !== 'STARTING'
            : attempt.state !== 'RUNNING' || !same(attempt.sessionRef, request.previousSessionRef))
        ) {
          throw new Error('Execution child session start is stale or already running');
        }
        const running = agentExecutionAttemptSchema.parse({
          ...attempt,
          state: 'RUNNING',
          revision: attempt.revision + 1,
          sessionRef: request.sessionRef
        });
        await tx.unsafe(
          `update ${this.#schema}.forge_records set payload=$3 where run_id=$1 and kind='builder' and key=$2`,
          [request.owner.runId, request.owner.attemptId, JSON.stringify(running)]
        );
        return running;
      },
      request.owner.runId
    );
  }

  /** Persist the terminal attempt and ownership outcome in one scope/run transaction.
   * A runner return is not stop evidence: without independent confirmation the
   * claim remains HELD_UNCERTAIN, including when the attempt completed successfully.
   */
  async finishExecutionChild(request: {
    scopeId: string;
    parentClaimId: string;
    claimId: string;
    owner: GlobalMutationOwner;
    token: number;
    expectedRevision: number;
    state: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN';
    detail: string;
    stopEvidence?: string;
  }): Promise<{ attempt: AgentExecutionAttempt; claimState: 'RELEASED' | 'HELD_UNCERTAIN' }> {
    required(request.detail, 'Builder outcome evidence');
    if (request.stopEvidence !== undefined) {
      required(request.stopEvidence, 'Independent builder stop evidence');
    }
    return this.#scopedLocked(
      request.scopeId,
      async (tx) => {
        const attempt = await this.#executionAttempt(tx, request);
        if (
          (attempt.state !== 'STARTING' && attempt.state !== 'RUNNING') ||
          attempt.revision !== request.expectedRevision
        ) {
          throw new Error('Execution child terminal outcome is stale');
        }
        const claim = await this.#claim(tx, request.scopeId, request.claimId);
        const permits = await this.#one(
          tx,
          `select 1 from ${this.#schema}.forge_global_permits where scope_id=$1 and claim_id=$2 limit 1`,
          [request.scopeId, request.claimId]
        );
        const canRelease =
          request.stopEvidence !== undefined &&
          request.state !== 'UNKNOWN' &&
          claim.state === 'ACTIVE' &&
          permits === undefined;
        if (canRelease) {
          const lease = (await this.#leases(tx, request.scopeId, request.claimId))[0];
          if (lease === undefined) {
            throw new Error('Execution child has no execution resources');
          }
          // Cancellation or current-trust revocation never authorizes ordinary release.
          // The caller can record the same outcome without stopEvidence to quarantine it.
          await this.#assertCurrent(tx, { ...request, resource: lease.resource });
        }
        const terminal = agentExecutionAttemptSchema.parse({
          ...attempt,
          state: request.state,
          revision: attempt.revision + 1,
          completedAt: new Date(),
          ...(request.state === 'COMPLETED'
            ? {}
            : {
                failure: {
                  type:
                    request.state === 'UNKNOWN'
                      ? 'unknown-outcome'
                      : request.state === 'CANCELLED'
                        ? 'cancelled'
                        : 'execution-failed',
                  detail: request.detail
                }
              })
        });
        const claimState = canRelease ? 'RELEASED' : 'HELD_UNCERTAIN';
        await tx.unsafe(
          `update ${this.#schema}.forge_records set payload=$3 where run_id=$1 and kind='builder' and key=$2`,
          [request.owner.runId, request.owner.attemptId, JSON.stringify(terminal)]
        );
        await tx.unsafe(
          `update ${this.#schema}.forge_global_claims set state=$3,version=version+1,evidence=$4 where scope_id=$1 and claim_id=$2`,
          [
            request.scopeId,
            request.claimId,
            claimState,
            canRelease ? (request.stopEvidence ?? request.detail) : request.detail
          ]
        );
        return { attempt: terminal, claimState };
      },
      request.owner.runId
    );
  }

  /** Attach to an admitted repair without minting another claim or widening scope. */
  async recoverRepairExecution(request: {
    scopeId: string;
    claimId: string;
    owner: GlobalMutationOwner;
    token: number;
  }): Promise<{
    attempt: TaskRepairAttempt;
    workspace: TaskWorkspace;
    leases: readonly GlobalMutationLease[];
  }> {
    return this.#scopedLocked(
      request.scopeId,
      async (tx) => {
        const claim = await this.#claim(tx, request.scopeId, request.claimId);
        this.#assertOwner(claim, request.owner, request.token);
        const leases = await this.#leases(tx, request.scopeId, request.claimId);
        const bindingRecord = await this.#record(
          tx,
          request.owner.runId,
          'binding',
          request.owner.taskId
        );
        if (
          bindingRecord === undefined ||
          claim.state !== 'ACTIVE' ||
          leases.length === 0 ||
          request.owner.workspaceId === undefined
        ) {
          throw new Error('Repair execution has no active approved claim');
        }
        const binding = persistedTaskExecutionBindingSchema.parse(json(bindingRecord));
        if (
          !same(
            leases.map((lease) => resourceKey(lease.resource)).toSorted(),
            canonicalTaskLeaseResources(binding.leasePlan.predictedResources)
              .map(resourceKey)
              .toSorted()
          )
        ) {
          throw new Error('Repair execution resources differ from the approved plan');
        }
        const admitted = await this.#authorizedAttempt(
          tx,
          { ...request, resources: leases.map((lease) => lease.resource) },
          true
        );
        if (admitted.kind !== 'repair') {
          throw new Error('Repair execution cannot attach to a builder claim');
        }
        const attempt = taskRepairAttemptSchema.parse(admitted.attempt);
        const handoff = await this.#one(
          tx,
          `select p.phase from ${this.#schema}.forge_global_workspace_phases p join ${this.#schema}.forge_global_claims c on c.scope_id=p.scope_id and c.claim_id=p.parent_claim_id where p.scope_id=$1 and c.owner_json::jsonb->>'runId'=$2 and c.owner_json::jsonb->>'attemptId'=$3 and p.workspace_id=$4`,
          [
            request.scopeId,
            attempt.runId,
            attempt.parentReviewSubject.builderAttemptId,
            attempt.workspaceId
          ]
        );
        if (handoff?.phase !== 'HANDOFF_COMMITTED') {
          throw new Error('Repair execution has no committed builder workspace handoff');
        }
        await this.#assertCurrent(tx, { ...request, resource: leases[0].resource });
        const workspaceRecord = await this.#record(
          tx,
          request.owner.runId,
          'workspace',
          request.owner.workspaceId
        );
        if (workspaceRecord === undefined) {
          throw new Error('Repair execution has no persisted workspace');
        }
        const workspace = taskWorkspaceSchema.parse(json(workspaceRecord));
        if (
          workspace.id !== attempt.workspaceId ||
          attempt.parentReviewSubject.workspaceId !== workspace.id ||
          attempt.parentReviewSubject.workspaceRevision !== workspace.revision ||
          workspace.runId !== attempt.runId ||
          workspace.taskId !== attempt.taskId ||
          workspace.workspacePath !== binding.workspace.workspacePath ||
          workspace.integrationRepositoryPath !== binding.workspace.integrationRepositoryPath ||
          workspace.branchName !== binding.workspace.branchName ||
          workspace.baseRef !== binding.workspace.baseRef ||
          workspace.integrationRef !== binding.workspace.integrationRef ||
          workspace.phase !== 'READY_TO_INTEGRATE'
        ) {
          throw new Error('Repair workspace differs from the approved task binding');
        }
        return { attempt, workspace, leases };
      },
      request.owner.runId
    );
  }

  async #repairLifecycle(
    tx: Query,
    request: { scopeId: string; claimId: string; owner: GlobalMutationOwner; token: number }
  ): Promise<TaskRepairAttempt> {
    const claim = await this.#claim(tx, request.scopeId, request.claimId);
    this.#assertOwner(claim, request.owner, request.token);
    const record = await this.#record(tx, request.owner.runId, 'repair', request.owner.attemptId);
    if (record === undefined || (claim.state !== 'ACTIVE' && claim.state !== 'HELD_UNCERTAIN')) {
      throw new Error('Repair lifecycle has no unresolved claim');
    }
    const attempt = taskRepairAttemptSchema.parse(attemptJson(record));
    const item = await this.#record(
      tx,
      request.owner.runId,
      'repair-item',
      request.owner.attemptId
    );
    if (item === undefined) {
      throw new Error('Repair lifecycle has no admitted work item');
    }
    const work = taskRepairWorkItemSchema.parse(json(item));
    if (
      attempt.runId !== request.owner.runId ||
      attempt.taskId !== request.owner.taskId ||
      attempt.agentId !== request.owner.agentId ||
      attempt.workspaceId !== request.owner.workspaceId ||
      work.runId !== attempt.runId ||
      work.taskId !== attempt.taskId ||
      work.repairAttemptId !== attempt.id ||
      work.workspaceId !== attempt.workspaceId ||
      work.parentReviewIteration !== attempt.parentReviewIteration ||
      work.builderAttemptId !== attempt.parentReviewSubject.builderAttemptId
    ) {
      throw new Error('Repair lifecycle owner differs from the admitted attempt');
    }
    return attempt;
  }

  async #persistGlobalRepair(
    tx: Query,
    before: TaskRepairAttempt,
    after: TaskRepairAttempt
  ): Promise<void> {
    await tx.unsafe(
      `insert into ${this.#schema}.forge_records values ($1,'repair-history',$2,$3)`,
      [
        before.runId,
        `${before.id}:${String(before.revision).padStart(8, '0')}`,
        JSON.stringify(before)
      ]
    );
    await tx.unsafe(
      `update ${this.#schema}.forge_records set payload=$3 where run_id=$1 and kind='repair' and key=$2`,
      [after.runId, after.id, JSON.stringify(after)]
    );
  }

  async startRepairExecution(request: {
    scopeId: string;
    claimId: string;
    owner: GlobalMutationOwner;
    token: number;
    expectedRevision: number;
    sessionRef: AgentSessionRef;
    previousSessionRef?: AgentSessionRef;
  }): Promise<TaskRepairAttempt> {
    return this.#scopedLocked(
      request.scopeId,
      async (tx) => {
        const attempt = await this.#repairLifecycle(tx, request);
        const lease = (await this.#leases(tx, request.scopeId, request.claimId))[0];
        if (lease === undefined) {
          throw new Error('Repair execution has no resources');
        }
        await this.#assertCurrent(tx, { ...request, resource: lease.resource });
        if (
          attempt.state === 'RUNNING' &&
          attempt.revision === request.expectedRevision + 1 &&
          same(attempt.sessionRef, request.sessionRef)
        ) {
          return attempt;
        }
        if (
          attempt.revision !== request.expectedRevision ||
          (request.previousSessionRef === undefined
            ? attempt.state !== 'STARTING'
            : attempt.state !== 'RUNNING' || !same(attempt.sessionRef, request.previousSessionRef))
        ) {
          throw new Error('Repair session start is stale or already running');
        }
        const running = taskRepairAttemptSchema.parse({
          ...attempt,
          state: 'RUNNING',
          revision: attempt.revision + 1,
          sessionRef: request.sessionRef
        });
        await this.#persistGlobalRepair(tx, attempt, running);
        return running;
      },
      request.owner.runId
    );
  }

  async finishRepairExecution(request: {
    scopeId: string;
    claimId: string;
    owner: GlobalMutationOwner;
    token: number;
    expectedRevision: number;
    state: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN';
    detail: string;
    stopEvidence?: string;
  }): Promise<{ attempt: TaskRepairAttempt; claimState: 'RELEASED' | 'HELD_UNCERTAIN' }> {
    required(request.detail, 'Repair outcome evidence');
    if (request.stopEvidence !== undefined) {
      required(request.stopEvidence, 'Independent repair stop evidence');
    }
    return this.#scopedLocked(
      request.scopeId,
      async (tx) => {
        const attempt = await this.#repairLifecycle(tx, request);
        if (
          !['STARTING', 'RUNNING'].includes(attempt.state) ||
          attempt.revision !== request.expectedRevision
        ) {
          throw new Error('Repair terminal outcome is stale');
        }
        const claim = await this.#claim(tx, request.scopeId, request.claimId);
        const permits = await this.#one(
          tx,
          `select 1 from ${this.#schema}.forge_global_permits where scope_id=$1 and claim_id=$2 limit 1`,
          [request.scopeId, request.claimId]
        );
        const canRelease =
          request.stopEvidence !== undefined &&
          request.state !== 'UNKNOWN' &&
          claim.state === 'ACTIVE' &&
          permits === undefined;
        if (canRelease) {
          const lease = (await this.#leases(tx, request.scopeId, request.claimId))[0];
          if (lease === undefined) {
            throw new Error('Repair execution has no resources');
          }
          await this.#assertCurrent(tx, { ...request, resource: lease.resource });
        }
        const terminal = taskRepairAttemptSchema.parse({
          ...attempt,
          state: request.state,
          revision: attempt.revision + 1,
          completedAt: new Date(),
          ...(request.state === 'COMPLETED'
            ? {}
            : {
                failure: {
                  type:
                    request.state === 'UNKNOWN'
                      ? 'unknown-outcome'
                      : request.state === 'CANCELLED'
                        ? 'cancelled'
                        : 'execution-failed',
                  detail: request.detail
                }
              })
        });
        const claimState = canRelease ? 'RELEASED' : 'HELD_UNCERTAIN';
        await this.#persistGlobalRepair(tx, attempt, terminal);
        await tx.unsafe(
          `update ${this.#schema}.forge_global_claims set state=$3,version=version+1,evidence=$4 where scope_id=$1 and claim_id=$2`,
          [
            request.scopeId,
            request.claimId,
            claimState,
            canRelease ? (request.stopEvidence ?? request.detail) : request.detail
          ]
        );
        return { attempt: terminal, claimState };
      },
      request.owner.runId
    );
  }

  async recoverFencedMutationPermits(
    scopeId: string,
    claimId?: string
  ): Promise<readonly PersistedFencedMutationPermit[]> {
    await this.#scope(this.#sql, scopeId);
    const rows = await this.#sql.unsafe(
      `select * from ${this.#schema}.forge_global_permits where scope_id=$1 ${claimId === undefined ? '' : 'and claim_id=$2'} order by id`,
      claimId === undefined ? [scopeId] : [scopeId, claimId]
    );
    return rows.map((row) => ({
      id: String(row.id),
      scopeId: String(row.scope_id),
      claimId: String(row.claim_id),
      owner: owner(row.owner_json),
      token: safeInteger(row.token),
      resource: resource(row.resource_json)
    }));
  }

  async #assertCurrent(tx: Query, request: CurrentMutationTokenRequest): Promise<void> {
    await this.#assertOrdinaryClaim(tx, request.scopeId, request.claimId);
    let phaseByChild = await this.#one(
      tx,
      `select phase,signing_key,setup_plan_digest,authorization_digest,execution_generation from ${this.#schema}.forge_global_workspace_phases
       where scope_id=$1 and child_claim_id=$2`,
      [request.scopeId, request.claimId]
    );
    const repairRecord = await this.#record(
      tx,
      request.owner.runId,
      'repair',
      request.owner.attemptId
    );
    if (repairRecord !== undefined) {
      const repairAttempt = taskRepairAttemptSchema.parse(attemptJson(repairRecord));
      phaseByChild = await this.#one(
        tx,
        `select p.phase,p.signing_key,p.setup_plan_digest,p.authorization_digest,p.execution_generation from ${this.#schema}.forge_global_workspace_phases p join ${this.#schema}.forge_global_claims c on c.scope_id=p.scope_id and c.claim_id=p.parent_claim_id where p.scope_id=$1 and c.owner_json::jsonb->>'runId'=$2 and c.owner_json::jsonb->>'attemptId'=$3 and p.workspace_id=$4`,
        [
          request.scopeId,
          repairAttempt.runId,
          repairAttempt.parentReviewSubject.builderAttemptId,
          repairAttempt.workspaceId
        ]
      );
    }
    if (phaseByChild !== undefined && phaseByChild.phase !== 'HANDOFF_COMMITTED') {
      throw new Error('Execution child has no committed handoff');
    }
    // Child permits must consult current setup trust, not a cached attachment:
    // an administrator can revoke the signing key or either exact decision
    // between a worker restart and the next filesystem mutation.
    const handoff = phaseByChild;
    if (handoff !== undefined) {
      const registry = await this.#one(
        tx,
        `select policy_version from ${this.#schema}.forge_global_trust_registry where id=1`
      );
      const key = await this.#one(
        tx,
        `select state from ${this.#schema}.forge_global_trust_keys where key_id=$1`,
        [handoff.signing_key]
      );
      const generation = await this.#one(
        tx,
        `select state from ${this.#schema}.forge_global_generations where id=$1`,
        [handoff.execution_generation]
      );
      const revoked = await tx.unsafe(
        `select kind from ${this.#schema}.forge_global_trust_revocations
         where (kind='DECISION' and digest=$1) or (kind='AUTHORIZATION' and digest=$2)`,
        [handoff.setup_plan_digest, handoff.authorization_digest]
      );
      if (
        registry?.policy_version !== workspaceSetupPolicy ||
        key?.state !== 'ACTIVE' ||
        generation?.state !== 'REVOKED' ||
        revoked.length !== 0
      ) {
        throw new Error('Execution child mutation trust is no longer current');
      }
    }
    const claim = await this.#claim(tx, request.scopeId, request.claimId);
    const repair = await this.#record(tx, request.owner.runId, 'repair', request.owner.attemptId);
    if (repair !== undefined) {
      const admitted = await this.#authorizedAttempt(
        tx,
        { ...request, resources: [request.resource] },
        true
      );
      if (admitted.kind !== 'repair' || request.owner.workspaceId === undefined) {
        throw new Error('Repair mutation owner is not workspace-bound');
      }
    }
    const run = await this.#one(tx, `select state from ${this.#schema}.forge_runs where id=$1`, [
      request.owner.runId
    ]);
    if (
      run?.state !== 'ACTIVE' ||
      claim.state !== 'ACTIVE' ||
      safeInteger(claim.token) !== request.token ||
      !same(owner(claim.owner_json), request.owner) ||
      !(await this.#leases(tx, request.scopeId, request.claimId)).some((lease) =>
        isWritableResourceCoveredBy(lease.resource, writableResourceSchema.parse(request.resource))
      )
    ) {
      throw new Error('Stale or uncovered global mutation token');
    }
  }

  async assertCurrentMutationToken(request: CurrentMutationTokenRequest): Promise<void> {
    await this.#scopedLocked(
      request.scopeId,
      async (tx) => this.#assertCurrent(tx, request),
      request.owner.runId
    );
  }

  async beginFencedMutation(
    request: CurrentMutationTokenRequest
  ): Promise<FencedMutationExecutionPermit> {
    return this.#scopedLocked(
      request.scopeId,
      async (tx) => {
        await this.#assertCurrent(tx, request);
        const permit = {
          id: randomUUID(),
          completionSecret: randomBytes(32).toString('hex')
        };
        await tx.unsafe(
          `insert into ${this.#schema}.forge_global_permits values ($1,$2,$3,$4,$5,$6,$7)`,
          [
            permit.id,
            request.scopeId,
            request.claimId,
            JSON.stringify(request.owner),
            request.token,
            JSON.stringify(writableResourceSchema.parse(request.resource)),
            verifier(permit.completionSecret).toString('hex')
          ]
        );
        return permit;
      },
      request.owner.runId
    );
  }

  async #permitScope(id: string): Promise<string> {
    const row = await this.#one(
      this.#sql,
      `select scope_id from ${this.#schema}.forge_global_permits where id=$1`,
      [id]
    );
    if (row === undefined) {
      throw new Error('Invalid fenced mutation completion capability');
    }
    return String(row.scope_id);
  }

  async endFencedMutation(permit: FencedMutationExecutionPermit): Promise<void> {
    const scopeId = await this.#permitScope(permit.id);
    await this.#scopedLocked(scopeId, async (tx) => {
      const row = await this.#one(
        tx,
        `select scope_id,verifier from ${this.#schema}.forge_global_permits where id=$1`,
        [permit.id]
      );
      if (row?.scope_id !== scopeId) {
        throw new Error('Fenced mutation permit changed scope');
      }
      const actual = row === undefined ? Buffer.alloc(0) : Buffer.from(String(row.verifier), 'hex');
      const supplied = verifier(permit.completionSecret);
      if (actual.length !== supplied.length || !timingSafeEqual(actual, supplied)) {
        throw new Error('Invalid fenced mutation completion capability');
      }
      await tx.unsafe(`delete from ${this.#schema}.forge_global_permits where id=$1`, [permit.id]);
    });
  }

  async #audit(tx: Tx, action: string, subject: string, evidence: string): Promise<void> {
    await tx.unsafe(`insert into ${this.#schema}.forge_global_audit values ($1,$2,$3,$4)`, [
      randomUUID(),
      action,
      subject,
      evidence
    ]);
  }

  async settleOrphanedFencedMutation(
    permit: PersistedFencedMutationPermit,
    verifiedQuiescenceEvidence: string
  ): Promise<void> {
    required(verifiedQuiescenceEvidence, 'Quiescence evidence');
    await this.#scopedLocked(permit.scopeId, async (tx) => {
      const row = await this.#one(
        tx,
        `select * from ${this.#schema}.forge_global_permits where id=$1`,
        [permit.id]
      );
      if (
        row === undefined ||
        row.scope_id !== permit.scopeId ||
        row.claim_id !== permit.claimId ||
        safeInteger(row.token) !== permit.token ||
        !same(owner(row.owner_json), permit.owner) ||
        !same(resource(row.resource_json), permit.resource) ||
        (await this.#claim(tx, permit.scopeId, permit.claimId)).state !== 'HELD_UNCERTAIN'
      ) {
        throw new Error('Orphan permit is not eligible for settlement');
      }
      await tx.unsafe(`delete from ${this.#schema}.forge_global_permits where id=$1`, [permit.id]);
      await this.#audit(tx, 'settle-orphaned-permit', permit.id, verifiedQuiescenceEvidence);
    });
  }

  #assertOwner(row: Row, claimOwner: GlobalMutationOwner, token: number): void {
    if (safeInteger(row.token) !== token || !same(owner(row.owner_json), claimOwner)) {
      throw new Error('Global mutation owner or token mismatch');
    }
  }

  async #assertNoPermits(tx: Tx, scopeId: string, claimId: string): Promise<void> {
    const row = await this.#one(
      tx,
      `select 1 from ${this.#schema}.forge_global_permits where scope_id=$1 and claim_id=$2 limit 1`,
      [scopeId, claimId]
    );
    if (row !== undefined) {
      throw new GlobalMutationInFlightError();
    }
  }

  async releaseGlobalMutation(request: {
    scopeId: string;
    claimId: string;
    owner: GlobalMutationOwner;
    token: number;
    expectedVersion: number;
    stopEvidence: string;
  }): Promise<void> {
    required(request.stopEvidence, 'Stop evidence');
    await this.#scopedLocked(request.scopeId, async (tx) => {
      await this.#assertOrdinaryClaim(tx, request.scopeId, request.claimId);
      const row = await this.#claim(tx, request.scopeId, request.claimId);
      this.#assertOwner(row, request.owner, request.token);
      if (row.state !== 'ACTIVE' || safeInteger(row.version) !== request.expectedVersion) {
        throw new Error('Invalid active claim release');
      }
      await this.#assertNoPermits(tx, request.scopeId, request.claimId);
      await tx.unsafe(
        `update ${this.#schema}.forge_global_claims set state='RELEASED',version=version+1,evidence=$3 where scope_id=$1 and claim_id=$2`,
        [request.scopeId, request.claimId, request.stopEvidence]
      );
    });
  }

  async markMutationUncertain(request: {
    scopeId: string;
    claimId: string;
    owner: GlobalMutationOwner;
    token: number;
    evidence: string;
  }): Promise<void> {
    required(request.evidence, 'Uncertainty evidence');
    await this.#scopedLocked(request.scopeId, async (tx) => {
      const row = await this.#claim(tx, request.scopeId, request.claimId);
      this.#assertOwner(row, request.owner, request.token);
      if (row.state !== 'ACTIVE') {
        throw new Error('Only an active claim can become uncertain');
      }
      await tx.unsafe(
        `update ${this.#schema}.forge_global_claims set state='HELD_UNCERTAIN',version=version+1,evidence=$3 where scope_id=$1 and claim_id=$2`,
        [request.scopeId, request.claimId, request.evidence]
      );
    });
  }

  async reclaimUncertainMutation(request: {
    scopeId: string;
    claimId: string;
    owner: GlobalMutationOwner;
    token: number;
    expectedVersion: number;
    verifiedQuiescenceEvidence: string;
  }): Promise<void> {
    required(request.verifiedQuiescenceEvidence, 'Quiescence evidence');
    await this.#scopedLocked(request.scopeId, async (tx) => {
      await this.#assertOrdinaryClaim(tx, request.scopeId, request.claimId);
      const row = await this.#claim(tx, request.scopeId, request.claimId);
      this.#assertOwner(row, request.owner, request.token);
      if (row.state !== 'HELD_UNCERTAIN' || safeInteger(row.version) !== request.expectedVersion) {
        throw new Error('Invalid uncertain claim reclamation');
      }
      await this.#assertNoPermits(tx, request.scopeId, request.claimId);
      await tx.unsafe(
        `update ${this.#schema}.forge_global_claims set state='RELEASED',version=version+1,evidence=$3 where scope_id=$1 and claim_id=$2`,
        [request.scopeId, request.claimId, request.verifiedQuiescenceEvidence]
      );
    });
  }
}
