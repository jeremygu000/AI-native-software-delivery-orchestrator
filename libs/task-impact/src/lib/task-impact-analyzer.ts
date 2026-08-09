import type {
  FileId,
  ImpactRiskSignal,
  PredictedTaskImpact,
  ProjectId,
  RepositoryGraph,
  ResourceSelector,
  SharedResourceAccess,
  SharedResourceAccessMode,
  SymbolId,
  TaskContract,
  TaskImpactAnalyzer
} from '@ai-native-software-delivery-orchestrator/domain';

import { matchesPathPattern, normalizeRepositoryPath } from './path-pattern.js';
import { SharedResourceRegistry } from './shared-resource-registry.js';

export interface TaskImpactAnalyzerOptions {
  readonly highFanOutProjectCount?: number;
}

export type TaskImpactAnalysisErrorCode = 'UNKNOWN_SHARED_RESOURCE';

export class TaskImpactAnalysisError extends Error {
  readonly code: TaskImpactAnalysisErrorCode;
  readonly resourceIds: readonly string[];

  constructor(code: TaskImpactAnalysisErrorCode, resourceIds: readonly string[]) {
    super(`Unknown shared resource IDs: ${resourceIds.join(', ')}`);
    this.name = 'TaskImpactAnalysisError';
    this.code = code;
    this.resourceIds = resourceIds;
  }
}

interface MutableImpact {
  readonly projectsRead: Set<ProjectId>;
  readonly projectsWritten: Set<ProjectId>;
  readonly filesRead: Set<FileId>;
  readonly filesWritten: Set<FileId>;
  readonly symbolsRead: Set<SymbolId>;
  readonly symbolsWritten: Set<SymbolId>;
  readonly sharedResourceModes: Map<string, Set<SharedResourceAccessMode>>;
  readonly riskSignals: ImpactRiskSignal[];
}

const stableSet = <T extends string>(values: Iterable<T>): ReadonlySet<T> =>
  new Set([...values].toSorted());

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const accessModeOrder: Readonly<Record<SharedResourceAccessMode, number>> = {
  read: 0,
  write: 1,
  coordinate: 2
};

const recordSharedResource = (
  impact: MutableImpact,
  resourceId: string,
  mode: SharedResourceAccessMode
): void => {
  const modes = impact.sharedResourceModes.get(resourceId) ?? new Set<SharedResourceAccessMode>();
  modes.add(mode);
  impact.sharedResourceModes.set(resourceId, modes);
};

const recordFile = (
  impact: MutableImpact,
  graph: RepositoryGraph,
  fileId: FileId,
  mode: Extract<SharedResourceAccessMode, 'read' | 'write'>,
  registry: SharedResourceRegistry
): void => {
  const file = graph.files.get(fileId);
  if (file === undefined) {
    return;
  }
  if (mode === 'read') {
    impact.filesRead.add(file.id);
    impact.projectsRead.add(file.projectId);
  } else {
    impact.filesWritten.add(file.id);
    impact.projectsWritten.add(file.projectId);
  }
  for (const resource of registry.matchingFile(file.path)) {
    recordSharedResource(impact, resource.id, mode);
  }
};

const recordSymbol = (
  impact: MutableImpact,
  graph: RepositoryGraph,
  symbolId: SymbolId,
  mode: Extract<SharedResourceAccessMode, 'read' | 'write'>,
  registry: SharedResourceRegistry
): void => {
  const symbol = graph.symbols.get(symbolId);
  if (symbol === undefined) {
    return;
  }
  if (mode === 'read') {
    impact.symbolsRead.add(symbol.id);
  } else {
    impact.symbolsWritten.add(symbol.id);
  }
  recordFile(impact, graph, symbol.fileId, mode, registry);
};

const resolveDownstreamProjects = (
  writtenProjects: ReadonlySet<ProjectId>,
  graph: RepositoryGraph
): ReadonlySet<ProjectId> => {
  const dependents = new Map<ProjectId, ProjectId[]>();
  for (const dependency of graph.projectDependencies) {
    const projectDependents = dependents.get(dependency.to) ?? [];
    projectDependents.push(dependency.from);
    dependents.set(dependency.to, projectDependents);
  }

  const downstream = new Set<ProjectId>();
  const queue = [...writtenProjects].toSorted();
  for (let index = 0; index < queue.length; index += 1) {
    const projectId = queue[index];
    for (const dependent of (dependents.get(projectId) ?? []).toSorted()) {
      if (!writtenProjects.has(dependent) && !downstream.has(dependent)) {
        downstream.add(dependent);
        queue.push(dependent);
      }
    }
  }
  return stableSet(downstream);
};

export class RepositoryTaskImpactAnalyzer implements TaskImpactAnalyzer {
  readonly #registry: SharedResourceRegistry;
  readonly #highFanOutProjectCount: number;

  constructor(registry: SharedResourceRegistry, options: TaskImpactAnalyzerOptions = {}) {
    this.#registry = registry;
    this.#highFanOutProjectCount = options.highFanOutProjectCount ?? 3;
  }

