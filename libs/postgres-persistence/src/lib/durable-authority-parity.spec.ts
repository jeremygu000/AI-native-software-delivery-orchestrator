import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import postgres from 'postgres';
import { DeterministicScheduler } from '@ai-native-software-delivery-orchestrator/scheduler';
import { ForgeReadModel } from '@ai-native-software-delivery-orchestrator/orchestration-runtime';
import {
  taskLeasePlanFingerprint,
  taskVerificationEvidenceFingerprint,
  FencedMutationPort,
  type GlobalMutationClaim
} from '@ai-native-software-delivery-orchestrator/domain';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import {
  durableAuthorityContract,
  durableAuthorityInitialDispatch,
  durableAuthorityRepairAttempt,
  durableAuthorityRepairWorkItem,
  durableAuthorityRunRequest,
  type DurableAuthorityFixture
} from '../../../persistence/src/lib/durable-authority.contract.test.js';
import {
  globalMutationCutoverContract,
  globalMutationPermitContract,
  type GlobalMutationCutoverFixture,
  type GlobalMutationPermitFixture
} from '../../../persistence/src/lib/global-mutation-authority.contract.test.js';
import { PostgresGlobalMutationAuthority } from './postgres-global-mutation-authority.js';
import { PostgresOrchestrationPersistence } from './postgres-orchestration-persistence.js';
import {
  assertPostgresAuthoritySchema,
  assertPostgresGlobalAuthoritySchema,
  migratePostgresAuthoritySchema,
  POSTGRES_AUTHORITY_SCHEMA_VERSION,
  POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION
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

const createGlobalPermitFixture = async (): Promise<
  GlobalMutationPermitFixture & {
    schema: string;
    admin: ReturnType<typeof postgres>;
    store: PostgresOrchestrationPersistence;
  }
> => {
  const schema = `forge_global_adapter_${++fixtureOrdinal}`;
  const migration = { connectionString: ownerConnectionString, schema, role };
  const runtime = { connectionString: runtimeConnectionString, schema, role: runtimeRole };
  const admin = postgres(connectionString, { onnotice: () => undefined });
  let store: PostgresOrchestrationPersistence | undefined;
  let authority: PostgresGlobalMutationAuthority | undefined;
  let peer: PostgresGlobalMutationAuthority | undefined;
  try {
    await migratePostgresAuthoritySchema(
      migration,
      runtimeRole,
      POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION
    );
    store = await PostgresOrchestrationPersistence.connect(runtime);
    authority = await PostgresGlobalMutationAuthority.connect(runtime);
    peer = await PostgresGlobalMutationAuthority.connect(runtime);
    const scopeId = await authority.registerScope('contract-repository');
    await authority.beginLegacyCutover();
    await authority.completeLegacyCutover('The previous writers are stopped.');
    await authority.activateScope(scopeId);
    const runId = `global-run-${fixtureOrdinal}`;
    const request = durableAuthorityRunRequest(runId);
    await store.createRun(request);
    await authority.bindRun(runId, request.run.repositoryId);
    const binding = request.taskBindings[0];
    if (binding === undefined) {
      throw new Error('Missing global test binding');
    }
    for (const attemptId of ['original', 'replacement']) {
      await store.persistAttempt({
        runId,
        attempt: {
          id: attemptId,
          runId,
          taskId: 'task-1',
          agentId: 'agent-1',
          workspaceId: 'workspace-1',
          leasePlanFingerprint: taskLeasePlanFingerprint(binding.leasePlan),
          state: 'PREPARING',
          revision: 1
        }
      });
    }
    const originalClaim: GlobalMutationClaim = {
      scopeId,
      claimId: 'original-claim',
      owner: { runId, taskId: 'task-1', attemptId: 'original', agentId: 'agent-1' },
      resources: [{ type: 'project', projectId: 'project-1' }]
    };
    const originalGrant = await authority.claimGlobalMutation(originalClaim);
    if (originalGrant.status !== 'granted') {
      throw new Error('Fixture claim was not granted');
    }
    let ownerClosed = false;
    return {
      schema,
      admin,
      store,
      authority,
      peer,
      scopeId,
      originalClaim,
      originalGrant,
      replacementClaim: {
        ...originalClaim,
        claimId: 'replacement-claim',
        owner: { ...originalClaim.owner, attemptId: 'replacement' }
      },
      closeOwnerConnectionWithoutEnd: async () => {
        await authority.close();
        ownerClosed = true;
      },
      close: async () => {
        if (!ownerClosed) {
          await authority.close();
        }
        await peer.close();
        await store.close();
        await admin.unsafe(`drop schema "${schema}" cascade`);
        await admin.end();
      }
    };
  } catch (error) {
    await Promise.all([authority?.close(), peer?.close(), store?.close()]);
    await admin.unsafe(`drop schema if exists "${schema}" cascade`);
    await admin.end();
    throw error;
  }
};

globalMutationPermitContract('PostgreSQL isolated server', createGlobalPermitFixture);

it('refuses a legacy PostgreSQL worker at GLOBAL_READY even on an already connected store', async () => {
  const fixture = await createGlobalPermitFixture();
  try {
    await expect(fixture.store.assertLegacyWorkerCompositionAllowed()).rejects.toThrow(
      'Legacy worker composition is closed by global cutover'
    );
  } finally {
    await fixture.close();
  }
});

it('refuses a legacy PostgreSQL worker when the cutover starts after store connection', async () => {
  const schema = `forge_worker_cutover_${++fixtureOrdinal}`;
  const runtime = { connectionString: runtimeConnectionString, schema, role: runtimeRole };
  const admin = postgres(connectionString);
  let store: PostgresOrchestrationPersistence | undefined;
  let authority: PostgresGlobalMutationAuthority | undefined;
  try {
    await migratePostgresAuthoritySchema(
      { connectionString: ownerConnectionString, schema, role },
      runtimeRole,
      POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION
    );
    store = await PostgresOrchestrationPersistence.connect(runtime);
    authority = await PostgresGlobalMutationAuthority.connect(runtime);
    await store.assertLegacyWorkerCompositionAllowed();
    await authority.beginLegacyCutover();
    await expect(store.assertLegacyWorkerCompositionAllowed()).rejects.toThrow(
      'Legacy worker composition is closed by global cutover'
    );
  } finally {
    await Promise.all([store?.close(), authority?.close()]);
    await admin.unsafe(`drop schema if exists "${schema}" cascade`);
    await admin.end();
  }
});

const createGlobalCutoverFixture = async (): Promise<GlobalMutationCutoverFixture> => {
  const schema = `forge_global_race_${++fixtureOrdinal}`;
  const migration = { connectionString: ownerConnectionString, schema, role };
  const runtime = { connectionString: runtimeConnectionString, schema, role: runtimeRole };
  const admin = postgres(connectionString, { onnotice: () => undefined });
  let store: PostgresOrchestrationPersistence | undefined;
  let authority: PostgresGlobalMutationAuthority | undefined;
  let peer: PostgresGlobalMutationAuthority | undefined;
  let blocker: ReturnType<typeof postgres> | undefined;
  let unblock: (() => void) | undefined;
  let blocking: Promise<void> | undefined;
  try {
    await migratePostgresAuthoritySchema(
      migration,
      runtimeRole,
      POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION
    );
    store = await PostgresOrchestrationPersistence.connect(runtime);
    authority = await PostgresGlobalMutationAuthority.connect(runtime);
    peer = await PostgresGlobalMutationAuthority.connect(runtime);
    const scopeId = await authority.registerScope('registered-A');
    const runId = `historical-${fixtureOrdinal}`;
    const original = durableAuthorityRunRequest(runId);
    const request = { ...original, run: { ...original.run, repositoryId: 'unregistered-B' } };
    await store.createRun(request);
    const plan = request.taskBindings[0]?.leasePlan;
    if (plan === undefined) {
      throw new Error('Missing historical binding');
    }
    await store.persistAttempt({
      runId,
      attempt: {
        id: 'builder-attempt',
        runId,
        taskId: 'task-1',
        agentId: 'agent-1',
        workspaceId: 'workspace-1',
        leasePlanFingerprint: taskLeasePlanFingerprint(plan),
        state: 'PREPARING',
        revision: 1
      }
    });
    const repair = {
      ...durableAuthorityRepairAttempt('repair-attempt'),
      runId,
      parentReviewSubject: {
        ...durableAuthorityRepairAttempt('repair-attempt').parentReviewSubject,
        builderAttemptId: 'builder-attempt'
      }
    };
    await store.persistRepairAttempt({ runId, attempt: repair });
    const timestamp = new Date('2026-09-29T00:00:00.000Z');
    const lease = {
      id: 'admitted-lease',
      runId,
      agentId: 'agent-1',
      taskId: 'task-1',
      resource: { type: 'project' as const, projectId: 'project-1' },
      mode: 'exclusive' as const,
      version: 1,
      state: 'ACTIVE' as const,
      acquiredAt: timestamp,
      lastHeartbeatAt: timestamp
    };
    const savedStore = store;
    const savedAuthority = authority;
    const savedPeer = peer;
    const admitted = async (kind: 'builder' | 'repair' | 'integration' | 'dynamic-lease') => {
      if (kind === 'builder') {
        await savedStore.claimBuilderStart({
          runId,
          attempt: {
            id: 'builder-attempt',
            runId,
            taskId: 'task-1',
            agentId: 'agent-1',
            workspaceId: 'workspace-1',
            leasePlanFingerprint: taskLeasePlanFingerprint(plan),
            state: 'STARTING',
            revision: 2,
            startedAt: timestamp
          },
          leases: [lease]
        });
        return { ownerKey: `builder:${runId}:builder-attempt` };
      }
      if (kind === 'repair') {
        await savedStore.claimRepairStart({
          runId,
          attempt: {
            ...repair,
            state: 'STARTING',
            revision: 2,
            startedAt: timestamp
          }
        });
        return { ownerKey: `repair:${runId}:repair-attempt` };
      }
      if (kind === 'integration') {
        await savedStore.claimIntegrationStart({
          runId,
          taskId: 'task-1',
          workspaceId: 'workspace-1',
          outputAttemptId: 'builder-attempt'
        });
        return { ownerKey: `integration:${runId}:task-1` };
      }
      await savedStore.persistLease({ runId, lease });
      return { ownerKey: `lease:${runId}:admitted-lease` };
    };
    const waiting = async (
      application: 'forge-authority' | 'forge-global-authority',
      target: 'gate' | 'admission' | 'inventory' = 'gate'
    ) => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const rows = await admin`select 1 from pg_stat_activity where datname=current_database()
          and application_name=${application} and wait_event_type='Lock'
          and query like ${`%"${schema}".${target === 'gate' ? 'forge_global_control' : target === 'admission' ? 'forge_runs' : 'forge_global_legacy_owners'}%`} limit 1`;
        if (rows.length) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`${application} did not wait on the deployment gate`);
    };
    const holdContention = async (target: 'admission' | 'inventory') => {
      blocker = postgres(runtimeConnectionString, { onnotice: () => undefined });
      let signal: (() => void) | undefined;
      const acquired = new Promise<void>((resolve) => {
        signal = resolve;
      });
      const release = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      blocking = blocker
        .begin(async (tx) => {
          if (target === 'admission') {
            await tx.unsafe(`select id from "${schema}".forge_runs where id=$1 for update`, [
              runId
            ]);
          } else {
            await tx.unsafe(
              `lock table "${schema}".forge_global_legacy_owners in access exclusive mode`
            );
          }
          signal?.();
          await release;
        })
        .then(() => undefined);
      await acquired;
      return () => unblock?.();
    };
    const evidence = async () => {
      const rows = await admin.unsafe(
        `select kind,key,payload from "${schema}".forge_records
        where run_id=$1 and kind in ('builder','repair','lease','integration-claim') order by kind,key`,
        [runId]
      );
      return {
        attempts: rows
          .filter((row) => row.kind === 'builder' || row.kind === 'repair')
          .map((row) => `${row.kind}:${row.key}:${row.payload}`),
        leases: rows
          .filter((row) => row.kind === 'lease')
          .map((row) => `${row.key}:${row.payload}`),
        integrationClaims: rows
          .filter((row) => row.kind === 'integration-claim')
          .map((row) => `${row.key}:${row.payload}`)
      };
    };
    return {
      authority: savedAuthority,
      peer: savedPeer,
      scopeId,
      registeredRepositoryId: 'registered-A',
      unregisteredRepositoryId: 'unregistered-B',
      historicalRunId: runId,
      holdLegacyAdmissionAtGate: async (kind) => {
        const release = await holdContention('admission');
        const finished = admitted(kind);
        await waiting('forge-authority', 'admission');
        const gate =
          await admin.unsafe(`select 1 from pg_locks l join pg_class c on c.oid=l.relation
          where c.oid='"${schema}".forge_global_control'::regclass and l.mode='RowShareLock' and l.granted
          and l.pid in (select pid from pg_stat_activity where application_name='forge-authority' and wait_event_type='Lock')`);
        expect(gate).toHaveLength(1);
        return { finished, release };
      },
      holdCutoverAtGate: async () => {
        const release = await holdContention('inventory');
        const finished = savedAuthority.beginLegacyCutover();
        await waiting('forge-global-authority', 'inventory');
        const gate =
          await admin.unsafe(`select 1 from pg_locks l join pg_class c on c.oid=l.relation
          where c.oid='"${schema}".forge_global_control'::regclass and l.mode='RowShareLock' and l.granted
          and l.pid in (select pid from pg_stat_activity where application_name='forge-global-authority' and wait_event_type='Lock')`);
        expect(gate).toHaveLength(1);
        return { finished, release };
      },
      admitLegacyWriter: async (kind) => {
        await admitted(kind);
      },
      assertWaitingOnGate: async (operation) => {
        await waiting(operation === 'cutover' ? 'forge-global-authority' : 'forge-authority');
      },
      readLegacyWriterEvidence: evidence,
      assertRejectedAdmissionHasNoStartResidue: async (kind) => {
        const rows = await evidence();
        if (kind === 'builder') {
          expect(rows.attempts.find((value) => value.startsWith('builder:'))).toContain(
            '"state":"PREPARING"'
          );
          expect(rows.leases).toEqual([]);
        }
        if (kind === 'repair') {
          expect(rows.attempts.find((value) => value.startsWith('repair:'))).toContain(
            '"state":"PREPARING"'
          );
          const history = await admin.unsafe(
            `select 1 from "${schema}".forge_records where run_id=$1 and kind='repair-history'`,
            [runId]
          );
          expect(history).toHaveLength(0);
        }
      },
      close: async () => {
        unblock?.();
        await blocking?.catch(() => undefined);
        await blocker?.end();
        await Promise.all([savedAuthority.close(), savedPeer.close(), savedStore.close()]);
        await admin.unsafe(`drop schema "${schema}" cascade`);
        await admin.end();
      }
    };
  } catch (error) {
    unblock?.();
    await blocking?.catch(() => undefined);
    await Promise.all([blocker?.end(), authority?.close(), peer?.close(), store?.close()]);
    await admin.unsafe(`drop schema if exists "${schema}" cascade`);
    await admin.end();
    throw error;
  }
};

