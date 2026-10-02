import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, expect, it, vi } from 'vitest';
import type { WorkspaceRecoveryObservation } from './postgres-workspace-recovery.js';

import {
  WorkspaceRecoveryAttestor,
  verifyWorkspaceRecoveryAttestation
} from './workspace-recovery-attestation.js';

const workspacePath = realpathSync(mkdtempSync(join(tmpdir(), 'forge-attestation-')));
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

const observation: WorkspaceRecoveryObservation = {
  containerExitCode: 137,
  authority: {
    scopeId: 'scope',
    parentClaimId: 'parent',
    owner: {
      runId: 'run',
      taskId: 'task',
      attemptId: 'attempt',
      agentId: 'agent',
      workspaceId: 'workspace'
    },
    token: 1,
    version: 2,
    parentState: 'HELD_UNCERTAIN' as const,
    phase: 'WORKSPACE_UNCERTAIN' as const,
    workspaceId: 'workspace',
    setupPlanDigest: 'setup',
    executionPlanDigest: 'execution',
    signingKey: 'setup-signer',
    authorizationDigest: 'authorization',
    runState: 'ACTIVE',
    generation: { id: 'generation', state: 'REVOKED' as const, supervisorId: 'supervisor' },
    permit: { id: 'permit', completed: true },
    workspace: { revision: 1, workspacePath, branchName: 'forge/run/task' }
  },
  git: {
    workspaceId: 'workspace',
    workspaceRevision: 1,
    worktreePath: workspacePath,
    integrationRepositoryPath: '/repository',
    commonGitDirectory: '/repository/.git',
    headCommit: 'a'.repeat(40),
    baseCommit: 'a'.repeat(40),
    branchRef: 'refs/heads/forge/run/task',
    branchCommit: 'a'.repeat(40),
    clean: true as const
  }
};

const fixture = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const observe = vi.fn(async () => observation);
  const observePendingPermit = vi.fn(async () => ({
    ...observation,
    authority: {
      ...observation.authority,
      parentState: 'ACTIVE' as const,
      phase: 'WORKSPACE_ARMED' as const,
      version: 1,
      permit: { id: 'permit', completed: false }
    }
  }));
  const signer = new WorkspaceRecoveryAttestor(
    { observe, observePendingPermit },
    'recovery-signer',
    privateKey.export({ type: 'pkcs8', format: 'pem' })
  );
  const keys = new Map([['recovery-signer', publicKey.export({ type: 'spki', format: 'pem' })]]);
  return { signer, observe, observePendingPermit, keys };
};

it('attests a single unresolved Git lineage only after stopped-generation inspection', async () => {
  const { signer, observePendingPermit, keys } = fixture();
  const proof = await signer.attestPendingPermit(generation);
  expect(observePendingPermit).toHaveBeenCalledExactlyOnceWith(generation);
  expect(
    verifyWorkspaceRecoveryAttestation({ attestation: proof, trustedPublicKeys: keys })
  ).toEqual(proof);
  expect(proof.observation.authority).toMatchObject({
    parentState: 'ACTIVE',
    phase: 'WORKSPACE_ARMED',
    permit: { completed: false }
  });
});

it('signs only an independent observer result and binds every recovery and Git identity', async () => {
  const { signer, observe, keys } = fixture();
  const attestation = await signer.attest(generation);
  expect(observe).toHaveBeenCalledExactlyOnceWith(generation);
  expect(verifyWorkspaceRecoveryAttestation({ attestation, trustedPublicKeys: keys })).toEqual(
    attestation
  );
  for (const forged of [
    { ...attestation, observation: { ...attestation.observation, containerExitCode: 0 } },
    {
      ...attestation,
      observation: {
        ...attestation.observation,
        authority: { ...attestation.observation.authority, token: 2 }
      }
    },
    {
      ...attestation,
      observation: {
        ...attestation.observation,
        git: { ...attestation.observation.git, headCommit: 'b'.repeat(40) }
      }
    },
    { ...attestation, generation: { ...attestation.generation, containerId: 'b'.repeat(64) } }
  ]) {
    expect(() =>
      verifyWorkspaceRecoveryAttestation({ attestation: forged, trustedPublicKeys: keys })
    ).toThrow('signature is invalid');
  }
});

it('rejects response tampering, unknown keys, and expired or not-yet-valid evidence', async () => {
  const { signer, keys } = fixture();
  const attestation = await signer.attest(generation);
  expect(() =>
    verifyWorkspaceRecoveryAttestation({
      attestation: { ...attestation, digest: 'sha256:' + 'f'.repeat(64) },
      trustedPublicKeys: keys
    })
  ).toThrow('signature is invalid');
  expect(() =>
    verifyWorkspaceRecoveryAttestation({ attestation, trustedPublicKeys: new Map() })
  ).toThrow('not trusted');
  expect(() =>
    verifyWorkspaceRecoveryAttestation({
      attestation,
      trustedPublicKeys: keys,
      now: new Date(attestation.expiresAt)
    })
  ).toThrow('stale');
  expect(() =>
    verifyWorkspaceRecoveryAttestation({
      attestation,
      trustedPublicKeys: keys,
      now: new Date(Date.parse(attestation.issuedAt) - 1)
    })
  ).toThrow('stale');
  const failed = fixture();
  failed.observe.mockRejectedValueOnce(new Error('supervisor cannot confirm stop'));
  await expect(failed.signer.attest(generation)).rejects.toThrow('cannot confirm stop');
  const incomplete = fixture();
  incomplete.observe.mockResolvedValueOnce({
    ...observation,
    authority: {
      ...observation.authority,
      generation: { id: 'generation', supervisorId: 'supervisor', state: 'ISSUED' }
    }
  });
  await expect(incomplete.signer.attest(generation)).rejects.toThrow('not an eligible Git setup');
});
