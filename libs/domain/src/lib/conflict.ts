import type { FileId, ProjectId, RepositoryGraph, SymbolId } from './repository-graph.js';
import type { TaskContract } from './task-contract.js';
import { z } from 'zod';

export type ResourceId = string;

export type ImpactRiskSignalType =
  | 'public-api-touch'
  | 'public-api-signature-change'
  | 'generated-artifact'
  | 'high-fan-out'
  | 'ambiguous-selector';

export interface ImpactRiskSignal {
  readonly type: ImpactRiskSignalType;
  readonly detail: string;
}

export type SharedResourceAccessMode = 'read' | 'write' | 'coordinate';

export interface SharedResourceAccess {
  readonly resourceId: ResourceId;
  readonly modes: readonly SharedResourceAccessMode[];
}

const stringSetSchema = z.set(z.string());

export const sharedResourceAccessSchema = z.object({
  resourceId: z.string(),
  modes: z.array(z.enum(['read', 'write', 'coordinate']))
});

export const impactRiskSignalSchema = z.object({
  type: z.enum([
    'public-api-touch',
    'public-api-signature-change',
    'generated-artifact',
    'high-fan-out',
    'ambiguous-selector'
  ]),
  detail: z.string()
});

export const predictedTaskImpactSchema = z.object({
  taskId: z.string(),
  projectsRead: stringSetSchema,
  projectsWritten: stringSetSchema,
  explicitProjectsWritten: stringSetSchema,
  filesRead: stringSetSchema,
  filesWritten: stringSetSchema,
  explicitFilesWritten: stringSetSchema,
  globFilesWritten: stringSetSchema,
  symbolDerivedFilesWritten: stringSetSchema,
  symbolsRead: stringSetSchema,
  symbolsWritten: stringSetSchema,
  sharedResources: stringSetSchema,
  sharedResourceAccesses: z.array(sharedResourceAccessSchema),
  downstreamProjects: stringSetSchema,
  riskSignals: z.array(impactRiskSignalSchema)
});

export const observedTaskImpactSchema = z.object({
  taskId: z.string(),
  filesRead: stringSetSchema,
  filesCreated: stringSetSchema,
  filesWritten: stringSetSchema,
  filesDeleted: stringSetSchema,
  symbolsWritten: stringSetSchema,
  dependencyRequests: stringSetSchema,
  manifestFilesChanged: stringSetSchema,
  generatedFilesChanged: stringSetSchema
});

export const taskImpactSchema = z.object({
  predicted: predictedTaskImpactSchema,
  observed: observedTaskImpactSchema.optional()
});

export interface PredictedTaskImpact {
  readonly taskId: string;
  readonly projectsRead: ReadonlySet<ProjectId>;
  readonly projectsWritten: ReadonlySet<ProjectId>;
  readonly explicitProjectsWritten: ReadonlySet<ProjectId>;
  readonly filesRead: ReadonlySet<FileId>;
  readonly filesWritten: ReadonlySet<FileId>;
  readonly explicitFilesWritten: ReadonlySet<FileId>;
  readonly globFilesWritten: ReadonlySet<FileId>;
  readonly symbolDerivedFilesWritten: ReadonlySet<FileId>;
  readonly symbolsRead: ReadonlySet<SymbolId>;
  readonly symbolsWritten: ReadonlySet<SymbolId>;
  readonly sharedResources: ReadonlySet<ResourceId>;
  readonly sharedResourceAccesses: readonly SharedResourceAccess[];
  readonly downstreamProjects: ReadonlySet<ProjectId>;
  readonly riskSignals: readonly ImpactRiskSignal[];
}

export interface ObservedTaskImpact {
  readonly taskId: string;
  readonly filesRead: ReadonlySet<FileId>;
  readonly filesCreated: ReadonlySet<FileId>;
  readonly filesWritten: ReadonlySet<FileId>;
  readonly filesDeleted: ReadonlySet<FileId>;
  readonly symbolsWritten: ReadonlySet<SymbolId>;
  readonly dependencyRequests: ReadonlySet<ResourceId>;
  readonly manifestFilesChanged: ReadonlySet<FileId>;
  readonly generatedFilesChanged: ReadonlySet<FileId>;
}

export interface TaskImpact {
  readonly predicted: PredictedTaskImpact;
  readonly observed?: ObservedTaskImpact;
}

