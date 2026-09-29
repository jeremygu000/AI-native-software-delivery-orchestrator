import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { DrizzleSqliteOrchestrationPersistence } from './drizzle-sqlite-orchestration-persistence.js';
import { globalMutationPermitContract } from './global-mutation-authority.contract.test.js';
import { SqliteGlobalMutationAuthority } from './sqlite-global-mutation-authority.js';

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
      .run('run-A', repositoryId, 'ACTIVE', '2026-09-29T00:00:00.000Z', '[]', '[]', '[]', '{}');
  } finally {
    sqlite.close();
  }
  await authority.bindRun('run-A', repositoryId);
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
      owner: { ...originalClaim.owner, attemptId: 'attempt-B', agentId: 'agent-B' }
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
      expect(await peer.recoverRepositoryMutationAuthority(scopeId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            claimId: 'legacy:run:historical-B',
            state: 'HELD_UNCERTAIN',
            resource: { type: 'repository' }
          })
        ])
      );
      insertRun.run('new-A', 'alias-A', 'ACTIVE', '2026-09-29', '[]', '[]', '[]', '{}');
      await authority.bindRun('new-A', 'alias-A');
      expect(
        await peer.claimGlobalMutation({
          scopeId,
          claimId: 'new-claim',
          owner: { runId: 'new-A', taskId: 'task-A', attemptId: 'attempt-A', agentId: 'agent-A' },
          resources: [{ type: 'file', projectId: 'project-A', fileId: 'file-A' }]
        })
      ).toMatchObject({ status: 'blocked' });
    } finally {
      sqlite.close();
      peer.close();
      authority.close();
      legacyStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
