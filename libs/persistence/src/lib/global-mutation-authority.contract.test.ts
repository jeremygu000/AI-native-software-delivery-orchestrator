import type {
  GlobalMutationAuthority,
  GlobalMutationClaim,
  GlobalMutationClaimResult,
  GlobalMutationLease
} from '@ai-native-software-delivery-orchestrator/domain';
import {
  FencedMutationPort,
  GlobalMutationInFlightError
} from '@ai-native-software-delivery-orchestrator/domain';
import { describe, expect, it, vi } from 'vitest';

/**
 * Shared acceptance suite for two independent connections to one authority
 * store. SQLite and PostgreSQL fixtures must each call this factory when their
 * M4.2 adapters exist; this file alone is not backend evidence.
 */
export interface GlobalMutationPermitFixture {
  readonly authority: GlobalMutationAuthority;
  readonly peer: GlobalMutationAuthority;
  readonly scopeId: string;
  readonly originalClaim: GlobalMutationClaim;
  readonly originalGrant: Extract<GlobalMutationClaimResult, { readonly status: 'granted' }>;
  readonly replacementClaim: GlobalMutationClaim;
  /** Simulates worker/process loss without ending its durable permit. */
  closeOwnerConnectionWithoutEnd(): Promise<void>;
  close(): Promise<void>;
}

export type LegacyAdmissionKind = 'builder' | 'repair' | 'integration' | 'dynamic-lease';

export interface HeldGateOperation<T> {
  /** The real transaction has acquired the deployment gate and is paused before commit. */
  readonly finished: Promise<T>;
  release(): void;
}

export interface GlobalMutationCutoverFixture {
  readonly authority: GlobalMutationAuthority;
  readonly peer: GlobalMutationAuthority;
  /** Alias A is registered to this scope. */
  readonly scopeId: string;
  readonly registeredRepositoryId: string;
  /** A separate, historical ACTIVE run uses unregistered alias B. */
  readonly unregisteredRepositoryId: string;
  readonly historicalRunId: string;
  /** Use a real legacy writer-creating entry and hold its gate lock before commit. */
  holdLegacyAdmissionAtGate(
    kind: LegacyAdmissionKind
  ): Promise<HeldGateOperation<{ readonly ownerKey: string }>>;
  /** Begin the real cutover transition and hold its gate lock before commit. */
  holdCutoverAtGate(): Promise<HeldGateOperation<void>>;
  admitLegacyWriter(kind: LegacyAdmissionKind): Promise<void>;
  /** Prove the opposite transaction is waiting on the held gate, not just scheduled. */
  assertWaitingOnGate(operation: 'cutover' | 'legacy-admission'): Promise<void>;
  /** Independent-connection canonical row evidence, including revisions and payloads. */
  readLegacyWriterEvidence(): Promise<{
    readonly attempts: readonly string[];
    readonly leases: readonly string[];
    readonly integrationClaims: readonly string[];
  }>;
  close(): Promise<void>;
}

const currentLease = async (fixture: GlobalMutationPermitFixture): Promise<GlobalMutationLease> => {
  const leases = await fixture.peer.recoverRepositoryMutationAuthority(fixture.scopeId);
  const lease = leases.find((candidate) => candidate.claimId === fixture.originalClaim.claimId);
  if (lease === undefined) {
    throw new Error('Missing original claim in shared authority fixture');
  }
  return lease;
};

const releaseRequest = async (fixture: GlobalMutationPermitFixture) => ({
  scopeId: fixture.scopeId,
  claimId: fixture.originalClaim.claimId,
  owner: fixture.originalClaim.owner,
  token: fixture.originalGrant.token,
  expectedVersion: (await currentLease(fixture)).version,
  stopEvidence: 'Managed callback completed and the writer is quiescent.'
});

const mutationRequest = (fixture: GlobalMutationPermitFixture) => {
  const resource = fixture.originalClaim.resources[0];
  if (resource === undefined) {
    throw new Error('Shared authority fixture must claim a mutation resource');
  }
  return {
    scopeId: fixture.scopeId,
    claimId: fixture.originalClaim.claimId,
    owner: fixture.originalClaim.owner,
    token: fixture.originalGrant.token,
    resource
  };
};

const deferred = () => {
  let complete: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (complete === undefined) {
        throw new Error('Deferred callback was not initialized');
      }
      complete();
    }
  };
};

const assertGranted = (
  result: GlobalMutationClaimResult
): Extract<GlobalMutationClaimResult, { readonly status: 'granted' }> => {
  expect(result.status).toBe('granted');
  if (result.status !== 'granted') {
    throw new Error('Replacement claim was not granted');
  }
  return result;
};