export type ConflictReasonType =
  | 'same-symbol'
  | 'same-file-different-symbol'
  | 'same-file'
  | 'same-project'
  | 'shared-resource'
  | 'producer-consumer'
  | 'generated-code'
  | 'upstream-downstream-project'
  | 'public-api-touch'
  | 'high-fan-out';

export interface ConflictReason {
  readonly type: ConflictReasonType;
  readonly score: number;
  readonly detail: string;
  readonly resourceIds: readonly string[];
}

export const conflictReasonSchema = z.object({
  type: z.enum([
    'same-symbol',
    'same-file-different-symbol',
    'same-file',
    'same-project',
    'shared-resource',
    'producer-consumer',
    'generated-code',
    'upstream-downstream-project',
    'public-api-touch',
    'high-fan-out'
  ]),
  score: z.number().int().min(0).max(100),
  detail: z.string(),
  resourceIds: z.array(z.string())
});

export type ConflictAction = 'parallel' | 'guarded-parallel' | 'stagger' | 'serialize';
export type HardConflictAction = Extract<ConflictAction, 'stagger' | 'serialize'>;
export type ConflictSeverity = 'none' | 'soft' | 'hard';
export type SchedulingConstraintType =
  | 'exclusive-resource'
  | 'ordered-resource'
  | 'producer-consumer'
  | 'producer-controlled-resource'
  | 'same-symbol-write'
  | 'runtime-scope-expansion';

interface SchedulingConstraintBase {
  readonly detail: string;
  readonly resourceIds: readonly string[];
}

export interface ProducerConsumerSchedulingConstraint extends SchedulingConstraintBase {
  readonly type: 'producer-consumer';
  readonly producerTaskId: string;
  readonly consumerTaskId: string;
}

export interface StandardSchedulingConstraint extends SchedulingConstraintBase {
  readonly type: Exclude<SchedulingConstraintType, 'producer-consumer'>;
}

export type SchedulingConstraint =
  | ProducerConsumerSchedulingConstraint
  | StandardSchedulingConstraint;

const schedulingConstraintBaseSchema = z.object({
  detail: z.string(),
  resourceIds: z.array(z.string())
});

export const schedulingConstraintSchema = z.discriminatedUnion('type', [
  schedulingConstraintBaseSchema.extend({
    type: z.literal('producer-consumer'),
    producerTaskId: z.string(),
    consumerTaskId: z.string()
  }),
  schedulingConstraintBaseSchema.extend({
    type: z.enum([
      'exclusive-resource',
      'ordered-resource',
      'producer-controlled-resource',
      'same-symbol-write',
      'runtime-scope-expansion'
    ])
  })
]);

interface TaskConflictBase {
  readonly taskA: string;
  readonly taskB: string;
  readonly score: number;
  readonly reasons: readonly ConflictReason[];
}

export interface HardTaskConflict extends TaskConflictBase {
  readonly severity: 'hard';
  readonly constraints: readonly [SchedulingConstraint, ...SchedulingConstraint[]];
  readonly recommendedAction: HardConflictAction;
}

export interface RiskTaskConflict extends TaskConflictBase {
  readonly severity: Exclude<ConflictSeverity, 'hard'>;
  readonly constraints: readonly [];
  readonly recommendedAction: ConflictAction;
}

export type TaskConflict = HardTaskConflict | RiskTaskConflict;

const taskConflictBaseSchema = z.object({
  taskA: z.string(),
  taskB: z.string(),
  score: z.number().int().min(0).max(100),
  reasons: z.array(conflictReasonSchema)
});

export const taskConflictSchema = z.discriminatedUnion('severity', [
  taskConflictBaseSchema.extend({
    severity: z.literal('hard'),
    constraints: z.tuple([schedulingConstraintSchema]).rest(schedulingConstraintSchema),
    recommendedAction: z.enum(['stagger', 'serialize'])
  }),
  taskConflictBaseSchema.extend({
    severity: z.enum(['none', 'soft']),
    constraints: z.tuple([]),
    recommendedAction: z.enum(['parallel', 'guarded-parallel', 'stagger', 'serialize'])
  })
]);

export interface TaskImpactAnalyzer {
  analyze(task: TaskContract, graph: RepositoryGraph): Promise<PredictedTaskImpact>;
}

export interface ConflictAnalyzer {
  compare(a: PredictedTaskImpact, b: PredictedTaskImpact, graph: RepositoryGraph): TaskConflict;
}
