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

export interface TaskImpact {
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

export interface TaskConflict {
  readonly taskA: string;
  readonly taskB: string;
  readonly score: number;
  readonly reasons: readonly ConflictReason[];
  readonly recommendedAction: ConflictAction;
}

export interface TaskImpactAnalyzer {
  analyze(task: TaskContract, graph: RepositoryGraph): Promise<TaskImpact>;
}

export interface ConflictAnalyzer {
  compare(a: TaskImpact, b: TaskImpact, graph: RepositoryGraph): TaskConflict;
}
