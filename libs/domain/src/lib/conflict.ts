import type { FileId, ProjectId, RepositoryGraph, SymbolId } from './repository-graph.js';
import type { TaskContract } from './task-contract.js';

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

export interface TaskImpactAnalyzer {
  analyze(task: TaskContract, graph: RepositoryGraph): Promise<PredictedTaskImpact>;
}

export interface ConflictAnalyzer {
  compare(a: PredictedTaskImpact, b: PredictedTaskImpact, graph: RepositoryGraph): TaskConflict;
}