globalMutationCutoverContract('PostgreSQL isolated server', createGlobalCutoverFixture);

const holdRow = async (schema: string, table: 'forge_runs' | 'forge_global_claims', id: string) => {
  const sql = postgres(runtimeConnectionString, { onnotice: () => undefined });
  let acquired: ((pid: number) => void) | undefined;
  let unblock: (() => void) | undefined;
  const ready = new Promise<number>((resolve) => {
    acquired = resolve;
  });
  const released = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const finished = sql.begin(async (tx) => {
    const rows = await tx.unsafe(
      table === 'forge_runs'
        ? `select pg_backend_pid() as pid from "${schema}".forge_runs where id=$1 for update`
        : `select pg_backend_pid() as pid from "${schema}".forge_global_claims where claim_id=$1 for update`,
      [id]
    );
    if (rows.length !== 1) {
      throw new Error('Missing controlled overlap row');
    }
    acquired?.(Number(rows[0]?.pid));
    await released;
  });
  try {
    const pid = await ready;
    return {
      pid,
      release: () => unblock?.(),
      close: async () => {
        unblock?.();
        await finished;
        await sql.end();
      }
    };
  } catch (error) {
    unblock?.();
    await finished.catch(() => undefined);
    await sql.end();
    throw error;
  }
};

