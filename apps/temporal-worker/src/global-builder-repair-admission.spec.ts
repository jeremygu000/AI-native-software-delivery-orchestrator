import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  taskLeasePlanFingerprint,
  type AgentExecutionAttempt,
  type CreatePersistedRunRequest
} from '@ai-native-software-delivery-orchestrator/domain';
import {
  DrizzleSqliteOrchestrationPersistence,
  SqliteGlobalMutationAuthority
} from '@ai-native-software-delivery-orchestrator/persistence';
import { describe, expect, it } from 'vitest';

import { GlobalBuilderRepairAdmission } from '@ai-native-software-delivery-orchestrator/forge-runtime-composition';

const digest = (digit: string): string => `sha256:${digit.repeat(64)}`;
const runId = 'global-admission-run';
const request: CreatePersistedRunRequest = {
  run: {
    id: runId,
    repositoryId: 'approved-repository',
    state: 'ACTIVE',
    createdAt: '2026-09-01T00:00:00.000Z',
    authority: {
      artifactId: 'artifact',
      artifactRevision: 1,
      approvalId: 'approval',
      planFingerprint: digest('1'),
      approvalFingerprint: digest('2'),
      claimFingerprint: digest('3'),
      executionFingerprint: digest('4'),
      repositoryRoot: '/approved-repository',
      baseCommit: '5'.repeat(40),
      workingTreeFingerprint: digest('6'),
      repositoryFactsFingerprint: digest('7'),
      sharedResourcePolicyFingerprint: digest('8'),
      verificationPolicyFingerprint: digest('9'),
      codeReviewPolicyFingerprint: digest('a')
    }
  },
  tasks: [
    {
      id: 'task-1',
      title: 'Build',
      goal: 'Build',
      dependencies: [],
      expectedReads: [],
      expectedWrites: [],
      sharedResources: [],
      verification: []
    }
  ],
  taskBindings: [
    {
      runId,
      taskId: 'task-1',
      agentId: 'agent-1',
      leasePlan: {
        taskId: 'task-1',
        source: 'manual',
        predictedResources: [{ type: 'project', projectId: 'project-1' }]
      },
      workspace: {
        id: 'workspace-1',
        runId,
        taskId: 'task-1',
        integrationRepositoryPath: '/approved-repository',
        workspacePath: '/workspaces/task-1',
        branchName: 'forge/global-admission-run/task-1',
        baseRef: 'main',
        integrationRef: 'main'
      }
    }
  ],
  hardConflicts: [],
  riskConflicts: [],
  scheduleOptions: { maxConcurrency: 1 }
};

