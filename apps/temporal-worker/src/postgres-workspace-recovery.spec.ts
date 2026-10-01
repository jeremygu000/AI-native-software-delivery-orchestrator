import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, expect, it, vi } from 'vitest';
import type { WorkspaceSetupRecoverySnapshot } from '@ai-native-software-delivery-orchestrator/postgres-persistence';

import { PostgresWorkspaceRecoveryObserver } from './postgres-workspace-recovery.js';

const workspacePath = realpathSync(mkdtempSync(join(tmpdir(), 'forge-recovery-unit-')));
afterAll(() => rmSync(workspacePath, { recursive: true, force: true }));

const generation = {
  scopeId: 'scope',
  parentClaimId: 'parent',
  generationId: 'generation',
  workspaceId: 'workspace',
  workspacePath,
  workspaceDevice: '1',
  workspaceInode: '2',
  supervisorId: 'supervisor',
  containerId: 'a'.repeat(64)
};

const initial: WorkspaceSetupRecoverySnapshot = {
  scopeId: 'scope',
  parentClaimId: 'parent',
  owner: {
    runId: 'run',
    taskId: 'task',
    attemptId: 'attempt',
    agentId: 'agent',
    workspaceId: 'workspace'
  },
  token: 5,
  version: 1,
  parentState: 'ACTIVE' as const,
  phase: 'WORKSPACE_ARMED' as const,
  workspaceId: 'workspace',
  setupPlanDigest: 'setup',
  executionPlanDigest: 'execution',
  signingKey: 'key',
  authorizationDigest: 'authorization',
  runState: 'ACTIVE',
  generation: { id: 'generation', state: 'ISSUED' as const, supervisorId: 'supervisor' },
  permit: { id: 'permit', completed: false }
};
const uncertain: WorkspaceSetupRecoverySnapshot = {
  ...initial,
  version: 2,
  parentState: 'HELD_UNCERTAIN' as const,
  phase: 'WORKSPACE_UNCERTAIN' as const,
  generation: { id: 'generation', supervisorId: 'supervisor', state: 'REVOKED' as const },
  permit: { id: 'permit', completed: true },
  workspace: { revision: 1, workspacePath, branchName: 'forge/run/task' }
};
const workspace = {
  id: 'workspace',
  runId: 'run',
  taskId: 'task',
  revision: 1,
  phase: 'READY_TO_INTEGRATE' as const,
  workspacePath,
  integrationRepositoryPath: '/repo',
  branchName: 'forge/run/task',
  baseRef: 'main',
  integrationRef: 'main'
};
const git = {
  workspaceId: 'workspace',
  workspaceRevision: 1,
  worktreePath: workspacePath,
  integrationRepositoryPath: '/repo',
  commonGitDirectory: '/repo/.git',
  headCommit: 'a'.repeat(40),
  baseCommit: 'a'.repeat(40),
  branchRef: 'refs/heads/forge/run/task',
  branchCommit: 'a'.repeat(40),
  clean: true as const
};

const fixture = () => {
  const calls: string[] = [];
  const recover = vi.fn(async () => {
    calls.push('authority');
    return recover.mock.calls.length === 1 ? initial : uncertain;
  });
  const revoke = vi.fn(async () => {
    calls.push('revoke');
  });
  const stopAndVerify = vi.fn(async () => {
    calls.push('stop');
    return { generation, exitCode: 137 };
  });
  const assertStopped = vi.fn(async () => {
    calls.push('stopped');
  });
  const inspectStoppedWorkspace = vi.fn(async () => {
    calls.push('git');
    return git;
  });
  const recoverRun = vi.fn(async () => {
    calls.push('run');
    return {
      run: {
        state: 'ACTIVE' as const,
        authority: { repositoryRoot: '/repo', baseCommit: 'a'.repeat(40) }
      },
      workspaces: [{ workspace }],
      taskBindings: [{ taskId: 'task', agentId: 'agent', workspace }]
    };
  });
  const observer = new PostgresWorkspaceRecoveryObserver({
    authority: { recoverWorkspaceSetupEvidence: recover },
    issuer: { revoke },
    persistence: { recoverRun },
    supervisor: { stopAndVerify, assertStopped, inspectStoppedWorkspace }
  });
  return { observer, calls, recover, revoke, stopAndVerify, inspectStoppedWorkspace, recoverRun };
};