const blockedBackend = async (
  admin: ReturnType<typeof postgres>,
  schema: string,
  application: 'forge-authority' | 'forge-global-authority',
  table: 'forge_runs' | 'forge_global_scopes' | 'forge_global_claims'
): Promise<{ pid: number; blockers: number[] }> => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const rows = await admin`select pid, pg_blocking_pids(pid) as blockers from pg_stat_activity
      where datname=current_database() and application_name=${application}
      and wait_event_type='Lock' and query like ${`%"${schema}".${table}%`}`;
    const row = rows[0];
    if (row !== undefined) {
      const blockers: unknown = row.blockers;
      if (!Array.isArray(blockers) || !blockers.every((pid) => typeof pid === 'number')) {
        throw new Error('Unexpected PostgreSQL blocking PID evidence');
      }
      return { pid: Number(row.pid), blockers: blockers.map(Number) };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${application} did not block on ${table}`);
};

const createScopeOverlapFixture = async () => {
  const fixture = await createGlobalPermitFixture();
  const { authority, peer, store, scopeId, originalClaim, originalGrant, schema } = fixture;
  const third = await PostgresGlobalMutationAuthority.connect({
    connectionString: runtimeConnectionString,
    schema,
    role: runtimeRole
  });
  try {
    const lease = (await peer.recoverRepositoryMutationAuthority(scopeId))[0];
    if (lease === undefined) {
      throw new Error('Missing original claim');
    }
    await peer.releaseGlobalMutation({
      scopeId,
      claimId: originalClaim.claimId,
      owner: originalClaim.owner,
      token: originalGrant.token,
      expectedVersion: lease.version,
      stopEvidence: 'Original writer stopped before overlap.'
    });
    const otherRunId = `competing-${fixtureOrdinal}`;
    await authority.registerAlias(scopeId, 'overlap-alias');
    const request = durableAuthorityRunRequest(otherRunId);
    await store.createRun({ ...request, run: { ...request.run, repositoryId: 'overlap-alias' } });
    await third.bindRun(otherRunId, 'overlap-alias');
    const binding = request.taskBindings[0];
    if (binding === undefined) {
      throw new Error('Missing competing binding');
    }
    await store.persistAttempt({
      runId: otherRunId,
      attempt: {
        id: 'other-builder',
        runId: otherRunId,
        taskId: 'task-1',
        agentId: 'agent-1',
        workspaceId: 'workspace-1',
        leasePlanFingerprint: taskLeasePlanFingerprint(binding.leasePlan),
        state: 'PREPARING',
        revision: 1
      }
    });
    const competing: GlobalMutationClaim = {
      scopeId,
      claimId: 'competing-claim',
      owner: {
        runId: otherRunId,
        taskId: 'task-1',
        attemptId: 'other-builder',
        agentId: 'agent-1'
      },
      resources: [{ type: 'project', projectId: 'project-1' }]
    };
    return {
      ...fixture,
      third,
      competing,
      close: async () => {
        await third.close();
        await fixture.close();
      }
    };
  } catch (error) {
    await third.close();
    await fixture.close();
    throw error;
  }
};

it('uses the actual scope row to serialize competing cross-run claims and persists only the winner', async () => {
  const fixture = await createScopeOverlapFixture();
  const { admin, schema, replacementClaim, competing, authority, peer, third } = fixture;
  const blocker = await holdRow(schema, 'forge_runs', replacementClaim.owner.runId);
  let first: Promise<Awaited<ReturnType<typeof authority.claimGlobalMutation>>> | undefined;
  let second: Promise<Awaited<ReturnType<typeof authority.claimGlobalMutation>>> | undefined;
  try {
    first = authority.claimGlobalMutation(replacementClaim);
    const a = await blockedBackend(admin, schema, 'forge-global-authority', 'forge_runs');
    expect(a.blockers).toContain(blocker.pid);
    second = peer.claimGlobalMutation(competing);
    const b = await blockedBackend(admin, schema, 'forge-global-authority', 'forge_global_scopes');
    expect(b.blockers).toContain(a.pid);
    blocker.release();
    expect(await first).toMatchObject({ status: 'granted' });
    expect(await second).toMatchObject({ status: 'blocked' });
    const rows = await admin.unsafe(
      `select claim_id,state from "${schema}".forge_global_claims where claim_id in ($1,$2) order by claim_id`,
      [replacementClaim.claimId, competing.claimId]
    );
    expect(rows).toMatchObject([{ claim_id: replacementClaim.claimId, state: 'ACTIVE' }]);
    expect(await third.recoverRepositoryMutationAuthority(fixture.scopeId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ claimId: replacementClaim.claimId })])
    );
    expect(
      await admin.unsafe(
        `select payload from "${schema}".forge_records where run_id=$1 and kind='builder' and key=$2`,
        [competing.owner.runId, competing.owner.attemptId]
      )
    ).toEqual([
      expect.objectContaining({ payload: expect.stringContaining('"state":"PREPARING"') })
    ]);
  } finally {
    blocker.release();
    await Promise.allSettled([first, second]);
    await blocker.close();
    await fixture.close();
  }
});

it('grants another scope while a claim holds the first scope row', async () => {
  const fixture = await createScopeOverlapFixture();
  const { admin, schema, authority, peer, third, store, replacementClaim, scopeId } = fixture;
  let blocker: Awaited<ReturnType<typeof holdRow>> | undefined;
  let held: Promise<Awaited<ReturnType<typeof authority.claimGlobalMutation>>> | undefined;
  try {
    const otherScopeId = await authority.registerScope('independent-repository');
    await authority.activateScope(otherScopeId);
    const runId = `independent-${fixtureOrdinal}`;
    const request = durableAuthorityRunRequest(runId);
    await store.createRun({
      ...request,
      run: { ...request.run, repositoryId: 'independent-repository' }
    });
    await peer.bindRun(runId, 'independent-repository');
    const binding = request.taskBindings[0];
    if (binding === undefined) {
      throw new Error('Missing independent scope binding');
    }
    await store.persistAttempt({
      runId,
      attempt: {
        id: 'independent-builder',
        runId,
        taskId: 'task-1',
        agentId: 'agent-1',
        workspaceId: 'workspace-1',
        leasePlanFingerprint: taskLeasePlanFingerprint(binding.leasePlan),
        state: 'PREPARING',
        revision: 1
      }
    });
    blocker = await holdRow(schema, 'forge_runs', replacementClaim.owner.runId);
    held = authority.claimGlobalMutation(replacementClaim);
    const a = await blockedBackend(admin, schema, 'forge-global-authority', 'forge_runs');
    expect(a.blockers).toContain(blocker.pid);
    const granted = await third.claimGlobalMutation({
      scopeId: otherScopeId,
      claimId: 'independent-claim',
      owner: { runId, taskId: 'task-1', attemptId: 'independent-builder', agentId: 'agent-1' },
      resources: [{ type: 'project', projectId: 'project-1' }]
    });
    expect(granted).toMatchObject({ status: 'granted', token: 1 });
    expect(
      await admin.unsafe(
        `select id,next_token from "${schema}".forge_global_scopes
      where id in ($1,$2) order by id`,
        [scopeId, otherScopeId]
      )
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: scopeId, next_token: '1' }),
        expect.objectContaining({ id: otherScopeId, next_token: '1' })
      ])
    );
    expect((await blockedBackend(admin, schema, 'forge-global-authority', 'forge_runs')).pid).toBe(
      a.pid
    );
    blocker.release();
    expect(await held).toMatchObject({ status: 'granted', token: 2 });
  } finally {
    blocker?.release();
    await Promise.allSettled([held]);
    await blocker?.close();
    await fixture.close();
  }
});

it.each([
  ['request cancellation', 'CANCEL_REQUESTED'],
  ['finish failed', 'FAILED'],
  ['finish completed', 'COMPLETED']
] as const)(
  'serializes global claim and %s in both commit orders through the scope lock',
  async (operation, finalState) => {
    for (const claimFirst of [true, false]) {
      const fixture = await createScopeOverlapFixture();
      const { admin, schema, replacementClaim, authority, peer, third, store } = fixture;
      const runId = replacementClaim.owner.runId;
      const blocker = await holdRow(schema, 'forge_runs', runId);
      const lifecycle = async () =>
        operation === 'request cancellation'
          ? store.requestCancellation(runId)
          : store.updateRunState(runId, finalState);
      let first: Promise<unknown> | undefined;
      let second: Promise<unknown> | undefined;
      try {
        first = claimFirst ? authority.claimGlobalMutation(replacementClaim) : lifecycle();
        const holder = await blockedBackend(
          admin,
          schema,
          claimFirst ? 'forge-global-authority' : 'forge-authority',
          'forge_runs'
        );
        expect(holder.blockers).toContain(blocker.pid);
        second = claimFirst ? lifecycle() : peer.claimGlobalMutation(replacementClaim);
        const waiter = await blockedBackend(
          admin,
          schema,
          claimFirst ? 'forge-authority' : 'forge-global-authority',
          'forge_global_scopes'
        );
        expect(waiter.blockers).toContain(holder.pid);
        blocker.release();
        if (claimFirst) {
          expect(await first).toMatchObject({ status: 'granted' });
          await second;
        } else {
          await first;
          await expect(second).rejects.toThrow();
        }
        expect(
          (await third.recoverRepositoryMutationAuthority(fixture.scopeId)).filter(
            (lease) => lease.claimId === replacementClaim.claimId
          )
        ).toHaveLength(claimFirst ? 1 : 0);
        expect(
          await admin.unsafe(`select state from "${schema}".forge_runs where id=$1`, [runId])
        ).toMatchObject([{ state: finalState }]);
        const attempts = await admin.unsafe(
          `select payload from "${schema}".forge_records where run_id=$1 and kind='builder' and key='replacement'`,
          [runId]
        );
        expect(JSON.parse(String(attempts[0]?.payload))).toMatchObject({
          state: claimFirst ? 'STARTING' : 'PREPARING'
        });
        if (finalState === 'CANCEL_REQUESTED') {
          expect(await store.finalizeCancellation(runId)).toMatchObject({ state: 'CANCELLED' });
          expect(
            await admin.unsafe(`select state from "${schema}".forge_runs where id=$1`, [runId])
          ).toMatchObject([{ state: 'CANCELLED' }]);
        }
      } finally {
        blocker.release();
        await Promise.allSettled([first, second]);
        await blocker.close();
        await fixture.close();
      }
    }
  }
);

it.each(['release', 'reclaim'] as const)(
  'serializes %s against a stale fenced write at the scope row before callback execution',
  async (operation) => {
    const fixture = await createGlobalPermitFixture();
    const { admin, schema, authority, peer, originalClaim, originalGrant, scopeId } = fixture;
    const third = await PostgresGlobalMutationAuthority.connect({
      connectionString: runtimeConnectionString,
      schema,
      role: runtimeRole
    });
    let blocker: Awaited<ReturnType<typeof holdRow>> | undefined;
    let transition: Promise<void> | undefined;
    let attempted: Promise<unknown> | undefined;
    try {
      if (operation === 'reclaim') {
        await authority.markMutationUncertain({
          scopeId,
          claimId: originalClaim.claimId,
          owner: originalClaim.owner,
          token: originalGrant.token,
          evidence: 'The worker outcome is uncertain.'
        });
      }
      const lease = (await third.recoverRepositoryMutationAuthority(scopeId))[0];
      if (lease === undefined) {
        throw new Error('Missing claim for transition overlap');
      }
      blocker = await holdRow(schema, 'forge_global_claims', originalClaim.claimId);
      transition =
        operation === 'release'
          ? authority.releaseGlobalMutation({
              scopeId,
              claimId: originalClaim.claimId,
              owner: originalClaim.owner,
              token: originalGrant.token,
              expectedVersion: lease.version,
              stopEvidence: 'Original writer is stopped.'
            })
          : authority.reclaimUncertainMutation({
              scopeId,
              claimId: originalClaim.claimId,
              owner: originalClaim.owner,
              token: originalGrant.token,
              expectedVersion: lease.version,
              verifiedQuiescenceEvidence: 'The old worker is verified quiescent.'
            });
      const holder = await blockedBackend(
        admin,
        schema,
        'forge-global-authority',
        'forge_global_claims'
      );
      expect(holder.blockers).toContain(blocker.pid);
      const callback = vi.fn(async () => 'unsafe stale write');
      attempted = new FencedMutationPort(peer).execute(
        {
          scopeId,
          claimId: originalClaim.claimId,
          owner: originalClaim.owner,
          token: originalGrant.token,
          resource: { type: 'project', projectId: 'project-1' }
        },
        callback
      );
      const waiter = await blockedBackend(
        admin,
        schema,
        'forge-global-authority',
        'forge_global_scopes'
      );
      expect(waiter.blockers).toContain(holder.pid);
      blocker.release();
      await transition;
      await expect(attempted).rejects.toThrow();
      expect(callback).not.toHaveBeenCalled();
      expect((await third.recoverRepositoryMutationAuthority(scopeId))[0]).toMatchObject({
        state: 'RELEASED'
      });
      expect(await third.recoverFencedMutationPermits(scopeId)).toEqual([]);
      expect(
        await admin.unsafe(
          `select state,version from "${schema}".forge_global_claims where claim_id=$1`,
          [originalClaim.claimId]
        )
      ).toMatchObject([{ state: 'RELEASED', version: operation === 'release' ? '2' : '3' }]);
    } finally {
      blocker?.release();
      await Promise.allSettled([transition, attempted]);
      await blocker?.close();
      await third.close();
      await fixture.close();
    }
  }
);

it('fences competing runs in the same scope across a third PostgreSQL connection', async () => {
  const fixture = await createGlobalPermitFixture();
  const { authority, peer, store, originalClaim, originalGrant, scopeId, schema, admin } = fixture;
  const third = await PostgresGlobalMutationAuthority.connect({
    connectionString: runtimeConnectionString,
    schema,
    role: runtimeRole
  });
  try {
    await authority.registerAlias(scopeId, 'second-alias');
    const runId = 'second-run';
    const request = durableAuthorityRunRequest(runId);
    await store.createRun({ ...request, run: { ...request.run, repositoryId: 'second-alias' } });
    await third.bindRun(runId, 'second-alias');
    const binding = request.taskBindings[0];
    if (binding === undefined) {
      throw new Error('Missing competing run binding');
    }
    await store.persistAttempt({
      runId,
      attempt: {
        id: 'second-builder',
        runId,
        taskId: 'task-1',
        agentId: 'agent-1',
        workspaceId: 'workspace-1',
        leasePlanFingerprint: taskLeasePlanFingerprint(binding.leasePlan),
        state: 'PREPARING',
        revision: 1
      }
    });
    const competing: GlobalMutationClaim = {
      scopeId,
      claimId: 'second-claim',
      owner: { runId, taskId: 'task-1', attemptId: 'second-builder', agentId: 'agent-1' },
      resources: [{ type: 'project', projectId: 'project-1' }]
    };
    expect(await third.claimGlobalMutation(competing)).toMatchObject({
      status: 'blocked',
      blockers: [
        expect.objectContaining({ claimId: originalClaim.claimId, token: originalGrant.token })
      ]
    });
    const lease = (await peer.recoverRepositoryMutationAuthority(scopeId))[0];
    if (lease === undefined) {
      throw new Error('Missing original lease');
    }
    await peer.markMutationUncertain({
      scopeId,
      claimId: originalClaim.claimId,
      owner: originalClaim.owner,
      token: originalGrant.token,
      evidence: 'Worker outcome is uncertain.'
    });
    expect(await third.claimGlobalMutation(competing)).toMatchObject({
      status: 'blocked',
      blockers: [expect.objectContaining({ state: 'HELD_UNCERTAIN' })]
    });
    await authority.reclaimUncertainMutation({
      scopeId,
      claimId: originalClaim.claimId,
      owner: originalClaim.owner,
      token: originalGrant.token,
      expectedVersion: lease.version + 1,
      verifiedQuiescenceEvidence: 'The old worker has stopped.'
    });
    const granted = await third.claimGlobalMutation(competing);
    expect(granted).toMatchObject({ status: 'granted' });
    if (granted.status !== 'granted') {
      throw new Error('Competing claim was not granted');
    }
    expect(granted.token).toBeGreaterThan(originalGrant.token);
    const rows = await admin.unsafe(
      `select claim_id,token,state from "${schema}".forge_global_claims order by claim_id`
    );
    expect(rows).toMatchObject([
      { claim_id: originalClaim.claimId, state: 'RELEASED' },
      { claim_id: competing.claimId, state: 'ACTIVE' }
    ]);
    expect(await peer.recoverRepositoryMutationAuthority(scopeId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ claimId: competing.claimId, token: granted.token })
      ])
    );
  } finally {
    await third.close();
    await fixture.close();
  }
});

it('rejects invented, mismatched, or overbroad global admissions without consuming a token', async () => {
  const fixture = await createGlobalPermitFixture();
  try {
    const { peer, originalClaim, replacementClaim, schema, admin, scopeId, originalGrant } =
      fixture;
    const before = await admin.unsafe(
      `select next_token from "${schema}".forge_global_scopes where id=$1`,
      [scopeId]
    );
    for (const [claimId, owner] of [
      ['unknown-attempt', { ...replacementClaim.owner, attemptId: 'absent' }],
      ['wrong-task', { ...replacementClaim.owner, taskId: 'absent' }],
      ['wrong-agent', { ...replacementClaim.owner, agentId: 'absent' }],
      ['already-started', originalClaim.owner]
    ] as const) {
      await expect(
        peer.claimGlobalMutation({ ...replacementClaim, claimId, owner })
      ).rejects.toThrow();
    }
    for (const resources of [
      [{ type: 'repository' as const }],
      [{ type: 'project' as const, projectId: 'different-project' }]
    ]) {
      await expect(peer.claimGlobalMutation({ ...replacementClaim, resources })).rejects.toThrow(
        'exceeds the approved lease plan'
      );
    }
    expect(
      await admin.unsafe(`select next_token from "${schema}".forge_global_scopes where id=$1`, [
        scopeId
      ])
    ).toEqual(before);
    expect(
      await admin.unsafe(`select claim_id from "${schema}".forge_global_claims`)
    ).toMatchObject([{ claim_id: originalClaim.claimId }]);
    expect(await peer.claimGlobalMutation(originalClaim)).toMatchObject({
      status: 'granted',
      token: originalGrant.token
    });
    expect(await peer.claimGlobalMutation(replacementClaim)).toMatchObject({ status: 'blocked' });
    const lease = (await peer.recoverRepositoryMutationAuthority(scopeId))[0];
    if (lease === undefined) {
      throw new Error('Missing original claim');
    }
    await peer.releaseGlobalMutation({
      scopeId,
      claimId: originalClaim.claimId,
      owner: originalClaim.owner,
      token: originalGrant.token,
      expectedVersion: lease.version,
      stopEvidence: 'Worker stopped.'
    });
    const replacement = await peer.claimGlobalMutation(replacementClaim);
    expect(replacement).toMatchObject({ status: 'granted' });
    if (replacement.status !== 'granted') {
      throw new Error('Missing replacement claim');
    }
    expect(replacement.token).toBeGreaterThan(originalGrant.token);
    const row = await admin.unsafe(
      `select payload from "${schema}".forge_records where run_id=$1 and kind='builder' and key='replacement'`,
      [originalClaim.owner.runId]
    );
    expect(JSON.parse(String(row[0]?.payload))).toMatchObject({ state: 'STARTING', revision: 2 });
  } finally {
    await fixture.close();
  }
});

it('advances an admitted repair attempt and its history in the same claim transaction', async () => {
  const fixture = await createGlobalPermitFixture();
  try {
    const { store, peer, admin, schema, scopeId, originalClaim, originalGrant } = fixture;
    const runId = originalClaim.owner.runId;
    const repair = {
      ...durableAuthorityRepairAttempt('repair-attempt'),
      runId,
      parentReviewSubject: {
        ...durableAuthorityRepairAttempt('repair-attempt').parentReviewSubject,
        builderAttemptId: 'original'
      }
    };
    await store.persistRepairAttempt({ runId, attempt: repair });
    const claim: GlobalMutationClaim = {
      scopeId,
      claimId: 'repair-claim',
      owner: { runId, taskId: 'task-1', attemptId: repair.id, agentId: repair.agentId },
      resources: [{ type: 'project', projectId: 'project-1' }]
    };
    await expect(peer.claimGlobalMutation(claim)).rejects.toThrow('no admitted work item');
    const binding = await store.recoverTaskBinding(runId, 'task-1');
    if (binding === undefined) {
      throw new Error('Missing repair binding');
    }
    await store.persistRepairWorkItem({
      ...durableAuthorityRepairWorkItem({ ...repair, runId }),
      builderAttemptId: 'original',
      leasePlanFingerprint: taskLeasePlanFingerprint(binding.leasePlan)
    });
    expect(await peer.claimGlobalMutation(claim)).toMatchObject({ status: 'blocked' });
    const lease = (await peer.recoverRepositoryMutationAuthority(scopeId))[0];
    if (lease === undefined) {
      throw new Error('Missing original lease');
    }
    await peer.releaseGlobalMutation({
      scopeId,
      claimId: originalClaim.claimId,
      owner: originalClaim.owner,
      token: originalGrant.token,
      expectedVersion: lease.version,
      stopEvidence: 'Worker stopped.'
    });
    expect(await peer.claimGlobalMutation(claim)).toMatchObject({ status: 'granted' });
    const rows = await admin.unsafe(
      `select kind,payload from "${schema}".forge_records where run_id=$1 and kind in ('repair','repair-history') order by kind`,
      [runId]
    );
    expect(rows.map((row) => [row.kind, JSON.parse(String(row.payload)).state])).toEqual([
      ['repair', 'STARTING'],
      ['repair-history', 'PREPARING']
    ]);
  } finally {
    await fixture.close();
  }
});

it('keeps unknown-alias historical owners blocking every scope until classified and imported', async () => {
  const schema = `forge_global_import_${++fixtureOrdinal}`;
  const runtime = { connectionString: runtimeConnectionString, schema, role: runtimeRole };
  const admin = postgres(connectionString, { onnotice: () => undefined });
  let store: PostgresOrchestrationPersistence | undefined;
  let authority: PostgresGlobalMutationAuthority | undefined;
  let peer: PostgresGlobalMutationAuthority | undefined;
  try {
    await migratePostgresAuthoritySchema(
      { connectionString: ownerConnectionString, schema, role },
      runtimeRole,
      POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION
    );
    store = await PostgresOrchestrationPersistence.connect(runtime);
    authority = await PostgresGlobalMutationAuthority.connect(runtime);
    peer = await PostgresGlobalMutationAuthority.connect(runtime);
    const scopeId = await authority.registerScope('known-repository');
    await store.createRun({
      ...durableAuthorityRunRequest('historical-run'),
      run: {
        ...durableAuthorityRunRequest('historical-run').run,
        repositoryId: 'unregistered-repository'
      }
    });
    await authority.beginLegacyCutover();
    expect(await peer.recoverLegacyOwners()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'run:historical-run',
          repositoryId: 'unregistered-repository',
          kind: 'run'
        })
      ])
    );
    await expect(peer.completeLegacyCutover('Workers stopped.')).rejects.toThrow('unresolved');
    await expect(peer.activateScope(scopeId)).rejects.toThrow('not globally ready');
    await peer.importLegacyOwner('run:historical-run', scopeId, {
      type: 'file',
      projectId: 'guess',
      fileId: 'guess'
    });
    await peer.completeLegacyCutover('All previous worker processes are stopped.');
    await peer.activateScope(scopeId);
    expect(await authority.registerScope('unregistered-repository')).toBe(scopeId);
    const third = await PostgresGlobalMutationAuthority.connect(runtime);
    try {
      expect(await third.recoverRepositoryMutationAuthority(scopeId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            claimId: 'legacy:run:historical-run',
            state: 'HELD_UNCERTAIN',
            resource: { type: 'repository' }
          })
        ])
      );
    } finally {
      await third.close();
    }
    const audit = await admin.unsafe(`select action,evidence from "${schema}".forge_global_audit`);
    expect(audit).toMatchObject([
      { action: 'complete-legacy-cutover', evidence: 'All previous worker processes are stopped.' }
    ]);
  } finally {
    await Promise.all([store?.close(), authority?.close(), peer?.close()]);
    await admin.unsafe(`drop schema if exists "${schema}" cascade`);
    await admin.end();
  }
});

it('fails closed before allocating an unsafe BIGINT token', async () => {
  const fixture = await createGlobalPermitFixture();
  try {
    const { admin, schema, peer, originalClaim, originalGrant, replacementClaim, scopeId } =
      fixture;
    const lease = (await peer.recoverRepositoryMutationAuthority(scopeId))[0];
    if (lease === undefined) {
      throw new Error('Missing original lease');
    }
    await peer.releaseGlobalMutation({
      scopeId,
      claimId: originalClaim.claimId,
      owner: originalClaim.owner,
      token: originalGrant.token,
      expectedVersion: lease.version,
      stopEvidence: 'Worker stopped.'
    });
    await admin.unsafe(`update "${schema}".forge_global_scopes set next_token=$2 where id=$1`, [
      scopeId,
      String(Number.MAX_SAFE_INTEGER)
    ]);
    await expect(peer.claimGlobalMutation(replacementClaim)).rejects.toThrow('token exhausted');
    const rows = await admin.unsafe(
      `select payload from "${schema}".forge_records where run_id=$1 and kind='builder' and key='replacement'`,
      [originalClaim.owner.runId]
    );
    expect(JSON.parse(String(rows[0]?.payload))).toMatchObject({ state: 'PREPARING', revision: 1 });
    expect(
      await admin.unsafe(
        `select claim_id from "${schema}".forge_global_claims where claim_id='replacement-claim'`
      )
    ).toEqual([]);
  } finally {
    await fixture.close();
  }
});

it('atomically creates a v4 run with its pre-registered scope and rejects missing aliases or cutover', async () => {
  const schema = `forge_launch_binding_${++fixtureOrdinal}`;
  const migration = { connectionString: ownerConnectionString, schema, role };
  const runtime = { connectionString: runtimeConnectionString, schema, role: runtimeRole };
  const admin = postgres(connectionString, { onnotice: () => undefined });
  let store: PostgresOrchestrationPersistence | undefined;
  let authority: PostgresGlobalMutationAuthority | undefined;
  try {
    await migratePostgresAuthoritySchema(
      migration,
      runtimeRole,
      POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION
    );
    store = await PostgresOrchestrationPersistence.connect(runtime);
    authority = await PostgresGlobalMutationAuthority.connect(runtime);
    expect(store.requiresGlobalRunBinding()).toBe(true);
    const missing = durableAuthorityRunRequest('missing-alias');
    await expect(store.createBoundRun(missing)).rejects.toThrow('Unregistered repository alias');
    expect(await store.recoverRun(missing.run.id)).toBeUndefined();
    const scopeId = await authority.registerScope(missing.run.repositoryId);
    const unbound = durableAuthorityRunRequest('unbound-legacy-run');
    await store.createRun(unbound);
    await expect(
      store.assertGlobalRunBinding(unbound.run.id, unbound.run.repositoryId)
    ).rejects.toThrow('matching immutable repository scope binding');
    await store.createBoundRun(missing);
    await store.assertGlobalRunBinding(missing.run.id, missing.run.repositoryId);
    const bindings = await admin.unsafe(
      `select run_id,repository_id,scope_id from "${schema}".forge_global_run_bindings where run_id=$1`,
      [missing.run.id]
    );
    expect(bindings).toMatchObject([
      { run_id: missing.run.id, repository_id: missing.run.repositoryId, scope_id: scopeId }
    ]);
    await expect(
      store.assertGlobalRunBinding(missing.run.id, 'different-repository')
    ).rejects.toThrow('matching immutable repository scope binding');
    await authority.beginLegacyCutover();
    await expect(store.createBoundRun(durableAuthorityRunRequest('after-barrier'))).rejects.toThrow(
      'Legacy run launch is closed'
    );
    expect(await store.recoverRun('after-barrier')).toBeUndefined();
    await expect(
      store.assertGlobalRunBinding(missing.run.id, missing.run.repositoryId)
    ).rejects.toThrow('Legacy run launch is closed');
  } finally {
    await Promise.all([store?.close(), authority?.close()]);
    await admin.unsafe(`drop schema if exists "${schema}" cascade`);
    await admin.end();
  }
});

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

it('installs M4.2 global authority tables through migration owner and gates runtime startup', async () => {
  const schema = `forge_global_${++fixtureOrdinal}`;
  const migration = { connectionString: ownerConnectionString, schema, role };
  const runtime = { connectionString: runtimeConnectionString, schema, role: runtimeRole };
  const admin = postgres(connectionString, { onnotice: () => undefined });
  const runtimeSql = postgres(runtimeConnectionString, { onnotice: () => undefined });
  try {
    await migratePostgresAuthoritySchema(migration, runtimeRole);
    await expect(assertPostgresGlobalAuthoritySchema(runtimeSql, runtime)).rejects.toThrow(
      'schema version is incompatible'
    );
    await migratePostgresAuthoritySchema(
      migration,
      runtimeRole,
      POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION
    );
    await migratePostgresAuthoritySchema(
      migration,
      runtimeRole,
      POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION
    );
    await assertPostgresGlobalAuthoritySchema(runtimeSql, runtime);
    const existingM41 = await PostgresOrchestrationPersistence.connect(runtime);
    await existingM41.close();
    const tables = await admin`select relname from pg_class
      where relnamespace=${schema}::regnamespace and relkind='r' order by relname`;
    expect(tables.map((row) => row.relname)).toEqual([
      'forge_global_aliases',
      'forge_global_audit',
      'forge_global_claims',
      'forge_global_control',
      'forge_global_leases',
      'forge_global_legacy_owners',
      'forge_global_permits',
      'forge_global_run_bindings',
      'forge_global_scopes',
      'forge_records',
      'forge_runs',
      'forge_schema_migrations'
    ]);
    const control = await runtimeSql.unsafe(
      `select state from "${schema}".forge_global_control where id=1`
    );
    expect(control).toMatchObject([{ state: 'LEGACY_ALLOWED' }]);
    const versions = await admin.unsafe(
      `select version from "${schema}".forge_schema_migrations order by version`
    );
    expect(versions.map((row) => row.version)).toEqual([1, 2, 3, 4]);
    await expect(
      runtimeSql.unsafe(`create table "${schema}".unauthorized (id text)`)
    ).rejects.toThrow();
    await admin.unsafe(
      `alter table "${schema}".forge_global_control drop constraint forge_global_control_id_check`
    );
    await expect(assertPostgresGlobalAuthoritySchema(runtimeSql, runtime)).rejects.toThrow(
      'global authority constraints are incompatible'
    );
  } finally {
    await runtimeSql.end();
    await admin.unsafe(`drop schema if exists "${schema}" cascade`);
    await admin.end();
  }
});

it('upgrades v3 counters per scope without resetting existing claim tokens or changing v3 checksum', async () => {
  const schema = `forge_scope_upgrade_${++fixtureOrdinal}`;
  const migration = { connectionString: ownerConnectionString, schema, role };
  const runtime = { connectionString: runtimeConnectionString, schema, role: runtimeRole };
  const owner = postgres(ownerConnectionString, { onnotice: () => undefined });
  const admin = postgres(connectionString, { onnotice: () => undefined });
  const runtimeSql = postgres(runtimeConnectionString, { onnotice: () => undefined });
  try {
    await migratePostgresAuthoritySchema(migration, runtimeRole, 3);
    const before = await admin.unsafe(
      `select checksum from "${schema}".forge_schema_migrations where version=3`
    );
    await owner.unsafe(
      `insert into "${schema}".forge_global_scopes values ('scope-a','REGISTERING'),('scope-b','REGISTERING')`
    );
    await owner.unsafe(`insert into "${schema}".forge_global_claims values
      ('scope-a','one','{}',5,'RELEASED',1,null),
      ('scope-a','two','{}',9,'HELD_UNCERTAIN',1,null),
      ('scope-b','three','{}',3,'RELEASED',1,null)`);
    await owner.unsafe(`update "${schema}".forge_global_control set next_token=200 where id=1`);
    await migratePostgresAuthoritySchema(migration, runtimeRole, 4);
    await migratePostgresAuthoritySchema(migration, runtimeRole, 4);
    await expect(assertPostgresGlobalAuthoritySchema(runtimeSql, runtime)).resolves.toBeUndefined();
    expect(
      await admin.unsafe(`select id,next_token from "${schema}".forge_global_scopes order by id`)
    ).toMatchObject([
      { id: 'scope-a', next_token: '9' },
      { id: 'scope-b', next_token: '3' }
    ]);
    expect(
      await admin.unsafe(
        `select claim_id,token,state from "${schema}".forge_global_claims order by claim_id`
      )
    ).toMatchObject([
      { claim_id: 'one', token: '5', state: 'RELEASED' },
      { claim_id: 'three', token: '3', state: 'RELEASED' },
      { claim_id: 'two', token: '9', state: 'HELD_UNCERTAIN' }
    ]);
    expect(
      await admin.unsafe(`select checksum from "${schema}".forge_schema_migrations where version=3`)
    ).toEqual(before);
    expect(
      await admin.unsafe(
        `select column_name from information_schema.columns
      where table_schema=$1 and table_name='forge_global_control' and column_name='next_token'`,
        [schema]
      )
    ).toEqual([]);
  } finally {
    await runtimeSql.end();
    await owner.unsafe(`drop schema if exists "${schema}" cascade`);
    await owner.end();
    await admin.end();
  }
});

it.each([
  { table: 'forge_global_aliases', privilege: 'UPDATE(scope_id)', capability: 'UPDATE' },
  { table: 'forge_global_run_bindings', privilege: 'UPDATE(scope_id)', capability: 'UPDATE' },
  { table: 'forge_global_claims', privilege: 'UPDATE(owner_json)', capability: 'UPDATE' },
  { table: 'forge_global_leases', privilege: 'REFERENCES(lease_id)', capability: 'REFERENCES' },
  { table: 'forge_global_permits', privilege: 'UPDATE(token)', capability: 'UPDATE' },
  { table: 'forge_global_audit', privilege: 'UPDATE(evidence)', capability: 'UPDATE' }
])(
  'rejects column-level $privilege on $table and repairs it on v4 migration rerun',
  async ({ table, privilege, capability }) => {
    const schema = `forge_global_column_${++fixtureOrdinal}`;
    const migration = { connectionString: ownerConnectionString, schema, role };
    const runtime = { connectionString: runtimeConnectionString, schema, role: runtimeRole };
    const owner = postgres(ownerConnectionString);
    const runtimeSql = postgres(runtimeConnectionString);
    try {
      await migratePostgresAuthoritySchema(
        migration,
        runtimeRole,
        POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION
      );
      await owner.unsafe(`grant ${privilege} on "${schema}".${table} to "${runtimeRole}"`);
      const before = await runtimeSql.unsafe(
        `select has_table_privilege(current_user, $1, $2) as table_allowed,
          has_any_column_privilege(current_user, $1, $2) as column_allowed`,
        [`${schema}.${table}`, capability]
      );
      expect(before[0]).toMatchObject({
        table_allowed: table === 'forge_global_claims',
        column_allowed: true
      });
      await expect(assertPostgresGlobalAuthoritySchema(runtimeSql, runtime)).rejects.toThrow(
        `global authority runtime privileges are incompatible: ${table}`
      );
      await migratePostgresAuthoritySchema(
        migration,
        runtimeRole,
        POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION
      );
      const after = await runtimeSql.unsafe(
        `select has_any_column_privilege(current_user, $1, $2) as column_allowed,
          exists (select 1 from pg_attribute a
            cross join lateral aclexplode(a.attacl) grant_entry
            where a.attrelid=$1::regclass and a.attnum > 0
              and grant_entry.grantee=current_user::regrole::oid) as column_grant`,
        [`${schema}.${table}`, capability]
      );
      expect(after[0]).toMatchObject({
        column_allowed: table === 'forge_global_claims',
        column_grant: false
      });
      await assertPostgresGlobalAuthoritySchema(runtimeSql, runtime);
    } finally {
      await runtimeSql.end();
      await owner.unsafe(`drop schema if exists "${schema}" cascade`);
      await owner.end();
    }
  }
);

it.each([
  { table: 'forge_global_control', privilege: 'UPDATE', capability: 'UPDATE' },
  { table: 'forge_global_scopes', privilege: 'INSERT(id)', capability: 'INSERT' },
  { table: 'forge_global_aliases', privilege: 'SELECT(scope_id)', capability: 'SELECT' },
  { table: 'forge_global_run_bindings', privilege: 'INSERT', capability: 'INSERT' },
  { table: 'forge_global_claims', privilege: 'UPDATE(owner_json)', capability: 'UPDATE' },
  { table: 'forge_global_leases', privilege: 'SELECT', capability: 'SELECT' },
  { table: 'forge_global_permits', privilege: 'DELETE', capability: 'DELETE' },
  { table: 'forge_global_legacy_owners', privilege: 'UPDATE', capability: 'UPDATE' },
  { table: 'forge_global_audit', privilege: 'SELECT', capability: 'SELECT' }
])(
  'rejects $privilege grant option on $table and repairs it on v4 migration rerun',
  async ({ table, privilege, capability }) => {
    const schema = `forge_global_grant_${++fixtureOrdinal}`;
    const migration = { connectionString: ownerConnectionString, schema, role };
    const runtime = { connectionString: runtimeConnectionString, schema, role: runtimeRole };
    const owner = postgres(ownerConnectionString);
    const runtimeSql = postgres(runtimeConnectionString);
    try {
      await migratePostgresAuthoritySchema(
        migration,
        runtimeRole,
        POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION
      );
      await owner.unsafe(
        `grant ${privilege} on "${schema}".${table} to "${runtimeRole}" with grant option`
      );
      const check = capability === 'DELETE' ? 'has_table_privilege' : 'has_any_column_privilege';
      const before = await runtimeSql.unsafe(`select ${check}(current_user, $1, $2) as granted`, [
        `${schema}.${table}`,
        `${capability} WITH GRANT OPTION`
      ]);
      expect(before[0]?.granted).toBe(true);
      await expect(assertPostgresGlobalAuthoritySchema(runtimeSql, runtime)).rejects.toThrow(
        `global authority runtime privileges are incompatible: ${table}`
      );
      await migratePostgresAuthoritySchema(
        migration,
        runtimeRole,
        POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION
      );
      const after = await runtimeSql.unsafe(`select ${check}(current_user, $1, $2) as granted`, [
        `${schema}.${table}`,
        `${capability} WITH GRANT OPTION`
      ]);
      expect(after[0]?.granted).toBe(false);
      await assertPostgresGlobalAuthoritySchema(runtimeSql, runtime);
    } finally {
      await runtimeSql.end();
      await owner.unsafe(`drop schema if exists "${schema}" cascade`);
      await owner.end();
    }
  }
);

it('rejects PUBLIC column ACL drift even when table privileges already cover it', async () => {
  const schema = `forge_global_public_${++fixtureOrdinal}`;
  const migration = { connectionString: ownerConnectionString, schema, role };
  const runtime = { connectionString: runtimeConnectionString, schema, role: runtimeRole };
  const owner = postgres(ownerConnectionString);
  const runtimeSql = postgres(runtimeConnectionString);
  try {
    await migratePostgresAuthoritySchema(
      migration,
      runtimeRole,
      POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION
    );
    await owner.unsafe(`grant update(owner_json) on "${schema}".forge_global_claims to public`);
    const before = await runtimeSql.unsafe(
      `select has_table_privilege(current_user, $1, 'UPDATE') as table_allowed,
        exists (select 1 from pg_attribute a
          cross join lateral aclexplode(a.attacl) grant_entry
          where a.attrelid=$1::regclass and a.attname='owner_json'
            and grant_entry.grantee=0) as public_column_grant`,
      [`${schema}.forge_global_claims`]
    );
    expect(before[0]).toMatchObject({ table_allowed: true, public_column_grant: true });
    await expect(assertPostgresGlobalAuthoritySchema(runtimeSql, runtime)).rejects.toThrow(
      'global authority runtime privileges are incompatible: forge_global_claims'
    );
    await migratePostgresAuthoritySchema(
      migration,
      runtimeRole,
      POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION
    );
    const after = await runtimeSql.unsafe(
      `select exists (select 1 from pg_attribute a
        cross join lateral aclexplode(a.attacl) grant_entry
        where a.attrelid=$1::regclass and a.attname='owner_json'
          and grant_entry.grantee=0) as public_column_grant`,
      [`${schema}.forge_global_claims`]
    );
    expect(after[0]?.public_column_grant).toBe(false);
    await assertPostgresGlobalAuthoritySchema(runtimeSql, runtime);
  } finally {
    await runtimeSql.end();
    await owner.unsafe(`drop schema if exists "${schema}" cascade`);
    await owner.end();
  }
});

it('closes PostgreSQL legacy writer creation after the deployment cutover barrier', async () => {
  const schema = `forge_global_gate_${++fixtureOrdinal}`;
  const migration = { connectionString: ownerConnectionString, schema, role };
  const runtime = { connectionString: runtimeConnectionString, schema, role: runtimeRole };
  const sql = postgres(runtimeConnectionString, { onnotice: () => undefined });
  const owner = postgres(ownerConnectionString, { onnotice: () => undefined });
  let store: PostgresOrchestrationPersistence | undefined;
  try {
    await migratePostgresAuthoritySchema(
      migration,
      runtimeRole,
      POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION
    );
    store = await PostgresOrchestrationPersistence.connect(runtime);
    const runId = 'legacy-run';
    await store.createRun(durableAuthorityRunRequest(runId));
    const builder = durableAuthorityInitialDispatch(runId).attempts[0];
    if (builder === undefined) {
      throw new Error('Missing builder fixture');
    }
    await store.persistAttempt(builder);
    const repair = { ...durableAuthorityRepairAttempt('legacy-repair'), runId };
    await store.persistRepairAttempt({ runId, attempt: repair });
    await sql.unsafe(
      `update "${schema}".forge_global_control set state='LEGACY_CUTOVER' where id=1`
    );
    const startedAt = new Date('2026-09-29T00:00:00.000Z');
    const lease = {
      id: 'legacy-builder-lease',
      runId,
      agentId: 'agent-1',
      taskId: 'task-1',
      resource: { type: 'project' as const, projectId: 'project-1' },
      mode: 'exclusive' as const,
      version: 1,
      state: 'ACTIVE' as const,
      acquiredAt: startedAt,
      lastHeartbeatAt: startedAt
    };
    await expect(
      store.claimBuilderStart({
        runId,
        attempt: { ...builder.attempt, state: 'STARTING', revision: 2, startedAt },
        leases: [lease]
      })
    ).rejects.toThrow('Legacy mutation admission is closed');
    await expect(
      store.claimRepairStart({
        runId,
        attempt: { ...repair, state: 'STARTING', revision: 2, startedAt }
      })
    ).rejects.toThrow('Legacy mutation admission is closed');
    await expect(
      store.claimIntegrationStart({
        runId,
        taskId: 'task-1',
        workspaceId: 'workspace-1',
        outputAttemptId: 'contract-builder'
      })
    ).rejects.toThrow('Legacy mutation admission is closed');
    await expect(store.persistLease({ runId, lease })).rejects.toThrow(
      'Legacy mutation admission is closed'
    );
    await expect(
      store.persistAttempt({
        runId,
        attempt: { ...builder.attempt, state: 'STARTING', revision: 2, startedAt }
      })
    ).rejects.toThrow('Legacy mutation admission is closed');
    await expect(
      store.persistRepairAttempt({
        runId,
        attempt: { ...repair, state: 'STARTING', revision: 2, startedAt }
      })
    ).rejects.toThrow('Legacy mutation admission is closed');
    const evidence = await sql.unsafe(
      `select kind,key,payload from "${schema}".forge_records where run_id=$1 order by kind,key`,
      [runId]
    );
    expect(
      evidence.filter((row) =>
        ['lease', 'integration-claim', 'repair-history'].includes(String(row.kind))
      )
    ).toEqual([]);
    expect(
      evidence
        .filter((row) => row.kind === 'builder' || row.kind === 'repair')
        .map((row) => JSON.parse(String(row.payload)))
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: 'PREPARING' }),
        expect.objectContaining({ state: 'PREPARING' })
      ])
    );
  } finally {
    await store?.close();
    await sql.end();
    await owner.unsafe(`drop schema if exists "${schema}" cascade`);
    await owner.end();
  }
});

it.each([0, 5, Number.NaN])(
  'rejects unsupported runtime migration target %s before creating schema objects',
  async (target) => {
    const schema = `forge_bad_target_${++fixtureOrdinal}`;
    const migration = { connectionString: ownerConnectionString, schema, role };
    const admin = postgres(connectionString);
    try {
      await expect(
        Reflect.apply(migratePostgresAuthoritySchema, undefined, [migration, runtimeRole, target])
      ).rejects.toThrow('Unsupported PostgreSQL authority schema target version');
      const schemas = await admin`select 1 from pg_namespace where nspname = ${schema}`;
      expect(schemas).toHaveLength(0);
    } finally {
      await admin.end();
    }
  }
);

it('removes excessive table grants on migration rerun and requires exact runtime privileges', async () => {
  const fixture = await createFixture();
  const owner = postgres(ownerConnectionString);
  const admin = postgres(connectionString);
  const runtime = {
    connectionString: runtimeConnectionString,
    schema: fixture.schema,
    role: runtimeRole
  };
  try {
    const tables = `"${fixture.schema}".forge_runs, "${fixture.schema}".forge_records`;
    await owner.unsafe(`grant delete on "${fixture.schema}".forge_runs to "${runtimeRole}"`);
    await owner.unsafe(`grant truncate, references, trigger on ${tables} to "${runtimeRole}"`);
    await owner.unsafe(`grant truncate on "${fixture.schema}".forge_records to public`);
    await expect(PostgresOrchestrationPersistence.connect(runtime)).rejects.toThrow(
      'runtime privileges are incompatible'
    );
    await migratePostgresAuthoritySchema(
      { connectionString: ownerConnectionString, schema: fixture.schema, role },
      runtimeRole
    );
    const privileges = await admin.unsafe(
      `select has_table_privilege($1,$2,'DELETE') as runs_delete,
        has_table_privilege($1,$2,'TRUNCATE') as runs_truncate,
        has_table_privilege($1,$2,'REFERENCES') as runs_references,
        has_table_privilege($1,$2,'TRIGGER') as runs_trigger,
        has_table_privilege($1,$3,'DELETE') as records_delete,
        has_table_privilege($1,$3,'TRUNCATE') as records_truncate,
        has_table_privilege($1,$3,'REFERENCES') as records_references,
        has_table_privilege($1,$3,'TRIGGER') as records_trigger`,
      [runtimeRole, `${fixture.schema}.forge_runs`, `${fixture.schema}.forge_records`]
    );
    expect(privileges[0]).toMatchObject({
      runs_delete: false,
      runs_truncate: false,
      runs_references: false,
      runs_trigger: false,
      records_delete: true,
      records_truncate: false,
      records_references: false,
      records_trigger: false
    });
    const publicGrants = await admin.unsafe(
      `select relname, coalesce((select bool_or(a.grantee = 0) from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a), false) as public_grant
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = $1 and c.relname in ('forge_runs','forge_records')`,
      [fixture.schema]
    );
    expect(publicGrants).toHaveLength(2);
    expect(publicGrants.every((row) => row.public_grant === false)).toBe(true);
    const reopened = await PostgresOrchestrationPersistence.connect(runtime);
    await reopened.close();
  } finally {
    await admin.end();
    await owner.end();
    await fixture.close();
  }
});

it.each([
  { table: 'forge_schema_migrations', privilege: 'INSERT(version)', column: 'INSERT' },
  { table: 'forge_schema_migrations', privilege: 'UPDATE(checksum)', column: 'UPDATE' },
  { table: 'forge_schema_migrations', privilege: 'REFERENCES(version)', column: 'REFERENCES' },
  { table: 'forge_runs', privilege: 'REFERENCES(id)', column: 'REFERENCES' },
  { table: 'forge_records', privilege: 'REFERENCES(run_id)', column: 'REFERENCES' }
])(
  'rejects column-level $column on $table and removes it on migration rerun',
  async ({ table, privilege, column }) => {
    const fixture = await createFixture();
    const owner = postgres(ownerConnectionString);
    const runtimeSql = postgres(runtimeConnectionString);
    try {
      await owner.unsafe(`grant ${privilege} on "${fixture.schema}".${table} to "${runtimeRole}"`);
      const rows = await runtimeSql.unsafe(
        `select has_any_column_privilege(current_user, $1, $2) as allowed,
        has_table_privilege(current_user, $1, $2) as table_allowed`,
        [`${fixture.schema}.${table}`, column]
      );
      expect(rows[0]?.allowed).toBe(true);
      expect(rows[0]?.table_allowed).toBe(false);
      if (table === 'forge_schema_migrations' && column === 'UPDATE') {
        await expect(
          runtimeSql.begin(async (tx) => {
            await tx.unsafe(
              `update "${fixture.schema}".forge_schema_migrations set checksum='tampered' where version=1`
            );
            throw new Error('rollback privilege probe');
          })
        ).rejects.toThrow('rollback privilege probe');
      }
      await expect(
        PostgresOrchestrationPersistence.connect({
          connectionString: runtimeConnectionString,
          schema: fixture.schema,
          role: runtimeRole
        })
      ).rejects.toThrow('runtime privileges are incompatible');
      await migratePostgresAuthoritySchema(
        { connectionString: ownerConnectionString, schema: fixture.schema, role },
        runtimeRole
      );
      const after = await runtimeSql.unsafe(
        `select has_any_column_privilege(current_user, $1, $2) as allowed`,
        [`${fixture.schema}.${table}`, column]
      );
      expect(after[0]?.allowed).toBe(false);
      const reopened = await PostgresOrchestrationPersistence.connect({
        connectionString: runtimeConnectionString,
        schema: fixture.schema,
        role: runtimeRole
      });
      await reopened.close();
    } finally {
      await runtimeSql.end();
      await owner.end();
      await fixture.close();
    }
  }
);

it.each([
  { table: 'forge_schema_migrations', privilege: 'SELECT' },
  { table: 'forge_schema_migrations', privilege: 'SELECT(checksum)' },
  { table: 'forge_runs', privilege: 'UPDATE' },
  { table: 'forge_records', privilege: 'DELETE' }
])(
  'rejects $privilege grant option on $table and removes it on migration rerun',
  async ({ table, privilege }) => {
    const fixture = await createFixture();
    const owner = postgres(ownerConnectionString);
    try {
      await owner.unsafe(
        `grant ${privilege} on "${fixture.schema}".${table} to "${runtimeRole}" with grant option`
      );
      await expect(
        PostgresOrchestrationPersistence.connect({
          connectionString: runtimeConnectionString,
          schema: fixture.schema,
          role: runtimeRole
        })
      ).rejects.toThrow('runtime privileges are incompatible');
      await migratePostgresAuthoritySchema(
        { connectionString: ownerConnectionString, schema: fixture.schema, role },
        runtimeRole
      );
      const reopened = await PostgresOrchestrationPersistence.connect({
        connectionString: runtimeConnectionString,
        schema: fixture.schema,
        role: runtimeRole
      });
      await reopened.close();
    } finally {
      await owner.end();
      await fixture.close();
    }
  }
);

it('rejects non-inherited role membership that can be activated with SET ROLE', async () => {
  const fixture = await createFixture();
  const admin = postgres(connectionString, { onnotice: () => undefined });
  const extraRole = `forge_extra_${process.pid}_${fixtureOrdinal}`;
  let membershipGranted = false;
  try {
    await admin.unsafe(`create role "${extraRole}"`);
    await admin.unsafe(`alter role "${runtimeRole}" noinherit`);
    await admin.unsafe(`grant "${extraRole}" to "${runtimeRole}"`);
    membershipGranted = true;
    const runtime = postgres(runtimeConnectionString);
    try {
      const permissions = await runtime`select
        pg_has_role(current_user, ${extraRole}, 'USAGE') as inherited,
        pg_has_role(current_user, ${extraRole}, 'MEMBER') as member`;
      expect(permissions[0]).toMatchObject({ inherited: false, member: true });
      await runtime.unsafe(`set role "${extraRole}"`);
      const assumed = await runtime`select current_user as name`;
      expect(assumed[0]?.name).toBe(extraRole);
      await runtime`set role none`;
    } finally {
      await runtime.end();
    }
    await expect(
      PostgresOrchestrationPersistence.connect({
        connectionString: runtimeConnectionString,
        schema: fixture.schema,
        role: runtimeRole
      })
    ).rejects.toThrow('runtime role is not least privileged');
    await admin.unsafe(`revoke "${extraRole}" from "${runtimeRole}"`);
    membershipGranted = false;
    const reopened = await PostgresOrchestrationPersistence.connect({
      connectionString: runtimeConnectionString,
      schema: fixture.schema,
      role: runtimeRole
    });
    await reopened.close();
  } finally {
    if (membershipGranted) {
      await admin.unsafe(`revoke "${extraRole}" from "${runtimeRole}"`);
    }
    await admin.unsafe(`alter role "${runtimeRole}" inherit`);
    await admin.unsafe(`drop role if exists "${extraRole}"`);
    await admin.end();
    await fixture.close();
  }
});

it('rejects an assumed runtime role whose session can restore a privileged login', async () => {
  const fixture = await createFixture();
  const admin = postgres(connectionString);
  const proxyRole = `forge_proxy_${process.pid}_${fixtureOrdinal}`;
  let created = false;
  try {
    await admin.unsafe(`create role "${proxyRole}" login createdb`);
    created = true;
    await admin.unsafe(`grant "${runtimeRole}" to "${proxyRole}"`);
    const proxyConnectionString = connectionString.replace(
      'postgresql://',
      `postgresql://${proxyRole}@`
    );
    const proxy = postgres(proxyConnectionString);
    try {
      await proxy.unsafe(`set role "${runtimeRole}"`);
      const identity =
        await proxy`select current_user as current_name, session_user as session_name`;
      expect(identity[0]).toMatchObject({
        current_name: runtimeRole,
        session_name: proxyRole
      });
      await expect(
        assertPostgresAuthoritySchema(proxy, {
          connectionString: runtimeConnectionString,
          schema: fixture.schema,
          role: runtimeRole
        })
      ).rejects.toThrow('PostgreSQL authority connection login role mismatch');
      await proxy`set role none`;
      const restored = await proxy`select current_user as current_name`;
      expect(restored[0]?.current_name).toBe(proxyRole);
    } finally {
      await proxy.end();
    }
    const assumedRoleConnectionString = `${proxyConnectionString}?options=${encodeURIComponent(`-c role=${runtimeRole}`)}`;
    await expect(
      PostgresOrchestrationPersistence.connect({
        connectionString: assumedRoleConnectionString,
        schema: fixture.schema,
        role: runtimeRole
      })
    ).rejects.toThrow('PostgreSQL authority requires an explicit runtime login');
  } finally {
    if (created) {
      await admin.unsafe(`drop role "${proxyRole}"`);
    }
    await admin.end();
    await fixture.close();
  }
});

