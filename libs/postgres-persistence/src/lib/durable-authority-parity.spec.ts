import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import postgres from 'postgres';
import { DeterministicScheduler } from '@ai-native-software-delivery-orchestrator/scheduler';
import { ForgeReadModel } from '@ai-native-software-delivery-orchestrator/orchestration-runtime';
import { taskVerificationEvidenceFingerprint } from '@ai-native-software-delivery-orchestrator/domain';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  durableAuthorityContract,
  durableAuthorityInitialDispatch,
  durableAuthorityRepairAttempt,
  durableAuthorityRepairWorkItem,
  durableAuthorityRunRequest,
  type DurableAuthorityFixture
} from '../../../persistence/src/lib/durable-authority.contract.test.js';
import { PostgresOrchestrationPersistence } from './postgres-orchestration-persistence.js';
import {
  migratePostgresAuthoritySchema,
  POSTGRES_AUTHORITY_SCHEMA_VERSION
} from './postgres-authority-schema.js';

let directory: string;
let connectionString: string;
let role: string;
let runtimeRole: string;
let runtimeConnectionString: string;
let ownerConnectionString: string;
const port = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('No PostgreSQL fixture port'));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'forge-postgres-authority-'));
  const data = join(directory, 'data');
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions'], { stdio: 'pipe' });
  const assignedPort = await port();
  execFileSync(
    'pg_ctl',
    [
      '-D',
      data,
      '-l',
      join(directory, 'postgres.log'),
      '-o',
      `-h 127.0.0.1 -p ${assignedPort}`,
      '-w',
      'start'
    ],
    { stdio: 'pipe' }
  );
  connectionString = `postgresql://127.0.0.1:${assignedPort}/postgres`;
  const admin = postgres(connectionString, { onnotice: () => undefined });
  try {
    const identity = await admin`select current_user as name`;
    const adminRole = String(identity[0]?.name);
    role = `forge_migrator_${process.pid}`;
    runtimeRole = `forge_runtime_${process.pid}`;
    await admin.unsafe(`create role "${role}" login`);
    await admin.unsafe(`create role "${runtimeRole}" login`);
    await admin`revoke create on database postgres from public`;
    await admin`revoke temporary on database postgres from public`;
    await admin`revoke create on schema public from public`;
    await admin.unsafe(`grant create on database postgres to "${role}"`);
    ownerConnectionString = `postgresql://${role}@127.0.0.1:${assignedPort}/postgres`;
    runtimeConnectionString = `postgresql://${runtimeRole}@127.0.0.1:${assignedPort}/postgres`;
    if (adminRole === role || adminRole === runtimeRole) {
      throw new Error('Fixture migration and runtime roles must not be superusers');
    }
  } finally {
    await admin.end();
  }
}, 90_000);