export const globalMutationPermitContract = (
  name: string,
  createFixture: () => Promise<GlobalMutationPermitFixture>
): void => {
  describe(`${name} controlled mutation handoff`, () => {
    it('keeps ownership blocking while a controlled callback is in flight', async () => {
      const fixture = await createFixture();
      const entered = deferred();
      const finish = deferred();
      const content = { value: 'original' };
      let mutation: Promise<void> | undefined;
      try {
        mutation = new FencedMutationPort(fixture.authority).execute(
          mutationRequest(fixture),
          async () => {
            entered.resolve();
            await finish.promise;
            content.value = 'first owner';
          }
        );
        await entered.promise;

        await expect(
          fixture.peer.releaseGlobalMutation(await releaseRequest(fixture))
        ).rejects.toBeInstanceOf(GlobalMutationInFlightError);
        expect(await currentLease(fixture)).toMatchObject({
          state: 'ACTIVE',
          token: fixture.originalGrant.token
        });
        expect(await fixture.peer.claimGlobalMutation(fixture.replacementClaim)).toMatchObject({
          status: 'blocked'
        });
        expect(content.value).toBe('original');

        finish.resolve();
        await mutation;
        await fixture.peer.releaseGlobalMutation(await releaseRequest(fixture));
        const replacement = assertGranted(
          await fixture.peer.claimGlobalMutation(fixture.replacementClaim)
        );
        expect(replacement.token).toBeGreaterThan(fixture.originalGrant.token);

        const staleCallback = vi.fn(async () => {
          content.value = 'stale owner';
        });
        await expect(
          new FencedMutationPort(fixture.authority).execute(mutationRequest(fixture), staleCallback)
        ).rejects.toThrow();
        expect(staleCallback).not.toHaveBeenCalled();
        expect(content.value).toBe('first owner');
      } finally {
        finish.resolve();
        await mutation?.catch(() => undefined);
        await fixture.close();
      }
    });

    it('rejects a stale permit when release and handoff win first', async () => {
      const fixture = await createFixture();
      try {
        await fixture.authority.releaseGlobalMutation(await releaseRequest(fixture));
        const replacement = assertGranted(
          await fixture.peer.claimGlobalMutation(fixture.replacementClaim)
        );
        expect(replacement.token).toBeGreaterThan(fixture.originalGrant.token);

        const callback = vi.fn(async () => 'mutated');
        await expect(
          new FencedMutationPort(fixture.authority).execute(mutationRequest(fixture), callback)
        ).rejects.toThrow();
        expect(callback).not.toHaveBeenCalled();
      } finally {
        await fixture.close();
      }
    });

    it('rejects uncertain-owner reclamation until the exact permit ends', async () => {
      const fixture = await createFixture();
      const entered = deferred();
      const finish = deferred();
      let mutation: Promise<void> | undefined;
      try {
        mutation = new FencedMutationPort(fixture.authority).execute(
          mutationRequest(fixture),
          async () => {
            entered.resolve();
            await finish.promise;
          }
        );
        await entered.promise;
        await fixture.peer.markMutationUncertain({
          scopeId: fixture.scopeId,
          claimId: fixture.originalClaim.claimId,
          owner: fixture.originalClaim.owner,
          token: fixture.originalGrant.token,
          evidence: 'Worker outcome is unknown.'
        });
        const reclaim = async () =>
          fixture.peer.reclaimUncertainMutation({
            scopeId: fixture.scopeId,
            claimId: fixture.originalClaim.claimId,
            owner: fixture.originalClaim.owner,
            token: fixture.originalGrant.token,
            expectedVersion: (await currentLease(fixture)).version,
            verifiedQuiescenceEvidence: 'Managed writer exited and cannot restart.'
          });
        await expect(reclaim()).rejects.toBeInstanceOf(GlobalMutationInFlightError);
        expect(await currentLease(fixture)).toMatchObject({
          state: 'HELD_UNCERTAIN',
          token: fixture.originalGrant.token
        });
        expect(await fixture.peer.claimGlobalMutation(fixture.replacementClaim)).toMatchObject({
          status: 'blocked'
        });

        finish.resolve();
        await mutation;
        await reclaim();
        assertGranted(await fixture.peer.claimGlobalMutation(fixture.replacementClaim));
      } finally {
        finish.resolve();
        await mutation?.catch(() => undefined);
        await fixture.close();
      }
    });

    it('recovers and settles an orphaned durable permit after owner process loss', async () => {
      const fixture = await createFixture();
      try {
        const permit = await fixture.authority.beginFencedMutation(mutationRequest(fixture));
        await fixture.closeOwnerConnectionWithoutEnd();

        const recovered = await fixture.peer.recoverFencedMutationPermits(
          fixture.scopeId,
          fixture.originalClaim.claimId
        );
        expect(recovered).toHaveLength(1);
        expect(recovered[0]).toMatchObject({
          id: permit.id,
          scopeId: fixture.scopeId,
          claimId: fixture.originalClaim.claimId,
          owner: fixture.originalClaim.owner,
          token: fixture.originalGrant.token,
          resource: mutationRequest(fixture).resource
        });
        const orphan = recovered[0];
        if (orphan === undefined) {
          throw new Error('Lost worker permit was not recoverable');
        }
        await expect(
          fixture.peer.releaseGlobalMutation(await releaseRequest(fixture))
        ).rejects.toBeInstanceOf(GlobalMutationInFlightError);
        await fixture.peer.markMutationUncertain({
          scopeId: fixture.scopeId,
          claimId: fixture.originalClaim.claimId,
          owner: fixture.originalClaim.owner,
          token: fixture.originalGrant.token,
          evidence: 'Owner process disappeared during a controlled mutation.'
        });
        const reclaim = async () =>
          fixture.peer.reclaimUncertainMutation({
            scopeId: fixture.scopeId,
            claimId: fixture.originalClaim.claimId,
            owner: fixture.originalClaim.owner,
            token: fixture.originalGrant.token,
            expectedVersion: (await currentLease(fixture)).version,
            verifiedQuiescenceEvidence: 'The lost process is proven unable to write.'
          });
        await expect(reclaim()).rejects.toBeInstanceOf(GlobalMutationInFlightError);
        expect(await fixture.peer.claimGlobalMutation(fixture.replacementClaim)).toMatchObject({
          status: 'blocked'
        });

        await fixture.peer.settleOrphanedFencedMutation(
          orphan,
          'The owner process exited and its controlled mutation cannot resume.'
        );
        expect(await fixture.peer.recoverFencedMutationPermits(fixture.scopeId)).toEqual([]);
        expect(await currentLease(fixture)).toMatchObject({
          state: 'HELD_UNCERTAIN',
          token: fixture.originalGrant.token
        });
        expect(await fixture.peer.claimGlobalMutation(fixture.replacementClaim)).toMatchObject({
          status: 'blocked'
        });

        await reclaim();
        const replacement = assertGranted(
          await fixture.peer.claimGlobalMutation(fixture.replacementClaim)
        );
        expect(replacement.token).toBeGreaterThan(fixture.originalGrant.token);
      } finally {
        await fixture.close();
      }
    });
  });
};