it('rejects a privileged login even after changing both SQL identities to runtime', async () => {
  const fixture = await createFixture();
  const admin = postgres(connectionString);
  const proxyRole = `forge_session_proxy_${process.pid}_${fixtureOrdinal}`;
  let created = false;
  try {
    await admin.unsafe(`create role "${proxyRole}" login superuser`);
    created = true;
    const proxyConnectionString = connectionString.replace(
      'postgresql://',
      `postgresql://${proxyRole}@`
    );
    const proxy = postgres(proxyConnectionString);
    try {
      await proxy.unsafe(`set session authorization "${runtimeRole}"`);
      const assumed =
        await proxy`select current_user as current_name, session_user as session_name`;
      expect(assumed[0]).toMatchObject({ current_name: runtimeRole, session_name: runtimeRole });
      await expect(
        assertPostgresAuthoritySchema(proxy, {
          connectionString: proxyConnectionString,
          schema: fixture.schema,
          role: runtimeRole
        })
      ).rejects.toThrow('PostgreSQL authority requires an explicit runtime login');
      await expect(
        assertPostgresAuthoritySchema(proxy, {
          connectionString: runtimeConnectionString,
          schema: fixture.schema,
          role: runtimeRole
        })
      ).rejects.toThrow('PostgreSQL authority connection login role mismatch');
      await proxy`reset session authorization`;
      const restored =
        await proxy`select current_user as current_name, session_user as session_name`;
      expect(restored[0]).toMatchObject({ current_name: proxyRole, session_name: proxyRole });
    } finally {
      await proxy.end();
    }
    await expect(
      PostgresOrchestrationPersistence.connect({
        connectionString: `${proxyConnectionString}?options=${encodeURIComponent(`-c session_authorization=${runtimeRole}`)}`,
        schema: fixture.schema,
        role: runtimeRole
      })
    ).rejects.toThrow('PostgreSQL authority requires an explicit runtime login');
  } finally {
    if (created) {
      await admin.unsafe(`drop role "${proxyRole}"`);
    }
    await admin.end();
    await fixture.close();
  }
});