afterAll(() => {
  if (directory !== undefined) {
    try {
      execFileSync('pg_ctl', ['-D', join(directory, 'data'), '-m', 'immediate', '-w', 'stop'], {
        stdio: 'pipe'
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

let fixtureOrdinal = 0;
const createFixture = async (): Promise<DurableAuthorityFixture & { schema: string }> => {
  const schema = `forge_contract_${++fixtureOrdinal}`;
  const admin = postgres(connectionString, { onnotice: () => undefined });
  const configuration = { connectionString: runtimeConnectionString, schema, role: runtimeRole };
  let store: PostgresOrchestrationPersistence | undefined;
  let peer: PostgresOrchestrationPersistence | undefined;
  try {
    await migratePostgresAuthoritySchema(
      { connectionString: ownerConnectionString, schema, role },
      runtimeRole
    );
    store = await PostgresOrchestrationPersistence.connect(configuration);
    peer = await PostgresOrchestrationPersistence.connect(configuration);
    return {
      store,
      peer,
      schema,
      corruptRecord: async (kind, key, transform) => {
        const rows = await admin.unsafe(
          `select payload from "${schema}".forge_records where run_id=$1 and kind=$2 and key=$3`,
          ['contract-run', kind, key]
        );
        if (rows.length !== 1 || typeof rows[0]?.payload !== 'string') {
          throw new Error(`Missing ${kind} corruption fixture: ${key}`);
        }
        const value: unknown = JSON.parse(rows[0].payload);
        await admin.unsafe(
          `update "${schema}".forge_records set payload=$4 where run_id=$1 and kind=$2 and key=$3`,
          ['contract-run', kind, key, JSON.stringify(transform(value))]
        );
      },
      removeRecord: async (kind, key) => {
        await admin.unsafe(
          `delete from "${schema}".forge_records where run_id=$1 and kind=$2 and key=$3`,
          ['contract-run', kind, key]
        );
      },
      close: async () => {
        await Promise.all([store.close(), peer.close()]);
        await admin.unsafe(`drop schema "${schema}" cascade`);
        await admin.end();
      }
    };
  } catch (error) {
    await Promise.all([store?.close(), peer?.close()]);
    await admin.end();
    throw error;
  }
};

durableAuthorityContract('PostgreSQL isolated server', createFixture);

it('installs, upgrades, and safely reruns migrations without losing persisted authority', async () => {
  const schema = `forge_upgrade_${++fixtureOrdinal}`;
  const migration = { connectionString: ownerConnectionString, schema, role };
  const runtime = { connectionString: runtimeConnectionString, schema, role: runtimeRole };
  const admin = postgres(connectionString, { onnotice: () => undefined });
  try {
    await migratePostgresAuthoritySchema(migration, runtimeRole, 1);
    await expect(PostgresOrchestrationPersistence.connect(runtime)).rejects.toThrow(
      'schema version is incompatible'
    );
    const owner = postgres(ownerConnectionString);
    try {
      await owner.unsafe(
        `insert into "${schema}".forge_runs (id,state,payload) values ($1,$2,$3)`,
        ['preserved-run', 'ACTIVE', JSON.stringify({ run: { id: 'preserved-run' } })]
      );
    } finally {
      await owner.end();
    }
    await migratePostgresAuthoritySchema(migration, runtimeRole);
    await migratePostgresAuthoritySchema(migration, runtimeRole);
    const adapter = await PostgresOrchestrationPersistence.connect(runtime);
    try {
      const rows = await admin.unsafe(
        `select state from "${schema}".forge_runs where id='preserved-run'`
      );
      expect(rows[0]?.state).toBe('ACTIVE');
      const versions = await admin.unsafe(
        `select version from "${schema}".forge_schema_migrations order by version`
      );
      expect(versions.map((row) => row.version)).toEqual([1, POSTGRES_AUTHORITY_SCHEMA_VERSION]);
      await adapter.createRun(durableAuthorityRunRequest('after-upgrade'));
      await expect(adapter.recoverRun('after-upgrade')).resolves.toMatchObject({
        run: { id: 'after-upgrade' }
      });
    } finally {
      await adapter.close();
    }
    await expect(migratePostgresAuthoritySchema(migration, runtimeRole, 1)).rejects.toThrow(
      'cannot downgrade'
    );
  } finally {
    await admin.unsafe(`drop schema if exists "${schema}" cascade`);
    await admin.end();
  }
});

it('refuses missing, future, and altered migration metadata without repairing the schema', async () => {
  const fixture = await createFixture();
  const admin = postgres(connectionString, { onnotice: () => undefined });
  const runtime = {
    connectionString: runtimeConnectionString,
    schema: fixture.schema,
    role: runtimeRole
  };
  try {
    await admin.unsafe(
      `insert into "${fixture.schema}".forge_schema_migrations (version, checksum) values (3,'future')`
    );
    await expect(PostgresOrchestrationPersistence.connect(runtime)).rejects.toThrow(
      'schema version is incompatible'
    );
    await admin.unsafe(`delete from "${fixture.schema}".forge_schema_migrations where version=3`);
    await admin.unsafe(
      `update "${fixture.schema}".forge_schema_migrations set checksum='tampered' where version=1`
    );
    await expect(PostgresOrchestrationPersistence.connect(runtime)).rejects.toThrow(
      'migration ledger is incompatible'
    );
    await admin.unsafe(`drop table "${fixture.schema}".forge_schema_migrations`);
    await expect(PostgresOrchestrationPersistence.connect(runtime)).rejects.toThrow(
      'object is missing'
    );
    const remaining = await admin.unsafe(
      `select count(*)::int as count from "${fixture.schema}".forge_runs`
    );
    expect(remaining[0]?.count).toBe(0);
  } finally {
    await fixture.close();
    await admin.end();
  }
});

it('separates the installer from the restricted runtime role in real PostgreSQL', async () => {
  const fixture = await createFixture();
  const runtimeSql = postgres(runtimeConnectionString);
  const admin = postgres(connectionString, { onnotice: () => undefined });
  try {
    await expect(
      runtimeSql.unsafe(`create table "${fixture.schema}".forbidden (id int)`)
    ).rejects.toThrow();
    await expect(
      runtimeSql.unsafe(`alter table "${fixture.schema}".forge_runs add column forbidden int`)
    ).rejects.toThrow();
    await expect(
      runtimeSql.unsafe(`drop table "${fixture.schema}".forge_records`)
    ).rejects.toThrow();
    await expect(
      runtimeSql.unsafe(`update "${fixture.schema}".forge_schema_migrations set version=88`)
    ).rejects.toThrow();
    await expect(
      runtimeSql.unsafe(`delete from "${fixture.schema}".forge_schema_migrations`)
    ).rejects.toThrow();
    await expect(
      runtimeSql.unsafe(
        `insert into "${fixture.schema}".forge_schema_migrations (version,checksum) values (88,'bad')`
      )
    ).rejects.toThrow();
    await expect(runtimeSql.unsafe('create schema forbidden_runtime')).rejects.toThrow();
    await expect(
      runtimeSql.unsafe('create temp table forbidden_runtime (id int)')
    ).rejects.toThrow();
    await expect(
      runtimeSql.unsafe('create table public.forbidden_runtime (id int)')
    ).rejects.toThrow();
    await expect(
      migratePostgresAuthoritySchema(
        { connectionString: runtimeConnectionString, schema: fixture.schema, role: runtimeRole },
        runtimeRole
      )
    ).rejects.toThrow('must be distinct');
    const privileges = await admin.unsafe(
      `select has_schema_privilege($1,$2,'CREATE') as can_create, has_table_privilege($1,$3,'SELECT,INSERT,UPDATE,DELETE') as can_mutate`,
      [runtimeRole, fixture.schema, `${fixture.schema}.forge_records`]
    );
    expect(privileges[0]).toMatchObject({ can_create: false, can_mutate: true });
    await fixture.store.createRun(durableAuthorityRunRequest('restricted-run'));
    await expect(fixture.peer.recoverRun('restricted-run')).resolves.toMatchObject({
      run: { id: 'restricted-run' }
    });
  } finally {
    await runtimeSql.end();
    await admin.end();
    await fixture.close();
  }
});

it('refuses missing objects and incompatible runtime privileges without startup DDL', async () => {
  const fixture = await createFixture();
  const admin = postgres(connectionString, { onnotice: () => undefined });
  const runtime = {
    connectionString: runtimeConnectionString,
    schema: fixture.schema,
    role: runtimeRole
  };
  try {
    await admin.unsafe(`revoke update on "${fixture.schema}".forge_records from "${runtimeRole}"`);
    await expect(PostgresOrchestrationPersistence.connect(runtime)).rejects.toThrow(
      'runtime privileges are incompatible'
    );
    await admin.unsafe(`grant update on "${fixture.schema}".forge_records to "${runtimeRole}"`);
    const owner = postgres(ownerConnectionString);
    try {
      await owner.unsafe(`drop index "${fixture.schema}".forge_records_kind_run_idx`);
    } finally {
      await owner.end();
    }
    await expect(PostgresOrchestrationPersistence.connect(runtime)).rejects.toThrow(
      'missing required index'
    );
    const index = await admin.unsafe(
      `select 1 from pg_indexes where schemaname=$1 and indexname='forge_records_kind_run_idx'`,
      [fixture.schema]
    );
    expect(index.length).toBe(0);
  } finally {
    await fixture.close();
    await admin.end();
  }
});

it.each([
  {
    name: 'changed column nullability',
    alter: (schema: string) =>
      `alter table "${schema}".forge_runs alter column state drop not null`,
    message: 'table columns are incompatible'
  },
  {
    name: 'missing evidence primary key',
    alter: (schema: string) =>
      `alter table "${schema}".forge_records drop constraint forge_records_pkey`,
    message: 'table constraints are incompatible'
  },
  {
    name: 'same-named index on the wrong columns',
    alter: (schema: string) =>
      `drop index "${schema}".forge_records_kind_run_idx; create index forge_records_kind_run_idx on "${schema}".forge_records (payload)`,
    message: 'required index or its definition is incompatible'
  }
])('rejects $name at runtime startup without repairing it', async ({ alter, message }) => {
  const fixture = await createFixture();
  const owner = postgres(ownerConnectionString);
  try {
    await owner.unsafe(alter(fixture.schema));
    await expect(
      PostgresOrchestrationPersistence.connect({
        connectionString: runtimeConnectionString,
        schema: fixture.schema,
        role: runtimeRole
      })
    ).rejects.toThrow(message);
    await expect(
      migratePostgresAuthoritySchema(
        {
          connectionString: ownerConnectionString,
          schema: fixture.schema,
          role
        },
        runtimeRole
      )
    ).rejects.toThrow(message);
  } finally {
    await owner.end();
    await fixture.close();
  }
});

it('fails closed on missing schema, wrong role, and malformed persisted run evidence', async () => {
  const fixture = await createFixture();
  const admin = postgres(connectionString, { onnotice: () => undefined });
  try {
    await expect(
      PostgresOrchestrationPersistence.connect({
        connectionString: runtimeConnectionString,
        schema: 'forge_missing_schema',
        role: runtimeRole
      })
    ).rejects.toThrow('schema does not exist');
    await expect(
      PostgresOrchestrationPersistence.connect({
        connectionString,
        schema: fixture.schema,
        role: 'forge_wrong_role'
      })
    ).rejects.toThrow('role mismatch');
    await fixture.store.createRun(durableAuthorityRunRequest('corrupted-run'));
    await admin.unsafe(
      `update "${fixture.schema}".forge_runs set payload = '{broken' where id = $1`,
      ['corrupted-run']
    );
    await expect(fixture.peer.recoverRun('corrupted-run')).rejects.toThrow();
  } finally {
    await admin.end();
    await fixture.close();
  }
});

it('rejects a partial sequence-one reevaluation without dispatch attempts', async () => {
  const fixture = await createFixture();
  try {
    await fixture.store.createRun(durableAuthorityRunRequest('partial-run'));
    const dispatch = durableAuthorityInitialDispatch('partial-run');
    await fixture.store.persistReevaluation(dispatch.reevaluation);
    await expect(fixture.peer.ensureInitialDispatch(dispatch)).rejects.toThrow(
      'attempt authority is missing'
    );
    await expect(fixture.store.recoverAttempts('partial-run')).resolves.toEqual([]);
  } finally {
    await fixture.close();
  }
});

it('replays recorded scheduler decisions and reconstructs them after reopening', async () => {
  const fixture = await createFixture();
  try {
    await fixture.store.createRun(durableAuthorityRunRequest('replay-run'));
    const dispatch = durableAuthorityInitialDispatch('replay-run');
    await fixture.store.ensureInitialDispatch(dispatch);
    await expect(
      fixture.peer.replayRun('replay-run', new DeterministicScheduler())
    ).resolves.toHaveLength(1);
    const reopened = await PostgresOrchestrationPersistence.connect({
      connectionString: runtimeConnectionString,
      schema: fixture.schema,
      role: runtimeRole
    });
    try {
      await expect(reopened.recoverRun('replay-run')).resolves.toMatchObject({
        events: [{ sequence: 1 }],
        decisions: [{ sequence: 1 }]
      });
      await expect(
        reopened.replayRun('replay-run', new DeterministicScheduler())
      ).resolves.toHaveLength(1);
    } finally {
      await reopened.close();
    }
  } finally {
    await fixture.close();
  }
});

it('projects recovered builder, repair, lease, review, verification, timeline, and blocking evidence', async () => {
  const fixture = await createFixture();
  try {
    const runId = 'read-model-run';
    const request = durableAuthorityRunRequest(runId);
    await fixture.store.createRun(request);
    await fixture.store.ensureInitialDispatch(durableAuthorityInitialDispatch(runId));
    const builder = durableAuthorityInitialDispatch(runId).attempts[0].attempt;
    await fixture.store.persistLease({
      runId,
      lease: {
        id: 'blocked-lease',
        runId,
        taskId: 'task-1',
        agentId: 'agent-1',
        resource: { type: 'project', projectId: 'project-1' },
        mode: 'exclusive',
        version: 1,
        state: 'ACTIVE',
        acquiredAt: new Date('2026-09-01T00:02:00.000Z'),
        lastHeartbeatAt: new Date('2026-09-01T00:02:00.000Z')
      }
    });
    const repair = await fixture.store.admitRepairAttemptWithWorkItem({
      attempt: { ...durableAuthorityRepairAttempt('read-repair'), runId },
      maxRepairs: 1,
      createWorkItem: (attempt) => ({ ...durableAuthorityRepairWorkItem(attempt), runId })
    });
    const verified = {
      id: 'read-verification',
      runId,
      taskId: 'task-1',
      attemptId: repair.id,
      workspaceId: 'workspace-1',
      workspaceRevision: 1,
      workspaceChangeFingerprint: `sha256:${'c'.repeat(64)}`,
      verificationPolicyFingerprint: request.run.authority.verificationPolicyFingerprint,
      status: 'passed' as const,
      verifiedAt: '2026-09-01T00:04:00.000Z'
    };
    await fixture.store.persistVerificationEvidence({
      ...verified,
      fingerprint: taskVerificationEvidenceFingerprint(verified)
    });
    await fixture.store.persistReview({
      runId,
      taskId: 'task-1',
      iteration: 2,
      subject: { ...repair.parentReviewSubject, outputAttemptId: repair.id },
      review: { recommendation: 'accept', summary: 'Repair accepted.', findings: [] }
    });
    await fixture.store.persistReevaluation({
      event: {
        runId,
        sequence: 2,
        occurredAt: '2026-09-01T00:05:00.000Z',
        event: { type: 'lease-blocked', taskId: 'task-1', leaseId: 'blocked-lease' }
      },
      decision: {
        runId,
        sequence: 2,
        inputSnapshot: { taskStates: [{ taskId: 'task-1', state: 'RUNNING' }], runtimeBlocks: [] },
        decision: {
          taskDecisions: [
            {
              taskId: 'task-1',
              action: 'block',
              fromState: 'RUNNING',
              toState: 'BLOCKED',
              reasons: [
                { type: 'runtime-blocked', blockers: [{ type: 'lease', leaseId: 'blocked-lease' }] }
              ]
            }
          ]
        }
      },
      transitions: [
        { runId, sequence: 2, taskId: 'task-1', fromState: 'RUNNING', toState: 'BLOCKED' }
      ]
    });
    const reopened = await PostgresOrchestrationPersistence.connect({
      connectionString: runtimeConnectionString,
      schema: fixture.schema,
      role: runtimeRole
    });
    try {
      const result = await new ForgeReadModel({
        persistence: reopened,
        workflowId: (id) => `forge-run:${id}`
      }).read(runId);
      expect(result).toMatchObject({
        runId,
        correlation: { runId, workflowId: `forge-run:${runId}` },
        leases: [
          {
            id: 'blocked-lease',
            state: 'ACTIVE',
            resource: { type: 'project', projectId: 'project-1' }
          }
        ],
        timeline: [
          { sequence: 1, type: 'run-started' },
          { sequence: 2, type: 'lease-blocked', correlation: { taskId: 'task-1' } }
        ],
        tasks: [
          {
            id: 'task-1',
            state: 'BLOCKED',
            currentBlockingReason: {
              type: 'runtime-blocked',
              blockers: [{ type: 'lease', leaseId: 'blocked-lease' }]
            },
            attempts: [
              { id: builder.id, kind: 'builder' },
              {
                id: repair.id,
                kind: 'repair',
                correlation: { attemptId: builder.id, repairAttemptId: repair.id }
              }
            ],
            verification: [
              {
                id: 'read-verification',
                correlation: { attemptId: builder.id, repairAttemptId: repair.id }
              }
            ],
            reviews: [
              { iteration: 2, correlation: { attemptId: builder.id, repairAttemptId: repair.id } }
            ]
          }
        ]
      });
    } finally {
      await reopened.close();
    }
  } finally {
    await fixture.close();
  }
});

it('permits one builder claim after two competing transactions block on the same run row', async () => {
  const fixture = await createFixture();
  const holder = postgres(connectionString);
  const observer = postgres(connectionString);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markLocked!: () => void;
  const locked = new Promise<void>((resolve) => {
    markLocked = resolve;
  });
  try {
    await fixture.store.createRun(durableAuthorityRunRequest('competing-run'));
    await fixture.store.ensureInitialDispatch(durableAuthorityInitialDispatch('competing-run'));
    const holding = holder.begin(async (tx) => {
      await tx.unsafe(`select id from "${fixture.schema}".forge_runs where id=$1 for update`, [
        'competing-run'
      ]);
      markLocked();
      await gate;
    });
    try {
      await locked;
      const starting = {
        ...durableAuthorityInitialDispatch('competing-run').attempts[0].attempt,
        state: 'STARTING' as const,
        revision: 2,
        startedAt: new Date('2026-09-01T00:02:00.000Z')
      };
      const claims = [
        fixture.store.claimBuilderStart({ runId: 'competing-run', attempt: starting, leases: [] }),
        fixture.peer.claimBuilderStart({ runId: 'competing-run', attempt: starting, leases: [] })
      ];
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        const rows =
          await observer`select count(*)::int as blocked from pg_stat_activity where query like '%forge_runs where id=$1 for update%' and cardinality(pg_blocking_pids(pid)) > 0`;
        if (Number(rows[0]?.blocked) === 2) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      release();
      await holding;
      const outcomes = await Promise.allSettled(claims);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
      await expect(fixture.peer.recoverAttempts('competing-run')).resolves.toMatchObject([
        { attempt: { state: 'STARTING', revision: 2 } }
      ]);
    } finally {
      release();
      await holding;
    }
  } finally {
    await Promise.all([holder.end(), observer.end()]);
    await fixture.close();
  }
}, 15_000);

it('serializes cancellation before three genuinely blocked mutation claims', async () => {
  const fixture = await createFixture();
  try {
    await fixture.store.createRun(durableAuthorityRunRequest('race-run'));
    await fixture.store.ensureInitialDispatch(durableAuthorityInitialDispatch('race-run'));
    const admitted = await fixture.store.admitRepairAttemptWithWorkItem({
      attempt: { ...durableAuthorityRepairAttempt('race-repair'), runId: 'race-run' },
      maxRepairs: 1,
      createWorkItem: (attempt) => ({
        ...durableAuthorityRepairWorkItem(attempt),
        runId: 'race-run'
      })
    });
    const holder = postgres(connectionString);
    const observer = postgres(connectionString);
    let unlock!: () => void;
    const release = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    let markLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const holding = holder.begin(async (tx) => {
      await tx.unsafe(`select id from "${fixture.schema}".forge_runs where id = $1 for update`, [
        'race-run'
      ]);
      markLocked();
      await release;
      await tx.unsafe(
        `update "${fixture.schema}".forge_runs set state = 'CANCEL_REQUESTED' where id = 'race-run'`
      );
    });
    try {
      await locked;
      const starting = {
        ...durableAuthorityInitialDispatch('race-run').attempts[0].attempt,
        state: 'STARTING' as const,
        revision: 2,
        startedAt: new Date('2026-09-01T00:02:00.000Z')
      };
      const pending = [
        fixture.peer.claimBuilderStart({
          runId: 'race-run',
          attempt: starting,
          leases: [
            {
              id: 'race-lease',
              runId: 'race-run',
              agentId: 'agent-1',
              taskId: 'task-1',
              resource: { type: 'project' as const, projectId: 'project-1' },
              mode: 'exclusive' as const,
              state: 'ACTIVE' as const,
              version: 1,
              acquiredAt: new Date(),
              lastHeartbeatAt: new Date()
            }
          ]
        }),
        fixture.store.claimRepairStart({
          runId: 'race-run',
          attempt: { ...admitted, state: 'STARTING', revision: 2, startedAt: new Date() }
        }),
        fixture.peer.claimIntegrationStart({
          runId: 'race-run',
          taskId: 'task-1',
          workspaceId: 'workspace-1',
          outputAttemptId: 'contract-builder'
        })
      ];
      // pg_blocking_pids proves the claim reached PostgreSQL and is blocked on the locked run row.
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        const rows =
          await observer`select count(*)::int as blocked from pg_stat_activity where query like '%forge_runs where id=$1 for update%' and cardinality(pg_blocking_pids(pid)) > 0`;
        if (Number(rows[0]?.blocked) === 3) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      unlock();
      await holding;
      const outcomes = await Promise.allSettled(pending);
      expect(outcomes).toHaveLength(3);
      expect(outcomes.every((outcome) => outcome.status === 'rejected')).toBe(true);
      await expect(fixture.store.hasActiveIntegrationClaim('race-run')).resolves.toBe(false);
      await expect(fixture.peer.recoverAttempts('race-run')).resolves.toMatchObject([
        { attempt: { state: 'PREPARING', revision: 1 } }
      ]);
      await expect(fixture.peer.recoverRepairAttempts('race-run')).resolves.toMatchObject([
        { attempt: { state: 'PREPARING', revision: 1 } }
      ]);
      await expect(fixture.peer.recoverLeases('race-run')).resolves.toEqual([]);
    } finally {
      unlock();
      await holding;
      await Promise.all([holder.end(), observer.end()]);
    }
  } finally {
    await fixture.close();
  }
}, 15_000);
