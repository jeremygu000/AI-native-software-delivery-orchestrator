import type { FileId, ProjectId, RepositoryGraph, SymbolId } from './repository-graph.js';
import type { TaskContract } from './task-contract.js';

export type ResourceId = string;

export type ImpactRiskSignalType =
  | 'public-api-change'
  | 'generated-artifact'
  | 'high-fan-out'
  | 'ambiguous-selector';

export interface ImpactRiskSignal {
  readonly type: ImpactRiskSignalType;
  readonly detail: string;
}

export interface PredictedTaskImpact {
  readonly taskId: string;
  readonly projectsRead: ReadonlySet<ProjectId>;
  readonly projectsWritten: ReadonlySet<ProjectId>;
  readonly filesRead: ReadonlySet<FileId>;
  readonly filesWritten: ReadonlySet<FileId>;
  readonly symbolsRead: ReadonlySet<SymbolId>;
  readonly symbolsWritten: ReadonlySet<SymbolId>;
  readonly sharedResources: ReadonlySet<ResourceId>;
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
  | 'upstream-downstream-project';

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
  | 'same-symbol-write'
  | 'runtime-scope-expansion';

export interface SchedulingConstraint {
  readonly type: SchedulingConstraintType;
  readonly detail: string;
  readonly resourceIds: readonly string[];
}

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
