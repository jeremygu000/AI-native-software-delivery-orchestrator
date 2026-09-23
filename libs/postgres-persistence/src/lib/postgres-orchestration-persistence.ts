import postgres from 'postgres';
import type {
  ActiveMutationClaimPersistence,
  AgentExecutionAttempt,
  CancellationFinalizationResult,
  CancellationRequestResult,
  CancellationSettlementPersistence,
  CancellationSettlementResult,
  CreatePersistedRunRequest,
  IntegrationMutationClaimPersistence,
  OrchestrationPersistence,
  OrchestrationRunState,
  PersistedAgentExecutionAttempt,
  PersistedDispatch,
  PersistedReevaluation,
  PersistedRepairResumeDispatch,
  PersistedSchedulerDecision,
  PersistedTaskCodeReview,
  PersistedTaskConflict,
  PersistedTaskExecutionBinding,
  PersistedTaskImpact,
  PersistedTaskRepairAttempt,
  PersistedTaskWorkspace,
  PersistedWriteLease,
  RecoveredRun,
  Scheduler,
  TaskCodeReviewStore,
  TaskRepairAttempt,
  TaskRepairResumeStore,
  TaskRepairWorkItem,
  TaskRepairWorkItemAdmissionStore,
  TaskRepairWorkItemStore,
  TaskVerificationEvidence,
  TaskVerificationEvidenceStore,
  WriteLease
} from '@ai-native-software-delivery-orchestrator/domain';
import {
  assertTaskVerificationEvidenceIntegrity,
  agentExecutionAttemptSchema,
  persistedTaskExecutionBindingSchema,
  runAuthorityEvidenceSchema,
  scheduleOptionsSchema,
  taskCodeReviewSchema,
  taskCodeReviewSubjectSchema,
  taskConflictSchema,
  schedulerEventSchema,
  schedulerSnapshotSchema,
  schedulerTaskDecisionSchema,
  taskStateSchema,
  taskDecisionsWithTransitions,
  taskImpactSchema,
  taskRepairAttemptSchema,
  taskRepairWorkItemSchema,
  taskSpecificationSchema,
  taskVerificationEvidenceSchema,
  taskWorkspaceSchema,
  writeLeaseSchema
} from '@ai-native-software-delivery-orchestrator/domain';

import {
  assertPostgresEvidenceStoreConfiguration,
  type PostgresEvidenceStoreConfiguration
} from './postgres-evidence-store.js';
import { assertPostgresAuthoritySchema } from './postgres-authority-schema.js';

type Sql = ReturnType<typeof postgres>;
type TransactionSql = postgres.TransactionSql;
type Query = Sql | TransactionSql;
type RecordKind =
  | 'binding'
  | 'event'
  | 'decision'
  | 'transition'
  | 'conflict'
  | 'impact'
  | 'lease'
  | 'workspace'
  | 'builder'
  | 'repair'
  | 'repair-history'
  | 'repair-item'
  | 'repair-resume'
  | 'review'
  | 'verification'
  | 'integration'
  | 'integration-claim';

const encode = (value: unknown): string =>
  JSON.stringify(value, (_key, entry: unknown) =>
    entry instanceof Set ? { $set: [...entry] } : entry
  );
const decode = (value: string): unknown =>
  JSON.parse(value, (key: string, entry: unknown): unknown => {
    if (
      [
        'acquiredAt',
        'lastHeartbeatAt',
        'releasedAt',
        'staleDetectedAt',
        'startedAt',
        'completedAt'
      ].includes(key) &&
      typeof entry === 'string'
    ) {
      return new Date(entry);
    }
    if (
      typeof entry === 'object' &&
      entry !== null &&
      '$set' in entry &&
      Array.isArray(entry.$set)
    ) {
      return new Set(entry.$set);
    }
    return entry;
  });
const parsed = <T>(value: string, validate: (value: unknown) => T): T => validate(decode(value));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const objectValue = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new Error('Invalid persisted PostgreSQL record');
  }
  return value;
};
const runState = (value: unknown): OrchestrationRunState => {
  if (
    value === 'ACTIVE' ||
    value === 'CANCEL_REQUESTED' ||
    value === 'COMPLETED' ||
    value === 'FAILED' ||
    value === 'CANCELLED'
  ) {
    return value;
  }
  throw new Error('Invalid persisted PostgreSQL run state');
};
const text = (value: unknown): string => {
  if (typeof value !== 'string') {
    throw new Error('Invalid persisted PostgreSQL text');
  }
  return value;
};
const normalized = (entry: unknown): unknown => {
  if (entry instanceof Date) {
    return entry.toISOString();
  }
  if (entry instanceof Set) {
    return { $set: [...entry].toSorted((a, b) => String(a).localeCompare(String(b))) };
  }
  if (Array.isArray(entry)) {
    return entry.map(normalized);
  }
  if (entry !== null && typeof entry === 'object') {
    return Object.fromEntries(
      Object.entries(entry)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, normalized(item)])
    );
  }
  return entry;
};
const canonical = (value: unknown): string => JSON.stringify(normalized(value));

