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

let directory: string;
let connectionString: string;
let role: string;
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
    role = String(identity[0]?.name);
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
  await admin.unsafe(`create schema "${schema}"`);
  const configuration = { connectionString, schema, role };
  let store: PostgresOrchestrationPersistence | undefined;
  let peer: PostgresOrchestrationPersistence | undefined;
  try {
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

it('fails closed on missing schema, wrong role, and malformed persisted run evidence', async () => {
  const fixture = await createFixture();
  const admin = postgres(connectionString, { onnotice: () => undefined });
  try {
    await expect(
      PostgresOrchestrationPersistence.connect({
        connectionString,
        schema: 'forge_missing_schema',
        role
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
      connectionString,
      schema: fixture.schema,
      role
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
      connectionString,
      schema: fixture.schema,
      role
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
