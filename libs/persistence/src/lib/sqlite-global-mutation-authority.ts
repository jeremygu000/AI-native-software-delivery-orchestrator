import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import Database from 'better-sqlite3';
import { z } from 'zod';
import {
  agentExecutionAttemptSchema,
  areWritableResourcesConflicting,
  canonicalTaskLeaseResources,
  GlobalMutationInFlightError,
  isWritableResourceCoveredBy,
  persistedTaskExecutionBindingSchema,
  taskContractSchema,
  taskLeasePlanFingerprint,
  taskRepairAttemptSchema,
  taskRepairWorkItemSchema,
  writableResourceIdentity,
  writableResourceSchema,
  type CurrentMutationTokenRequest,
  type FencedMutationExecutionPermit,
  type GlobalMutationAuthority,
  type GlobalMutationClaim,
  type GlobalMutationClaimResult,
  type GlobalMutationLease,
  type GlobalMutationOwner,
  type LegacyMutationOwner,
  type PersistedFencedMutationPermit,
  type WritableResource
} from '@ai-native-software-delivery-orchestrator/domain';

const stringRow = z.object({ state: z.string() });
const scopeRow = z.object({ scope_id: z.string() });
const countRow = z.object({ count: z.number().int().nonnegative() });
const ownerSchema = z.object({
  runId: z.string(),
  taskId: z.string(),
  attemptId: z.string(),
  agentId: z.string(),
  workspaceId: z.string().optional()
});
const legacyOwnerSchema = z.object({
  key: z.string(),
  runId: z.string(),
  repositoryId: z.string(),
  kind: z.enum(['run', 'lease', 'builder', 'repair', 'integration']),
  resource: writableResourceSchema.optional()
});
const claimRowSchema = z.object({
  scope_id: z.string(),
  claim_id: z.string(),
  owner_json: z.string(),
  token: z.number().int(),
  state: z.enum(['ACTIVE', 'HELD_UNCERTAIN', 'RELEASED']),
  version: z.number().int(),
  evidence: z.string().nullable()
});
const leaseRowSchema = claimRowSchema.extend({ lease_id: z.string(), resource_json: z.string() });
const permitRowSchema = z.object({
  id: z.string(),
  scope_id: z.string(),
  claim_id: z.string(),
  owner_json: z.string(),
  token: z.number().int(),
  resource_json: z.string(),
  verifier: z.string()
});
const legacyRowSchema = z.object({
  key: z.string(),
  owner_json: z.string(),
  disposition: z.string().nullable()
});
type ClaimRow = z.infer<typeof claimRowSchema>;
type AuthorizedAttempt =
  | {
      kind: 'builder';
      attempt: z.infer<typeof agentExecutionAttemptSchema>;
      previousJson: string;
      approvedResources: readonly WritableResource[];
    }
  | {
      kind: 'repair';
      attempt: z.infer<typeof taskRepairAttemptSchema>;
      previousJson: string;
      approvedResources: readonly WritableResource[];
    };

const nonempty = (value: string, name: string): string => {
  if (value.trim().length === 0) {
    throw new Error(`${name} must not be empty`);
  }
  return value;
};
const parsed = <T>(json: string, schema: z.ZodType<T>): T => schema.parse(JSON.parse(json));
const parsedAttempt = <T>(json: string, schema: z.ZodType<T>): T =>
  schema.parse(
    JSON.parse(json, (key: string, value: unknown): unknown =>
      (key === 'startedAt' || key === 'completedAt') && typeof value === 'string'
        ? new Date(value)
        : value
    )
  );
const resource = (json: string): WritableResource => writableResourceSchema.parse(JSON.parse(json));
const resourceKey = (value: WritableResource): string =>
  `${value.type}\u0000${writableResourceIdentity(value)}`;
const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);
const secretVerifier = (secret: string): Buffer => createHash('sha256').update(secret).digest();

/** SQLite authority uses one immediate write transaction as its deployment gate. */
export class SqliteGlobalMutationAuthority implements GlobalMutationAuthority {
  readonly #db: Database.Database;

