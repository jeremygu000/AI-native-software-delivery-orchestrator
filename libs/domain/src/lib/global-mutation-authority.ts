import type { WritableResource } from './write-lease.js';

export type GlobalMutationState = 'ACTIVE' | 'HELD_UNCERTAIN' | 'RELEASED';
export type GlobalCutoverState = 'LEGACY_ALLOWED' | 'LEGACY_CUTOVER' | 'GLOBAL_READY';
export type RepositoryScopeState = 'REGISTERING' | 'MIGRATING' | 'ACTIVE_FOR_GLOBAL_CLAIMS';

export interface GlobalMutationOwner {
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly agentId: string;
  readonly workspaceId?: string;
}

export interface GlobalMutationLease {
  readonly scopeId: string;
  readonly claimId: string;
  readonly leaseId: string;
  readonly token: number;
  readonly version: number;
  readonly resource: WritableResource;
  readonly owner: GlobalMutationOwner;
  readonly state: GlobalMutationState;
  readonly evidence?: string;
}

export interface GlobalMutationClaim {
  readonly scopeId: string;
  readonly claimId: string;
  readonly owner: GlobalMutationOwner;
  readonly resources: readonly WritableResource[];
}

export type GlobalMutationClaimResult =
  | {
      readonly status: 'granted';
      readonly token: number;
      readonly leases: readonly GlobalMutationLease[];
    }
  | { readonly status: 'blocked'; readonly blockers: readonly GlobalMutationLease[] };

export interface LegacyMutationOwner {
  /** Stable key for an individual historical run, lease, actor, or integration claim. */
  readonly key: string;
  readonly runId: string;
  readonly repositoryId: string;
  readonly kind: 'run' | 'lease' | 'builder' | 'repair' | 'integration';
  readonly resource?: WritableResource;
}

/** An opaque, store-unique slot for one controlled callback. */
export interface FencedMutationPermit {
  readonly id: string;
}

/** Durable unresolved permit evidence, recoverable after its worker disappears. */
export interface PersistedFencedMutationPermit extends FencedMutationPermit {
  readonly scopeId: string;
  readonly claimId: string;
  readonly owner: GlobalMutationOwner;
  readonly token: number;
  readonly resource: WritableResource;
}

export class GlobalMutationInFlightError extends Error {
  constructor() {
    super('Mutation authority has an in-flight controlled callback');
    this.name = 'GlobalMutationInFlightError';
  }
}

export interface CurrentMutationTokenRequest {
  readonly scopeId: string;
  readonly claimId: string;
  readonly owner: GlobalMutationOwner;
  readonly token: number;
  readonly resource: WritableResource;
}

/**
 * The deployment-wide gate serializes legacy writer admission, cutover,
 * classification of owners with unknown scopes, and activation readiness.
 * Repository-scope serialization protects claims, permits, release, and
 * handoff. Every transition either commits all durable evidence or none of
 * it. Operations touching both acquire the deployment gate before the
 * scope; operations touching run eligibility acquire the scope before the run.
 * A repository-scope lock alone cannot protect an owner with unknown scope.
 */
