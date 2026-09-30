import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { Worker } from 'node:worker_threads';

import Database from 'better-sqlite3';
import { build } from 'esbuild';
import { taskLeasePlanFingerprint } from '@ai-native-software-delivery-orchestrator/domain';
import { afterAll, describe, expect, it } from 'vitest';

import { DrizzleSqliteOrchestrationPersistence } from './drizzle-sqlite-orchestration-persistence.js';
import {
  globalMutationCutoverContract,
  globalMutationPermitContract,
  type GlobalMutationCutoverFixture,
  type HeldGateOperation,
  type LegacyAdmissionKind
} from './global-mutation-authority.contract.test.js';
import { SqliteGlobalMutationAuthority } from './sqlite-global-mutation-authority.js';

const task = (id: string) => ({
  id,
  title: id,
  goal: `Complete ${id}`,
  dependencies: [],
  expectedReads: [],
  expectedWrites: [],
  sharedResources: [],
  verification: []
});
const leasePlan = (taskId: string) => ({
  taskId,
  predictedResources: [{ type: 'file' as const, projectId: 'project-A', fileId: 'file-A' }],
  source: 'manual' as const
});
const workspaceId = (taskId: string): string => `workspace-${taskId}`;
const insertTaskBinding = (
  sqlite: Database.Database,
  runId: string,
  taskId: string,
  agentId: string
): void => {
  const binding = {
    runId,
    taskId,
    agentId,
    leasePlan: leasePlan(taskId),
    workspace: {
      id: workspaceId(taskId),
      runId,
      taskId,
      integrationRepositoryPath: '/repository',
      workspacePath: `/repository/${runId}-${taskId}`,
      branchName: `forge/${runId}/${taskId}`,
      baseRef: 'main',
      integrationRef: 'main'
    }
  };
  sqlite
    .prepare('INSERT INTO task_execution_bindings (run_id,task_id,binding_json) VALUES (?,?,?)')
    .run(runId, taskId, JSON.stringify(binding));
};

const persistPreparingBuilder = async (
  store: DrizzleSqliteOrchestrationPersistence,
  runId: string,
  attemptId: string,
  agentId: string,
  taskId = 'task-A'
): Promise<void> => {
  await store.persistAttempt({
    runId,
    attempt: {
      id: attemptId,
      runId,
      taskId,
      agentId,
      workspaceId: workspaceId(taskId),
      leasePlanFingerprint: taskLeasePlanFingerprint(leasePlan(taskId)),
      state: 'PREPARING',
      revision: 1
    }
  });
};