  constructor(filename: string) {
    this.#db = new Database(filename);
    this.#db.pragma('journal_mode = WAL');
    this.#db.pragma('busy_timeout = 5000');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS forge_global_control (
        id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL, next_token INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO forge_global_control (id,state,next_token)
        VALUES (1,'LEGACY_ALLOWED',0);
      CREATE TABLE IF NOT EXISTS forge_global_scopes (
        id TEXT PRIMARY KEY, state TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS forge_global_aliases (
        repository_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS forge_global_run_bindings (
        run_id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, scope_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS forge_global_claims (
        scope_id TEXT NOT NULL, claim_id TEXT NOT NULL, owner_json TEXT NOT NULL,
        token INTEGER NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL,
        evidence TEXT, PRIMARY KEY (scope_id,claim_id)
      );
      CREATE TABLE IF NOT EXISTS forge_global_leases (
        scope_id TEXT NOT NULL, claim_id TEXT NOT NULL, lease_id TEXT NOT NULL,
        resource_json TEXT NOT NULL, PRIMARY KEY (scope_id,claim_id,lease_id)
      );
      CREATE TABLE IF NOT EXISTS forge_global_permits (
        id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, claim_id TEXT NOT NULL,
        owner_json TEXT NOT NULL, token INTEGER NOT NULL, resource_json TEXT NOT NULL,
        verifier TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS forge_global_legacy_owners (
        key TEXT PRIMARY KEY, owner_json TEXT NOT NULL, disposition TEXT,
        evidence TEXT
      );
      CREATE TABLE IF NOT EXISTS forge_global_audit (
        id TEXT PRIMARY KEY, action TEXT NOT NULL, subject TEXT NOT NULL,
        evidence TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.#db.close();
  }

  #one<T>(query: string, schema: z.ZodType<T>, ...parameters: unknown[]): T | undefined {
    const row: unknown = this.#db.prepare(query).get(...parameters);
    return row === undefined ? undefined : schema.parse(row);
  }
  #all<T>(query: string, schema: z.ZodType<T>, ...parameters: unknown[]): T[] {
    const rows: unknown = this.#db.prepare(query).all(...parameters);
    return z.array(schema).parse(rows);
  }
  #transaction<T>(work: () => T): T {
    return this.#db.transaction(work).immediate();
  }
  #cutoverState(): string {
    const row = this.#one('SELECT state FROM forge_global_control WHERE id=1', stringRow);
    if (row === undefined) {
      throw new Error('Missing global authority control row');
    }
    return row.state;
  }
  #scope(scopeId: string): string {
    const row = this.#one('SELECT state FROM forge_global_scopes WHERE id=?', stringRow, scopeId);
    if (row === undefined) {
      throw new Error(`Unknown repository scope: ${scopeId}`);
    }
    return row.state;
  }
  #claim(scopeId: string, claimId: string): ClaimRow {
    const row = this.#one(
      'SELECT * FROM forge_global_claims WHERE scope_id=? AND claim_id=?',
      claimRowSchema,
      scopeId,
      claimId
    );
    if (row === undefined) {
      throw new Error(`Unknown global mutation claim: ${scopeId}/${claimId}`);
    }
    return row;
  }
  #leases(scopeId: string, claimId?: string): GlobalMutationLease[] {
    const rows = this.#all(
      `SELECT c.*,l.lease_id,l.resource_json FROM forge_global_claims c
       JOIN forge_global_leases l USING (scope_id,claim_id)
       WHERE c.scope_id=? ${claimId === undefined ? '' : 'AND c.claim_id=?'}
       ORDER BY c.token,c.claim_id,l.lease_id`,
      leaseRowSchema,
      ...(claimId === undefined ? [scopeId] : [scopeId, claimId])
    );
    return rows.map((row) => ({
      scopeId: row.scope_id,
      claimId: row.claim_id,
      leaseId: row.lease_id,
      token: row.token,
      version: row.version,
      resource: resource(row.resource_json),
      owner: parsed(row.owner_json, ownerSchema),
      state: row.state,
      ...(row.evidence === null ? {} : { evidence: row.evidence })
    }));
  }
  #nextToken(): number {
    const row = this.#one(
      'SELECT next_token FROM forge_global_control WHERE id=1',
      z.object({ next_token: z.number().int() })
    );
    if (row === undefined || !Number.isSafeInteger(row.next_token + 1)) {
      throw new Error('Global mutation token exhausted');
    }
    const next = row.next_token + 1;
    this.#db.prepare('UPDATE forge_global_control SET next_token=? WHERE id=1').run(next);
    return next;
  }

  async registerScope(repositoryId: string): Promise<string> {
    nonempty(repositoryId, 'Repository ID');
    return this.#transaction(() => {
      const existing = this.#one(
        'SELECT scope_id FROM forge_global_aliases WHERE repository_id=?',
        scopeRow,
        repositoryId
      );
      if (existing !== undefined) {
        return existing.scope_id;
      }
      const scopeId = randomUUID();
      this.#db
        .prepare('INSERT INTO forge_global_scopes (id,state) VALUES (?,?)')
        .run(scopeId, 'REGISTERING');
      this.#db
        .prepare('INSERT INTO forge_global_aliases (repository_id,scope_id) VALUES (?,?)')
        .run(repositoryId, scopeId);
      return scopeId;
    });
  }
  async registerAlias(scopeId: string, repositoryId: string): Promise<void> {
    nonempty(repositoryId, 'Repository ID');
    this.#transaction(() => {
      this.#scope(scopeId);
      const old = this.#one(
        'SELECT scope_id FROM forge_global_aliases WHERE repository_id=?',
        scopeRow,
        repositoryId
      );
      if (old !== undefined && old.scope_id !== scopeId) {
        throw new Error('Alias scope conflict');
      }
      if (old === undefined) {
        this.#db
          .prepare('INSERT INTO forge_global_aliases VALUES (?,?)')
          .run(repositoryId, scopeId);
      }
    });
  }
  async bindRun(runId: string, repositoryId: string): Promise<void> {
    this.#transaction(() => {
      const run = this.#one(
        'SELECT repository_id FROM orchestration_runs WHERE id=?',
        z.object({ repository_id: z.string() }),
        runId
      );
      if (run?.repository_id !== repositoryId) {
        throw new Error('Run repository identity mismatch');
      }
      const alias = this.#one(
        'SELECT scope_id FROM forge_global_aliases WHERE repository_id=?',
        scopeRow,
        repositoryId
      );
      if (alias === undefined) {
        throw new Error('Unregistered repository alias');
      }
      const old = this.#one(
        'SELECT repository_id,scope_id FROM forge_global_run_bindings WHERE run_id=?',
        z.object({ repository_id: z.string(), scope_id: z.string() }),
        runId
      );
      if (
        old !== undefined &&
        (old.repository_id !== repositoryId || old.scope_id !== alias.scope_id)
      ) {
        throw new Error('Run binding is immutable');
      }
      if (old === undefined) {
        this.#db
          .prepare('INSERT INTO forge_global_run_bindings VALUES (?,?,?)')
          .run(runId, repositoryId, alias.scope_id);
      }
    });
  }

  async recoverGlobalRunScope(runId: string): Promise<string> {
    const row = this.#one(
      `SELECT b.scope_id FROM forge_global_run_bindings b
       JOIN orchestration_runs r ON r.id=b.run_id AND r.repository_id=b.repository_id
       JOIN forge_global_aliases a ON a.repository_id=b.repository_id AND a.scope_id=b.scope_id
       JOIN forge_global_scopes s ON s.id=b.scope_id WHERE b.run_id=?`,
      scopeRow,
      runId
    );
    if (row === undefined) {
      throw new Error(`Run has no matching durable global scope binding: ${runId}`);
    }
    return row.scope_id;
  }

  #legacyInventory(): LegacyMutationOwner[] {
    const owners: LegacyMutationOwner[] = [];
    for (const run of this.#all(
      "SELECT id,repository_id,state FROM orchestration_runs WHERE state IN ('ACTIVE','CANCEL_REQUESTED') ORDER BY id",
      z.object({ id: z.string(), repository_id: z.string(), state: z.string() })
    )) {
      owners.push({
        key: `run:${run.id}`,
        runId: run.id,
        repositoryId: run.repository_id,
        kind: 'run'
      });
    }
    const sources = [
      ['write_leases', 'lease_id', 'lease_json', 'lease'],
      ['agent_execution_attempts', 'attempt_id', 'attempt_json', 'builder'],
      ['task_repair_attempts', 'attempt_id', 'attempt_json', 'repair']
    ] as const;
    for (const [table, keyColumn, jsonColumn, kind] of sources) {
      for (const row of this.#all(
        `SELECT x.run_id,x.${keyColumn} AS key,x.${jsonColumn} AS payload,r.repository_id
         FROM ${table} x JOIN orchestration_runs r ON r.id=x.run_id ORDER BY x.run_id,x.${keyColumn}`,
        z.object({
          run_id: z.string(),
          key: z.string(),
          payload: z.string(),
          repository_id: z.string()
        })
      )) {
        const value = parsed(
          row.payload,
          z.object({ state: z.string(), resource: writableResourceSchema.optional() })
        );
        if (!['ACTIVE', 'STARTING', 'RUNNING', 'UNKNOWN', 'STALE'].includes(value.state)) {
          continue;
        }
        owners.push({
          key: `${kind}:${row.run_id}:${row.key}`,
          runId: row.run_id,
          repositoryId: row.repository_id,
          kind,
          ...(value.resource === undefined
            ? {}
            : { resource: writableResourceSchema.parse(value.resource) })
        });
      }
    }
    for (const row of this.#all(
      `SELECT c.run_id,c.task_id,r.repository_id FROM task_integration_claims c
       JOIN orchestration_runs r ON r.id=c.run_id ORDER BY c.run_id,c.task_id`,
      z.object({ run_id: z.string(), task_id: z.string(), repository_id: z.string() })
    )) {
      owners.push({
        key: `integration:${row.run_id}:${row.task_id}`,
        runId: row.run_id,
        repositoryId: row.repository_id,
        kind: 'integration'
      });
    }
    return owners;
  }
  async beginLegacyCutover(): Promise<void> {
    this.#transaction(() => {
      if (this.#cutoverState() !== 'LEGACY_ALLOWED') {
        throw new Error('Legacy cutover already began');
      }
      this.#db.prepare("UPDATE forge_global_control SET state='LEGACY_CUTOVER' WHERE id=1").run();
      for (const owner of this.#legacyInventory()) {
        this.#db
          .prepare('INSERT INTO forge_global_legacy_owners (key,owner_json) VALUES (?,?)')
          .run(owner.key, JSON.stringify(owner));
      }
    });
  }
  async recoverLegacyOwners(): Promise<readonly LegacyMutationOwner[]> {
    return this.#all(
      'SELECT key,owner_json,disposition FROM forge_global_legacy_owners ORDER BY key',
      legacyRowSchema
    ).map((row) => parsed(row.owner_json, legacyOwnerSchema));
  }
  async settleLegacyOwner(key: string, quiescenceEvidence: string): Promise<void> {
    nonempty(quiescenceEvidence, 'Quiescence evidence');
    this.#transaction(() => {
      const row = this.#one(
        'SELECT * FROM forge_global_legacy_owners WHERE key=?',
        legacyRowSchema,
        key
      );
      if (row === undefined || row.disposition !== null) {
        throw new Error('Legacy owner is not unresolved');
      }
      this.#db
        .prepare(
          "UPDATE forge_global_legacy_owners SET disposition='SETTLED',evidence=? WHERE key=?"
        )
        .run(quiescenceEvidence, key);
    });
  }
  async importLegacyOwner(
    key: string,
    scopeId: string,
    requested?: WritableResource
  ): Promise<void> {
    this.#transaction(() => {
      this.#scope(scopeId);
      const row = this.#one(
        'SELECT * FROM forge_global_legacy_owners WHERE key=?',
        legacyRowSchema,
        key
      );
      if (row === undefined || row.disposition !== null) {
        throw new Error('Legacy owner is not unresolved');
      }
      const owner = parsed(row.owner_json, legacyOwnerSchema);
      const historicalRun = this.#one(
        'SELECT repository_id FROM orchestration_runs WHERE id=?',
        z.object({ repository_id: z.string() }),
        owner.runId
      );
      if (historicalRun?.repository_id !== owner.repositoryId) {
        throw new Error('Historical owner repository identity no longer matches its run');
      }
      const known = this.#one(
        'SELECT scope_id FROM forge_global_aliases WHERE repository_id=?',
        scopeRow,
        owner.repositoryId
      );
      if (known !== undefined && known.scope_id !== scopeId) {
        throw new Error('Legacy alias scope conflict');
      }
      if (known === undefined) {
        this.#db
          .prepare('INSERT INTO forge_global_aliases (repository_id,scope_id) VALUES (?,?)')
          .run(owner.repositoryId, scopeId);
      }
      const binding = this.#one(
        'SELECT repository_id,scope_id FROM forge_global_run_bindings WHERE run_id=?',
        z.object({ repository_id: z.string(), scope_id: z.string() }),
        owner.runId
      );
      if (
        binding !== undefined &&
        (binding.repository_id !== owner.repositoryId || binding.scope_id !== scopeId)
      ) {
        throw new Error('Historical run scope binding conflict');
      }
      if (binding === undefined) {
        this.#db
          .prepare('INSERT INTO forge_global_run_bindings VALUES (?,?,?)')
          .run(owner.runId, owner.repositoryId, scopeId);
      }
      const leaseResource =
        owner.resource === undefined
          ? { type: 'repository' as const }
          : requested === undefined
            ? owner.resource
            : writableResourceSchema.parse(requested);
      if (
        owner.resource !== undefined &&
        !isWritableResourceCoveredBy(leaseResource, owner.resource)
      ) {
        throw new Error('Imported authority cannot be narrower than historical evidence');
      }
      const token = this.#nextToken();
      const claimId = `legacy:${key}`;
      const importedOwner: GlobalMutationOwner = {
        runId: owner.runId,
        taskId: 'legacy',
        attemptId: key,
        agentId: 'legacy'
      };
      this.#db
        .prepare('INSERT INTO forge_global_claims VALUES (?,?,?,?,?,?,?)')
        .run(
          scopeId,
          claimId,
          JSON.stringify(importedOwner),
          token,
          'HELD_UNCERTAIN',
          1,
          'Historical owner imported during global cutover'
        );
      this.#db
        .prepare('INSERT INTO forge_global_leases VALUES (?,?,?,?)')
        .run(scopeId, claimId, randomUUID(), JSON.stringify(leaseResource));
      this.#db
        .prepare(
          "UPDATE forge_global_legacy_owners SET disposition='IMPORTED',evidence=? WHERE key=?"
        )
        .run(scopeId, key);
    });
  }
  async completeLegacyCutover(verifiedOldWriterShutdownEvidence: string): Promise<void> {
    nonempty(verifiedOldWriterShutdownEvidence, 'Old writer shutdown evidence');
    this.#transaction(() => {
      if (this.#cutoverState() !== 'LEGACY_CUTOVER') {
        throw new Error('Legacy cutover not in progress');
      }
      const unresolved = this.#one(
        'SELECT count(*) AS count FROM forge_global_legacy_owners WHERE disposition IS NULL',
        countRow
      );
      if ((unresolved?.count ?? 0) !== 0) {
        throw new Error('Historical legacy owners remain unresolved');
      }
      this.#db.prepare("UPDATE forge_global_control SET state='GLOBAL_READY' WHERE id=1").run();
      this.#db
        .prepare('INSERT INTO forge_global_audit VALUES (?,?,?,?)')
        .run(
          randomUUID(),
          'complete-legacy-cutover',
          'deployment',
          verifiedOldWriterShutdownEvidence
        );
    });
  }
  async activateScope(scopeId: string): Promise<void> {
    this.#transaction(() => {
      if (this.#cutoverState() !== 'GLOBAL_READY') {
        throw new Error('Deployment is not globally ready');
      }
      this.#scope(scopeId);
      this.#db
        .prepare("UPDATE forge_global_scopes SET state='ACTIVE_FOR_GLOBAL_CLAIMS' WHERE id=?")
        .run(scopeId);
    });
  }

  #authorizedAttempt(
    owner: GlobalMutationOwner,
    tasksJson: string,
    retry: boolean
  ): AuthorizedAttempt {
    const tasks = parsed(tasksJson, z.array(taskContractSchema));
    if (!tasks.some((task) => task.id === owner.taskId)) {
      throw new Error('Global mutation owner task is not in the approved run');
    }
    const rowSchema = z.object({ attempt_json: z.string() });
    const builder = this.#one(
      'SELECT attempt_json FROM agent_execution_attempts WHERE run_id=? AND attempt_id=?',
      rowSchema,
      owner.runId,
      owner.attemptId
    );
    const repair = this.#one(
      'SELECT attempt_json FROM task_repair_attempts WHERE run_id=? AND attempt_id=?',
      rowSchema,
      owner.runId,
      owner.attemptId
    );
    if ((builder === undefined) === (repair === undefined)) {
      throw new Error('Global mutation owner needs one unambiguous persisted attempt');
    }
    const valid = (attempt: {
      runId: string;
      taskId: string;
      id: string;
      agentId: string;
      workspaceId: string;
      state: string;
    }): void => {
      if (
        attempt.runId !== owner.runId ||
        attempt.taskId !== owner.taskId ||
        attempt.id !== owner.attemptId ||
        attempt.agentId !== owner.agentId ||
        (owner.workspaceId !== undefined && attempt.workspaceId !== owner.workspaceId)
      ) {
        throw new Error('Global mutation owner does not match the persisted attempt');
      }
      if (
        retry
          ? attempt.state !== 'STARTING' && attempt.state !== 'RUNNING'
          : attempt.state !== 'PREPARING'
      ) {
        throw new Error('Attempt lifecycle does not authorize global mutation admission');
      }
    };
    const binding = this.#one(
      'SELECT binding_json FROM task_execution_bindings WHERE run_id=? AND task_id=?',
      z.object({ binding_json: z.string() }),
      owner.runId,
      owner.taskId
    );
    if (binding === undefined) {
      throw new Error('Mutation attempt has no approved task execution binding');
    }
    const approvedBinding = parsed(binding.binding_json, persistedTaskExecutionBindingSchema);
    if (approvedBinding.runId !== owner.runId || approvedBinding.taskId !== owner.taskId) {
      throw new Error('Mutation attempt does not match its approved task binding');
    }
    if (builder !== undefined) {
      const attempt = parsedAttempt(builder.attempt_json, agentExecutionAttemptSchema);
      valid(attempt);
      if (
        approvedBinding.agentId !== owner.agentId ||
        approvedBinding.workspace.id !== attempt.workspaceId ||
        taskLeasePlanFingerprint(approvedBinding.leasePlan) !== attempt.leasePlanFingerprint
      ) {
        throw new Error('Builder attempt does not match its approved task binding');
      }
      return {
        kind: 'builder',
        attempt,
        previousJson: builder.attempt_json,
        approvedResources: approvedBinding.leasePlan.predictedResources
      };
    }
    if (repair === undefined) {
      throw new Error('Missing persisted repair attempt');
    }
    const attempt = parsedAttempt(repair.attempt_json, taskRepairAttemptSchema);
    valid(attempt);
    const workItem = this.#one(
      'SELECT item_json FROM task_repair_work_items WHERE run_id=? AND repair_attempt_id=?',
      z.object({ item_json: z.string() }),
      owner.runId,
      owner.attemptId
    );
    if (workItem === undefined) {
      throw new Error('Repair attempt has no admitted work item');
    }
    const approved = parsed(workItem.item_json, taskRepairWorkItemSchema);
    if (
      approved.runId !== owner.runId ||
      approved.taskId !== owner.taskId ||
      approved.repairAttemptId !== owner.attemptId ||
      approved.workspaceId !== attempt.workspaceId ||
      approved.parentReviewIteration !== attempt.parentReviewIteration ||
      approved.builderAttemptId !== attempt.parentReviewSubject.builderAttemptId ||
      approved.leasePlanFingerprint !== taskLeasePlanFingerprint(approvedBinding.leasePlan)
    ) {
      throw new Error('Repair attempt does not match its admitted work item');
    }
    return {
      kind: 'repair',
      attempt,
      previousJson: repair.attempt_json,
      approvedResources: approvedBinding.leasePlan.predictedResources
    };
  }

  #assertResourcesAuthorized(
    approvedResources: readonly WritableResource[],
    requestedResources: readonly WritableResource[]
  ): void {
    if (
      requestedResources.some(
        (requested) =>
          !approvedResources.some((approved) => isWritableResourceCoveredBy(approved, requested))
      )
    ) {
      throw new Error('Global claim resource exceeds the approved lease plan');
    }
  }

  #startAttempt(admitted: AuthorizedAttempt): void {
    const started = {
      ...admitted.attempt,
      state: 'STARTING' as const,
      revision: admitted.attempt.revision + 1,
      startedAt: new Date()
    };
    if (admitted.kind === 'builder') {
      agentExecutionAttemptSchema.parse(started);
      this.#db
        .prepare(
          'UPDATE agent_execution_attempts SET attempt_json=? WHERE run_id=? AND attempt_id=?'
        )
        .run(JSON.stringify(started), started.runId, started.id);
      return;
    }
    taskRepairAttemptSchema.parse(started);
    this.#db
      .prepare(
        `INSERT INTO task_repair_attempt_history
         (run_id,attempt_id,revision,attempt_json,recorded_at) VALUES (?,?,?,?,?)`
      )
      .run(
        admitted.attempt.runId,
        admitted.attempt.id,
        admitted.attempt.revision,
        admitted.previousJson,
        new Date().toISOString()
      );
    this.#db
      .prepare('UPDATE task_repair_attempts SET attempt_json=? WHERE run_id=? AND attempt_id=?')
      .run(JSON.stringify(started), started.runId, started.id);
  }

  async claimGlobalMutation(claim: GlobalMutationClaim): Promise<GlobalMutationClaimResult> {
    return this.#transaction(() => {
      if (
        this.#cutoverState() !== 'GLOBAL_READY' ||
        this.#scope(claim.scopeId) !== 'ACTIVE_FOR_GLOBAL_CLAIMS'
      ) {
        throw new Error('Global mutation claims are not active');
      }
      const run = this.#one(
        `SELECT b.scope_id,r.state,r.tasks_json FROM forge_global_run_bindings b
         JOIN orchestration_runs r ON r.id=b.run_id WHERE b.run_id=?`,
        z.object({ scope_id: z.string(), state: z.string(), tasks_json: z.string() }),
        claim.owner.runId
      );
      if (run?.scope_id !== claim.scopeId || run.state !== 'ACTIVE') {
        throw new Error('Claim run is not active in the approved repository scope');
      }
      nonempty(claim.claimId, 'Claim ID');
      if (claim.resources.length === 0) {
        throw new Error('A global claim needs resources');
      }
      const resources = canonicalTaskLeaseResources(
        claim.resources.map((value) => writableResourceSchema.parse(value))
      );
      if (new Set(resources.map(resourceKey)).size !== resources.length) {
        throw new Error('Duplicate claim resource');
      }
      const old = this.#one(
        'SELECT * FROM forge_global_claims WHERE scope_id=? AND claim_id=?',
        claimRowSchema,
        claim.scopeId,
        claim.claimId
      );
      if (old !== undefined) {
        const admitted = this.#authorizedAttempt(claim.owner, run.tasks_json, true);
        this.#assertResourcesAuthorized(admitted.approvedResources, resources);
        const previous = this.#leases(claim.scopeId, claim.claimId);
        if (
          old.state !== 'ACTIVE' ||
          !same(parsed(old.owner_json, ownerSchema), claim.owner) ||
          !same(
            previous.map((lease) => resourceKey(lease.resource)).toSorted(),
            resources.map(resourceKey).toSorted()
          )
        ) {
          throw new Error('Claim ID replay conflicts with durable authority');
        }
        return { status: 'granted', token: old.token, leases: previous };
      }
      const admitted = this.#authorizedAttempt(claim.owner, run.tasks_json, false);
      this.#assertResourcesAuthorized(admitted.approvedResources, resources);
      const blockers = this.#leases(claim.scopeId).filter(
        (lease) =>
          lease.state !== 'RELEASED' &&
          resources.some((value) => areWritableResourcesConflicting(lease.resource, value))
      );
      if (blockers.length > 0) {
        return { status: 'blocked', blockers };
      }
      const token = this.#nextToken();
      this.#db
        .prepare('INSERT INTO forge_global_claims VALUES (?,?,?,?,?,?,?)')
        .run(claim.scopeId, claim.claimId, JSON.stringify(claim.owner), token, 'ACTIVE', 1, null);
      for (const value of resources) {
        this.#db
          .prepare('INSERT INTO forge_global_leases VALUES (?,?,?,?)')
          .run(claim.scopeId, claim.claimId, randomUUID(), JSON.stringify(value));
      }
      this.#startAttempt(admitted);
      return { status: 'granted', token, leases: this.#leases(claim.scopeId, claim.claimId) };
    });
  }
  async recoverRepositoryMutationAuthority(
    scopeId: string
  ): Promise<readonly GlobalMutationLease[]> {
    this.#scope(scopeId);
    return this.#leases(scopeId);
  }
  async recoverFencedMutationPermits(
    scopeId: string,
    claimId?: string
  ): Promise<readonly PersistedFencedMutationPermit[]> {
    this.#scope(scopeId);
    return this.#all(
      `SELECT * FROM forge_global_permits WHERE scope_id=? ${claimId === undefined ? '' : 'AND claim_id=?'} ORDER BY id`,
      permitRowSchema,
      ...(claimId === undefined ? [scopeId] : [scopeId, claimId])
    ).map((row) => ({
      id: row.id,
      scopeId: row.scope_id,
      claimId: row.claim_id,
      owner: parsed(row.owner_json, ownerSchema),
      token: row.token,
      resource: resource(row.resource_json)
    }));
  }
  #assertCurrent(request: CurrentMutationTokenRequest): void {
    const claim = this.#claim(request.scopeId, request.claimId);
    if (
      claim.state !== 'ACTIVE' ||
      claim.token !== request.token ||
      !same(parsed(claim.owner_json, ownerSchema), request.owner) ||
      !this.#leases(request.scopeId, request.claimId).some((lease) =>
        isWritableResourceCoveredBy(lease.resource, request.resource)
      )
    ) {
      throw new Error('Stale or uncovered global mutation token');
    }
  }
  async assertCurrentMutationToken(request: CurrentMutationTokenRequest): Promise<void> {
    this.#assertCurrent(request);
  }
  async beginFencedMutation(
    request: CurrentMutationTokenRequest
  ): Promise<FencedMutationExecutionPermit> {
    return this.#transaction(() => {
      this.#assertCurrent(request);
      const permit = { id: randomUUID(), completionSecret: randomBytes(32).toString('hex') };
      this.#db
        .prepare('INSERT INTO forge_global_permits VALUES (?,?,?,?,?,?,?)')
        .run(
          permit.id,
          request.scopeId,
          request.claimId,
          JSON.stringify(request.owner),
          request.token,
          JSON.stringify(request.resource),
          secretVerifier(permit.completionSecret).toString('hex')
        );
      return permit;
    });
  }
  async endFencedMutation(permit: FencedMutationExecutionPermit): Promise<void> {
    this.#transaction(() => {
      const row = this.#one(
        'SELECT * FROM forge_global_permits WHERE id=?',
        permitRowSchema,
        permit.id
      );
      const supplied = secretVerifier(permit.completionSecret);
      if (row === undefined || !timingSafeEqual(Buffer.from(row.verifier, 'hex'), supplied)) {
        throw new Error('Invalid fenced mutation completion capability');
      }
      this.#db.prepare('DELETE FROM forge_global_permits WHERE id=?').run(permit.id);
    });
  }
  async settleOrphanedFencedMutation(
    permit: PersistedFencedMutationPermit,
    verifiedQuiescenceEvidence: string
  ): Promise<void> {
    nonempty(verifiedQuiescenceEvidence, 'Quiescence evidence');
    this.#transaction(() => {
      const row = this.#one(
        'SELECT * FROM forge_global_permits WHERE id=?',
        permitRowSchema,
        permit.id
      );
      if (
        row === undefined ||
        row.scope_id !== permit.scopeId ||
        row.claim_id !== permit.claimId ||
        row.token !== permit.token ||
        !same(parsed(row.owner_json, ownerSchema), permit.owner) ||
        !same(resource(row.resource_json), permit.resource) ||
        this.#claim(row.scope_id, row.claim_id).state !== 'HELD_UNCERTAIN'
      ) {
        throw new Error('Orphan permit is not eligible for settlement');
      }
      this.#db.prepare('DELETE FROM forge_global_permits WHERE id=?').run(permit.id);
      this.#db
        .prepare('INSERT INTO forge_global_audit VALUES (?,?,?,?)')
        .run(randomUUID(), 'settle-orphaned-permit', permit.id, verifiedQuiescenceEvidence);
    });
  }
  #assertClaimOwner(row: ClaimRow, owner: GlobalMutationOwner, token: number): void {
    if (row.token !== token || !same(parsed(row.owner_json, ownerSchema), owner)) {
      throw new Error('Global mutation owner or token mismatch');
    }
  }
  #assertNoPermits(scopeId: string, claimId: string): void {
    const row = this.#one(
      'SELECT count(*) AS count FROM forge_global_permits WHERE scope_id=? AND claim_id=?',
      countRow,
      scopeId,
      claimId
    );
    if ((row?.count ?? 0) !== 0) {
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
    nonempty(request.stopEvidence, 'Stop evidence');
    this.#transaction(() => {
      const row = this.#claim(request.scopeId, request.claimId);
      this.#assertClaimOwner(row, request.owner, request.token);
      if (row.state !== 'ACTIVE' || row.version !== request.expectedVersion) {
        throw new Error('Invalid active claim release');
      }
      this.#assertNoPermits(request.scopeId, request.claimId);
      this.#db
        .prepare(
          "UPDATE forge_global_claims SET state='RELEASED',version=version+1,evidence=? WHERE scope_id=? AND claim_id=?"
        )
        .run(request.stopEvidence, request.scopeId, request.claimId);
    });
  }
  async markMutationUncertain(request: {
    scopeId: string;
    claimId: string;
    owner: GlobalMutationOwner;
    token: number;
    evidence: string;
  }): Promise<void> {
    nonempty(request.evidence, 'Uncertainty evidence');
    this.#transaction(() => {
      const row = this.#claim(request.scopeId, request.claimId);
      this.#assertClaimOwner(row, request.owner, request.token);
      if (row.state !== 'ACTIVE') {
        throw new Error('Only an active claim can become uncertain');
      }
      this.#db
        .prepare(
          "UPDATE forge_global_claims SET state='HELD_UNCERTAIN',version=version+1,evidence=? WHERE scope_id=? AND claim_id=?"
        )
        .run(request.evidence, request.scopeId, request.claimId);
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
    nonempty(request.verifiedQuiescenceEvidence, 'Quiescence evidence');
    this.#transaction(() => {
      const row = this.#claim(request.scopeId, request.claimId);
      this.#assertClaimOwner(row, request.owner, request.token);
      if (row.state !== 'HELD_UNCERTAIN' || row.version !== request.expectedVersion) {
        throw new Error('Invalid uncertain claim reclamation');
      }
      this.#assertNoPermits(request.scopeId, request.claimId);
      this.#db
        .prepare(
          "UPDATE forge_global_claims SET state='RELEASED',version=version+1,evidence=? WHERE scope_id=? AND claim_id=?"
        )
        .run(request.verifiedQuiescenceEvidence, request.scopeId, request.claimId);
    });
  }
}
