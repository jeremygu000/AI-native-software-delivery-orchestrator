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
  });
};