  async analyze(task: TaskContract, graph: RepositoryGraph): Promise<PredictedTaskImpact> {
    this.#validateSharedResourceIds(task);
    const impact: MutableImpact = {
      projectsRead: new Set(),
      projectsWritten: new Set(),
      filesRead: new Set(),
      filesWritten: new Set(),
      symbolsRead: new Set(),
      symbolsWritten: new Set(),
      sharedResourceModes: new Map(),
      riskSignals: []
    };

    for (const resourceId of task.sharedResources) {
      recordSharedResource(impact, resourceId, 'coordinate');
    }
    for (const selector of task.expectedReads) {
      this.#resolveSelector(selector, 'read', impact, graph);
    }
    for (const selector of task.expectedWrites) {
      this.#resolveSelector(selector, 'write', impact, graph);
    }

    for (const symbolId of impact.symbolsWritten) {
      const symbol = graph.symbols.get(symbolId);
      if (symbol?.exported === true) {
        impact.riskSignals.push({
          type: 'public-api-touch',
          detail: `Task may touch exported symbol ${symbol.id}; no signature change is claimed.`
        });
      }
    }
    for (const fileId of impact.filesWritten) {
      const file = graph.files.get(fileId);
      if (file?.isGenerated === true) {
        impact.riskSignals.push({
          type: 'generated-artifact',
          detail: `Task may write generated file ${file.id}.`
        });
      }
    }

    const projectsWritten = stableSet(impact.projectsWritten);
    const downstreamProjects = resolveDownstreamProjects(projectsWritten, graph);
    if (downstreamProjects.size >= this.#highFanOutProjectCount) {
      impact.riskSignals.push({
        type: 'high-fan-out',
        detail: `Writes may affect ${downstreamProjects.size} downstream projects.`
      });
    }

    const sharedResourceAccesses: readonly SharedResourceAccess[] = [
      ...impact.sharedResourceModes.entries()
    ]
      .toSorted(([left], [right]) => compareStrings(left, right))
      .map(([resourceId, modes]) => ({
        resourceId,
        modes: [...modes].toSorted((left, right) => accessModeOrder[left] - accessModeOrder[right])
      }));

    return {
      taskId: task.id,
      projectsRead: stableSet(impact.projectsRead),
      projectsWritten,
      filesRead: stableSet(impact.filesRead),
      filesWritten: stableSet(impact.filesWritten),
      symbolsRead: stableSet(impact.symbolsRead),
      symbolsWritten: stableSet(impact.symbolsWritten),
      sharedResources: stableSet(impact.sharedResourceModes.keys()),
      sharedResourceAccesses,
      downstreamProjects,
      riskSignals: impact.riskSignals.toSorted(
        (left, right) =>
          compareStrings(left.type, right.type) || compareStrings(left.detail, right.detail)
      )
    };
  }

  #resolveSelector(
    selector: ResourceSelector,
    mode: Extract<SharedResourceAccessMode, 'read' | 'write'>,
    impact: MutableImpact,
    graph: RepositoryGraph
  ): void {
    if (selector.type === 'shared-resource') {
      recordSharedResource(impact, selector.value, mode);
      return;
    }

    if (selector.type === 'project') {
      const projects = [...graph.projects.values()].filter(
        (project) =>
          project.id === selector.value ||
          project.name === selector.value ||
          normalizeRepositoryPath(project.root) === normalizeRepositoryPath(selector.value)
      );
      for (const project of projects) {
        if (mode === 'read') {
          impact.projectsRead.add(project.id);
        } else {
          impact.projectsWritten.add(project.id);
        }
        for (const resource of this.#registry.matchingFile(project.packageJsonPath)) {
          recordSharedResource(impact, resource.id, mode);
        }
        for (const file of graph.files.values()) {
          if (file.projectId === project.id) {
            for (const resource of this.#registry.matchingFile(file.path)) {
              recordSharedResource(impact, resource.id, mode);
            }
          }
        }
      }
      this.#recordAmbiguity(selector, projects.length, impact);
      return;
    }

    if (selector.type === 'file' || selector.type === 'glob') {
      const normalizedValue = normalizeRepositoryPath(selector.value);
      const files = [...graph.files.values()].filter((file) =>
        selector.type === 'glob'
          ? matchesPathPattern(file.path, normalizedValue)
          : file.id === selector.value || normalizeRepositoryPath(file.path) === normalizedValue
      );
      for (const file of files) {
        recordFile(impact, graph, file.id, mode, this.#registry);
      }
      const selectorResources =
        selector.type === 'glob'
          ? this.#registry.matchingGlob(selector.value)
          : this.#registry.matchingFile(selector.value);
      for (const resource of selectorResources) {
        recordSharedResource(impact, resource.id, mode);
      }
      this.#recordAmbiguity(
        selector,
        files.length,
        impact,
        selector.type === 'glob',
        selectorResources.length > 0
      );
      return;
    }

    const symbols = [...graph.symbols.values()].filter(
      (symbol) =>
        symbol.id === selector.value ||
        symbol.path === selector.value ||
        symbol.name === selector.value
    );
    for (const symbol of symbols) {
      recordSymbol(impact, graph, symbol.id, mode, this.#registry);
    }
    this.#recordAmbiguity(selector, symbols.length, impact);
  }

  #validateSharedResourceIds(task: TaskContract): void {
    const declaredResourceIds = new Set(task.sharedResources);
    for (const selector of [...task.expectedReads, ...task.expectedWrites]) {
      if (selector.type === 'shared-resource') {
        declaredResourceIds.add(selector.value);
      }
    }
    const unknownResourceIds = [...declaredResourceIds]
      .filter((resourceId) => this.#registry.get(resourceId) === undefined)
      .toSorted(compareStrings);
    if (unknownResourceIds.length > 0) {
      throw new TaskImpactAnalysisError('UNKNOWN_SHARED_RESOURCE', unknownResourceIds);
    }
  }

  #recordAmbiguity(
    selector: ResourceSelector,
    matchCount: number,
    impact: MutableImpact,
    allowMany = false,
    resolvedOutsideRepositoryGraph = false
  ): void {
    if ((!resolvedOutsideRepositoryGraph && matchCount === 0) || (!allowMany && matchCount > 1)) {
      impact.riskSignals.push({
        type: 'ambiguous-selector',
        detail: `Selector ${selector.type}:${selector.value} matched ${matchCount} repository facts.`
      });
    }
  }
}
