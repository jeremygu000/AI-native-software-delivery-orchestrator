import Database from 'better-sqlite3';
import { and, asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type {
  CreatePersistedRunRequest,
  OrchestrationPersistence,
  TaskCodeReviewStore,
  OrchestrationRunState,
  PersistedReevaluation,
  PersistedTaskConflict,
  PersistedTaskImpact,
  PersistedTaskCodeReview,
  PersistedWriteLease,
  PersistedTaskWorkspace,
  PersistedAgentExecutionAttempt,
  PersistedDispatch,
  RecoveredRun,
  PersistedSchedulerDecision,
  SchedulerDecision,
  SchedulerEvent,
  SchedulerSnapshot,
  Scheduler,
  TaskState,
  TaskConflict
} from '@ai-native-software-delivery-orchestrator/domain';
import {
  scheduleOptionsSchema,
  schedulerEventSchema,
  schedulerSnapshotSchema,
  schedulerTaskDecisionSchema,
  taskConflictSchema,
  taskImpactSchema,
  taskCodeReviewSchema,
  taskCodeReviewSubjectSchema,
  taskDecisionsWithTransitions,
  taskSpecificationSchema,
  taskContractSchema,
  taskStateSchema,
  writeLeaseSchema,
  taskWorkspaceSchema,
  agentExecutionAttemptSchema,
  runAuthorityEvidenceSchema
} from '@ai-native-software-delivery-orchestrator/domain';

const runs = sqliteTable('orchestration_runs', {
  id: text('id').primaryKey(),
  repositoryId: text('repository_id').notNull(),
  state: text('state').notNull(),
  createdAt: text('created_at').notNull(),
  authorityJson: text('authority_json'),
  tasksJson: text('tasks_json').notNull(),
  hardConflictsJson: text('hard_conflicts_json').notNull(),
  riskConflictsJson: text('risk_conflicts_json').notNull(),
  scheduleOptionsJson: text('schedule_options_json').notNull()
});

const schedulerEvents = sqliteTable('scheduler_events', {
  runId: text('run_id').notNull(),
  sequence: integer('sequence').notNull(),
  occurredAt: text('occurred_at').notNull(),
  eventJson: text('event_json').notNull()
});

const taskTransitions = sqliteTable('task_transitions', {
  runId: text('run_id').notNull(),
  sequence: integer('sequence').notNull(),
  ordinal: integer('ordinal').notNull(),
  taskId: text('task_id').notNull(),
  fromState: text('from_state').notNull(),
  toState: text('to_state').notNull()
});

const schedulerDecisions = sqliteTable('scheduler_decisions', {
  runId: text('run_id').notNull(),
  sequence: integer('sequence').notNull(),
  snapshotJson: text('snapshot_json').notNull(),
  decisionJson: text('decision_json').notNull()
});

const taskImpacts = sqliteTable('task_impacts', {
  runId: text('run_id').notNull(),
  taskId: text('task_id').notNull(),
  impactJson: text('impact_json').notNull()
});

const taskCodeReviews = sqliteTable('task_code_reviews', {
  runId: text('run_id').notNull(),
  taskId: text('task_id').notNull(),
  iteration: integer('iteration').notNull(),
  subjectJson: text('subject_json'),
  reviewJson: text('review_json').notNull()
});

const taskConflicts = sqliteTable('task_conflicts', {
  runId: text('run_id').notNull(),
  taskA: text('task_a').notNull(),
  taskB: text('task_b').notNull(),
  effectiveFromSequence: integer('effective_from_sequence'),
  conflictJson: text('conflict_json').notNull()
});

const writeLeases = sqliteTable('write_leases', {
  runId: text('run_id').notNull(),
  leaseId: text('lease_id').notNull(),
  leaseJson: text('lease_json').notNull()
});

const taskWorkspaces = sqliteTable('task_workspaces', {
  runId: text('run_id').notNull(),
  workspaceId: text('workspace_id').notNull(),
  workspaceJson: text('workspace_json').notNull()
});

const agentExecutionAttempts = sqliteTable('agent_execution_attempts', {
  runId: text('run_id').notNull(),
  attemptId: text('attempt_id').notNull(),
  attemptJson: text('attempt_json').notNull()
});

const jsonReplacer = (_key: string, value: unknown): unknown => {
  if (value instanceof Set) {
    return { $set: [...value] };
  }
  return value;
};

const jsonReviver = (key: string, value: unknown): unknown => {
  if (
    [
      'acquiredAt',
      'lastHeartbeatAt',
      'releasedAt',
      'staleDetectedAt',
      'startedAt',
      'completedAt'
    ].includes(key) &&
    typeof value === 'string'
  ) {
    return new Date(value);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value;
  }
  if ('$set' in value && Array.isArray(value.$set)) {
    return new Set(value.$set);
  }
  return value;
};

const stringify = (value: unknown): string => JSON.stringify(value, jsonReplacer);
const parse = (value: string, name: string): unknown => {
  try {
    return JSON.parse(value, jsonReviver) as unknown;
  } catch {
    throw new PersistenceInputError(`Invalid persisted ${name}`);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isRunState = (value: unknown): value is OrchestrationRunState =>
  value === 'ACTIVE' || value === 'COMPLETED' || value === 'FAILED' || value === 'CANCELLED';

const isTaskContracts = (value: unknown): value is RecoveredRun['tasks'] =>
  Array.isArray(value) && value.every((task) => taskContractSchema.safeParse(task).success);

const isTaskConflicts = (value: unknown): value is readonly TaskConflict[] =>
  Array.isArray(value) && value.every((conflict) => taskConflictSchema.safeParse(conflict).success);

const isScheduleOptions = (value: unknown): value is RecoveredRun['scheduleOptions'] =>
  scheduleOptionsSchema.safeParse(value).success;

const isRunAuthorityEvidence = (value: unknown): value is RecoveredRun['run']['authority'] =>
  runAuthorityEvidenceSchema.safeParse(value).success;

const isSchedulerSnapshot = (value: unknown): value is SchedulerSnapshot =>
  schedulerSnapshotSchema.safeParse(value).success;

const isSchedulerDecision = (value: unknown): value is SchedulerDecision =>
  isRecord(value) &&
  Array.isArray(value.taskDecisions) &&
  value.taskDecisions.every((decision) => schedulerTaskDecisionSchema.safeParse(decision).success);

const isTaskImpact = (value: unknown): value is PersistedTaskImpact['impact'] =>
  taskImpactSchema.safeParse(value).success;

const isTaskCodeReview = (value: unknown): value is PersistedTaskCodeReview['review'] =>
  taskCodeReviewSchema.safeParse(value).success;

const isTaskCodeReviewSubject = (value: unknown): value is PersistedTaskCodeReview['subject'] =>
  taskCodeReviewSubjectSchema.safeParse(value).success;

const isWriteLease = (value: unknown): value is PersistedWriteLease['lease'] =>
  writeLeaseSchema.safeParse(value).success;

const isTaskWorkspace = (value: unknown): value is PersistedTaskWorkspace['workspace'] =>
  taskWorkspaceSchema.safeParse(value).success;

const isAgentExecutionAttempt = (
  value: unknown
): value is PersistedAgentExecutionAttempt['attempt'] =>
  agentExecutionAttemptSchema.safeParse(value).success;

const canonicalize = (value: unknown): unknown => {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
};

// Events, snapshots, and decisions are schema-validated plain JSON-like structures without Sets.
// Callers use this only for schema-validated records without Set fields.
const canonicalPlainStringify = (value: unknown): string => stringify(canonicalize(value));

const canonicalEvidenceStringify = (
  value: SchedulerEvent | SchedulerSnapshot | SchedulerDecision
): string => canonicalPlainStringify(value);

const canonicalDecisionStringify = (decision: SchedulerDecision): string =>
  stringify(canonicalize(decision));

const canonicalTransitions = (
  transitions: readonly {
    readonly taskId: string;
    readonly fromState: string;
    readonly toState: string;
  }[]
): string =>
  stringify(
    transitions
      .map(({ taskId, fromState, toState }) => ({ taskId, fromState, toState }))
      .toSorted((a, b) => {
        const left = `${a.taskId}\u0000${a.fromState}\u0000${a.toState}`;
        const right = `${b.taskId}\u0000${b.fromState}\u0000${b.toState}`;
        return left < right ? -1 : left > right ? 1 : 0;
      })
  );

const canonicalRuntimeConflicts = (conflicts: readonly PersistedTaskConflict[]): string =>
  canonicalPlainStringify(
    conflicts
      .map(({ runId: _runId, ...conflict }) => conflict)
      .toSorted((left, right) => {
        const leftKey = `${left.taskA}\u0000${left.taskB}`;
        const rightKey = `${right.taskA}\u0000${right.taskB}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      })
  );

const decode = <T>(value: string, predicate: (parsed: unknown) => parsed is T, name: string): T => {
  const parsed = parse(value, name);
  if (!predicate(parsed)) {
    throw new PersistenceInputError(`Invalid persisted ${name}`);
  }
  return parsed;
};

export class PersistenceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PersistenceInputError';
  }
}

export class PersistenceReplayError extends Error {
  readonly runId: string;
  readonly sequence: number;

  constructor(runId: string, sequence: number) {
    super(`Persisted scheduler decision does not replay: ${runId} sequence ${sequence}`);
    this.name = 'PersistenceReplayError';
    this.runId = runId;
    this.sequence = sequence;
  }
}

export class DrizzleSqliteOrchestrationPersistence
  implements OrchestrationPersistence, TaskCodeReviewStore
{
  readonly #sqlite: Database.Database;
  readonly #db;
  #reevaluationTail: Promise<void> = Promise.resolve();

  constructor(filename = ':memory:') {
    this.#sqlite = new Database(filename);
    this.#db = drizzle(this.#sqlite);
    this.#sqlite.exec(`
      CREATE TABLE IF NOT EXISTS orchestration_runs (
        id TEXT PRIMARY KEY NOT NULL,
        repository_id TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        authority_json TEXT,
        tasks_json TEXT NOT NULL,
        hard_conflicts_json TEXT NOT NULL,
        risk_conflicts_json TEXT NOT NULL,
        schedule_options_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS scheduler_events (
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        occurred_at TEXT NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS task_transitions (
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        task_id TEXT NOT NULL,
        from_state TEXT NOT NULL,
        to_state TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence, ordinal)
      );
      CREATE TABLE IF NOT EXISTS scheduler_decisions (
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        decision_json TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS task_impacts (
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        impact_json TEXT NOT NULL,
        PRIMARY KEY (run_id, task_id)
      );
      CREATE TABLE IF NOT EXISTS task_code_reviews (
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        iteration INTEGER NOT NULL,
        subject_json TEXT,
        review_json TEXT NOT NULL,
        PRIMARY KEY (run_id, task_id, iteration)
      );
      CREATE TABLE IF NOT EXISTS task_conflicts (
        run_id TEXT NOT NULL,
        task_a TEXT NOT NULL,
        task_b TEXT NOT NULL,
        effective_from_sequence INTEGER,
        conflict_json TEXT NOT NULL,
        PRIMARY KEY (run_id, task_a, task_b)
      );
      CREATE TABLE IF NOT EXISTS write_leases (
        run_id TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        lease_json TEXT NOT NULL,
        PRIMARY KEY (run_id, lease_id)
      );
      CREATE TABLE IF NOT EXISTS task_workspaces (
        run_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        workspace_json TEXT NOT NULL,
        PRIMARY KEY (run_id, workspace_id)
      );
      CREATE TABLE IF NOT EXISTS agent_execution_attempts (
        run_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        attempt_json TEXT NOT NULL,
        PRIMARY KEY (run_id, attempt_id)
      );
    `);
    const runColumns = this.#sqlite.prepare('PRAGMA table_info(orchestration_runs)').all();
    if (
      !runColumns.some(
        (column) =>
          typeof column === 'object' &&
          column !== null &&
          'name' in column &&
          column.name === 'authority_json'
      )
    ) {
      this.#sqlite.exec('ALTER TABLE orchestration_runs ADD COLUMN authority_json TEXT');
    }
    const conflictColumns = this.#sqlite.prepare('PRAGMA table_info(task_conflicts)').all();
    if (
      !conflictColumns.some(
        (column) =>
          typeof column === 'object' &&
          column !== null &&
          'name' in column &&
          column.name === 'effective_from_sequence'
      )
    ) {
      this.#sqlite.exec('ALTER TABLE task_conflicts ADD COLUMN effective_from_sequence INTEGER');
    }
    const reviewColumns = this.#sqlite.prepare('PRAGMA table_info(task_code_reviews)').all();
    if (
      !reviewColumns.some(
        (column) =>
          typeof column === 'object' &&
          column !== null &&
          'name' in column &&
          column.name === 'subject_json'
      )
    ) {
      this.#sqlite.exec('ALTER TABLE task_code_reviews ADD COLUMN subject_json TEXT');
    }
  }

  async createRun(request: CreatePersistedRunRequest): Promise<void> {
    this.#assertRunId(request.run.id);
    taskSpecificationSchema.parse({ tasks: request.tasks });
    scheduleOptionsSchema.parse(request.scheduleOptions);
    runAuthorityEvidenceSchema.parse(request.run.authority);
    await this.#exclusiveReevaluation(() =>
      this.#sqlite.transaction(() => {
        this.#db
          .insert(runs)
          .values({
            id: request.run.id,
            repositoryId: request.run.repositoryId,
            state: request.run.state,
            createdAt: request.run.createdAt,
            authorityJson: stringify(request.run.authority),
            tasksJson: stringify(request.tasks),
            hardConflictsJson: stringify(request.hardConflicts),
            riskConflictsJson: stringify(request.riskConflicts),
            scheduleOptionsJson: stringify(request.scheduleOptions)
          })
          .run();
      })()
    );
  }

  async persistReevaluation(reevaluation: PersistedReevaluation): Promise<void> {
    this.#assertReevaluation(reevaluation);
    await this.#exclusiveReevaluation(() =>
      this.#sqlite.transaction(() => {
        this.#persistReevaluationInTransaction(reevaluation);
      })()
    );
  }

  async persistDispatch(dispatch: PersistedDispatch): Promise<void> {
    const { reevaluation, attempts } = dispatch;
    this.#assertReevaluation(reevaluation);
    for (const attempt of attempts) {
      this.#assertAttempt(attempt);
    }
    const startTaskIds = reevaluation.decision.decision.taskDecisions
      .filter((decision) => decision.action === 'start')
      .map((decision) => decision.taskId)
      .toSorted();
    const attemptTaskIds = attempts.map(({ attempt }) => attempt.taskId).toSorted();
    if (
      startTaskIds.length !== attemptTaskIds.length ||
      startTaskIds.some((taskId, index) => taskId !== attemptTaskIds[index]) ||
      attempts.some(({ attempt }) => attempt.state !== 'PREPARING' || attempt.revision !== 1)
    ) {
      throw new PersistenceInputError(
        'Dispatch attempts must exactly match scheduler starts as revision 1 PREPARING evidence'
      );
    }
    await this.#exclusiveReevaluation(() =>
      this.#sqlite.transaction(() => {
        this.#persistReevaluationInTransaction(reevaluation);
        for (const attempt of attempts) {
          this.#persistAttemptInTransaction(attempt);
        }
      })()
    );
  }

  #assertReevaluation(reevaluation: PersistedReevaluation): void {
    this.#assertSequence(reevaluation.event.sequence);
    schedulerEventSchema.parse(reevaluation.event.event);
    schedulerSnapshotSchema.parse(reevaluation.decision.inputSnapshot);
    for (const taskDecision of reevaluation.decision.decision.taskDecisions) {
      schedulerTaskDecisionSchema.parse(taskDecision);
    }
    const expectedTransitions = taskDecisionsWithTransitions(
      reevaluation.decision.decision.taskDecisions
    );
    if (
      canonicalTransitions(reevaluation.transitions) !== canonicalTransitions(expectedTransitions)
    ) {
      throw new PersistenceInputError('Persisted transitions must match the scheduler decision');
    }
    if (
      reevaluation.event.runId !== reevaluation.decision.runId ||
      reevaluation.event.sequence !== reevaluation.decision.sequence ||
      reevaluation.transitions.some(
        (transition) =>
          transition.runId !== reevaluation.event.runId ||
          transition.sequence !== reevaluation.event.sequence
      )
    ) {
      throw new PersistenceInputError('Reevaluation records must share a run ID and sequence');
    }
    for (const conflict of reevaluation.runtimeConflicts ?? []) {
      this.#assertConflict(conflict);
      if (
        conflict.runId !== reevaluation.event.runId ||
        conflict.effectiveFromSequence !== reevaluation.event.sequence
      ) {
        throw new PersistenceInputError(
          'Runtime conflict mutations must become effective at their reevaluation sequence'
        );
      }
    }
  }

  #persistReevaluationInTransaction(reevaluation: PersistedReevaluation): void {
    this.#assertRunExists(reevaluation.event.runId);
    const expectedSequence =
      this.#db
        .select({ sequence: schedulerEvents.sequence })
        .from(schedulerEvents)
        .where(eq(schedulerEvents.runId, reevaluation.event.runId))
        .all().length + 1;
    if (reevaluation.event.sequence > expectedSequence) {
      throw new PersistenceInputError(
        `Scheduler event sequence must be ${expectedSequence}: ${reevaluation.event.runId}`
      );
    }
    if (reevaluation.event.sequence < expectedSequence) {
      this.#assertIdempotentReevaluation(reevaluation);
      return;
    }
    this.#db
      .insert(schedulerEvents)
      .values({
        runId: reevaluation.event.runId,
        sequence: reevaluation.event.sequence,
        occurredAt: reevaluation.event.occurredAt,
        eventJson: stringify(reevaluation.event.event)
      })
      .run();
    for (const conflict of reevaluation.runtimeConflicts ?? []) {
      this.#persistConflictInTransaction(conflict);
    }
    for (const [ordinal, transition] of reevaluation.transitions.entries()) {
      this.#db
        .insert(taskTransitions)
        .values({
          runId: transition.runId,
          sequence: transition.sequence,
          ordinal,
          taskId: transition.taskId,
          fromState: transition.fromState,
          toState: transition.toState
        })
        .run();
    }
    this.#db
      .insert(schedulerDecisions)
      .values({
        runId: reevaluation.decision.runId,
        sequence: reevaluation.decision.sequence,
        snapshotJson: stringify(reevaluation.decision.inputSnapshot),
        decisionJson: stringify(reevaluation.decision.decision)
      })
      .run();
  }

  async persistImpact(record: PersistedTaskImpact): Promise<void> {
    this.#assertRunId(record.runId);
    if (
      record.taskId !== record.impact.predicted.taskId ||
      (record.impact.observed !== undefined && record.taskId !== record.impact.observed.taskId)
    ) {
      throw new PersistenceInputError('Task impact key must match payload task ID');
    }
    taskImpactSchema.parse(record.impact);
    this.#sqlite.transaction(() => {
      this.#assertRunExists(record.runId);
      this.#db
        .insert(taskImpacts)
        .values({
          runId: record.runId,
          taskId: record.taskId,
          impactJson: stringify(record.impact)
        })
        .onConflictDoUpdate({
          target: [taskImpacts.runId, taskImpacts.taskId],
          set: { impactJson: stringify(record.impact) }
        })
        .run();
    })();
  }

  async persistReview(record: PersistedTaskCodeReview): Promise<void> {
    this.#assertRunId(record.runId);
    if (
      record.taskId.trim().length === 0 ||
      !Number.isInteger(record.iteration) ||
      record.iteration < 1
    ) {
      throw new PersistenceInputError('Task code review requires a task ID and positive iteration');
    }
    taskCodeReviewSchema.parse(record.review);
    if (record.subject === undefined) {
      throw new PersistenceInputError('New task code review evidence requires a review subject');
    }
    taskCodeReviewSubjectSchema.parse(record.subject);
    this.#sqlite.transaction(() => {
      this.#assertRunExists(record.runId);
      const existing = this.#db
        .select()
        .from(taskCodeReviews)
        .where(
          and(
            eq(taskCodeReviews.runId, record.runId),
            eq(taskCodeReviews.taskId, record.taskId),
            eq(taskCodeReviews.iteration, record.iteration)
          )
        )
        .get();
      if (
        existing !== undefined &&
        (existing.subjectJson === null ||
          canonicalPlainStringify(
            decode(existing.reviewJson, isTaskCodeReview, 'task code review')
          ) !== canonicalPlainStringify(record.review) ||
          canonicalPlainStringify(
            decode(existing.subjectJson, isTaskCodeReviewSubject, 'task code review subject')
          ) !== canonicalPlainStringify(record.subject))
      ) {
        throw new PersistenceInputError(
          'Task code review iteration already recorded with different evidence'
        );
      }
      this.#db
        .insert(taskCodeReviews)
        .values({
          runId: record.runId,
          taskId: record.taskId,
          iteration: record.iteration,
          subjectJson: stringify(record.subject),
          reviewJson: stringify(record.review)
        })
        .onConflictDoNothing()
        .run();
    })();
  }

  async persistConflict(record: PersistedTaskConflict): Promise<void> {
    this.#assertConflict(record);
    this.#sqlite.transaction(() => {
      this.#persistConflictInTransaction(record);
    })();
  }

  #assertConflict(record: PersistedTaskConflict): void {
    this.#assertRunId(record.runId);
    if (record.taskA !== record.conflict.taskA || record.taskB !== record.conflict.taskB) {
      throw new PersistenceInputError('Task conflict keys must match payload task IDs');
    }
    if (
      record.effectiveFromSequence !== undefined &&
      (!Number.isInteger(record.effectiveFromSequence) || record.effectiveFromSequence < 1)
    ) {
      throw new PersistenceInputError('Runtime conflict effective sequence must be positive');
    }
    taskConflictSchema.parse(record.conflict);
  }

  #persistConflictInTransaction(record: PersistedTaskConflict): void {
    this.#assertRunExists(record.runId);
    const existing = this.#db
      .select()
      .from(taskConflicts)
      .where(
        and(
          eq(taskConflicts.runId, record.runId),
          eq(taskConflicts.taskA, record.taskA),
          eq(taskConflicts.taskB, record.taskB)
        )
      )
      .get();
    // Runtime conflicts are monotonic knowledge: retain their first effective sequence for replay.
    if (
      record.effectiveFromSequence !== undefined &&
      existing !== undefined &&
      existing.effectiveFromSequence !== null
    ) {
      return;
    }
    this.#db
      .insert(taskConflicts)
      .values({
        runId: record.runId,
        taskA: record.taskA,
        taskB: record.taskB,
        effectiveFromSequence: record.effectiveFromSequence ?? null,
        conflictJson: stringify(record.conflict)
      })
      .onConflictDoUpdate({
        target: [taskConflicts.runId, taskConflicts.taskA, taskConflicts.taskB],
        set: {
          effectiveFromSequence: record.effectiveFromSequence ?? null,
          conflictJson: stringify(record.conflict)
        }
      })
      .run();
  }

  async persistLease(record: PersistedWriteLease): Promise<void> {
    this.#assertRunId(record.runId);
    if (record.runId !== record.lease.runId) {
      throw new PersistenceInputError('Write lease run ID must match payload run ID');
    }
    writeLeaseSchema.parse(record.lease);
    this.#sqlite.transaction(() => {
      this.#assertRunExists(record.runId);
      const existing = this.#db
        .select()
        .from(writeLeases)
        .where(and(eq(writeLeases.runId, record.runId), eq(writeLeases.leaseId, record.lease.id)))
        .get();
      if (existing !== undefined) {
        const stored = decode(existing.leaseJson, isWriteLease, 'write lease');
        if (record.lease.version < stored.version) {
          throw new PersistenceInputError(
            `Lease version regression rejected: stored version ${stored.version}, incoming version ${record.lease.version}`
          );
        }
        if (
          record.lease.version === stored.version &&
          canonicalPlainStringify(record.lease) !== canonicalPlainStringify(stored)
        ) {
          throw new PersistenceInputError('Lease version already recorded with different evidence');
        }
        if (record.lease.version === stored.version) {
          return;
        }
      }
      this.#db
        .insert(writeLeases)
        .values({
          runId: record.runId,
          leaseId: record.lease.id,
          leaseJson: stringify(record.lease)
        })
        .onConflictDoUpdate({
          target: [writeLeases.runId, writeLeases.leaseId],
          set: { leaseJson: stringify(record.lease) }
        })
        .run();
    })();
  }

  async persistWorkspace(record: PersistedTaskWorkspace): Promise<void> {
    this.#assertRunId(record.runId);
    if (record.workspace.runId !== record.runId) {
      throw new PersistenceInputError('Workspace run ID must match persistence run ID');
    }
    taskWorkspaceSchema.parse(record.workspace);
    this.#sqlite.transaction(() => {
      this.#assertRunExists(record.runId);
      const existing = this.#db
        .select()
        .from(taskWorkspaces)
        .where(
          and(
            eq(taskWorkspaces.runId, record.runId),
            eq(taskWorkspaces.workspaceId, record.workspace.id)
          )
        )
        .get();
      if (existing !== undefined) {
        const stored = decode(existing.workspaceJson, isTaskWorkspace, 'task workspace');
        if (record.workspace.revision < stored.revision) {
          throw new PersistenceInputError(
            `Workspace revision regression rejected: stored revision ${stored.revision}, incoming revision ${record.workspace.revision}`
          );
        }
        if (
          record.workspace.revision === stored.revision &&
          canonicalPlainStringify(record.workspace) !== canonicalPlainStringify(stored)
        ) {
          throw new PersistenceInputError(
            'Workspace revision already recorded with different evidence'
          );
        }
        if (record.workspace.revision === stored.revision) {
          return;
        }
      }
      this.#db
        .insert(taskWorkspaces)
        .values({
          runId: record.runId,
          workspaceId: record.workspace.id,
          workspaceJson: stringify(record.workspace)
        })
        .onConflictDoUpdate({
          target: [taskWorkspaces.runId, taskWorkspaces.workspaceId],
          set: { workspaceJson: stringify(record.workspace) }
        })
        .run();
    })();
  }

  async persistAttempt(record: PersistedAgentExecutionAttempt): Promise<void> {
    this.#assertAttempt(record);
    this.#sqlite.transaction(() => {
      this.#persistAttemptInTransaction(record);
    })();
  }

  async updateRunState(runId: string, state: OrchestrationRunState): Promise<void> {
    this.#assertRunId(runId);
    this.#sqlite.transaction(() => {
      const result = this.#db.update(runs).set({ state }).where(eq(runs.id, runId)).run();
      if (result.changes !== 1) {
        throw new PersistenceInputError(`Unknown orchestration run: ${runId}`);
      }
    })();
  }

  async recoverRun(runId: string): Promise<RecoveredRun | undefined> {
    this.#assertRunId(runId);
    const run = this.#db.select().from(runs).where(eq(runs.id, runId)).get();
    if (run === undefined) {
      return undefined;
    }
    const events = this.#db
      .select()
      .from(schedulerEvents)
      .where(eq(schedulerEvents.runId, runId))
      .orderBy(asc(schedulerEvents.sequence))
      .all();
    const transitions = this.#db
      .select()
      .from(taskTransitions)
      .where(eq(taskTransitions.runId, runId))
      .orderBy(asc(taskTransitions.sequence), asc(taskTransitions.ordinal))
      .all();
    const decisions = this.#db
      .select()
      .from(schedulerDecisions)
      .where(eq(schedulerDecisions.runId, runId))
      .orderBy(asc(schedulerDecisions.sequence))
      .all();
    const impacts = this.#db
      .select()
      .from(taskImpacts)
      .where(eq(taskImpacts.runId, runId))
      .orderBy(asc(taskImpacts.taskId))
      .all();
    const conflicts = this.#db
      .select()
      .from(taskConflicts)
      .where(eq(taskConflicts.runId, runId))
      .orderBy(
        asc(taskConflicts.effectiveFromSequence),
        asc(taskConflicts.taskA),
        asc(taskConflicts.taskB)
      )
      .all();
    const leases = this.#db
      .select()
      .from(writeLeases)
      .where(eq(writeLeases.runId, runId))
      .orderBy(asc(writeLeases.leaseId))
      .all();
    const workspaces = this.#db
      .select()
      .from(taskWorkspaces)
      .where(eq(taskWorkspaces.runId, runId))
      .orderBy(asc(taskWorkspaces.workspaceId))
      .all();
    const attempts = this.#db
      .select()
      .from(agentExecutionAttempts)
      .where(eq(agentExecutionAttempts.runId, runId))
      .orderBy(asc(agentExecutionAttempts.attemptId))
      .all();
    return {
      run: {
        id: run.id,
        repositoryId: run.repositoryId,
        state: this.#decodeRunState(run.state),
        createdAt: run.createdAt,
        authority: decode(run.authorityJson ?? '', isRunAuthorityEvidence, 'run authority evidence')
      },
      tasks: decode(run.tasksJson, isTaskContracts, 'task contracts'),
      hardConflicts: decode(run.hardConflictsJson, isTaskConflicts, 'hard conflicts').filter(
        (conflict): conflict is RecoveredRun['hardConflicts'][number] =>
          conflict.severity === 'hard'
      ),
      riskConflicts: decode(run.riskConflictsJson, isTaskConflicts, 'risk conflicts').filter(
        (conflict): conflict is RecoveredRun['riskConflicts'][number] =>
          conflict.severity !== 'hard'
      ),
      scheduleOptions: decode(run.scheduleOptionsJson, isScheduleOptions, 'schedule options'),
      events: events.map((event) => ({
        runId: event.runId,
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        event: decode(
          event.eventJson,
          (value): value is SchedulerEvent => schedulerEventSchema.safeParse(value).success,
          'scheduler event'
        )
      })),
      transitions: transitions.map((transition) => ({
        runId: transition.runId,
        sequence: transition.sequence,
        taskId: transition.taskId,
        fromState: this.#decodeTaskState(transition.fromState, 'transition from state'),
        toState: this.#decodeTaskState(transition.toState, 'transition to state')
      })),
      decisions: decisions.map((decision) => ({
        runId: decision.runId,
        sequence: decision.sequence,
        inputSnapshot: decode(
          decision.snapshotJson,
          isSchedulerSnapshot,
          'scheduler input snapshot'
        ),
        decision: decode(decision.decisionJson, isSchedulerDecision, 'scheduler decision')
      })),
      impacts: impacts.map((impact) => ({
        runId: impact.runId,
        taskId: impact.taskId,
        impact: decode(impact.impactJson, isTaskImpact, 'task impact')
      })),
      conflicts: conflicts.map((conflict) => ({
        runId: conflict.runId,
        taskA: conflict.taskA,
        taskB: conflict.taskB,
        ...(conflict.effectiveFromSequence === null
          ? {}
          : { effectiveFromSequence: conflict.effectiveFromSequence }),
        conflict: decode(
          conflict.conflictJson,
          (value): value is TaskConflict => taskConflictSchema.safeParse(value).success,
          'task conflict'
        )
      })),
      leases: leases.map((lease) => ({
        runId: lease.runId,
        lease: decode(lease.leaseJson, isWriteLease, 'write lease')
      })),
      workspaces: workspaces.map((workspace) => ({
        runId: workspace.runId,
        workspace: decode(workspace.workspaceJson, isTaskWorkspace, 'task workspace')
      })),
      attempts: attempts.map((attempt) => ({
        runId: attempt.runId,
        attempt: decode(attempt.attemptJson, isAgentExecutionAttempt, 'agent execution attempt')
      }))
    };
  }

  async recoverReviews(runId: string): Promise<readonly PersistedTaskCodeReview[]> {
    this.#assertRunId(runId);
    return this.#db
      .select()
      .from(taskCodeReviews)
      .where(eq(taskCodeReviews.runId, runId))
      .orderBy(asc(taskCodeReviews.taskId), asc(taskCodeReviews.iteration))
      .all()
      .map((review) => ({
        runId: review.runId,
        taskId: review.taskId,
        iteration: review.iteration,
        ...(review.subjectJson === null
          ? {}
          : {
              subject: decode(
                review.subjectJson,
                isTaskCodeReviewSubject,
                'task code review subject'
              )
            }),
        review: decode(review.reviewJson, isTaskCodeReview, 'task code review')
      }));
  }

  async replayRun(
    runId: string,
    scheduler: Scheduler
  ): Promise<readonly PersistedSchedulerDecision[]> {
    const recovered = await this.recoverRun(runId);
    if (recovered === undefined) {
      return [];
    }
    const decisions = new Map(recovered.decisions.map((decision) => [decision.sequence, decision]));
    const replayed: PersistedSchedulerDecision[] = [];
    for (const event of recovered.events) {
      const persistedDecision = decisions.get(event.sequence);
      if (persistedDecision === undefined) {
        throw new PersistenceReplayError(runId, event.sequence);
      }
      const decision = scheduler.reevaluate(
        event.event,
        persistedDecision.inputSnapshot,
        recovered.tasks,
        [
          ...recovered.hardConflicts,
          ...recovered.conflicts.flatMap((record) =>
            record.effectiveFromSequence !== undefined &&
            record.effectiveFromSequence <= event.sequence &&
            record.conflict.severity === 'hard'
              ? [record.conflict]
              : []
          )
        ],
        [
          ...recovered.riskConflicts,
          ...recovered.conflicts.flatMap((record) =>
            record.effectiveFromSequence !== undefined &&
            record.effectiveFromSequence <= event.sequence &&
            record.conflict.severity !== 'hard'
              ? [record.conflict]
              : []
          )
        ],
        recovered.scheduleOptions
      );
      if (
        canonicalDecisionStringify(decision) !==
        canonicalDecisionStringify(persistedDecision.decision)
      ) {
        throw new PersistenceReplayError(runId, event.sequence);
      }
      const transitions = recovered.transitions.filter(
        (transition) => transition.sequence === event.sequence
      );
      if (
        canonicalTransitions(transitions) !==
        canonicalTransitions(taskDecisionsWithTransitions(decision.taskDecisions))
      ) {
        throw new PersistenceReplayError(runId, event.sequence);
      }
      replayed.push(persistedDecision);
    }
    return replayed;
  }

  close(): void {
    this.#sqlite.close();
  }

  #assertRunId(runId: string): void {
    if (runId.trim().length === 0) {
      throw new PersistenceInputError('runId must not be empty');
    }
  }

  #assertSequence(sequence: number): void {
    if (!Number.isInteger(sequence) || sequence < 1) {
      throw new PersistenceInputError('sequence must be a positive integer');
    }
  }

  #assertRunExists(runId: string): void {
    if (this.#db.select().from(runs).where(eq(runs.id, runId)).get() === undefined) {
      throw new PersistenceInputError(`Unknown orchestration run: ${runId}`);
    }
  }

  #assertAttempt(record: PersistedAgentExecutionAttempt): void {
    this.#assertRunId(record.runId);
    if (record.runId !== record.attempt.runId) {
      throw new PersistenceInputError(
        'Agent execution attempt run ID must match persistence run ID'
      );
    }
    agentExecutionAttemptSchema.parse(record.attempt);
  }

  #persistAttemptInTransaction(record: PersistedAgentExecutionAttempt): void {
    this.#assertRunExists(record.runId);
    const existing = this.#db
      .select()
      .from(agentExecutionAttempts)
      .where(
        and(
          eq(agentExecutionAttempts.runId, record.runId),
          eq(agentExecutionAttempts.attemptId, record.attempt.id)
        )
      )
      .get();
    if (existing !== undefined) {
      const stored = decode(
        existing.attemptJson,
        isAgentExecutionAttempt,
        'agent execution attempt'
      );
      if (record.attempt.revision < stored.revision) {
        throw new PersistenceInputError(
          `Agent execution attempt revision regression rejected: stored revision ${stored.revision}, incoming revision ${record.attempt.revision}`
        );
      }
      if (
        record.attempt.revision === stored.revision &&
        canonicalPlainStringify(record.attempt) !== canonicalPlainStringify(stored)
      ) {
        throw new PersistenceInputError(
          'Agent execution attempt revision already recorded with different evidence'
        );
      }
      if (record.attempt.revision === stored.revision) {
        return;
      }
    }
    this.#db
      .insert(agentExecutionAttempts)
      .values({
        runId: record.runId,
        attemptId: record.attempt.id,
        attemptJson: stringify(record.attempt)
      })
      .onConflictDoUpdate({
        target: [agentExecutionAttempts.runId, agentExecutionAttempts.attemptId],
        set: { attemptJson: stringify(record.attempt) }
      })
      .run();
  }

  #assertIdempotentReevaluation(reevaluation: PersistedReevaluation): void {
    const event = this.#db
      .select()
      .from(schedulerEvents)
      .where(
        and(
          eq(schedulerEvents.runId, reevaluation.event.runId),
          eq(schedulerEvents.sequence, reevaluation.event.sequence)
        )
      )
      .get();
    const decision = this.#db
      .select()
      .from(schedulerDecisions)
      .where(
        and(
          eq(schedulerDecisions.runId, reevaluation.event.runId),
          eq(schedulerDecisions.sequence, reevaluation.event.sequence)
        )
      )
      .get();
    const transitions = this.#db
      .select()
      .from(taskTransitions)
      .where(
        and(
          eq(taskTransitions.runId, reevaluation.event.runId),
          eq(taskTransitions.sequence, reevaluation.event.sequence)
        )
      )
      .orderBy(asc(taskTransitions.ordinal))
      .all();
    const runtimeConflicts = this.#db
      .select()
      .from(taskConflicts)
      .where(
        and(
          eq(taskConflicts.runId, reevaluation.event.runId),
          eq(taskConflicts.effectiveFromSequence, reevaluation.event.sequence)
        )
      )
      .orderBy(asc(taskConflicts.taskA), asc(taskConflicts.taskB))
      .all()
      .map((record) => ({
        runId: record.runId,
        taskA: record.taskA,
        taskB: record.taskB,
        effectiveFromSequence: record.effectiveFromSequence ?? undefined,
        conflict: decode(
          record.conflictJson,
          (value): value is TaskConflict => taskConflictSchema.safeParse(value).success,
          'task conflict'
        )
      }));
    if (
      event === undefined ||
      decision === undefined ||
      event.occurredAt !== reevaluation.event.occurredAt ||
      canonicalEvidenceStringify(
        decode(
          event.eventJson,
          (value): value is SchedulerEvent => schedulerEventSchema.safeParse(value).success,
          'scheduler event'
        )
      ) !== canonicalEvidenceStringify(reevaluation.event.event) ||
      canonicalEvidenceStringify(
        decode(decision.snapshotJson, isSchedulerSnapshot, 'scheduler input snapshot')
      ) !== canonicalEvidenceStringify(reevaluation.decision.inputSnapshot) ||
      canonicalDecisionStringify(
        decode(decision.decisionJson, isSchedulerDecision, 'scheduler decision')
      ) !== canonicalDecisionStringify(reevaluation.decision.decision) ||
      canonicalTransitions(transitions) !== canonicalTransitions(reevaluation.transitions) ||
      canonicalRuntimeConflicts(runtimeConflicts) !==
        canonicalRuntimeConflicts(reevaluation.runtimeConflicts ?? [])
    ) {
      throw new PersistenceInputError(
        `Scheduler event sequence ${reevaluation.event.sequence} already recorded with different evidence`
      );
    }
  }

  #decodeRunState(value: string): OrchestrationRunState {
    if (!isRunState(value)) {
      throw new PersistenceInputError('Invalid persisted run state');
    }
    return value;
  }

  #decodeTaskState(value: string, name: string): TaskState {
    const parsed = taskStateSchema.safeParse(value);
    if (!parsed.success) {
      throw new PersistenceInputError(`Invalid persisted ${name}`);
    }
    return parsed.data;
  }

  async #exclusiveReevaluation<T>(operation: () => T): Promise<T> {
    const previous = this.#reevaluationTail;
    let complete!: () => void;
    this.#reevaluationTail = new Promise((resolve) => {
      complete = resolve;
    });
    await previous;
    try {
      return operation();
    } finally {
      complete();
    }
  }
}
