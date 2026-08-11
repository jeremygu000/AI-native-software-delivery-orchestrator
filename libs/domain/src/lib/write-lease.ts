import { z } from 'zod';

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

export type TaskLeasePlanSource = 'predicted-impact' | 'manual' | 'runtime-derived';

export interface TaskLeasePlan {
  readonly taskId: string;
  readonly predictedResources: readonly WritableResource[];
  readonly source: TaskLeasePlanSource;
}

const nonEmptyStringSchema = z.string().trim().min(1);

export const writableResourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('project'), projectId: nonEmptyStringSchema }),
  z.object({
    type: z.literal('file'),
    projectId: nonEmptyStringSchema,
    fileId: nonEmptyStringSchema
  }),
  z.object({
    type: z.literal('symbol'),
    projectId: nonEmptyStringSchema,
    fileId: nonEmptyStringSchema,
    symbolId: nonEmptyStringSchema,
    ancestorSymbolIds: z.array(nonEmptyStringSchema)
  }),
  z.object({ type: z.literal('shared-resource'), resourceId: nonEmptyStringSchema })
]);

const resourceTypeRanks = {
  project: 0,
  file: 1,
  symbol: 2,
  'shared-resource': 3
} as const satisfies Record<WritableResource['type'], number>;

export const writableResourceIdentity = (resource: WritableResource): string => {
  switch (resource.type) {
    case 'project':
      return resource.projectId;
    case 'file':
      return `${resource.projectId}\u0000${resource.fileId}`;
    case 'symbol':
      return `${resource.projectId}\u0000${resource.fileId}\u0000${resource.symbolId}`;
    case 'shared-resource':
      return resource.resourceId;
  }
  return '';
};

export const compareWritableResources = (a: WritableResource, b: WritableResource): number => {
  const rankDifference = resourceTypeRanks[a.type] - resourceTypeRanks[b.type];
  if (rankDifference !== 0) {
    return rankDifference;
  }
  const left = writableResourceIdentity(a);
  const right = writableResourceIdentity(b);
  return left < right ? -1 : left > right ? 1 : 0;
};

export const canonicalTaskLeaseResources = (
  resources: readonly WritableResource[]
): readonly WritableResource[] => [...resources].toSorted(compareWritableResources);

export const taskLeasePlanFingerprint = (plan: TaskLeasePlan): string =>
  JSON.stringify({
    taskId: plan.taskId,
    source: plan.source,
    resources: canonicalTaskLeaseResources(plan.predictedResources).map((resource) =>
      resource.type === 'symbol'
        ? { ...resource, ancestorSymbolIds: resource.ancestorSymbolIds.toSorted() }
        : resource
    )
  });

export const taskLeasePlanFromPredictedImpact = (impact: {
  readonly taskId: string;
  readonly projectsWritten: ReadonlySet<string>;
  readonly filesWritten: ReadonlySet<string>;
  readonly symbolDerivedFilesWritten: ReadonlySet<string>;
  readonly symbolsWritten: ReadonlySet<string>;
  readonly sharedResources: ReadonlySet<string>;
}): TaskLeasePlan => {
  const files = [...impact.filesWritten, ...impact.symbolDerivedFilesWritten]
    .map((fileId) => {
      const [projectId] = fileId.split(':', 1);
      return { type: 'file' as const, projectId, fileId };
    })
    .filter(
      (file, index, allFiles) =>
        allFiles.findIndex((candidate) => candidate.fileId === file.fileId) === index &&
        !impact.projectsWritten.has(file.projectId)
    );
  const projects = [...impact.projectsWritten].map((projectId) => ({
    type: 'project' as const,
    projectId
  }));
  const resources: WritableResource[] = [
    ...projects,
    ...files,
    ...[...impact.sharedResources].map((resourceId) => ({
      type: 'shared-resource' as const,
      resourceId
    }))
  ];
  const unique = new Map(
    resources.map((resource) => [
      `${resource.type}\u0000${writableResourceIdentity(resource)}`,
      resource
    ])
  );
  return {
    taskId: impact.taskId,
    predictedResources: canonicalTaskLeaseResources([...unique.values()]),
    source: 'predicted-impact'
  };
};

export const taskLeasePlanSchema = z
  .object({
    taskId: nonEmptyStringSchema,
    predictedResources: z.array(writableResourceSchema).min(1),
    source: z.enum(['predicted-impact', 'manual', 'runtime-derived'])
  })
  .superRefine((plan, context) => {
    const identities = new Set<string>();
    for (const [index, resource] of plan.predictedResources.entries()) {
      const identity = `${resource.type}\u0000${writableResourceIdentity(resource)}`;
      if (identities.has(identity)) {
        context.addIssue({
          code: 'custom',
          message: 'Task lease plan resources must be unique',
          path: ['predictedResources', index]
        });
      }
      identities.add(identity);
    }
  });

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

export const isWritableResourceCoveredBy = (
  covering: WritableResource,
  requested: WritableResource
): boolean => {
  if (covering.type === 'shared-resource' || requested.type === 'shared-resource') {
    return (
      covering.type === 'shared-resource' &&
      requested.type === 'shared-resource' &&
      covering.resourceId === requested.resourceId
    );
  }
  if (covering.projectId !== requested.projectId) {
    return false;
  }
  if (covering.type === 'project') {
    return true;
  }
  if (requested.type === 'project' || covering.fileId !== requested.fileId) {
    return false;
  }
  if (covering.type === 'file') {
    return true;
  }
  return (
    requested.type === 'symbol' &&
    (covering.symbolId === requested.symbolId ||
      requested.ancestorSymbolIds.includes(covering.symbolId))
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
  readonly staleEvidence?: string;
}

export const writeLeaseSchema = z.object({
  id: nonEmptyStringSchema,
  runId: nonEmptyStringSchema,
  agentId: nonEmptyStringSchema,
  taskId: nonEmptyStringSchema,
  resource: writableResourceSchema,
  mode: z.literal('exclusive'),
  version: z.number().int().positive(),
  state: z.enum(['ACTIVE', 'RELEASED', 'STALE']),
  acquiredAt: z.date(),
  lastHeartbeatAt: z.date(),
  releasedAt: z.date().optional(),
  staleDetectedAt: z.date().optional(),
  staleEvidence: z.string().optional()
});

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

export interface ReleaseWriteLeaseRequest {
  readonly leaseId: string;
  readonly expectedVersion: number;
}

export type ReleaseWriteLeaseResult =
  | { readonly status: 'released'; readonly lease: WriteLease }
  | { readonly status: 'not-found' }
  | { readonly status: 'version-conflict'; readonly actualVersion: number };

export interface WriteGuard {
  acquire(request: WriteLeaseRequest): Promise<WriteLeaseResult>;
  heartbeat(request: HeartbeatWriteLeaseRequest): Promise<HeartbeatWriteLeaseResult>;
  markStale(request: MarkWriteLeaseStaleRequest): Promise<MarkWriteLeaseStaleResult>;
  release(request: ReleaseWriteLeaseRequest): Promise<ReleaseWriteLeaseResult>;
}
