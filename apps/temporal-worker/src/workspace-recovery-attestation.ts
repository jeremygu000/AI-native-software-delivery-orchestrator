import { createPrivateKey, createPublicKey, randomUUID, sign, verify } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  canonicalPlanJson,
  fingerprintPlanValue
} from '@ai-native-software-delivery-orchestrator/planning';
import type { SupervisedWorkspaceGeneration } from '@ai-native-software-delivery-orchestrator/workspace-git';

import {
  PostgresWorkspaceRecoveryObserver,
  type WorkspaceRecoveryObservation
} from './postgres-workspace-recovery.js';

const purpose = 'forge-workspace-recovery-attestation-v1';
const signaturePattern = /^[A-Za-z0-9_-]{86}$/;
const maxValidityMs = 60_000;

export interface WorkspaceRecoveryAttestation {
  readonly purpose: typeof purpose;
  readonly id: string;
  readonly keyId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly generation: SupervisedWorkspaceGeneration;
  readonly observation: WorkspaceRecoveryObservation;
  readonly digest: string;
  readonly signature: string;
}

export class WorkspaceRecoveryAttestationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceRecoveryAttestationError';
  }
}

const signedFacts = (attestation: Omit<WorkspaceRecoveryAttestation, 'digest' | 'signature'>) => ({
  purpose: attestation.purpose,
  id: attestation.id,
  keyId: attestation.keyId,
  issuedAt: attestation.issuedAt,
  expiresAt: attestation.expiresAt,
  generation: attestation.generation,
  observation: attestation.observation
});

const assertObservedRecovery = async (
  generation: SupervisedWorkspaceGeneration,
  observation: WorkspaceRecoveryObservation,
  pendingPermit: boolean
): Promise<void> => {
  const { authority, git } = observation;
  const actualWorkspacePath =
    authority.workspace === undefined
      ? undefined
      : await realpath(resolve(authority.workspace.workspacePath));
  if (
    authority.scopeId !== generation.scopeId ||
    authority.parentClaimId !== generation.parentClaimId ||
    authority.workspaceId !== generation.workspaceId ||
    authority.generation?.id !== generation.generationId ||
    authority.generation.supervisorId !== generation.supervisorId ||
    authority.generation.state !== 'REVOKED' ||
    authority.runState !== 'ACTIVE' ||
    authority.parentState !== (pendingPermit ? 'ACTIVE' : 'HELD_UNCERTAIN') ||
    authority.phase !== (pendingPermit ? 'WORKSPACE_ARMED' : 'WORKSPACE_UNCERTAIN') ||
    authority.permit?.completed !== !pendingPermit ||
    authority.workspace?.revision !== 1 ||
    actualWorkspacePath !== generation.workspacePath ||
    git.workspaceId !== generation.workspaceId ||
    git.workspaceRevision !== authority.workspace.revision ||
    git.worktreePath !== generation.workspacePath ||
    git.headCommit !== git.baseCommit ||
    git.branchCommit !== git.baseCommit ||
    !git.clean
  ) {
    throw new WorkspaceRecoveryAttestationError(
      'Recovery observation is not an eligible Git setup'
    );
  }
};

/** Keep this key in the independent recovery service, never in a writer container. */
export class WorkspaceRecoveryAttestor {
  readonly #privateKey: ReturnType<typeof createPrivateKey>;

  constructor(
    private readonly observer: Pick<
      PostgresWorkspaceRecoveryObserver,
      'observe' | 'observePendingPermit'
    >,
    private readonly keyId: string,
    privateKeyPem: string
  ) {
    if (!keyId.trim()) {
      throw new WorkspaceRecoveryAttestationError('Recovery signing key identity is required');
    }
    this.#privateKey = createPrivateKey(privateKeyPem);
    if (this.#privateKey.asymmetricKeyType !== 'ed25519') {
      throw new WorkspaceRecoveryAttestationError('Recovery signing key must be Ed25519');
    }
  }

  async attest(generation: SupervisedWorkspaceGeneration): Promise<WorkspaceRecoveryAttestation> {
    // Only observations produced after durable revocation, supervised stop and
    // bracketed Git inspection can enter this signer. No worker-supplied facts.
    const observation = await this.observer.observe(generation);
    await assertObservedRecovery(generation, observation, false);
    return this.#sign(generation, observation);
  }

  /** Recovery of a lost Git response: this does not itself settle the permit. */
  async attestPendingPermit(
    generation: SupervisedWorkspaceGeneration
  ): Promise<WorkspaceRecoveryAttestation> {
    const observation = await this.observer.observePendingPermit(generation);
    await assertObservedRecovery(generation, observation, true);
    return this.#sign(generation, observation);
  }

  #sign(
    generation: SupervisedWorkspaceGeneration,
    observation: WorkspaceRecoveryObservation
  ): WorkspaceRecoveryAttestation {
    const issued = Date.now();
    const facts = signedFacts({
      purpose,
      id: randomUUID(),
      keyId: this.keyId,
      issuedAt: new Date(issued).toISOString(),
      expiresAt: new Date(issued + maxValidityMs).toISOString(),
      generation,
      observation
    });
    const digest = fingerprintPlanValue(facts);
    const signature = sign(null, Buffer.from(canonicalPlanJson(facts)), this.#privateKey).toString(
      'base64url'
    );
    return { ...facts, digest, signature };
  }
}

/** Signature and freshness only: verification does not authorize a PG handoff. */
export const verifyWorkspaceRecoveryAttestation = (request: {
  readonly attestation: WorkspaceRecoveryAttestation;
  readonly trustedPublicKeys: ReadonlyMap<string, string>;
  readonly now?: Date;
}): WorkspaceRecoveryAttestation => {
  const attestation = request.attestation;
  const issued = Date.parse(attestation.issuedAt);
  const expires = Date.parse(attestation.expiresAt);
  const now = (request.now ?? new Date()).getTime();
  if (
    attestation.purpose !== purpose ||
    !attestation.id.trim() ||
    !attestation.keyId.trim() ||
    !Number.isFinite(issued) ||
    !Number.isFinite(expires) ||
    !Number.isFinite(now) ||
    expires <= issued ||
    expires - issued > maxValidityMs ||
    now < issued ||
    now >= expires ||
    !signaturePattern.test(attestation.signature)
  ) {
    throw new WorkspaceRecoveryAttestationError('Recovery attestation is invalid or stale');
  }
  const publicKeyPem = request.trustedPublicKeys.get(attestation.keyId);
  if (publicKeyPem === undefined) {
    throw new WorkspaceRecoveryAttestationError('Recovery signer is not trusted');
  }
  const publicKey = createPublicKey(publicKeyPem);
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new WorkspaceRecoveryAttestationError('Recovery signer must be Ed25519');
  }
  const facts = signedFacts(attestation);
  const signature = Buffer.from(attestation.signature, 'base64url');
  if (
    attestation.digest !== fingerprintPlanValue(facts) ||
    signature.length !== 64 ||
    signature.toString('base64url') !== attestation.signature ||
    !verify(null, Buffer.from(canonicalPlanJson(facts)), publicKey, signature)
  ) {
    throw new WorkspaceRecoveryAttestationError('Recovery attestation signature is invalid');
  }
  return attestation;
};
