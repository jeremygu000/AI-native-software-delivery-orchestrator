import {
  areWritableResourcesConflicting,
  type HeartbeatWriteLeaseRequest,
  type HeartbeatWriteLeaseResult,
  type MarkWriteLeaseStaleRequest,
  type MarkWriteLeaseStaleResult,
  type ReleaseWriteLeaseResult,
  type WritableResource,
  type WriteGuard,
  type WriteLease,
  type WriteLeaseRequest,
  type WriteLeaseResult
} from '@ai-native-software-delivery-orchestrator/domain';

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const cloneResource = (resource: WritableResource): WritableResource =>
  resource.type === 'symbol'
    ? { ...resource, ancestorSymbolIds: [...resource.ancestorSymbolIds].toSorted(compareIds) }
    : { ...resource };

const cloneLease = (lease: WriteLease): WriteLease => ({
  ...lease,
  resource: cloneResource(lease.resource),
  acquiredAt: new Date(lease.acquiredAt),
  lastHeartbeatAt: new Date(lease.lastHeartbeatAt),
  ...(lease.releasedAt === undefined ? {} : { releasedAt: new Date(lease.releasedAt) }),
  ...(lease.staleDetectedAt === undefined
    ? {}
    : { staleDetectedAt: new Date(lease.staleDetectedAt) })
});

const resourcesEqual = (a: WritableResource, b: WritableResource): boolean => {
  if (a.type === 'project') {
    return b.type === 'project' && b.projectId === a.projectId;
  }
  if (a.type === 'file') {
    return b.type === 'file' && b.projectId === a.projectId && b.fileId === a.fileId;
  }
  if (a.type === 'symbol') {
    const ancestorsA = a.ancestorSymbolIds.toSorted(compareIds);
    const ancestorsB = b.type === 'symbol' ? b.ancestorSymbolIds.toSorted(compareIds) : [];
    return (
      b.type === 'symbol' &&
      b.projectId === a.projectId &&
      b.fileId === a.fileId &&
      b.symbolId === a.symbolId &&
      ancestorsA.length === ancestorsB.length &&
      ancestorsA.every((ancestorSymbolId, index) => ancestorSymbolId === ancestorsB[index])
    );
  }
  return b.type === 'shared-resource' && b.resourceId === a.resourceId;
};

const requireNonEmpty = (value: string, name: string): void => {
  if (value.trim().length === 0) {
    throw new WriteGuardInputError(`${name} must not be empty`);
  }
};

const assertResource = (resource: WritableResource): void => {
  switch (resource.type) {
    case 'project':
      requireNonEmpty(resource.projectId, 'projectId');
      return;
    case 'file':
      requireNonEmpty(resource.projectId, 'projectId');
      requireNonEmpty(resource.fileId, 'fileId');
      return;
    case 'symbol':
      requireNonEmpty(resource.projectId, 'projectId');
      requireNonEmpty(resource.fileId, 'fileId');
      requireNonEmpty(resource.symbolId, 'symbolId');
      if (new Set(resource.ancestorSymbolIds).size !== resource.ancestorSymbolIds.length) {
        throw new WriteGuardInputError('ancestorSymbolIds must be unique');
      }
      for (const ancestorSymbolId of resource.ancestorSymbolIds) {
        requireNonEmpty(ancestorSymbolId, 'ancestorSymbolId');
      }
      if (resource.ancestorSymbolIds.includes(resource.symbolId)) {
        throw new WriteGuardInputError('ancestorSymbolIds cannot include symbolId');
      }
      return;
    case 'shared-resource':
      requireNonEmpty(resource.resourceId, 'resourceId');
      return;
  }
};

export interface InMemoryWriteGuardOptions {
  readonly now?: () => Date;
  readonly createLeaseId?: () => string;
}

export class WriteGuardInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WriteGuardInputError';
  }
}