it('requires an explicit runtime login without startup query parameters', async () => {
  const fixture = await createFixture();
  try {
    for (const candidate of [
      connectionString,
      `${runtimeConnectionString}?options=${encodeURIComponent(`-c session_authorization=${runtimeRole}`)}`,
      `${runtimeConnectionString}?user=forge_proxy`
    ]) {
      await expect(
        PostgresOrchestrationPersistence.connect({
          connectionString: candidate,
          schema: fixture.schema,
          role: runtimeRole
        })
      ).rejects.toThrow('PostgreSQL authority requires an explicit runtime login');
    }
  } finally {
    await fixture.close();
  }
});

it('rejects schema USAGE with grant option and removes it on migration rerun', async () => {
  const fixture = await createFixture();
  const owner = postgres(ownerConnectionString);
  try {
    await owner.unsafe(
      `grant usage on schema "${fixture.schema}" to "${runtimeRole}" with grant option`
    );
    await expect(
      PostgresOrchestrationPersistence.connect({
        connectionString: runtimeConnectionString,
        schema: fixture.schema,
        role: runtimeRole
      })
    ).rejects.toThrow('runtime privileges are incompatible');
    await migratePostgresAuthoritySchema(
      { connectionString: ownerConnectionString, schema: fixture.schema, role },
      runtimeRole
    );
    const reopened = await PostgresOrchestrationPersistence.connect({
      connectionString: runtimeConnectionString,
      schema: fixture.schema,
      role: runtimeRole
    });
    await reopened.close();
  } finally {
    await owner.end();
    await fixture.close();
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
      `insert into "${fixture.schema}".forge_schema_migrations (version, checksum) values (4,'future')`
    );
    await expect(PostgresOrchestrationPersistence.connect(runtime)).rejects.toThrow(
      'schema version is incompatible'
    );
    await admin.unsafe(`delete from "${fixture.schema}".forge_schema_migrations where version=4`);
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
    name: 'unlogged migration ledger',
    alter: (schema: string) => `alter table "${schema}".forge_schema_migrations set unlogged`,
    message: 'relation semantics are incompatible'
  },
  {
    name: 'row-level security enabled on runs',
    alter: (schema: string) => `alter table "${schema}".forge_runs enable row level security`,
    message: 'relation semantics are incompatible'
  },
  {
    name: 'force row-level security on runs',
    alter: (schema: string) => `alter table "${schema}".forge_runs force row level security`,
    message: 'relation semantics are incompatible'
  },
  {
    name: 'removed migration timestamp default',
    alter: (schema: string) =>
      `alter table "${schema}".forge_schema_migrations alter column applied_at drop default`,
    message: 'column defaults are incompatible'
  },
  {
    name: 'user-defined authority trigger',
    alter: (schema: string) =>
      `create function "${schema}".authority_noop() returns trigger language plpgsql as $$ begin return new; end $$; create trigger authority_noop before update on "${schema}".forge_runs for each row execute function "${schema}".authority_noop()`,
    message: 'triggers or rules are incompatible'
  },
  {
    name: 'user-defined authority rule',
    alter: (schema: string) =>
      `create rule authority_noop as on update to "${schema}".forge_runs do instead nothing`,
    message: 'triggers or rules are incompatible'
  },
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
    ).rejects.toThrow('requires an explicit runtime login');
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