describe('GlobalBuilderRepairAdmission with durable SQLite authority', () => {
  it('requires a bound run, advances only a persisted attempt, and fences its callback', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'forge-admission-'));
    const filename = join(directory, 'authority.sqlite');
    const store = new DrizzleSqliteOrchestrationPersistence(filename);
    const authority = new SqliteGlobalMutationAuthority(filename);
    const peer = new SqliteGlobalMutationAuthority(filename);
    try {
      const scopeId = await authority.registerScope(request.run.repositoryId);
      await store.createRun(request);
      const binding = request.taskBindings[0];
      if (binding === undefined) {
        throw new Error('Missing test binding');
      }
      const attempt: AgentExecutionAttempt = {
        id: 'builder-A',
        runId,
        taskId: binding.taskId,
        agentId: binding.agentId,
        workspaceId: binding.workspace.id,
        leasePlanFingerprint: taskLeasePlanFingerprint(binding.leasePlan),
        state: 'PREPARING',
        revision: 1
      };
      await store.persistAttempt({ runId, attempt });
      const orphan = {
        ...attempt,
        id: 'builder-without-claim',
        state: 'STARTING' as const,
        startedAt: new Date()
      };
      await store.persistAttempt({ runId, attempt: orphan });
      await authority.beginLegacyCutover();
      for (const historical of await authority.recoverLegacyOwners()) {
        await authority.settleLegacyOwner(historical.key, 'Legacy writer has stopped');
      }
      await authority.completeLegacyCutover('All previous workers stopped');
      await authority.activateScope(scopeId);
      const admission = new GlobalBuilderRepairAdmission(peer);
      await expect(admission.admitBuilder(binding, attempt)).rejects.toThrow(
        'durable global scope'
      );
      expect((await store.recoverAttempts(runId))[0]?.attempt.state).toBe('PREPARING');
      await authority.bindRun(runId, request.run.repositoryId);
      await expect(
        admission.admitBuilder(
          { ...binding, workspace: { ...binding.workspace, id: 'wrong' } },
          attempt
        )
      ).rejects.toThrow('exact approved attempt');
      const result = await admission.admitBuilder(binding, attempt);
      expect(result.status).toBe('granted');
      if (result.status !== 'granted') {
        throw new Error('Missing admitted claim');
      }
      const { mutation, leases } = result.admission;
      expect(mutation.claim).toMatchObject({
        scopeId,
        owner: {
          runId,
          taskId: 'task-1',
          attemptId: 'builder-A',
          agentId: 'agent-1',
          workspaceId: 'workspace-1'
        }
      });
      expect(leases).toHaveLength(1);
      expect((await store.recoverAttempts(runId))[0]?.attempt.state).toBe('STARTING');
      const startingBuilder = (await store.recoverAttempts(runId))[0]?.attempt;
      if (startingBuilder === undefined) {
        throw new Error('Missing committed builder attempt');
      }
      // Discard the first response: a new seam instance must recover the same
      // committed claim and token from the persisted STARTING attempt.
      const builderReplay = await new GlobalBuilderRepairAdmission(authority).admitBuilder(
        binding,
        startingBuilder
      );
      expect(builderReplay.status).toBe('granted');
      if (builderReplay.status !== 'granted') {
        throw new Error('Missing replayed builder admission');
      }
      expect(builderReplay.admission.mutation.claim).toEqual(mutation.claim);
      expect(builderReplay.admission.leases).toEqual(leases);
      const staleBuilderReplay = await admission.admitBuilder(binding, attempt);
      expect(staleBuilderReplay.status).toBe('granted');
      if (staleBuilderReplay.status !== 'granted') {
        throw new Error('Missing replay from a stale PREPARING builder object');
      }
      expect(staleBuilderReplay.admission.mutation.claim).toEqual(mutation.claim);
      expect(staleBuilderReplay.admission.leases).toEqual(leases);
      expect(
        (await authority.recoverRepositoryMutationAuthority(scopeId)).filter(
          (item) => item.state === 'ACTIVE'
        )
      ).toHaveLength(1);

      await expect(admission.admitBuilder(binding, orphan)).rejects.toThrow(
        'Attempt lifecycle does not authorize global mutation admission'
      );
      expect(
        (await authority.recoverRepositoryMutationAuthority(scopeId)).filter(
          (item) => item.state === 'ACTIVE'
        )
      ).toHaveLength(1);
      const rival = { ...attempt, id: 'builder-B' };
      await store.persistAttempt({ runId, attempt: rival });
      const blocked = await admission.admitBuilder(binding, rival);
      expect(blocked.status).toBe('blocked');
      expect(
        (await store.recoverAttempts(runId)).find((item) => item.attempt.id === rival.id)?.attempt
          .state
      ).toBe('PREPARING');
      let called = 0;
      const file = { type: 'file' as const, projectId: 'project-1', fileId: 'file-1' };
      await result.admission.execute(file, async () => {
        called++;
      });
      expect(called).toBe(1);
      expect(await authority.recoverFencedMutationPermits(scopeId)).toEqual([]);
      const current = (await authority.recoverRepositoryMutationAuthority(scopeId))[0];
      if (current === undefined) {
        throw new Error('Missing granted lease');
      }
      await authority.releaseGlobalMutation({
        scopeId,
        claimId: mutation.claim.claimId,
        owner: mutation.claim.owner,
        token: mutation.claim.token,
        expectedVersion: current.version,
        stopEvidence: 'Builder stopped'
      });
      await expect(
        result.admission.execute(file, async () => {
          called++;
        })
      ).rejects.toThrow();
      expect(called).toBe(1);

      const repair = {
        id: 'repair-A',
        runId,
        taskId: 'task-1',
        agentId: 'repair-agent',
        workspaceId: 'workspace-1',
        parentReviewIteration: 1,
        repairIteration: 1,
        parentReviewSubject: {
          builderAttemptId: 'builder-A',
          outputAttemptId: 'builder-A',
          workspaceId: 'workspace-1',
          workspaceRevision: 1,
          workspaceChangeFingerprint: digest('b'),
          impactFingerprint: digest('c'),
          verificationFingerprint: digest('d')
        },
        state: 'PREPARING' as const,
        revision: 1
      };
      await store.persistRepairAttempt({ runId, attempt: repair });
      await expect(admission.admitRepair(binding, repair)).rejects.toThrow('no admitted work item');
      await store.persistRepairWorkItem({
        runId,
        taskId: 'task-1',
        repairAttemptId: 'repair-A',
        builderAttemptId: 'builder-A',
        workspaceId: 'workspace-1',
        leasePlanFingerprint: attempt.leasePlanFingerprint,
        impactFingerprint: digest('e'),
        parentReviewIteration: 1,
        reviewIteration: 2,
        verificationPolicyFingerprint: digest('f'),
        codeReviewPolicyFingerprint: digest('a')
      });
      const repairResult = await admission.admitRepair(binding, repair);
      expect(repairResult.status).toBe('granted');
      if (repairResult.status !== 'granted') {
        throw new Error('Missing admitted repair claim');
      }
      expect(repairResult.admission.mutation.claim.owner).toMatchObject({
        runId,
        attemptId: 'repair-A',
        agentId: 'repair-agent',
        workspaceId: 'workspace-1'
      });
      expect((await store.recoverRepairAttempts(runId))[0]?.attempt.state).toBe('STARTING');
      const startingRepair = (await store.recoverRepairAttempts(runId))[0]?.attempt;
      if (startingRepair === undefined) {
        throw new Error('Missing committed repair attempt');
      }
      const repairReplay = await new GlobalBuilderRepairAdmission(authority).admitRepair(
        binding,
        startingRepair
      );
      expect(repairReplay.status).toBe('granted');
      if (repairReplay.status !== 'granted') {
        throw new Error('Missing replayed repair admission');
      }
      expect(repairReplay.admission.mutation.claim).toEqual(repairResult.admission.mutation.claim);
      expect(repairReplay.admission.leases).toEqual(repairResult.admission.leases);
      const staleRepairReplay = await admission.admitRepair(binding, repair);
      expect(staleRepairReplay.status).toBe('granted');
      if (staleRepairReplay.status !== 'granted') {
        throw new Error('Missing replay from a stale PREPARING repair object');
      }
      expect(staleRepairReplay.admission.mutation.claim).toEqual(
        repairResult.admission.mutation.claim
      );
      expect(staleRepairReplay.admission.leases).toEqual(repairResult.admission.leases);
      expect(repairResult.admission.mutation.claim.token).toBe(mutation.claim.token + 1);
      expect(
        (await authority.recoverRepositoryMutationAuthority(scopeId)).filter(
          (item) => item.state === 'ACTIVE'
        )
      ).toHaveLength(1);
      await expect(
        repairResult.admission.execute({ type: 'repository' }, async () => {
          called++;
        })
      ).rejects.toThrow();
      expect(called).toBe(1);
      const repairLease = repairResult.admission.leases[0];
      if (repairLease === undefined) {
        throw new Error('Missing repair lease');
      }
      await authority.releaseGlobalMutation({
        scopeId,
        claimId: repairResult.admission.mutation.claim.claimId,
        owner: repairResult.admission.mutation.claim.owner,
        token: repairResult.admission.mutation.claim.token,
        expectedVersion: repairLease.version,
        stopEvidence: 'Repair stopped'
      });
      const afterReplay = await admission.admitBuilder(binding, rival);
      expect(afterReplay.status).toBe('granted');
      if (afterReplay.status !== 'granted') {
        throw new Error('Missing next claim after exact retries');
      }
      expect(afterReplay.admission.mutation.claim.token).toBe(
        repairResult.admission.mutation.claim.token + 1
      );
    } finally {
      peer.close();
      authority.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