/** The run row is the serialization point for every same-run authority mutation. */
export class PostgresOrchestrationPersistence
  implements
    OrchestrationPersistence,
    ActiveMutationClaimPersistence,
    IntegrationMutationClaimPersistence,
    CancellationSettlementPersistence,
    TaskCodeReviewStore,
    TaskRepairWorkItemAdmissionStore,
    TaskRepairResumeStore,
    TaskRepairWorkItemStore,
    TaskVerificationEvidenceStore
{
  readonly #sql: Sql;
  readonly #schema: string;

  private constructor(configuration: PostgresEvidenceStoreConfiguration) {
    this.#schema = `"${configuration.schema}"`;
    this.#sql = postgres(configuration.connectionString, {
      connection: { application_name: 'forge-authority' },
      onnotice: () => undefined
    });
  }

  static async connect(
    configuration: PostgresEvidenceStoreConfiguration
  ): Promise<PostgresOrchestrationPersistence> {
    assertPostgresEvidenceStoreConfiguration(configuration);
    const store = new PostgresOrchestrationPersistence(configuration);
    try {
      await assertPostgresAuthoritySchema(store.#sql, configuration);
      return store;
    } catch (error) {
      await store.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.#sql.end({ timeout: 5 });
  }

  async #row(tx: Query, runId: string, kind: RecordKind, key: string): Promise<string | undefined> {
    const rows = await tx.unsafe(
      `select payload from ${this.#schema}.forge_records where run_id = $1 and kind = $2 and key = $3`,
      [runId, kind, key]
    );
    return rows.length === 0 ? undefined : text(rows[0]?.payload);
  }
  async #rows(
    tx: Query,
    runId: string,
    kind: RecordKind
  ): Promise<{ key: string; payload: string }[]> {
    const rows = await tx.unsafe(
      `select key, payload from ${this.#schema}.forge_records where run_id = $1 and kind = $2 order by key`,
      [runId, kind]
    );
    return rows.map((row) => ({ key: String(row.key), payload: String(row.payload) }));
  }
  async #put(
    tx: Query,
    runId: string,
    kind: RecordKind,
    key: string,
    value: unknown
  ): Promise<void> {
    await tx.unsafe(
      `insert into ${this.#schema}.forge_records (run_id,kind,key,payload) values ($1,$2,$3,$4)
      on conflict (run_id,kind,key) do update set payload=excluded.payload`,
      [runId, kind, key, encode(value)]
    );
  }
  async #insert(
    tx: Query,
    runId: string,
    kind: RecordKind,
    key: string,
    value: unknown
  ): Promise<void> {
    await tx.unsafe(
      `insert into ${this.#schema}.forge_records (run_id,kind,key,payload) values ($1,$2,$3,$4)`,
      [runId, kind, key, encode(value)]
    );
  }
  async #remove(tx: Query, runId: string, kind: RecordKind, key: string): Promise<void> {
    await tx.unsafe(
      `delete from ${this.#schema}.forge_records where run_id=$1 and kind=$2 and key=$3`,
      [runId, kind, key]
    );
  }
  async #locked<T>(
    runId: string,
    work: (tx: TransactionSql, state: OrchestrationRunState) => Promise<T>
  ): Promise<T> {
    const result = await this.#sql.begin(async (tx) => {
      const rows = await tx.unsafe(
        `select state from ${this.#schema}.forge_runs where id=$1 for update`,
        [runId]
      );
      if (rows.length !== 1) {
        throw new Error(`Unknown orchestration run: ${runId}`);
      }
      return { value: await work(tx, runState(rows[0]?.state)) };
    });
    return result.value;
  }
  #active(runId: string, state: OrchestrationRunState): void {
    if (state !== 'ACTIVE') {
      throw new Error(`Mutation claim requires ACTIVE run: ${runId}/${state}`);
    }
  }
  async #setState(tx: Query, runId: string, state: OrchestrationRunState): Promise<void> {
    await tx.unsafe(`update ${this.#schema}.forge_runs set state=$2 where id=$1`, [runId, state]);
  }

  async createRun(request: CreatePersistedRunRequest): Promise<void> {
    taskSpecificationSchema.parse({ tasks: request.tasks });
    scheduleOptionsSchema.parse(request.scheduleOptions);
    runAuthorityEvidenceSchema.parse(request.run.authority);
    if (
      request.tasks.length !== request.taskBindings.length ||
      new Set(request.tasks.map((task) => task.id)).size !==
        new Set(request.taskBindings.map((binding) => binding.taskId)).size ||
      request.tasks.some(
        (task) => !request.taskBindings.some((binding) => binding.taskId === task.id)
      )
    ) {
      throw new Error('Task bindings must match task set');
    }
    for (const binding of request.taskBindings) {
      persistedTaskExecutionBindingSchema.parse(binding);
      if (binding.runId !== request.run.id) {
        throw new Error('Task binding run mismatch');
      }
    }
    await this.#sql.begin(async (tx) => {
      await tx.unsafe(
        `insert into ${this.#schema}.forge_runs (id,state,payload) values ($1,$2,$3)`,
        [request.run.id, request.run.state, encode(request)]
      );
      for (const binding of request.taskBindings) {
        await this.#insert(tx, request.run.id, 'binding', binding.taskId, binding);
      }
    });
  }
  async recoverTaskBindings(runId: string): Promise<readonly PersistedTaskExecutionBinding[]> {
    return (await this.#rows(this.#sql, runId, 'binding')).map((row) => this.#binding(runId, row));
  }
  #binding(
    runId: string,
    row: { readonly key: string; readonly payload: string }
  ): PersistedTaskExecutionBinding {
    const binding = parsed(row.payload, (value) =>
      persistedTaskExecutionBindingSchema.parse(value)
    );
    if (binding.runId !== runId || binding.taskId !== row.key) {
      throw new Error('Persisted task binding row identity mismatch');
    }
    return binding;
  }
  async recoverTaskBinding(
    runId: string,
    taskId: string
  ): Promise<PersistedTaskExecutionBinding | undefined> {
    const payload = await this.#row(this.#sql, runId, 'binding', taskId);
    return payload === undefined ? undefined : this.#binding(runId, { key: taskId, payload });
  }

  async #reevaluate(tx: Query, record: PersistedReevaluation): Promise<boolean> {
    const runId = record.event.runId;
    const sequence = record.event.sequence;
    schedulerEventSchema.parse(record.event.event);
    schedulerSnapshotSchema.parse(record.decision.inputSnapshot);
    for (const decision of record.decision.decision.taskDecisions) {
      schedulerTaskDecisionSchema.parse(decision);
    }
    if (
      sequence < 1 ||
      !Number.isInteger(sequence) ||
      runId !== record.decision.runId ||
      sequence !== record.decision.sequence ||
      record.transitions.some(
        (transition) => transition.runId !== runId || transition.sequence !== sequence
      )
    ) {
      throw new Error('Invalid reevaluation identity');
    }
    const expected = taskDecisionsWithTransitions(record.decision.decision.taskDecisions).map(
      ({ taskId, fromState, toState }) => ({ taskId, fromState, toState })
    );
    const actual = record.transitions.map(({ taskId, fromState, toState }) => ({
      taskId,
      fromState,
      toState
    }));
    if (
      canonical(expected.toSorted((a, b) => a.taskId.localeCompare(b.taskId))) !==
      canonical(actual.toSorted((a, b) => a.taskId.localeCompare(b.taskId)))
    ) {
      throw new Error('Persisted transitions must match scheduler decision');
    }
    for (const conflict of record.runtimeConflicts ?? []) {
      this.#validateConflict(conflict);
      if (conflict.runId !== runId || conflict.effectiveFromSequence !== sequence) {
        throw new Error('Runtime conflict must become effective at reevaluation sequence');
      }
    }
    const previous = await this.#rows(tx, runId, 'event');
    if (sequence > previous.length + 1) {
      throw new Error('Scheduler event sequence gap');
    }
    const key = String(sequence).padStart(10, '0');
    const persisted = await this.#row(tx, runId, 'event', key);
    if (persisted !== undefined) {
      const old = await this.#row(tx, runId, 'decision', key);
      const transitions = await this.#rows(tx, runId, 'transition');
      const conflicts = await this.#rows(tx, runId, 'conflict');
      if (
        canonical(decode(persisted)) !== canonical(record.event) ||
        canonical(decode(old ?? 'null')) !== canonical(record.decision) ||
        canonical(
          transitions
            .filter((item) => item.key.startsWith(`${key}:`))
            .map((item) => decode(item.payload))
        ) !== canonical(record.transitions) ||
        canonical(
          conflicts
            .map((item) =>
              parsed(item.payload, (value): PersistedTaskConflict => {
                const row = objectValue(value);
                return {
                  runId: text(row.runId),
                  taskA: text(row.taskA),
                  taskB: text(row.taskB),
                  effectiveFromSequence:
                    row.effectiveFromSequence === undefined
                      ? undefined
                      : Number(row.effectiveFromSequence),
                  conflict: taskConflictSchema.parse(row.conflict)
                };
              })
            )
            .filter((item) => item.effectiveFromSequence === sequence)
        ) !== canonical(record.runtimeConflicts ?? [])
      ) {
        throw new Error('Scheduler event already recorded with different evidence');
      }
      return true;
    }
    if (sequence !== previous.length + 1) {
      throw new Error('Scheduler event sequence mismatch');
    }
    await this.#insert(tx, runId, 'event', key, record.event);
    for (const [ordinal, transition] of record.transitions.entries()) {
      await this.#insert(
        tx,
        runId,
        'transition',
        `${key}:${String(ordinal).padStart(6, '0')}`,
        transition
      );
    }
    await this.#insert(tx, runId, 'decision', key, record.decision);
    for (const conflict of record.runtimeConflicts ?? []) {
      await this.#conflict(tx, conflict);
    }
    return false;
  }
  async persistReevaluation(record: PersistedReevaluation): Promise<void> {
    await this.#locked(record.event.runId, async (tx) => {
      await this.#reevaluate(tx, record);
    });
  }
  async persistDispatch(dispatch: PersistedDispatch): Promise<void> {
    await this.#dispatch(dispatch, false);
  }
  async ensureInitialDispatch(dispatch: PersistedDispatch): Promise<void> {
    if (
      dispatch.reevaluation.event.sequence !== 1 ||
      dispatch.reevaluation.event.event.type !== 'run-started'
    ) {
      throw new Error('Initial dispatch must be sequence-one run-started authority');
    }
    await this.#dispatch(dispatch, true);
  }
  async #dispatch(dispatch: PersistedDispatch, initial: boolean): Promise<void> {
    const starts = dispatch.reevaluation.decision.decision.taskDecisions
      .filter((decision) => decision.action === 'start')
      .map((decision) => decision.taskId)
      .toSorted();
    if (
      canonical(starts) !==
        canonical(dispatch.attempts.map((item) => item.attempt.taskId).toSorted()) ||
      dispatch.attempts.some(
        (item) => item.attempt.state !== 'PREPARING' || item.attempt.revision !== 1
      )
    ) {
      throw new Error('Dispatch attempts must match scheduler starts');
    }
    await this.#locked(dispatch.reevaluation.event.runId, async (tx) => {
      const old = await this.#reevaluate(tx, dispatch.reevaluation);
      for (const attempt of dispatch.attempts) {
        if (initial && old) {
          const payload = await this.#row(tx, attempt.runId, 'builder', attempt.attempt.id);
          if (payload === undefined) {
            throw new Error(`Initial dispatch attempt authority is missing: ${attempt.attempt.id}`);
          }
          const recorded = parsed(payload, (value) => agentExecutionAttemptSchema.parse(value));
          const fields = [
            'id',
            'runId',
            'taskId',
            'agentId',
            'workspaceId',
            'leasePlanFingerprint',
            'commandPolicyFingerprint',
            'trustedCommandPath'
          ] as const;
          if (fields.some((field) => recorded[field] !== attempt.attempt[field])) {
            throw new Error('Initial dispatch attempt authority mismatch');
          }
        } else {
          await this.#builder(tx, attempt);
        }
      }
    });
  }
  async recoverDispatches(runId: string): Promise<readonly PersistedDispatch[]> {
    const run = await this.recoverRun(runId);
    if (run === undefined) {
      return [];
    }
    const dispatches: PersistedDispatch[] = [];
    for (const decision of run.decisions) {
      const tasks = decision.decision.taskDecisions
        .filter((item) => item.action === 'start')
        .map((item) => item.taskId);
      if (tasks.length === 0) {
        continue;
      }
      const attempts = run.attempts.filter(
        ({ attempt }) =>
          tasks.includes(attempt.taskId) && attempt.state === 'PREPARING' && attempt.revision === 1
      );
      const event = run.events.find((item) => item.sequence === decision.sequence);
      if (event !== undefined && attempts.length === tasks.length) {
        dispatches.push({ reevaluation: { event, decision, transitions: [] }, attempts });
      }
    }
    return dispatches;
  }

  async #revision(
    tx: Query,
    runId: string,
    kind: 'builder' | 'repair' | 'workspace' | 'lease',
    key: string,
    value: { revision?: number; version?: number },
    lineage?: readonly string[]
  ): Promise<void> {
    const payload = await this.#row(tx, runId, kind, key);
    if (payload !== undefined) {
      const stored = objectValue(decode(payload));
      const from = stored.revision ?? stored.version;
      const to = value.revision ?? value.version;
      if (typeof from !== 'number' || typeof to !== 'number' || to < from) {
        throw new Error(`${kind} revision regression rejected`);
      }
      if (
        lineage?.some((field) => canonical(stored[field]) !== canonical(objectValue(value)[field]))
      ) {
        throw new Error(`${kind} lineage cannot change`);
      }
      if (to === from) {
        if (canonical(stored) !== canonical(value)) {
          throw new Error(`${kind} revision already recorded with different evidence`);
        }
        return;
      }
      if (kind === 'repair') {
        await this.#insert(
          tx,
          runId,
          'repair-history',
          `${key}:${String(from).padStart(8, '0')}`,
          stored
        );
      }
    }
    await this.#put(tx, runId, kind, key, value);
  }
  async #builder(tx: Query, record: PersistedAgentExecutionAttempt): Promise<void> {
    if (record.runId !== record.attempt.runId) {
      throw new Error('Builder run identity mismatch');
    }
    agentExecutionAttemptSchema.parse(record.attempt);
    await this.#revision(tx, record.runId, 'builder', record.attempt.id, record.attempt);
  }
  async persistAttempt(record: PersistedAgentExecutionAttempt): Promise<void> {
    await this.#locked(record.runId, async (tx) => this.#builder(tx, record));
  }
  async persistRepairAttempt(record: PersistedTaskRepairAttempt): Promise<void> {
    await this.#locked(record.runId, async (tx) => this.#repair(tx, record));
  }
  async #repair(tx: Query, record: PersistedTaskRepairAttempt): Promise<void> {
    taskRepairAttemptSchema.parse(record.attempt);
    if (record.runId !== record.attempt.runId) {
      throw new Error('Repair run identity mismatch');
    }
    const fields = [
      'id',
      'runId',
      'taskId',
      'agentId',
      'workspaceId',
      'parentReviewIteration',
      'repairIteration',
      'parentReviewSubject'
    ];
    await this.#revision(tx, record.runId, 'repair', record.attempt.id, record.attempt, fields);
  }
  async claimBuilderStart(request: {
    readonly runId: string;
    readonly attempt: AgentExecutionAttempt;
    readonly leases: readonly WriteLease[];
  }): Promise<AgentExecutionAttempt> {
    return this.#locked(request.runId, async (tx, state) => {
      this.#active(request.runId, state);
      const before = await this.#row(tx, request.runId, 'builder', request.attempt.id);
      if (
        request.attempt.state !== 'STARTING' ||
        before === undefined ||
        parsed(before, (value) => agentExecutionAttemptSchema.parse(value)).state !== 'PREPARING' ||
        parsed(before, (value) => agentExecutionAttemptSchema.parse(value)).revision + 1 !==
          request.attempt.revision
      ) {
        throw new Error('Builder mutation claim is stale');
      }
      for (const lease of request.leases) {
        await this.#lease(tx, { runId: request.runId, lease });
      }
      await this.#builder(tx, { runId: request.runId, attempt: request.attempt });
      return request.attempt;
    });
  }
  async claimRepairStart(record: PersistedTaskRepairAttempt): Promise<TaskRepairAttempt> {
    return this.#locked(record.runId, async (tx, state) => {
      this.#active(record.runId, state);
      const before = await this.#row(tx, record.runId, 'repair', record.attempt.id);
      if (
        record.attempt.state !== 'STARTING' ||
        before === undefined ||
        parsed(before, (value) => taskRepairAttemptSchema.parse(value)).state !== 'PREPARING' ||
        parsed(before, (value) => taskRepairAttemptSchema.parse(value)).revision + 1 !==
          record.attempt.revision
      ) {
        throw new Error('Repair mutation claim is stale');
      }
      await this.#repair(tx, record);
      return record.attempt;
    });
  }
  async #lease(tx: Query, record: PersistedWriteLease): Promise<void> {
    writeLeaseSchema.parse(record.lease);
    if (record.runId !== record.lease.runId) {
      throw new Error('Lease run mismatch');
    }
    await this.#revision(tx, record.runId, 'lease', record.lease.id, record.lease);
  }
  async persistLease(record: PersistedWriteLease): Promise<void> {
    await this.#locked(record.runId, async (tx) => this.#lease(tx, record));
  }
  async recoverLeases(runId: string): Promise<readonly PersistedWriteLease[]> {
    return (await this.#rows(this.#sql, runId, 'lease')).map(({ payload }) => ({
      runId,
      lease: parsed(payload, (value) => writeLeaseSchema.parse(value))
    }));
  }

  async requestCancellation(runId: string): Promise<CancellationRequestResult> {
    return this.#locked(runId, async (tx, state) => {
      if (state === 'ACTIVE') {
        await this.#setState(tx, runId, 'CANCEL_REQUESTED');
        return { status: 'requested', state: 'CANCEL_REQUESTED' };
      }
      if (state === 'CANCEL_REQUESTED') {
        return { status: 'already-requested', state };
      }
      return { status: 'terminal', state };
    });
  }
  async finalizeCancellation(runId: string): Promise<CancellationFinalizationResult> {
    return this.#locked(runId, async (tx, state) => {
      if (state === 'CANCEL_REQUESTED') {
        await this.#setState(tx, runId, 'CANCELLED');
        return { status: 'cancelled', state: 'CANCELLED' };
      }
      return { status: 'not-requested', state };
    });
  }
  async updateRunState(runId: string, state: OrchestrationRunState): Promise<void> {
    await this.#locked(runId, async (tx, current) => {
      this.#active(runId, current);
      await this.#setState(tx, runId, state);
    });
  }

  async claimIntegrationStart(request: {
    readonly runId: string;
    readonly taskId: string;
    readonly workspaceId: string;
    readonly outputAttemptId: string;
  }): Promise<void> {
    await this.#locked(request.runId, async (tx, state) => {
      this.#active(request.runId, state);
      const key = request.taskId;
      const old = await this.#row(tx, request.runId, 'integration-claim', key);
      if (old !== undefined && canonical(decode(old)) !== canonical(request)) {
        throw new Error('Integration mutation claim authority mismatch');
      }
      if (old === undefined) {
        await this.#insert(tx, request.runId, 'integration-claim', key, request);
      }
    });
  }
  async releaseIntegrationClaim(request: {
    readonly runId: string;
    readonly taskId: string;
    readonly workspaceId: string;
    readonly outputAttemptId: string;
  }): Promise<void> {
    await this.#locked(request.runId, async (tx) => this.#removeExactClaim(tx, request));
  }
  async #removeExactClaim(
    tx: Query,
    request: {
      readonly runId: string;
      readonly taskId: string;
      readonly workspaceId: string;
      readonly outputAttemptId: string;
    }
  ): Promise<void> {
    const old = await this.#row(tx, request.runId, 'integration-claim', request.taskId);
    const { detail: _detail, ...identity } = request as typeof request & {
      readonly detail?: string;
    };
    if (old === undefined || canonical(decode(old)) !== canonical(identity)) {
      throw new Error('Integration mutation claim is missing or mismatched');
    }
    await this.#remove(tx, request.runId, 'integration-claim', request.taskId);
  }
  async settleIntegrationCancellation(request: {
    readonly runId: string;
    readonly taskId: string;
    readonly workspaceId: string;
    readonly outputAttemptId: string;
    readonly detail: string;
  }): Promise<void> {
    await this.#locked(request.runId, async (tx, state) => {
      if (state !== 'CANCEL_REQUESTED' || request.detail.trim().length === 0) {
        throw new Error('Cancellation settlement requires requested run and detail');
      }
      await this.#removeExactClaim(tx, request);
    });
  }
  async hasActiveIntegrationClaim(runId: string): Promise<boolean> {
    return (await this.#rows(this.#sql, runId, 'integration-claim')).length > 0;
  }

  async #settleUnknown(
    runId: string,
    attemptId: string,
    expectedRevision: number,
    detail: string,
    kind: 'builder' | 'repair'
  ): Promise<CancellationSettlementResult> {
    return this.#locked(runId, async (tx, state) => {
      if (state !== 'CANCEL_REQUESTED') {
        throw new Error('Cancellation settlement requires CANCEL_REQUESTED run');
      }
      const payload = await this.#row(tx, runId, kind, attemptId);
      if (payload === undefined) {
        throw new Error(`Unknown attempt: ${attemptId}`);
      }
      const attempt =
        kind === 'builder'
          ? parsed(payload, (value) => agentExecutionAttemptSchema.parse(value))
          : parsed(payload, (value) => taskRepairAttemptSchema.parse(value));
      if (attempt.state !== 'UNKNOWN') {
        return { status: 'not-unknown', state: attempt.state };
      }
      if (attempt.revision !== expectedRevision) {
        return { status: 'version-conflict', actualRevision: attempt.revision };
      }
      const cancelled = {
        ...attempt,
        state: 'CANCELLED' as const,
        revision: attempt.revision + 1,
        completedAt: new Date(),
        failure: { type: 'cancelled' as const, detail }
      };
      if (kind === 'builder') {
        await this.#builder(tx, { runId, attempt: agentExecutionAttemptSchema.parse(cancelled) });
      } else {
        await this.#repair(tx, { runId, attempt: taskRepairAttemptSchema.parse(cancelled) });
      }
      for (const row of await this.#rows(tx, runId, 'lease')) {
        const lease = parsed(row.payload, (value) => writeLeaseSchema.parse(value));
        if (
          lease.state === 'ACTIVE' &&
          lease.taskId === attempt.taskId &&
          lease.agentId === attempt.agentId
        ) {
          await this.#lease(tx, {
            runId,
            lease: {
              ...lease,
              state: 'RELEASED',
              version: lease.version + 1,
              releasedAt: new Date()
            }
          });
        }
      }
      return { status: 'settled', attemptId };
    });
  }
  async settleUnknownBuilderCancellation(request: {
    readonly runId: string;
    readonly attemptId: string;
    readonly expectedRevision: number;
    readonly detail: string;
  }): Promise<CancellationSettlementResult> {
    return this.#settleUnknown(
      request.runId,
      request.attemptId,
      request.expectedRevision,
      request.detail,
      'builder'
    );
  }
  async settleUnknownRepairCancellation(request: {
    readonly runId: string;
    readonly attemptId: string;
    readonly expectedRevision: number;
    readonly detail: string;
  }): Promise<CancellationSettlementResult> {
    return this.#settleUnknown(
      request.runId,
      request.attemptId,
      request.expectedRevision,
      request.detail,
      'repair'
    );
  }

  async admitRepairAttempt(request: {
    readonly attempt: TaskRepairAttempt;
    readonly maxRepairs: number;
  }): Promise<TaskRepairAttempt> {
    return this.#admit(request);
  }
  async admitRepairAttemptWithWorkItem(request: {
    readonly attempt: TaskRepairAttempt;
    readonly maxRepairs: number;
    readonly createWorkItem: (attempt: TaskRepairAttempt) => TaskRepairWorkItem;
  }): Promise<TaskRepairAttempt> {
    return this.#admit(request, request.createWorkItem);
  }
  async #admit(
    request: { readonly attempt: TaskRepairAttempt; readonly maxRepairs: number },
    createWorkItem?: (attempt: TaskRepairAttempt) => TaskRepairWorkItem
  ): Promise<TaskRepairAttempt> {
    taskRepairAttemptSchema.parse(request.attempt);
    if (!Number.isInteger(request.maxRepairs) || request.maxRepairs < 1) {
      throw new Error('Repair budget must be positive');
    }
    return this.#locked(request.attempt.runId, async (tx) => {
      const attempts = (await this.#rows(tx, request.attempt.runId, 'repair'))
        .map(({ payload }) => parsed(payload, (value) => taskRepairAttemptSchema.parse(value)))
        .filter((attempt) => attempt.taskId === request.attempt.taskId);
      const same = attempts.find(
        (attempt) =>
          attempt.parentReviewIteration === request.attempt.parentReviewIteration &&
          canonical(attempt.parentReviewSubject) === canonical(request.attempt.parentReviewSubject)
      );
      if (same === undefined && attempts.length >= request.maxRepairs) {
        throw new Error(`Repair budget exhausted for task: ${request.attempt.taskId}`);
      }
      const admitted = same ?? { ...request.attempt, repairIteration: attempts.length + 1 };
      if (same === undefined) {
        await this.#repair(tx, { runId: admitted.runId, attempt: admitted });
      }
      if (createWorkItem !== undefined) {
        const item = createWorkItem(admitted);
        taskRepairWorkItemSchema.parse(item);
        if (
          item.runId !== admitted.runId ||
          item.taskId !== admitted.taskId ||
          item.repairAttemptId !== admitted.id
        ) {
          throw new Error('Repair work item identity mismatch');
        }
        await this.#exact(tx, admitted.runId, 'repair-item', admitted.id, item);
      }
      return admitted;
    });
  }
  async #exact(
    tx: Query,
    runId: string,
    kind: RecordKind,
    key: string,
    value: unknown
  ): Promise<void> {
    const old = await this.#row(tx, runId, kind, key);
    if (old !== undefined) {
      if (canonical(decode(old)) !== canonical(value)) {
        throw new Error(`${kind} already recorded with different evidence`);
      }
      return;
    }
    await this.#insert(tx, runId, kind, key, value);
  }
  async persistRepairWorkItem(item: TaskRepairWorkItem): Promise<void> {
    taskRepairWorkItemSchema.parse(item);
    await this.#locked(item.runId, async (tx) =>
      this.#exact(tx, item.runId, 'repair-item', item.repairAttemptId, item)
    );
  }
  async recoverRepairWorkItems(runId: string): Promise<readonly TaskRepairWorkItem[]> {
    return (await this.#rows(this.#sql, runId, 'repair-item')).map(({ payload }) =>
      parsed(payload, (value) => taskRepairWorkItemSchema.parse(value))
    );
  }
  async recoverRepairAttempts(runId: string): Promise<readonly PersistedTaskRepairAttempt[]> {
    return (await this.#rows(this.#sql, runId, 'repair')).map(({ payload }) => ({
      runId,
      attempt: parsed(payload, (value) => taskRepairAttemptSchema.parse(value))
    }));
  }
  async recoverRepairAttemptHistory(runId: string): Promise<readonly PersistedTaskRepairAttempt[]> {
    return (await this.#rows(this.#sql, runId, 'repair-history')).map(({ payload }) => ({
      runId,
      attempt: parsed(payload, (value) => taskRepairAttemptSchema.parse(value))
    }));
  }
  async resumeRepairAttempt(request: {
    readonly runId: string;
    readonly attemptId: string;
    readonly expectedRevision: number;
    readonly dispatch?: {
      readonly taskId: string;
      readonly dispatchId: string;
      readonly authorizedAt: string;
    };
  }): Promise<
    | { readonly status: 'resumed'; readonly attempt: TaskRepairAttempt }
    | { readonly status: 'not-found' }
    | { readonly status: 'not-blocked'; readonly state: TaskRepairAttempt['state'] }
    | { readonly status: 'version-conflict'; readonly actualRevision: number }
    | { readonly status: 'lease-not-released'; readonly actualState: WriteLease['state'] }
  > {
    return this.#locked(request.runId, async (tx) => {
      const payload = await this.#row(tx, request.runId, 'repair', request.attemptId);
      if (payload === undefined) {
        return { status: 'not-found' as const };
      }
      const attempt = parsed(payload, (value) => taskRepairAttemptSchema.parse(value));
      if (attempt.revision !== request.expectedRevision) {
        return { status: 'version-conflict' as const, actualRevision: attempt.revision };
      }
      if (attempt.state !== 'BLOCKED') {
        return { status: 'not-blocked' as const, state: attempt.state };
      }
      if (attempt.blocker?.type === 'lease') {
        const row = await this.#row(tx, request.runId, 'lease', attempt.blocker.leaseId);
        const state =
          row === undefined
            ? 'ACTIVE'
            : parsed(row, (value) => writeLeaseSchema.parse(value)).state;
        if (state !== 'RELEASED' && state !== 'STALE') {
          return { status: 'lease-not-released' as const, actualState: state };
        }
      }
      const resumed = {
        ...attempt,
        state: 'PREPARING' as const,
        revision: attempt.revision + 1,
        blocker: undefined
      };
      await this.#repair(tx, { runId: request.runId, attempt: resumed });
      if (request.dispatch !== undefined) {
        await this.#insert(
          tx,
          request.runId,
          'repair-resume',
          `${request.attemptId}:${String(resumed.revision).padStart(8, '0')}`,
          {
            runId: request.runId,
            taskId: request.dispatch.taskId,
            repairAttemptId: request.attemptId,
            repairRevision: resumed.revision,
            dispatchId: request.dispatch.dispatchId,
            authorizedAt: request.dispatch.authorizedAt
          }
        );
      }
      return { status: 'resumed' as const, attempt: resumed };
    });
  }
  async persistRepairResumeDispatch(dispatch: PersistedRepairResumeDispatch): Promise<void> {
    await this.#locked(dispatch.runId, async (tx) =>
      this.#insert(
        tx,
        dispatch.runId,
        'repair-resume',
        `${dispatch.repairAttemptId}:${String(dispatch.repairRevision).padStart(8, '0')}`,
        dispatch
      )
    );
  }
  async recoverRepairResumeDispatches(
    runId: string
  ): Promise<readonly PersistedRepairResumeDispatch[]> {
    return (await this.#rows(this.#sql, runId, 'repair-resume'))
      .map(({ payload }) => {
        const row = objectValue(decode(payload));
        return {
          runId: text(row.runId),
          taskId: text(row.taskId),
          repairAttemptId: text(row.repairAttemptId),
          repairRevision: Number(row.repairRevision),
          dispatchId: text(row.dispatchId),
          authorizedAt: text(row.authorizedAt)
        };
      })
      .toSorted((a, b) => a.repairRevision - b.repairRevision);
  }

  async persistReview(record: PersistedTaskCodeReview): Promise<void> {
    if (record.subject === undefined || record.iteration < 1) {
      throw new Error('Review subject and positive iteration required');
    }
    taskCodeReviewSubjectSchema.parse(record.subject);
    taskCodeReviewSchema.parse(record.review);
    await this.#locked(record.runId, async (tx) =>
      this.#exact(
        tx,
        record.runId,
        'review',
        `${record.taskId}:${String(record.iteration).padStart(8, '0')}`,
        record
      )
    );
  }
  async recoverReviews(runId: string): Promise<readonly PersistedTaskCodeReview[]> {
    return (await this.#rows(this.#sql, runId, 'review')).map(({ payload }) =>
      parsed(payload, (value): PersistedTaskCodeReview => {
        const row = objectValue(value);
        return {
          runId: text(row.runId),
          taskId: text(row.taskId),
          iteration: Number(row.iteration),
          subject:
            row.subject === undefined ? undefined : taskCodeReviewSubjectSchema.parse(row.subject),
          review: taskCodeReviewSchema.parse(row.review)
        };
      })
    );
  }
  async persistVerificationEvidence(evidence: TaskVerificationEvidence): Promise<void> {
    taskVerificationEvidenceSchema.parse(evidence);
    assertTaskVerificationEvidenceIntegrity(evidence);
    await this.#locked(evidence.runId, async (tx) =>
      this.#exact(tx, evidence.runId, 'verification', evidence.attemptId, evidence)
    );
  }
  async recoverVerificationEvidence(runId: string): Promise<readonly TaskVerificationEvidence[]> {
    return (await this.#rows(this.#sql, runId, 'verification')).map(({ payload }) => {
      const evidence = parsed(payload, (value) => taskVerificationEvidenceSchema.parse(value));
      assertTaskVerificationEvidenceIntegrity(evidence);
      return evidence;
    });
  }

  async persistImpact(record: PersistedTaskImpact): Promise<void> {
    if (
      record.taskId !== record.impact.predicted.taskId ||
      (record.impact.observed !== undefined && record.taskId !== record.impact.observed.taskId)
    ) {
      throw new Error('Task impact key must match payload task ID');
    }
    taskImpactSchema.parse(record.impact);
    await this.#locked(record.runId, async (tx) =>
      this.#put(tx, record.runId, 'impact', record.taskId, record)
    );
  }
  async persistConflict(record: PersistedTaskConflict): Promise<void> {
    this.#validateConflict(record);
    await this.#locked(record.runId, async (tx) => this.#conflict(tx, record));
  }
  #validateConflict(record: PersistedTaskConflict): void {
    if (record.taskA !== record.conflict.taskA || record.taskB !== record.conflict.taskB) {
      throw new Error('Task conflict keys must match payload task IDs');
    }
    if (
      record.effectiveFromSequence !== undefined &&
      (!Number.isInteger(record.effectiveFromSequence) || record.effectiveFromSequence < 1)
    ) {
      throw new Error('Runtime conflict effective sequence must be positive');
    }
    taskConflictSchema.parse(record.conflict);
  }
  async #conflict(tx: Query, record: PersistedTaskConflict): Promise<void> {
    this.#validateConflict(record);
    const key = `${record.taskA}:${record.taskB}`;
    const old = await this.#row(tx, record.runId, 'conflict', key);
    if (
      old !== undefined &&
      objectValue(decode(old)).effectiveFromSequence !== undefined &&
      record.effectiveFromSequence !== undefined
    ) {
      return;
    }
    await this.#put(tx, record.runId, 'conflict', key, record);
  }
  async persistWorkspace(record: PersistedTaskWorkspace): Promise<void> {
    if (record.workspace.runId !== record.runId) {
      throw new Error('Workspace run ID must match persistence run ID');
    }
    taskWorkspaceSchema.parse(record.workspace);
    await this.#locked(record.runId, async (tx) =>
      this.#revision(tx, record.runId, 'workspace', record.workspace.id, record.workspace)
    );
  }
  async persistIntegration(
    runId: string,
    status: 'integrated' | 'blocked',
    outputAttemptId?: string
  ): Promise<void> {
    await this.#locked(runId, async (tx) =>
      this.#put(tx, runId, 'integration', 'current', {
        status,
        ...(outputAttemptId === undefined ? {} : { outputAttemptId })
      })
    );
  }
  async recoverIntegration(
    runId: string
  ): Promise<
    { readonly status: 'integrated' | 'blocked'; readonly outputAttemptId?: string } | undefined
  > {
    const payload = await this.#row(this.#sql, runId, 'integration', 'current');
    if (payload === undefined) {
      return undefined;
    }
    const row = objectValue(decode(payload));
    if (row.status !== 'integrated' && row.status !== 'blocked') {
      throw new Error('Invalid integration status');
    }
    return {
      status: row.status,
      outputAttemptId: row.outputAttemptId === undefined ? undefined : text(row.outputAttemptId)
    };
  }
  async recoverAttempts(runId: string): Promise<readonly PersistedAgentExecutionAttempt[]> {
    return (await this.#rows(this.#sql, runId, 'builder')).map(({ payload }) => ({
      runId,
      attempt: parsed(payload, (value) => agentExecutionAttemptSchema.parse(value))
    }));
  }
  async recoverRun(runId: string): Promise<RecoveredRun | undefined> {
    const result = await this.#sql.begin(
      'isolation level repeatable read read only',
      async (tx) => {
        const rows = await tx.unsafe(
          `select state,payload from ${this.#schema}.forge_runs where id=$1`,
          [runId]
        );
        if (rows.length === 0) {
          return { value: undefined };
        }
        const initial = objectValue(decode(text(rows[0]?.payload)));
        const run = objectValue(initial.run);
        const read = async <T>(kind: RecordKind, validate: (value: unknown) => T): Promise<T[]> =>
          (await this.#rows(tx, runId, kind)).map(({ payload }) => parsed(payload, validate));
        return {
          value: {
            run: {
              id: text(run.id),
              repositoryId: text(run.repositoryId),
              createdAt: text(run.createdAt),
              authority: runAuthorityEvidenceSchema.parse(run.authority),
              state: runState(rows[0]?.state)
            },
            tasks: taskSpecificationSchema.parse({ tasks: initial.tasks }).tasks,
            taskBindings: await (async () => {
              const tasks = taskSpecificationSchema.parse({ tasks: initial.tasks }).tasks;
              const bindings = (await this.#rows(tx, runId, 'binding')).map((row) =>
                this.#binding(runId, row)
              );
              if (
                bindings.length !== tasks.length ||
                tasks.some((task) => !bindings.some((binding) => binding.taskId === task.id))
              ) {
                throw new Error('Recovered task bindings must match recovered task set');
              }
              return bindings;
            })(),
            hardConflicts: taskConflictSchema
              .array()
              .parse(initial.hardConflicts)
              .filter((conflict) => conflict.severity === 'hard'),
            riskConflicts: taskConflictSchema
              .array()
              .parse(initial.riskConflicts)
              .filter((conflict) => conflict.severity !== 'hard'),
            scheduleOptions: scheduleOptionsSchema.parse(initial.scheduleOptions),
            events: await read('event', (value): RecoveredRun['events'][number] => {
              const row = objectValue(value);
              return {
                runId: text(row.runId),
                sequence: Number(row.sequence),
                occurredAt: text(row.occurredAt),
                event: schedulerEventSchema.parse(row.event)
              };
            }),
            decisions: await read('decision', (value): RecoveredRun['decisions'][number] => {
              const row = objectValue(value);
              const decision = objectValue(row.decision);
              return {
                runId: text(row.runId),
                sequence: Number(row.sequence),
                inputSnapshot: schedulerSnapshotSchema.parse(row.inputSnapshot),
                decision: {
                  taskDecisions: schedulerTaskDecisionSchema.array().parse(decision.taskDecisions)
                }
              };
            }),
            transitions: await read('transition', (value): RecoveredRun['transitions'][number] => {
              const row = objectValue(value);
              return {
                runId: text(row.runId),
                sequence: Number(row.sequence),
                taskId: text(row.taskId),
                fromState: taskStateSchema.parse(row.fromState),
                toState: taskStateSchema.parse(row.toState)
              };
            }),
            impacts: await read('impact', (value): PersistedTaskImpact => {
              const row = objectValue(value);
              return {
                runId: text(row.runId),
                taskId: text(row.taskId),
                impact: taskImpactSchema.parse(row.impact)
              };
            }),
            conflicts: await read('conflict', (value): PersistedTaskConflict => {
              const row = objectValue(value);
              return {
                runId: text(row.runId),
                taskA: text(row.taskA),
                taskB: text(row.taskB),
                effectiveFromSequence:
                  row.effectiveFromSequence === undefined
                    ? undefined
                    : Number(row.effectiveFromSequence),
                conflict: taskConflictSchema.parse(row.conflict)
              };
            }),
            leases: (await read('lease', (value) => writeLeaseSchema.parse(value))).map(
              (lease) => ({
                runId,
                lease
              })
            ),
            workspaces: (await read('workspace', (value) => taskWorkspaceSchema.parse(value))).map(
              (workspace) => ({ runId, workspace })
            ),
            attempts: (
              await read('builder', (value) => agentExecutionAttemptSchema.parse(value))
            ).map((attempt) => ({
              runId,
              attempt
            }))
          }
        };
      }
    );
    return result.value;
  }
  async replayRun(
    runId: string,
    scheduler: Scheduler
  ): Promise<readonly PersistedSchedulerDecision[]> {
    const run = await this.recoverRun(runId);
    if (run === undefined) {
      return [];
    }
    return run.events.map((event) => {
      const decision = run.decisions.find((item) => item.sequence === event.sequence);
      if (decision === undefined) {
        throw new Error('Persisted scheduler decision does not replay');
      }
      const actual = scheduler.reevaluate(
        event.event,
        decision.inputSnapshot,
        run.tasks,
        [
          ...run.hardConflicts,
          ...run.conflicts.flatMap((record) =>
            record.effectiveFromSequence !== undefined &&
            record.effectiveFromSequence <= event.sequence &&
            record.conflict.severity === 'hard'
              ? [record.conflict]
              : []
          )
        ],
        [
          ...run.riskConflicts,
          ...run.conflicts.flatMap((record) =>
            record.effectiveFromSequence !== undefined &&
            record.effectiveFromSequence <= event.sequence &&
            record.conflict.severity !== 'hard'
              ? [record.conflict]
              : []
          )
        ],
        run.scheduleOptions
      );
      if (
        canonical(actual) !== canonical(decision.decision) ||
        canonical(
          run.transitions
            .filter((item) => item.sequence === event.sequence)
            .map(({ taskId, fromState, toState }) => ({ taskId, fromState, toState }))
            .toSorted((a, b) => a.taskId.localeCompare(b.taskId))
        ) !==
          canonical(
            taskDecisionsWithTransitions(actual.taskDecisions)
              .map(({ taskId, fromState, toState }) => ({ taskId, fromState, toState }))
              .toSorted((a, b) => a.taskId.localeCompare(b.taskId))
          )
      ) {
        throw new Error('Persisted scheduler decision does not replay');
      }
      return decision;
    });
  }
}
