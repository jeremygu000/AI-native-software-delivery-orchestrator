import { createPublicKey, verify } from 'node:crypto';

import { z } from 'zod';

import { canonicalPlanJson, type PlanArtifact } from './plan-artifact.js';
import type { PlanApproval } from './plan-approval.js';
import {
  assertWorkspaceSetupApproval,
  parseWorkspaceSetupApproval,
  type WorkspaceSetupApproval
} from './workspace-setup-approval.js';

const recordId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/** This signature is separate from the unsigned setup record and its content fingerprint. */
export const workspaceSetupAuthorizationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  keyId: recordId,
  setupApprovalId: recordId,
  setupApprovalFingerprint: digest,
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/)
});

export type WorkspaceSetupAuthorization = z.infer<typeof workspaceSetupAuthorizationSchema>;

export class WorkspaceSetupAuthorizationError extends Error {
  constructor() {
    super('Git setup decision does not have a valid trusted authorization');
    this.name = 'WorkspaceSetupAuthorizationError';
  }
}

/** Canonical, domain-separated bytes for a separate signer; never sign just the record ID or digest. */
export const workspaceSetupAuthorizationMessage = (
  setupApproval: WorkspaceSetupApproval,
  keyId: string
): Buffer => {
  const setup = parseWorkspaceSetupApproval(setupApproval);
  return Buffer.from(
    canonicalPlanJson({
      purpose: 'forge-git-workspace-setup-authorization-v1',
      keyId: recordId.parse(keyId),
      setupApproval: setup
    }),
    'utf8'
  );
};

/** Trusted keys must be supplied by a separate configuration, never by the record or its store. */
export const verifyWorkspaceSetupAuthorization = (request: {
  readonly setupApproval: WorkspaceSetupApproval;
  readonly artifact: PlanArtifact;
  readonly executionApproval: PlanApproval;
  readonly authorization: WorkspaceSetupAuthorization;
  readonly trustedPublicKeys: ReadonlyMap<string, string>;
}): WorkspaceSetupApproval => {
  const setup = assertWorkspaceSetupApproval(request);
  const authorization = workspaceSetupAuthorizationSchema.parse(request.authorization);
  const publicKeyPem = request.trustedPublicKeys.get(authorization.keyId);
  if (
    publicKeyPem === undefined ||
    authorization.setupApprovalId !== setup.setupApprovalId ||
    authorization.setupApprovalFingerprint !== setup.setupApprovalFingerprint
  ) {
    throw new WorkspaceSetupAuthorizationError();
  }
  const publicKey = createPublicKey(publicKeyPem);
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new WorkspaceSetupAuthorizationError();
  }
  const signature = Buffer.from(authorization.signature, 'base64url');
  if (
    signature.length !== 64 ||
    signature.toString('base64url') !== authorization.signature ||
    !verify(
      null,
      workspaceSetupAuthorizationMessage(setup, authorization.keyId),
      publicKey,
      signature
    )
  ) {
    throw new WorkspaceSetupAuthorizationError();
  }
  return setup;
};