export class InMemoryWriteGuard implements WriteGuard {
  readonly #leases = new Map<string, WriteLease>();
  readonly #now: () => Date;
  readonly #createLeaseId: () => string;
  #nextLeaseNumber = 1;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: InMemoryWriteGuardOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#createLeaseId = options.createLeaseId ?? (() => `lease-${this.#nextLeaseNumber++}`);
  }

  async acquire(request: WriteLeaseRequest): Promise<WriteLeaseResult> {
    return this.#exclusive(() => {
      this.#assertAcquireRequest(request);
      const activeLeases = this.#activeLeases();
      const existing = activeLeases.find(
        (lease) =>
          lease.runId === request.runId &&
          lease.agentId === request.agentId &&
          lease.taskId === request.taskId &&
          resourcesEqual(lease.resource, request.resource)
      );
      if (existing !== undefined) {
        return { status: 'granted', lease: cloneLease(existing) };
      }
      const conflictingLeaseIds = activeLeases
        .filter((lease) => areWritableResourcesConflicting(lease.resource, request.resource))
        .map((lease) => lease.id)
        .toSorted(compareIds);
      if (conflictingLeaseIds.length > 0) {
        return { status: 'blocked', conflictingLeaseIds };
      }
      const now = this.#now();
      const lease: WriteLease = {
        id: this.#createUniqueLeaseId(),
        runId: request.runId,
        agentId: request.agentId,
        taskId: request.taskId,
        resource: cloneResource(request.resource),
        mode: 'exclusive',
        version: 1,
        state: 'ACTIVE',
        acquiredAt: now,
        lastHeartbeatAt: now
      };
      this.#leases.set(lease.id, lease);
      return { status: 'granted', lease: cloneLease(lease) };
    });
  }

  async heartbeat(request: HeartbeatWriteLeaseRequest): Promise<HeartbeatWriteLeaseResult> {
    return this.#exclusive(() => {
      requireNonEmpty(request.leaseId, 'leaseId');
      this.#assertVersion(request.expectedVersion);
      const lease = this.#leases.get(request.leaseId);
      if (lease === undefined || lease.state !== 'ACTIVE') {
        return { status: 'not-found' };
      }
      if (lease.version !== request.expectedVersion) {
        return { status: 'version-conflict', actualVersion: lease.version };
      }
      const updated: WriteLease = {
        ...lease,
        version: lease.version + 1,
        lastHeartbeatAt: this.#now()
      };
      this.#leases.set(updated.id, updated);
      return { status: 'active', lease: cloneLease(updated) };
    });
  }

  async markStale(request: MarkWriteLeaseStaleRequest): Promise<MarkWriteLeaseStaleResult> {
    return this.#exclusive(() => {
      requireNonEmpty(request.leaseId, 'leaseId');
      this.#assertVersion(request.expectedVersion);
      requireNonEmpty(request.evidence, 'evidence');
      const lease = this.#leases.get(request.leaseId);
      if (lease === undefined || lease.state !== 'ACTIVE') {
        return { status: 'not-found' };
      }
      if (lease.version !== request.expectedVersion) {
        return { status: 'version-conflict', actualVersion: lease.version };
      }
      const updated: WriteLease = {
        ...lease,
        version: lease.version + 1,
        state: 'STALE',
        staleDetectedAt: this.#now(),
        staleEvidence: request.evidence
      };
      this.#leases.set(updated.id, updated);
      return { status: 'stale', lease: cloneLease(updated) };
    });
  }

  async release(leaseId: string): Promise<ReleaseWriteLeaseResult> {
    return this.#exclusive(() => {
      requireNonEmpty(leaseId, 'leaseId');
      const lease = this.#leases.get(leaseId);
      if (lease === undefined || lease.state !== 'ACTIVE') {
        return 'not-found';
      }
      this.#leases.set(lease.id, {
        ...lease,
        version: lease.version + 1,
        state: 'RELEASED',
        releasedAt: this.#now()
      });
      return 'released';
    });
  }

  #assertAcquireRequest(request: WriteLeaseRequest): void {
    requireNonEmpty(request.runId, 'runId');
    requireNonEmpty(request.agentId, 'agentId');
    requireNonEmpty(request.taskId, 'taskId');
    assertResource(request.resource);
  }

  #assertVersion(version: number): void {
    if (!Number.isInteger(version) || version < 1) {
      throw new WriteGuardInputError('expectedVersion must be a positive integer');
    }
  }

  #activeLeases(): readonly WriteLease[] {
    return [...this.#leases.values()].filter((lease) => lease.state === 'ACTIVE');
  }

  #createUniqueLeaseId(): string {
    const leaseId = this.#createLeaseId();
    requireNonEmpty(leaseId, 'leaseId');
    if (this.#leases.has(leaseId)) {
      throw new WriteGuardInputError(`Duplicate lease ID: ${leaseId}`);
    }
    return leaseId;
  }

  async #exclusive<T>(operation: () => T): Promise<T> {
    const previous = this.#tail;
    let complete!: () => void;
    this.#tail = new Promise((resolve) => {
      complete = resolve;
    });
    await previous;
    try {
      return operation();
    } finally {
      complete();
    }
  }
}
