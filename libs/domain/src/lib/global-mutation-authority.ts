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

/** A unique slot coordinates a controlled callback with release and handoff. */
export interface FencedMutationPermit {
  readonly id: string;
}

export interface CurrentMutationTokenRequest {
  readonly scopeId: string;
  readonly claimId: string;
  readonly owner: GlobalMutationOwner;
  readonly token: number;
  readonly resource: WritableResource;
}

/** The provider persists every transition atomically under a repository-scope lock. */
export interface GlobalMutationAuthority {
  /** Only privileged setup may allocate a scope or attach an approved alias. */
  registerScope(repositoryId: string): Promise<string>;
  registerAlias(scopeId: string, repositoryId: string): Promise<void>;
  bindRun(runId: string, repositoryId: string): Promise<void>;
  beginLegacyCutover(): Promise<void>;
  /** Inventory spans the entire store, including unknown and unregistered aliases. */
  recoverLegacyOwners(): Promise<readonly LegacyMutationOwner[]>;
  /** Settlement requires independently verified quiescence, recorded durably. */
  settleLegacyOwner(key: string, quiescenceEvidence: string): Promise<void>;
  /** Import an unresolved owner as blocking authority, conservatively if details are unknown. */
  importLegacyOwner(key: string, scopeId: string, resource?: WritableResource): Promise<void>;
  activateScope(scopeId: string): Promise<void>;
  claimGlobalMutation(claim: GlobalMutationClaim): Promise<GlobalMutationClaimResult>;
  recoverRepositoryMutationAuthority(scopeId: string): Promise<readonly GlobalMutationLease[]>;
  assertCurrentMutationToken(request: CurrentMutationTokenRequest): Promise<void>;
  /** Acquire an in-flight mutation slot atomically with checking current authority. */
  beginFencedMutation(request: CurrentMutationTokenRequest): Promise<FencedMutationPermit>;
  endFencedMutation(permit: FencedMutationPermit): Promise<void>;
  releaseGlobalMutation(request: {
    readonly scopeId: string;
    readonly claimId: string;
    readonly owner: GlobalMutationOwner;
    readonly token: number;
    readonly expectedVersion: number;
    readonly stopEvidence: string;
  }): Promise<void>;
  markMutationUncertain(request: {
    readonly scopeId: string;
    readonly claimId: string;
    readonly owner: GlobalMutationOwner;
    readonly token: number;
    readonly evidence: string;
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
