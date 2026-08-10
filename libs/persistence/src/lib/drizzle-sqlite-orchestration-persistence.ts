import Database from 'better-sqlite3';
import { asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type {
  CreatePersistedRunRequest,
  OrchestrationPersistence,
  OrchestrationRunState,
  PersistedReevaluation,
  PersistedTaskConflict,
  PersistedTaskImpact,
  PersistedWriteLease,
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
  taskSpecificationSchema,
  taskContractSchema,
  taskStateSchema,
  writeLeaseSchema
} from '@ai-native-software-delivery-orchestrator/domain';

const runs = sqliteTable('orchestration_runs', {
  id: text('id').primaryKey(),
  repositoryId: text('repository_id').notNull(),
  state: text('state').notNull(),
  createdAt: text('created_at').notNull(),
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

const taskConflicts = sqliteTable('task_conflicts', {
  runId: text('run_id').notNull(),
  taskA: text('task_a').notNull(),
  taskB: text('task_b').notNull(),
  conflictJson: text('conflict_json').notNull()
});

const writeLeases = sqliteTable('write_leases', {
  runId: text('run_id').notNull(),
  leaseId: text('lease_id').notNull(),
  leaseJson: text('lease_json').notNull()
});

const jsonReplacer = (_key: string, value: unknown): unknown => {
  if (value instanceof Set) {
    return { $set: [...value] };
  }
  return value;
};

const jsonReviver = (key: string, value: unknown): unknown => {
  if (
    ['acquiredAt', 'lastHeartbeatAt', 'releasedAt', 'staleDetectedAt'].includes(key) &&
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

const isSchedulerSnapshot = (value: unknown): value is SchedulerSnapshot =>
  schedulerSnapshotSchema.safeParse(value).success;

const isSchedulerDecision = (value: unknown): value is SchedulerDecision =>
  isRecord(value) &&
  Array.isArray(value.taskDecisions) &&
  value.taskDecisions.every((decision) => schedulerTaskDecisionSchema.safeParse(decision).success);

const isTaskImpact = (value: unknown): value is PersistedTaskImpact['impact'] =>
  taskImpactSchema.safeParse(value).success;

const isWriteLease = (value: unknown): value is PersistedWriteLease['lease'] =>
  writeLeaseSchema.safeParse(value).success;

const canonicalize = (value: unknown): unknown => {
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

// SchedulerDecision is schema-validated and contains only arrays and plain objects, never Sets.
const canonicalDecisionStringify = (decision: SchedulerDecision): string =>
  stringify(canonicalize(decision));

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

export class DrizzleSqliteOrchestrationPersistence implements OrchestrationPersistence {
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
        task_id TEXT NOT NULL,
        from_state TEXT NOT NULL,
        to_state TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence, task_id)
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
      CREATE TABLE IF NOT EXISTS task_conflicts (
        run_id TEXT NOT NULL,
        task_a TEXT NOT NULL,
        task_b TEXT NOT NULL,
        conflict_json TEXT NOT NULL,
        PRIMARY KEY (run_id, task_a, task_b)
      );
      CREATE TABLE IF NOT EXISTS write_leases (
        run_id TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        lease_json TEXT NOT NULL,
        PRIMARY KEY (run_id, lease_id)
      );
    `);
  }

  async createRun(request: CreatePersistedRunRequest): Promise<void> {
    this.#assertRunId(request.run.id);
    taskSpecificationSchema.parse({ tasks: request.tasks });
    scheduleOptionsSchema.parse(request.scheduleOptions);
    await this.#exclusiveReevaluation(() =>
      this.#sqlite.transaction(() => {
        this.#db
          .insert(runs)
          .values({
            id: request.run.id,
            repositoryId: request.run.repositoryId,
            state: request.run.state,
            createdAt: request.run.createdAt,
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
    this.#assertSequence(reevaluation.event.sequence);
    schedulerEventSchema.parse(reevaluation.event.event);
    schedulerSnapshotSchema.parse(reevaluation.decision.inputSnapshot);
    for (const taskDecision of reevaluation.decision.decision.taskDecisions) {
      schedulerTaskDecisionSchema.parse(taskDecision);
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
    await this.#exclusiveReevaluation(() =>
      this.#sqlite.transaction(() => {
        this.#assertRunExists(reevaluation.event.runId);
        const expectedSequence =
          this.#db
            .select({ sequence: schedulerEvents.sequence })
            .from(schedulerEvents)
            .where(eq(schedulerEvents.runId, reevaluation.event.runId))
            .all().length + 1;
        if (reevaluation.event.sequence !== expectedSequence) {
          throw new PersistenceInputError(
            `Scheduler event sequence must be ${expectedSequence}: ${reevaluation.event.runId}`
          );
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
        for (const transition of reevaluation.transitions) {
          this.#db
            .insert(taskTransitions)
            .values({
              runId: transition.runId,
              sequence: transition.sequence,
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
      })()
    );
  }

  async persistImpact(record: PersistedTaskImpact): Promise<void> {
    this.#assertRunId(record.runId);
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

  async persistConflict(record: PersistedTaskConflict): Promise<void> {
    this.#assertRunId(record.runId);
    this.#sqlite.transaction(() => {
      this.#assertRunExists(record.runId);
      this.#db
        .insert(taskConflicts)
        .values({
          runId: record.runId,
          taskA: record.taskA,
          taskB: record.taskB,
          conflictJson: stringify(record.conflict)
        })
        .onConflictDoUpdate({
          target: [taskConflicts.runId, taskConflicts.taskA, taskConflicts.taskB],
          set: { conflictJson: stringify(record.conflict) }
        })
        .run();
    })();
  }

  async persistLease(record: PersistedWriteLease): Promise<void> {
    this.#assertRunId(record.runId);
    this.#sqlite.transaction(() => {
      this.#assertRunExists(record.runId);
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
      .orderBy(asc(taskTransitions.sequence), asc(taskTransitions.taskId))
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
      .orderBy(asc(taskConflicts.taskA), asc(taskConflicts.taskB))
      .all();
    const leases = this.#db
      .select()
      .from(writeLeases)
      .where(eq(writeLeases.runId, runId))
      .orderBy(asc(writeLeases.leaseId))
      .all();
    return {
      run: {
        id: run.id,
        repositoryId: run.repositoryId,
        state: this.#decodeRunState(run.state),
        createdAt: run.createdAt
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
        conflict: decode(
          conflict.conflictJson,
          (value): value is TaskConflict => taskConflictSchema.safeParse(value).success,
          'task conflict'
        )
      })),
      leases: leases.map((lease) => ({
        runId: lease.runId,
        lease: decode(lease.leaseJson, isWriteLease, 'write lease')
      }))
    };
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
        recovered.hardConflicts,
        recovered.riskConflicts,
        recovered.scheduleOptions
      );
      if (
        canonicalDecisionStringify(decision) !==
        canonicalDecisionStringify(persistedDecision.decision)
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