const createPermitFixture = async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-global-sqlite-'));
  const filename = join(directory, 'authority.sqlite');
  const legacyStore = new DrizzleSqliteOrchestrationPersistence(filename);
  const authority = new SqliteGlobalMutationAuthority(filename);
  const peer = new SqliteGlobalMutationAuthority(filename);
  const repositoryId = 'repository-A';
  const scopeId = await authority.registerScope(repositoryId);
  await authority.beginLegacyCutover();
  await authority.completeLegacyCutover('Old writer processes are stopped.');
  await authority.activateScope(scopeId);
  const sqlite = new Database(filename);
  try {
    sqlite
      .prepare(`INSERT INTO orchestration_runs
      (id,repository_id,state,created_at,tasks_json,hard_conflicts_json,risk_conflicts_json,schedule_options_json)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(
        'run-A',
        repositoryId,
        'ACTIVE',
        '2026-09-29T00:00:00.000Z',
        JSON.stringify([task('task-A')]),
        '[]',
        '[]',
        '{}'
      );
    insertTaskBinding(sqlite, 'run-A', 'task-A', 'agent-A');
  } finally {
    sqlite.close();
  }
  await expect(peer.recoverGlobalRunScope('run-A')).rejects.toThrow('durable global scope binding');
  await authority.bindRun('run-A', repositoryId);
  expect(await peer.recoverGlobalRunScope('run-A')).toBe(scopeId);
  await persistPreparingBuilder(legacyStore, 'run-A', 'attempt-A', 'agent-A');
  await persistPreparingBuilder(legacyStore, 'run-A', 'attempt-B', 'agent-A');
  const originalClaim = {
    scopeId,
    claimId: 'claim-A',
    owner: { runId: 'run-A', taskId: 'task-A', attemptId: 'attempt-A', agentId: 'agent-A' },
    resources: [{ type: 'file' as const, projectId: 'project-A', fileId: 'file-A' }]
  };
  const originalGrant = await authority.claimGlobalMutation(originalClaim);
  if (originalGrant.status !== 'granted') {
    throw new Error('Fixture claim was not granted');
  }
  let ownerClosed = false;
  return {
    filename,
    authority,
    peer,
    scopeId,
    originalClaim,
    originalGrant,
    replacementClaim: {
      ...originalClaim,
      claimId: 'claim-B',
      owner: { ...originalClaim.owner, attemptId: 'attempt-B' }
    },
    closeOwnerConnectionWithoutEnd: async () => {
      authority.close();
      ownerClosed = true;
    },
    close: async () => {
      if (!ownerClosed) {
        authority.close();
      }
      peer.close();
      legacyStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
};

globalMutationPermitContract('SQLite', createPermitFixture);

it('denies ordinary permit, exact replay and release for every durably marked workspace parent phase', async () => {
  const fixture = await createPermitFixture();
  const db = new Database(fixture.filename);
  try {
    const request = {
      scopeId: fixture.scopeId,
      claimId: fixture.originalClaim.claimId,
      owner: fixture.originalClaim.owner,
      token: fixture.originalGrant.token,
      resource: fixture.originalClaim.resources[0]
    };
    for (const phase of ['INITIAL_ADMITTED', 'WORKSPACE_ARMED', 'WORKSPACE_UNCERTAIN']) {
      db.prepare(
        `INSERT INTO forge_global_workspace_phases (scope_id,parent_claim_id,phase)
         VALUES (?,?,?) ON CONFLICT (scope_id,parent_claim_id) DO UPDATE SET phase=excluded.phase`
      ).run(fixture.scopeId, fixture.originalClaim.claimId, phase);
      await expect(fixture.peer.assertCurrentMutationToken(request)).rejects.toThrow(
        'Workspace setup parent forbids ordinary mutation authority'
      );
      await expect(fixture.peer.beginFencedMutation(request)).rejects.toThrow(
        'Workspace setup parent forbids ordinary mutation authority'
      );
      await expect(fixture.peer.claimGlobalMutation(fixture.originalClaim)).rejects.toThrow(
        'Workspace setup parent forbids ordinary mutation authority'
      );
      await expect(
        fixture.peer.releaseGlobalMutation({
          ...request,
          expectedVersion: 1,
          stopEvidence: 'No writes remain'
        })
      ).rejects.toThrow('Workspace setup parent forbids ordinary mutation authority');
    }
    await fixture.authority.markMutationUncertain({
      ...request,
      evidence: 'Workspace result is uncertain'
    });
    await expect(
      fixture.peer.reclaimUncertainMutation({
        ...request,
        expectedVersion: 2,
        verifiedQuiescenceEvidence: 'Stopped externally'
      })
    ).rejects.toThrow('Workspace setup parent forbids ordinary mutation authority');
    expect(await fixture.peer.recoverFencedMutationPermits(fixture.scopeId)).toEqual([]);
    expect((await fixture.peer.recoverRepositoryMutationAuthority(fixture.scopeId))[0]?.state).toBe(
      'HELD_UNCERTAIN'
    );
  } finally {
    db.close();
    await fixture.close();
  }
});

const workerDirectory = mkdtempSync(resolvePath('libs/persistence/node_modules/.cutover-race-'));
const workerBundle = join(workerDirectory, 'worker.mjs');
let bundleReady: Promise<void> | undefined;
const prepareWorkerBundle = (): Promise<void> => {
  bundleReady ??= build({
    entryPoints: ['libs/persistence/test/sqlite-cutover-race-worker.ts'],
    outfile: workerBundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    conditions: ['@ai-native-software-delivery-orchestrator/source'],
    external: ['better-sqlite3', 'drizzle-orm', 'zod']
  }).then(() => undefined);
  return bundleReady;
};
afterAll(() => rmSync(workerDirectory, { recursive: true, force: true }));

type RaceMessage = {
  readonly type: 'ready' | 'gate-attempt' | 'gate-held' | 'done' | 'error';
  readonly ownerKey?: string;
  readonly message?: string;
};
type RaceCommand = { readonly kind: LegacyAdmissionKind | 'cutover'; readonly hold: boolean };

const startRaceWorker = async (filename: string) => {
  await prepareWorkerBundle();
  const gate = new SharedArrayBuffer(4);
  const worker = new Worker(workerBundle, { workerData: { filename, gate } });
  const queued = new Map<RaceMessage['type'], RaceMessage[]>();
  const waiting = new Map<RaceMessage['type'], ((message: RaceMessage) => void)[]>();
  worker.on('message', (message: RaceMessage) => {
    const deliver = waiting.get(message.type)?.shift();
    if (deliver !== undefined) {
      deliver(message);
    } else {
      const messages = queued.get(message.type) ?? [];
      messages.push(message);
      queued.set(message.type, messages);
    }
  });
  const next = async (type: RaceMessage['type']): Promise<RaceMessage> => {
    const message = queued.get(type)?.shift();
    return (
      message ??
      new Promise<RaceMessage>((deliver) => {
        const resolvers = waiting.get(type) ?? [];
        resolvers.push(deliver);
        waiting.set(type, resolvers);
      })
    );
  };
  await next('ready');
  let settled = false;
  return {
    next,
    get settled() {
      return settled;
    },
    run: (command: RaceCommand): Promise<string | undefined> => {
      settled = false;
      worker.postMessage(command, []);
      return Promise.race([next('done'), next('error')]).then((message) => {
        settled = true;
        if (message.type === 'error') {
          throw new Error(message.message);
        }
        return message.ownerKey;
      });
    },
    release: () => {
      Atomics.store(new Int32Array(gate), 0, 1);
      Atomics.notify(new Int32Array(gate), 0);
    },
    close: async () => {
      await worker.terminate();
    }
  };
};

type RaceWorker = Awaited<ReturnType<typeof startRaceWorker>>;
const holdGate = async <T>(
  worker: RaceWorker,
  command: RaceCommand,
  result: (key: string | undefined) => T
): Promise<HeldGateOperation<T>> => {
  const finished = worker.run(command).then(result);
  await Promise.race([
    worker.next('gate-held'),
    finished.then(() => {
      throw new Error('Gate operation finished before it was held');
    })
  ]);
  return { finished, release: worker.release };
};

const createCutoverFixture = async (): Promise<GlobalMutationCutoverFixture> => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-global-cutover-race-'));
  const filename = join(directory, 'authority.sqlite');
  const legacyStore = new DrizzleSqliteOrchestrationPersistence(filename);
  const authority = new SqliteGlobalMutationAuthority(filename);
  const peer = new SqliteGlobalMutationAuthority(filename);
  const scopeId = await authority.registerScope('registered-A');
  const sqlite = new Database(filename);
  sqlite
    .prepare(`INSERT INTO orchestration_runs
    (id,repository_id,state,created_at,tasks_json,hard_conflicts_json,risk_conflicts_json,schedule_options_json)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(
      'historical-B',
      'unregistered-B',
      'ACTIVE',
      '2026-09-29',
      JSON.stringify([task('task-A')]),
      '[]',
      '[]',
      '{}'
    );
  await legacyStore.persistAttempt({
    runId: 'historical-B',
    attempt: {
      id: 'builder-attempt',
      runId: 'historical-B',
      taskId: 'task-A',
      agentId: 'builder-agent',
      workspaceId: 'builder-workspace',
      leasePlanFingerprint: 'approved-plan',
      state: 'PREPARING',
      revision: 1
    }
  });
  await legacyStore.persistRepairAttempt({
    runId: 'historical-B',
    attempt: {
      id: 'repair-attempt',
      runId: 'historical-B',
      taskId: 'task-A',
      agentId: 'repair-agent',
      workspaceId: 'repair-workspace',
      parentReviewIteration: 1,
      parentReviewSubject: {
        builderAttemptId: 'builder-parent',
        outputAttemptId: 'builder-parent',
        workspaceId: 'builder-workspace',
        workspaceRevision: 1,
        workspaceChangeFingerprint: `sha256:${'a'.repeat(64)}`,
        impactFingerprint: `sha256:${'b'.repeat(64)}`,
        verificationFingerprint: `sha256:${'c'.repeat(64)}`
      },
      repairIteration: 1,
      state: 'PREPARING',
      revision: 1
    }
  });
  const admissionWorker = await startRaceWorker(filename);
  const cutoverWorker = await startRaceWorker(filename);
  const cutoverPeer = new Proxy(peer, {
    get(target, property) {
      if (property === 'beginLegacyCutover') {
        return async () => {
          await cutoverWorker.run({ kind: 'cutover', hold: false });
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  return {
    authority,
    peer: cutoverPeer,
    scopeId,
    registeredRepositoryId: 'registered-A',
    unregisteredRepositoryId: 'unregistered-B',
    historicalRunId: 'historical-B',
    holdLegacyAdmissionAtGate: async (kind) =>
      holdGate(admissionWorker, { kind, hold: true }, (ownerKey) => {
        if (ownerKey === undefined) {
          throw new Error('Missing admitted owner key');
        }
        return { ownerKey };
      }),
    holdCutoverAtGate: () =>
      holdGate(cutoverWorker, { kind: 'cutover', hold: true }, () => undefined),
    admitLegacyWriter: async (kind) => {
      await admissionWorker.run({ kind, hold: false });
    },
    assertWaitingOnGate: async (operation) => {
      const waitingWorker = operation === 'cutover' ? cutoverWorker : admissionWorker;
      await waitingWorker.next('gate-attempt');
      await new Promise((done) => setTimeout(done, 50));
      expect(waitingWorker.settled).toBe(false);
    },
    readLegacyWriterEvidence: async () => ({
      attempts: [
        ...sqlite
          .prepare('SELECT attempt_json FROM agent_execution_attempts ORDER BY run_id,attempt_id')
          .all(),
        ...sqlite
          .prepare('SELECT attempt_json FROM task_repair_attempts ORDER BY run_id,attempt_id')
          .all()
      ].map((row) => JSON.stringify(row)),
      leases: sqlite
        .prepare('SELECT lease_json FROM write_leases ORDER BY run_id,lease_id')
        .all()
        .map((row) => JSON.stringify(row)),
      integrationClaims: sqlite
        .prepare('SELECT * FROM task_integration_claims ORDER BY run_id,task_id')
        .all()
        .map((row) => JSON.stringify(row))
    }),
    assertRejectedAdmissionHasNoStartResidue: async (kind) => {
      if (kind === 'builder') {
        expect(
          sqlite
            .prepare(
              'SELECT attempt_json FROM agent_execution_attempts WHERE run_id=? AND attempt_id=?'
            )
            .get('historical-B', 'builder-attempt')
        ).toEqual({ attempt_json: expect.stringContaining('"state":"PREPARING"') });
        expect(
          sqlite
            .prepare('SELECT count(*) AS count FROM write_leases WHERE run_id=? AND lease_id=?')
            .get('historical-B', 'builder-lease')
        ).toEqual({ count: 0 });
      }
      if (kind === 'repair') {
        expect(
          sqlite
            .prepare(
              'SELECT attempt_json FROM task_repair_attempts WHERE run_id=? AND attempt_id=?'
            )
            .get('historical-B', 'repair-attempt')
        ).toEqual({ attempt_json: expect.stringContaining('"state":"PREPARING"') });
        expect(
          sqlite
            .prepare(
              'SELECT count(*) AS count FROM task_repair_attempt_history WHERE run_id=? AND attempt_id=?'
            )
            .get('historical-B', 'repair-attempt')
        ).toEqual({ count: 0 });
      }
    },
    close: async () => {
      admissionWorker.release();
      cutoverWorker.release();
      await admissionWorker.close();
      await cutoverWorker.close();
      sqlite.close();
      peer.close();
      authority.close();
      legacyStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
};

globalMutationCutoverContract('SQLite', createCutoverFixture);

describe('SQLite durable permit evidence', () => {
  it('persists a verifier without the live completion secret', async () => {
    const fixture = await createPermitFixture();
    const sqlite = new Database(fixture.filename);
    try {
      const permit = await fixture.authority.beginFencedMutation({
        scopeId: fixture.scopeId,
        claimId: fixture.originalClaim.claimId,
        owner: fixture.originalClaim.owner,
        token: fixture.originalGrant.token,
        resource: fixture.originalClaim.resources[0]
      });
      const row: unknown = sqlite
        .prepare('SELECT verifier FROM forge_global_permits WHERE id=?')
        .get(permit.id);
      expect(row).toEqual({ verifier: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(JSON.stringify(row)).not.toContain(permit.completionSecret);
      await fixture.authority.endFencedMutation(permit);
    } finally {
      sqlite.close();
      await fixture.close();
    }
  });
});

describe('SQLite global attempt admission', () => {
  it('rejects fabricated or mismatched owners and advances a real attempt atomically', async () => {
    const fixture = await createPermitFixture();
    const sqlite = new Database(fixture.filename);
    const legacyStore = new DrizzleSqliteOrchestrationPersistence(fixture.filename);
    try {
      const claim = fixture.replacementClaim;
      const reject = async (owner: typeof claim.owner, claimId: string) =>
        fixture.peer.claimGlobalMutation({ ...claim, claimId, owner });
      await expect(
        reject({ ...claim.owner, attemptId: 'missing-attempt' }, 'missing-claim')
      ).rejects.toThrow('persisted attempt');
      await expect(
        reject({ ...claim.owner, taskId: 'missing-task' }, 'wrong-task-claim')
      ).rejects.toThrow('not in the approved run');
      await expect(
        reject({ ...claim.owner, agentId: 'wrong-agent' }, 'wrong-agent-claim')
      ).rejects.toThrow('does not match');
      await expect(reject(fixture.originalClaim.owner, 'already-started-claim')).rejects.toThrow(
        'lifecycle'
      );
      await persistPreparingBuilder(legacyStore, 'run-A', 'attempt-C', 'unbound-agent');
      await expect(
        reject(
          { ...claim.owner, attemptId: 'attempt-C', agentId: 'unbound-agent' },
          'unbound-agent-claim'
        )
      ).rejects.toThrow('approved task binding');
      const tokenBeforeInvalidResource = sqlite
        .prepare('SELECT next_token FROM forge_global_control WHERE id=1')
        .get();
      for (const [claimId, requested] of [
        ['wrong-file-claim', { type: 'file' as const, projectId: 'project-A', fileId: 'file-B' }],
        ['overbroad-claim', { type: 'repository' as const }]
      ] as const) {
        await expect(
          fixture.peer.claimGlobalMutation({ ...claim, claimId, resources: [requested] })
        ).rejects.toThrow('exceeds the approved lease plan');
        expect(
          sqlite
            .prepare('SELECT count(*) AS count FROM forge_global_claims WHERE claim_id=?')
            .get(claimId)
        ).toEqual({ count: 0 });
        expect(
          sqlite
            .prepare('SELECT count(*) AS count FROM forge_global_leases WHERE claim_id=?')
            .get(claimId)
        ).toEqual({ count: 0 });
      }
      expect(
        sqlite.prepare('SELECT next_token FROM forge_global_control WHERE id=1').get()
      ).toEqual(tokenBeforeInvalidResource);
      expect(
        sqlite
          .prepare(
            'SELECT attempt_json FROM agent_execution_attempts WHERE run_id=? AND attempt_id=?'
          )
          .get('run-A', 'attempt-B')
      ).toEqual({ attempt_json: expect.stringContaining('"state":"PREPARING"') });
      expect(
        (await fixture.peer.recoverRepositoryMutationAuthority(fixture.scopeId)).map(
          (lease) => lease.claimId
        )
      ).toEqual(['claim-A']);

      expect(await fixture.peer.claimGlobalMutation(claim)).toMatchObject({ status: 'blocked' });
      expect(
        sqlite
          .prepare(
            'SELECT attempt_json FROM agent_execution_attempts WHERE run_id=? AND attempt_id=?'
          )
          .get('run-A', 'attempt-B')
      ).toEqual({ attempt_json: expect.stringContaining('"state":"PREPARING"') });
      const current = (await fixture.peer.recoverRepositoryMutationAuthority(fixture.scopeId))[0];
      if (current === undefined) {
        throw new Error('Missing original claim');
      }
      await fixture.authority.releaseGlobalMutation({
        scopeId: fixture.scopeId,
        claimId: fixture.originalClaim.claimId,
        owner: fixture.originalClaim.owner,
        token: fixture.originalGrant.token,
        expectedVersion: current.version,
        stopEvidence: 'Builder A has stopped.'
      });
      expect(await fixture.peer.claimGlobalMutation(claim)).toMatchObject({ status: 'granted' });
      expect(
        sqlite
          .prepare(
            'SELECT attempt_json FROM agent_execution_attempts WHERE run_id=? AND attempt_id=?'
          )
          .get('run-A', 'attempt-B')
      ).toEqual({ attempt_json: expect.stringContaining('"state":"STARTING"') });
    } finally {
      sqlite.close();
      legacyStore.close();
      await fixture.close();
    }
  });

  it('validates and advances an admitted repair attempt in the claim transaction', async () => {
    const fixture = await createPermitFixture();
    const legacyStore = new DrizzleSqliteOrchestrationPersistence(fixture.filename);
    const sqlite = new Database(fixture.filename);
    try {
      await legacyStore.persistRepairAttempt({
        runId: 'run-A',
        attempt: {
          id: 'repair-A',
          runId: 'run-A',
          taskId: 'task-A',
          agentId: 'repair-agent',
          workspaceId: 'repair-workspace',
          parentReviewIteration: 1,
          parentReviewSubject: {
            builderAttemptId: 'attempt-A',
            outputAttemptId: 'attempt-A',
            workspaceId: 'workspace-task-A',
            workspaceRevision: 1,
            workspaceChangeFingerprint: `sha256:${'a'.repeat(64)}`,
            impactFingerprint: `sha256:${'b'.repeat(64)}`,
            verificationFingerprint: `sha256:${'c'.repeat(64)}`
          },
          repairIteration: 1,
          state: 'PREPARING',
          revision: 1
        }
      });
      const claim = {
        scopeId: fixture.scopeId,
        claimId: 'repair-claim',
        owner: {
          runId: 'run-A',
          taskId: 'task-A',
          attemptId: 'repair-A',
          agentId: 'repair-agent'
        },
        resources: [{ type: 'file' as const, projectId: 'project-A', fileId: 'file-B' }]
      };
      await expect(fixture.peer.claimGlobalMutation(claim)).rejects.toThrow(
        'no admitted work item'
      );
      await legacyStore.persistRepairWorkItem({
        runId: 'run-A',
        taskId: 'task-A',
        repairAttemptId: 'repair-A',
        builderAttemptId: 'attempt-A',
        workspaceId: 'repair-workspace',
        leasePlanFingerprint: taskLeasePlanFingerprint(leasePlan('task-A')),
        impactFingerprint: `sha256:${'d'.repeat(64)}`,
        parentReviewIteration: 1,
        reviewIteration: 2,
        verificationPolicyFingerprint: `sha256:${'e'.repeat(64)}`,
        codeReviewPolicyFingerprint: `sha256:${'f'.repeat(64)}`
      });
      await expect(
        fixture.peer.claimGlobalMutation({
          ...claim,
          owner: { ...claim.owner, agentId: 'forged-agent' }
        })
      ).rejects.toThrow('does not match');
      const tokenBeforeInvalidResource = sqlite
        .prepare('SELECT next_token FROM forge_global_control WHERE id=1')
        .get();
      for (const [claimId, requested] of [
        ['repair-wrong-file', { type: 'file' as const, projectId: 'project-A', fileId: 'file-B' }],
        ['repair-overbroad', { type: 'repository' as const }]
      ] as const) {
        await expect(
          fixture.peer.claimGlobalMutation({ ...claim, claimId, resources: [requested] })
        ).rejects.toThrow('exceeds the approved lease plan');
        expect(
          sqlite
            .prepare('SELECT count(*) AS count FROM forge_global_claims WHERE claim_id=?')
            .get(claimId)
        ).toEqual({ count: 0 });
        expect(
          sqlite
            .prepare('SELECT count(*) AS count FROM forge_global_leases WHERE claim_id=?')
            .get(claimId)
        ).toEqual({ count: 0 });
      }
      expect(
        sqlite.prepare('SELECT next_token FROM forge_global_control WHERE id=1').get()
      ).toEqual(tokenBeforeInvalidResource);
      expect(
        sqlite
          .prepare('SELECT attempt_json FROM task_repair_attempts WHERE run_id=? AND attempt_id=?')
          .get('run-A', 'repair-A')
      ).toEqual({ attempt_json: expect.stringContaining('"state":"PREPARING"') });
      const original = (await fixture.peer.recoverRepositoryMutationAuthority(fixture.scopeId))[0];
      if (original === undefined) {
        throw new Error('Missing original claim');
      }
      await fixture.authority.releaseGlobalMutation({
        scopeId: fixture.scopeId,
        claimId: fixture.originalClaim.claimId,
        owner: fixture.originalClaim.owner,
        token: fixture.originalGrant.token,
        expectedVersion: original.version,
        stopEvidence: 'Builder A has stopped.'
      });
      expect(
        await fixture.peer.claimGlobalMutation({
          ...claim,
          resources: [{ type: 'file', projectId: 'project-A', fileId: 'file-A' }]
        })
      ).toMatchObject({ status: 'granted' });
      expect(
        sqlite
          .prepare('SELECT attempt_json FROM task_repair_attempts WHERE run_id=? AND attempt_id=?')
          .get('run-A', 'repair-A')
      ).toEqual({ attempt_json: expect.stringContaining('"state":"STARTING"') });
      expect(
        sqlite
          .prepare(
            'SELECT revision FROM task_repair_attempt_history WHERE run_id=? AND attempt_id=?'
          )
          .all('run-A', 'repair-A')
      ).toEqual([{ revision: 1 }]);
    } finally {
      sqlite.close();
      legacyStore.close();
      await fixture.close();
    }
  });
});

describe('SQLite global cutover', () => {
  it('inventories an unknown alias and imports unknown resources as repository authority', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'forge-global-cutover-'));
    const filename = join(directory, 'authority.sqlite');
    const legacyStore = new DrizzleSqliteOrchestrationPersistence(filename);
    const authority = new SqliteGlobalMutationAuthority(filename);
    const peer = new SqliteGlobalMutationAuthority(filename);
    const sqlite = new Database(filename);
    try {
      const scopeId = await authority.registerScope('alias-A');
      const insertRun = sqlite.prepare(`INSERT INTO orchestration_runs
        (id,repository_id,state,created_at,tasks_json,hard_conflicts_json,risk_conflicts_json,schedule_options_json)
        VALUES (?,?,?,?,?,?,?,?)`);
      insertRun.run(
        'historical-B',
        'unregistered-B',
        'ACTIVE',
        '2026-09-29',
        '[]',
        '[]',
        '[]',
        '{}'
      );
      await authority.beginLegacyCutover();
      expect(await peer.recoverLegacyOwners()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: 'run:historical-B',
            repositoryId: 'unregistered-B',
            kind: 'run'
          })
        ])
      );
      await expect(peer.completeLegacyCutover('Old workers stopped.')).rejects.toThrow();
      await expect(peer.activateScope(scopeId)).rejects.toThrow();
      await expect(
        legacyStore.claimIntegrationStart({
          runId: 'historical-B',
          taskId: 'task-B',
          workspaceId: 'workspace-B',
          outputAttemptId: 'output-B'
        })
      ).rejects.toThrow('Legacy mutation admission is closed');
      expect(sqlite.prepare('SELECT count(*) AS count FROM task_integration_claims').get()).toEqual(
        { count: 0 }
      );

      await peer.importLegacyOwner('run:historical-B', scopeId, {
        type: 'file',
        projectId: 'guess',
        fileId: 'guess'
      });
      await peer.completeLegacyCutover('Old workers stopped.');
      await peer.activateScope(scopeId);
      expect(await peer.registerScope('unregistered-B')).toBe(scopeId);
      expect(sqlite.prepare('SELECT count(*) AS count FROM forge_global_scopes').get()).toEqual({
        count: 1
      });
      expect(await peer.recoverRepositoryMutationAuthority(scopeId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            claimId: 'legacy:run:historical-B',
            state: 'HELD_UNCERTAIN',
            resource: { type: 'repository' }
          })
        ])
      );
      insertRun.run(
        'new-B',
        'unregistered-B',
        'ACTIVE',
        '2026-09-29',
        JSON.stringify([task('task-A')]),
        '[]',
        '[]',
        '{}'
      );
      insertTaskBinding(sqlite, 'new-B', 'task-A', 'agent-A');
      await authority.bindRun('new-B', 'unregistered-B');
      await persistPreparingBuilder(legacyStore, 'new-B', 'attempt-A', 'agent-A');
      expect(
        await peer.claimGlobalMutation({
          scopeId,
          claimId: 'new-claim',
          owner: { runId: 'new-B', taskId: 'task-A', attemptId: 'attempt-A', agentId: 'agent-A' },
          resources: [{ type: 'file', projectId: 'project-A', fileId: 'file-A' }]
        })
      ).toMatchObject({ status: 'blocked' });
      const blockedAttempt: unknown = sqlite
        .prepare(
          'SELECT attempt_json FROM agent_execution_attempts WHERE run_id=? AND attempt_id=?'
        )
        .get('new-B', 'attempt-A');
      expect(blockedAttempt).toEqual({
        attempt_json: expect.stringContaining('"state":"PREPARING"')
      });
    } finally {
      sqlite.close();
      peer.close();
      authority.close();
      legacyStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