export const globalMutationCutoverContract = (
  name: string,
  createFixture: () => Promise<GlobalMutationCutoverFixture>
): void => {
  describe(`${name} deployment-wide legacy cutover`, () => {
    it('inventories an unknown-alias writer whose legacy admission wins the gate first', async () => {
      const fixture = await createFixture();
      let held: HeldGateOperation<{ readonly ownerKey: string }> | undefined;
      let cutover: Promise<void> | undefined;
      try {
        expect(fixture.registeredRepositoryId).not.toBe(fixture.unregisteredRepositoryId);
        held = await fixture.holdLegacyAdmissionAtGate('builder');
        cutover = fixture.peer.beginLegacyCutover();
        await fixture.assertWaitingOnGate('cutover');
        held.release();
        const admitted = await held.finished;
        await cutover;

        const owners = await fixture.peer.recoverLegacyOwners();
        expect(owners).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              key: admitted.ownerKey,
              repositoryId: fixture.unregisteredRepositoryId,
              runId: fixture.historicalRunId
            })
          ])
        );
        await expect(
          fixture.peer.completeLegacyCutover('All old worker processes are stopped.')
        ).rejects.toThrow();
        await expect(fixture.peer.activateScope(fixture.scopeId)).rejects.toThrow();
      } finally {
        held?.release();
        await held?.finished.catch(() => undefined);
        await cutover?.catch(() => undefined);
        await fixture.close();
      }
    });

    for (const kind of ['builder', 'repair', 'integration', 'dynamic-lease'] as const) {
      it(`rejects ${kind} admission with no evidence when cutover wins the gate first`, async () => {
        const fixture = await createFixture();
        let held: HeldGateOperation<void> | undefined;
        let admission: Promise<'admitted' | 'rejected'> | undefined;
        try {
          const before = await fixture.readLegacyWriterEvidence();
          held = await fixture.holdCutoverAtGate();
          admission = fixture.admitLegacyWriter(kind).then(
            () => 'admitted' as const,
            () => 'rejected' as const
          );
          await fixture.assertWaitingOnGate('legacy-admission');
          held.release();
          await held.finished;
          expect(await admission).toBe('rejected');
          expect(await fixture.readLegacyWriterEvidence()).toEqual(before);

          const owners = await fixture.peer.recoverLegacyOwners();
          expect(owners).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                kind: 'run',
                runId: fixture.historicalRunId,
                repositoryId: fixture.unregisteredRepositoryId
              })
            ])
          );
          await expect(
            fixture.peer.completeLegacyCutover('All old worker processes are stopped.')
          ).rejects.toThrow();
          await expect(fixture.peer.activateScope(fixture.scopeId)).rejects.toThrow();
        } finally {
          held?.release();
          await held?.finished.catch(() => undefined);
          await admission?.catch(() => undefined);
          await fixture.close();
        }
      });
    }
  });
};

/** Both durable adapters must install both suites against independent connections. */
export const globalMutationAuthorityContract = (
  name: string,
  fixtures: {
    readonly createPermitFixture: () => Promise<GlobalMutationPermitFixture>;
    readonly createCutoverFixture: () => Promise<GlobalMutationCutoverFixture>;
  }
): void => {
  globalMutationPermitContract(name, fixtures.createPermitFixture);
  globalMutationCutoverContract(name, fixtures.createCutoverFixture);
};
