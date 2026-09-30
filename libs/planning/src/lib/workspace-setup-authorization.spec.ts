import { generateKeyPairSync, sign } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { approvalTestArtifact } from './plan-artifact.fixture.js';
import { fingerprintPlanValue } from './plan-artifact.js';
import { createPlanApproval } from './plan-approval.js';
import {
  verifyWorkspaceSetupAuthorization,
  workspaceSetupAuthorizationMessage
} from './workspace-setup-authorization.js';
import {
  createWorkspaceSetupApproval,
  parseWorkspaceSetupApproval
} from './workspace-setup-approval.js';

const fixture = () => {
  const artifact = approvalTestArtifact();
  const executionApproval = createPlanApproval({
    approvalId: 'execution-1',
    artifact,
    approvedBy: 'reviewer',
    approvedAt: '2026-08-13T01:00:00.000Z'
  });
  const setupApproval = createWorkspaceSetupApproval({
    setupApprovalId: 'setup-1',
    artifact,
    executionApproval,
    taskId: 'task-a',
    approvedBy: 'git-reviewer',
    approvedAt: '2026-08-13T02:00:00.000Z'
  });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const authorize = (keyId = 'trusted-git-setup') => ({
    schemaVersion: 1 as const,
    keyId,
    setupApprovalId: setupApproval.setupApprovalId,
    setupApprovalFingerprint: setupApproval.setupApprovalFingerprint,
    signature: sign(
      null,
      workspaceSetupAuthorizationMessage(setupApproval, keyId),
      privateKey
    ).toString('base64url')
  });
  return { artifact, executionApproval, setupApproval, publicKeyPem, authorize };
};

describe('trusted Git workspace setup authorization boundary', () => {
  it('verifies a separate signer over the exact record and approved execution', () => {
    const { artifact, executionApproval, setupApproval, publicKeyPem, authorize } = fixture();
    expect(
      verifyWorkspaceSetupAuthorization({
        artifact,
        executionApproval,
        setupApproval,
        authorization: authorize(),
        trustedPublicKeys: new Map([['trusted-git-setup', publicKeyPem]])
      })
    ).toEqual(setupApproval);
  });

  it('does not treat a rehashed, internally valid unsigned record as authorization', () => {
    const { artifact, executionApproval, setupApproval, publicKeyPem, authorize } = fixture();
    const { setupApprovalFingerprint: _fingerprint, ...payload } = setupApproval;
    const changed = { ...payload, approvedBy: 'forged-git-reviewer' };
    const forged = parseWorkspaceSetupApproval({
      ...changed,
      setupApprovalFingerprint: fingerprintPlanValue(changed)
    });
    expect(() =>
      verifyWorkspaceSetupAuthorization({
        artifact,
        executionApproval,
        setupApproval: forged,
        authorization: authorize(),
        trustedPublicKeys: new Map([['trusted-git-setup', publicKeyPem]])
      })
    ).toThrow('does not have a valid trusted authorization');
  });

  it('rejects an unknown key, swapped key ID, mismatched identity or untrusted signing key', () => {
    const { artifact, executionApproval, setupApproval, publicKeyPem, authorize } = fixture();
    const request = {
      artifact,
      executionApproval,
      setupApproval,
      trustedPublicKeys: new Map([['trusted-git-setup', publicKeyPem]])
    };
    expect(() =>
      verifyWorkspaceSetupAuthorization({ ...request, authorization: authorize('other') })
    ).toThrow();
    expect(() =>
      verifyWorkspaceSetupAuthorization({
        ...request,
        authorization: { ...authorize(), keyId: 'different' },
        trustedPublicKeys: new Map([['different', publicKeyPem]])
      })
    ).toThrow();
    expect(() =>
      verifyWorkspaceSetupAuthorization({
        ...request,
        authorization: { ...authorize(), setupApprovalId: 'setup-2' }
      })
    ).toThrow();
    const untrusted = generateKeyPairSync('ed25519').publicKey.export({
      type: 'spki',
      format: 'pem'
    });
    expect(() =>
      verifyWorkspaceSetupAuthorization({
        ...request,
        authorization: authorize(),
        trustedPublicKeys: new Map([['trusted-git-setup', untrusted]])
      })
    ).toThrow();
    expect(() =>
      verifyWorkspaceSetupAuthorization({
        ...request,
        authorization: { ...authorize(), signature: 'A'.repeat(86) }
      })
    ).toThrow();
    const { publicKey: rsaKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() =>
      verifyWorkspaceSetupAuthorization({
        ...request,
        authorization: authorize(),
        trustedPublicKeys: new Map([
          ['trusted-git-setup', rsaKey.export({ type: 'spki', format: 'pem' })]
        ])
      })
    ).toThrow();
  });

  it('requires the exact signed artifact and execution approval, not merely a valid signature', () => {
    const { executionApproval, setupApproval, publicKeyPem, authorize } = fixture();
    expect(() =>
      verifyWorkspaceSetupAuthorization({
        artifact: approvalTestArtifact('different-plan'),
        executionApproval,
        setupApproval,
        authorization: authorize(),
        trustedPublicKeys: new Map([['trusted-git-setup', publicKeyPem]])
      })
    ).toThrow('does not match approved execution');
  });
});
