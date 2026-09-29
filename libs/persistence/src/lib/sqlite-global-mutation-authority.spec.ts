import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { taskLeasePlanFingerprint } from '@ai-native-software-delivery-orchestrator/domain';
import { describe, expect, it } from 'vitest';

import { DrizzleSqliteOrchestrationPersistence } from './drizzle-sqlite-orchestration-persistence.js';
import { globalMutationPermitContract } from './global-mutation-authority.contract.test.js';
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
  await authority.bindRun('run-A', repositoryId);
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
      expect(await fixture.peer.claimGlobalMutation(claim)).toMatchObject({ status: 'granted' });
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