export interface GlobalMutationAuthority {
  /** Privileged identity registration is serialized by the deployment gate. */
  registerScope(repositoryId: string): Promise<string>;
  registerAlias(scopeId: string, repositoryId: string): Promise<void>;
  /** Bind the approved immutable run identity under gate, then scope/run lock order. */
  bindRun(runId: string, repositoryId: string): Promise<void>;
  /**
   * Atomically close every legacy writer-creating admission path under the
   * deployment-wide gate. An admission serialized first joins the inventory;
   * an admission serialized after the barrier is rejected. This includes
   * builder, repair, integration, dynamic lease acquisition, and every other
   * legacy writer-creating path, across all scopes and runs.
   */
  beginLegacyCutover(): Promise<void>;
  /**
   * Read a consistent store-wide inventory after admission closes, including
   * unknown and unregistered aliases; never filter by repository scope.
   */
  recoverLegacyOwners(): Promise<readonly LegacyMutationOwner[]>;
  /** Classify unknown-scope owners under the deployment gate. Settlement requires proven quiescence. */
  settleLegacyOwner(key: string, quiescenceEvidence: string): Promise<void>;
  /**
   * Classify under the deployment gate, then import under the scope lock.
   * An unknown resource in a known scope MUST become repository-wide
   * HELD_UNCERTAIN authority. An unknown scope cannot be guessed or omitted.
   */
  importLegacyOwner(key: string, scopeId: string, resource?: WritableResource): Promise<void>;
  /**
   * Privileged deployment-wide checked transition to GLOBAL_READY. It must
   * verify complete classification of every historical unresolved owner and
   * durable closure of old admission, including all live old workers. An
   * unknown-scope unresolved owner blocks readiness for every scope.
   */
  completeLegacyCutover(verifiedOldWriterShutdownEvidence: string): Promise<void>;
  /** Require GLOBAL_READY under the deployment gate before the scope transition. */
  activateScope(scopeId: string): Promise<void>;
  /** Check deployment readiness, then serialize scope claims before the run row. */
  claimGlobalMutation(claim: GlobalMutationClaim): Promise<GlobalMutationClaimResult>;
  recoverRepositoryMutationAuthority(scopeId: string): Promise<readonly GlobalMutationLease[]>;
  /**
   * Recover every unresolved durable permit in stable order, including permits
   * from lost processes. An independent connection must see the exact permit
   * ID and its scope/claim/owner/token/resource, with an optional claim filter.
   * Recovery is evidence only and does not release or settle a permit.
   */
  recoverFencedMutationPermits(
    scopeId: string,
    claimId?: string
  ): Promise<readonly PersistedFencedMutationPermit[]>;
  assertCurrentMutationToken(request: CurrentMutationTokenRequest): Promise<void>;
  /**
   * Atomically validate current scope/claim/owner/token/resource authority and
   * durably register a unique in-flight permit before the callback begins.
   * A process loss leaves the unresolved permit blocking release and handoff
   * until independent quiescence settlement; elapsed time is insufficient.
   */
  beginFencedMutation(request: CurrentMutationTokenRequest): Promise<FencedMutationPermit>;
  /**
   * Remove only this exact permit after its callback has settled. Do not
   * reject its removal merely because the claim became HELD_UNCERTAIN.
   */
  endFencedMutation(permit: FencedMutationPermit): Promise<void>;
  /**
   * Privileged recovery after the callback owner is proven unable to write.
   * Accept an exact permit recovered on another connection. Atomically retire
   * it, retain the claim as HELD_UNCERTAIN, and record independent quiescence
   * evidence; this is not a handoff. The permit remains recoverable on failure.
   */
  settleOrphanedFencedMutation(
    permit: FencedMutationPermit,
    verifiedQuiescenceEvidence: string
  ): Promise<void>;
  /**
   * Reject with GlobalMutationInFlightError while any permit for this claim is
   * unresolved, without changing durable lease evidence. Ownership cannot
   * close or transfer until every callback ends.
   */
  releaseGlobalMutation(request: {
    readonly scopeId: string;
    readonly claimId: string;
    readonly owner: GlobalMutationOwner;
    readonly token: number;
    readonly expectedVersion: number;
    readonly stopEvidence: string;
  }): Promise<void>;
  /** Retain every unresolved permit and keep the claim blocking replacement owners. */
  markMutationUncertain(request: {
    readonly scopeId: string;
    readonly claimId: string;
    readonly owner: GlobalMutationOwner;
    readonly token: number;
    readonly evidence: string;
  }): Promise<void>;
  /**
   * Close HELD_UNCERTAIN authority only with verified quiescence evidence and
   * no unresolved permit. Otherwise reject with GlobalMutationInFlightError;
   * leave durable evidence unchanged and keep the old owner blocking.
   */
  reclaimUncertainMutation(request: {
    readonly scopeId: string;
    readonly claimId: string;
    readonly owner: GlobalMutationOwner;
    readonly token: number;
    readonly expectedVersion: number;
    readonly verifiedQuiescenceEvidence: string;
  }): Promise<void>;
}

/** Gates the callback itself, rather than merely checking a cached lease beforehand. */
export class FencedMutationPort {
  constructor(
    private readonly authority: Pick<
      GlobalMutationAuthority,
      'beginFencedMutation' | 'endFencedMutation'
    >
  ) {}

  async execute<T>(request: CurrentMutationTokenRequest, sideEffect: () => Promise<T>): Promise<T> {
    const permit = await this.authority.beginFencedMutation(request);
    try {
      return await sideEffect();
    } finally {
      await this.authority.endFencedMutation(permit);
    }
  }
}
