export type RepositoryWritableResource =
  | {
      readonly type: 'project';
      readonly projectId: string;
    }
  | {
      readonly type: 'file';
      readonly projectId: string;
      readonly fileId: string;
    }
  | {
      readonly type: 'symbol';
      readonly projectId: string;
      readonly fileId: string;
      readonly symbolId: string;
      readonly ancestorSymbolIds: readonly string[];
    };

export type WritableResource =
  | RepositoryWritableResource
  | {
      readonly type: 'shared-resource';
      readonly resourceId: string;
    };

export const areWritableResourcesConflicting = (
  a: WritableResource,
  b: WritableResource
): boolean => {
  if (a.type === 'shared-resource' || b.type === 'shared-resource') {
    return (
      a.type === 'shared-resource' && b.type === 'shared-resource' && a.resourceId === b.resourceId
    );
  }

  if (a.projectId !== b.projectId) {
    return false;
  }
  if (a.type === 'project' || b.type === 'project') {
    return true;
  }
  if (a.fileId !== b.fileId) {
    return false;
  }
  if (a.type === 'file' || b.type === 'file') {
    return true;
  }

  return (
    a.symbolId === b.symbolId ||
    a.ancestorSymbolIds.includes(b.symbolId) ||
    b.ancestorSymbolIds.includes(a.symbolId)
  );
};

export interface WriteLeaseRequest {
  readonly runId: string;
  readonly agentId: string;
  readonly taskId: string;
  readonly resource: WritableResource;
  readonly mode: 'exclusive';
}

export type WriteLeaseState = 'ACTIVE' | 'RELEASED' | 'STALE';

export interface WriteLease {
  readonly id: string;
  readonly runId: string;
  readonly agentId: string;
  readonly taskId: string;
  readonly resource: WritableResource;
  readonly mode: 'exclusive';
  readonly version: number;
  readonly state: WriteLeaseState;
  readonly acquiredAt: Date;
  readonly lastHeartbeatAt: Date;
  readonly releasedAt?: Date;
  readonly staleDetectedAt?: Date;
}

export type WriteLeaseResult =
  | {
      readonly status: 'granted';
      readonly lease: WriteLease;
    }
  | {
      readonly status: 'blocked';
      readonly conflictingLeaseIds: readonly string[];
    };

export interface HeartbeatWriteLeaseRequest {
  readonly leaseId: string;
  readonly expectedVersion: number;
}

export type HeartbeatWriteLeaseResult =
  | {
      readonly status: 'active';
      readonly lease: WriteLease;
    }
  | {
      readonly status: 'not-found';
    }
  | {
      readonly status: 'version-conflict';
      readonly actualVersion: number;
    };

export interface MarkWriteLeaseStaleRequest {
  readonly leaseId: string;
  readonly expectedVersion: number;
  readonly evidence: string;
}

export type MarkWriteLeaseStaleResult =
  | { readonly status: 'stale'; readonly lease: WriteLease }
  | { readonly status: 'not-found' }
  | { readonly status: 'version-conflict'; readonly actualVersion: number };

export type ReleaseWriteLeaseResult = 'released' | 'not-found';

export interface WriteGuard {
  acquire(request: WriteLeaseRequest): Promise<WriteLeaseResult>;
  heartbeat(request: HeartbeatWriteLeaseRequest): Promise<HeartbeatWriteLeaseResult>;
  markStale(request: MarkWriteLeaseStaleRequest): Promise<MarkWriteLeaseStaleResult>;
  release(leaseId: string): Promise<ReleaseWriteLeaseResult>;
}