it('revokes durably before stopping the container and inspecting Git, without granting authority', async () => {
  const { observer, calls, revoke, inspectStoppedWorkspace } = fixture();
  await expect(observer.observe(generation)).resolves.toMatchObject({
    authority: uncertain,
    git,
    containerExitCode: 137
  });
  expect(calls).toEqual([
    'authority',
    'revoke',
    'stop',
    'authority',
    'run',
    'stopped',
    'git',
    'stopped',
    'run',
    'authority'
  ]);
  expect(revoke).toHaveBeenCalledWith('generation', 'scope');
  expect(inspectStoppedWorkspace).toHaveBeenCalledWith(generation, {
    workspace,
    approvedRepositoryRoot: '/repo',
    approvedBaseCommit: 'a'.repeat(40)
  });
});

it('never touches the supervisor if the generation is not durably bound or revocation fails', async () => {
  const mismatch = fixture();
  mismatch.recover.mockResolvedValueOnce({
    ...initial,
    generation: { id: 'generation', state: 'ISSUED' as const, supervisorId: 'other' }
  });
  await expect(mismatch.observer.observe(generation)).rejects.toThrow('generation does not match');
  expect(mismatch.revoke).not.toHaveBeenCalled();
  expect(mismatch.stopAndVerify).not.toHaveBeenCalled();

  const failed = fixture();
  failed.revoke.mockRejectedValueOnce(new Error('issuer unavailable'));
  await expect(failed.observer.observe(generation)).rejects.toThrow('issuer unavailable');
  expect(failed.stopAndVerify).not.toHaveBeenCalled();
});

it('refuses Git inspection when the permit is pending or the generation stays issued', async () => {
  for (const later of [
    { ...uncertain, permit: { id: 'permit', completed: false } },
    {
      ...uncertain,
      generation: { id: 'generation', state: 'ISSUED' as const, supervisorId: 'supervisor' }
    }
  ]) {
    const caseFixture = fixture();
    caseFixture.recover.mockResolvedValueOnce(initial).mockResolvedValueOnce(later);
    await expect(caseFixture.observer.observe(generation)).rejects.toThrow(
      'not an uncertain completed workspace setup'
    );
    expect(caseFixture.inspectStoppedWorkspace).not.toHaveBeenCalled();
  }
});

it('fails closed when the workspace or durable authority changes during inspection', async () => {
  const wrongWorkspace = fixture();
  wrongWorkspace.recoverRun.mockResolvedValueOnce({
    run: { state: 'ACTIVE', authority: { repositoryRoot: '/repo', baseCommit: 'a'.repeat(40) } },
    workspaces: [{ workspace: { ...workspace, workspacePath: '/other' } }],
    taskBindings: [{ taskId: 'task', agentId: 'agent', workspace }]
  });
  await expect(wrongWorkspace.observer.observe(generation)).rejects.toThrow('bound approved run');
  expect(wrongWorkspace.inspectStoppedWorkspace).not.toHaveBeenCalled();

  const changed = fixture();
  changed.recover
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce(uncertain)
    .mockResolvedValueOnce({
      ...uncertain,
      version: 3
    });
  await expect(changed.observer.observe(generation)).rejects.toThrow(
    'changed during Git inspection'
  );

  const changedRun = fixture();
  changedRun.recoverRun
    .mockResolvedValueOnce({
      run: { state: 'ACTIVE', authority: { repositoryRoot: '/repo', baseCommit: 'a'.repeat(40) } },
      workspaces: [{ workspace }],
      taskBindings: [{ taskId: 'task', agentId: 'agent', workspace }]
    })
    .mockResolvedValueOnce({
      run: { state: 'ACTIVE', authority: { repositoryRoot: '/repo', baseCommit: 'b'.repeat(40) } },
      workspaces: [{ workspace }],
      taskBindings: [{ taskId: 'task', agentId: 'agent', workspace }]
    });
  await expect(changedRun.observer.observe(generation)).rejects.toThrow(
    'approved run or workspace changed'
  );

  const changedBranch = fixture();
  changedBranch.recover
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce(uncertain)
    .mockResolvedValueOnce({
      ...uncertain,
      workspace: { revision: 1, workspacePath, branchName: 'different-branch' }
    });
  await expect(changedBranch.observer.observe(generation)).rejects.toThrow(
    'changed during Git inspection'
  );
});
