export type WritableResource =
  | {
      readonly type: 'project';
      readonly projectId: string;
    }
  | {
      readonly type: 'file';
      readonly fileId: string;
      readonly projectId?: string;
    }
  | {
      readonly type: 'symbol';
      readonly symbolId: string;
      readonly fileId: string;
      readonly ancestorSymbolIds: readonly string[];
    }
  | {
      readonly type: 'shared-resource';
      readonly resourceId: string;
    };

export interface WriteLeaseRequest {
  readonly agentId: string;
  readonly taskId: string;
  readonly resource: WritableResource;
  readonly mode: 'exclusive';
}

export interface WriteLease {
  readonly id: string;
  readonly agentId: string;
  readonly taskId: string;
  readonly resource: WritableResource;
  readonly mode: 'exclusive';
  readonly acquiredAt: Date;
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

export interface WriteGuard {
  acquire(request: WriteLeaseRequest): Promise<WriteLeaseResult>;
  release(leaseId: string): Promise<void>;
}
