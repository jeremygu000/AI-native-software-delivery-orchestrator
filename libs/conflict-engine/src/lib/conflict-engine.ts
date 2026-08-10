import type {
  ConflictAction,
  ConflictAnalyzer,
  ConflictReason,
  HardTaskConflict,
  PredictedTaskImpact,
  RepositoryGraph,
  RiskTaskConflict,
  SchedulingConstraint,
  SharedResourceAccessMode,
  TaskConflict
} from '@ai-native-software-delivery-orchestrator/domain';
import type { SharedResourcePolicyRegistry } from '@ai-native-software-delivery-orchestrator/task-impact';
import { z } from 'zod';

const scoreSchema = z.int().min(0).max(100);

export const conflictEngineConfigSchema = z.object({
  weights: z.object({
    sameSymbol: scoreSchema,
    sameFileDifferentSymbol: scoreSchema,
    sameFile: scoreSchema,
    sameProject: scoreSchema,
    sharedResource: scoreSchema,
    producerConsumer: scoreSchema,
    generatedCode: scoreSchema,
    upstreamDownstreamProject: scoreSchema,
    publicApiTouch: scoreSchema,
    highFanOut: scoreSchema
  }),
  thresholds: z
    .object({
      guardedParallel: scoreSchema,
      stagger: scoreSchema,
      serialize: scoreSchema
    })
    .refine(
      ({ guardedParallel, serialize, stagger }) =>
        guardedParallel <= stagger && stagger <= serialize,
      { message: 'Conflict thresholds must be monotonically increasing' }
    )
});

export type ConflictEngineConfig = z.infer<typeof conflictEngineConfigSchema>;

export const defaultConflictEngineConfig: ConflictEngineConfig = {
  weights: {
    sameSymbol: 100,
    sameFileDifferentSymbol: 30,
    sameFile: 60,
    sameProject: 15,
    sharedResource: 70,
    producerConsumer: 90,
    generatedCode: 80,
    upstreamDownstreamProject: 40,
    publicApiTouch: 40,
    highFanOut: 30
  },
  thresholds: {
    guardedParallel: 1,
    stagger: 60,
    serialize: 90
  }
};

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const intersect = <T extends string>(left: ReadonlySet<T>, right: ReadonlySet<T>): readonly T[] =>
  [...left].filter((value) => right.has(value)).toSorted(compareStrings);

const union = <T extends string>(...sets: readonly ReadonlySet<T>[]): ReadonlySet<T> =>
  new Set(sets.flatMap((set) => [...set]));

const addReason = (
  reasons: ConflictReason[],
  reason: Omit<ConflictReason, 'resourceIds'> & { readonly resourceIds: readonly string[] }
): void => {
  const normalizedReason = {
    ...reason,
    resourceIds: [...new Set(reason.resourceIds)].toSorted(compareStrings)
  };
  const key = `${normalizedReason.type}\u0000${normalizedReason.resourceIds.join('\u0000')}`;
  if (
    !reasons.some(
      (existing) => `${existing.type}\u0000${existing.resourceIds.join('\u0000')}` === key
    )
  ) {
    reasons.push(normalizedReason);
  }
};

const modesByResource = (
  impact: PredictedTaskImpact
): ReadonlyMap<string, ReadonlySet<SharedResourceAccessMode>> =>
  new Map(
    impact.sharedResourceAccesses.map((access) => [access.resourceId, new Set(access.modes)])
  );

const containsWriteIntent = (modes: ReadonlySet<SharedResourceAccessMode>): boolean =>
  modes.has('write') || modes.has('coordinate');

const recommendedRiskAction = (
  score: number,
  configuration: ConflictEngineConfig
): ConflictAction => {
  if (score === 0) {
    return 'parallel';
  }
  if (score >= configuration.thresholds.serialize) {
    return 'serialize';
  }
  if (score >= configuration.thresholds.stagger) {
    return 'stagger';
  }
  if (score >= configuration.thresholds.guardedParallel) {
    return 'guarded-parallel';
  }
  return 'parallel';
};

const hasWholeFileWriteScope = (
  impact: PredictedTaskImpact,
  fileId: string,
  graph: RepositoryGraph
): boolean => {
  if (impact.explicitFilesWritten.has(fileId) || impact.globFilesWritten.has(fileId)) {
    return true;
  }
  const projectId = graph.files.get(fileId)?.projectId;
  return projectId !== undefined && impact.explicitProjectsWritten.has(projectId);
};

const touchesProjects = (impact: PredictedTaskImpact): ReadonlySet<string> =>
  union(impact.projectsRead, impact.projectsWritten);

const downstreamProjectsTouchedByOtherTask = (
  source: PredictedTaskImpact,
  other: PredictedTaskImpact
): readonly string[] => intersect(source.downstreamProjects, touchesProjects(other));

export class DeterministicConflictEngine implements ConflictAnalyzer {
  readonly #registry: SharedResourcePolicyRegistry;
  readonly #configuration: ConflictEngineConfig;

  constructor(
    registry: SharedResourcePolicyRegistry,
    configuration: ConflictEngineConfig = defaultConflictEngineConfig
  ) {
    this.#registry = registry;
    this.#configuration = conflictEngineConfigSchema.parse(configuration);
  }

  compare(
    first: PredictedTaskImpact,
    second: PredictedTaskImpact,
    graph: RepositoryGraph
  ): TaskConflict {
    const [a, b] =
      compareStrings(first.taskId, second.taskId) <= 0 ? [first, second] : [second, first];
    const reasons: ConflictReason[] = [];
    const constraints: SchedulingConstraint[] = [];

    this.#compareCodeImpact(a, b, graph, reasons, constraints);
    this.#compareSharedResources(a, b, reasons, constraints);
    this.#compareProjectRelationships(a, b, reasons);
    this.#compareRiskSignals(a, b, reasons);

    const sortedReasons = reasons.toSorted(
      (left, right) =>
        compareStrings(left.type, right.type) ||
        compareStrings(left.resourceIds.join('\u0000'), right.resourceIds.join('\u0000')) ||
        compareStrings(left.detail, right.detail)
    );
    const score = Math.min(
      100,
      sortedReasons.reduce((total, reason) => total + reason.score, 0)
    );
    const sortedConstraints = constraints.toSorted(
      (left, right) =>
        compareStrings(left.type, right.type) ||
        compareStrings(left.resourceIds.join('\u0000'), right.resourceIds.join('\u0000')) ||
        compareStrings(left.detail, right.detail)
    );

    const [firstConstraint, ...remainingConstraints] = sortedConstraints;
    if (firstConstraint !== undefined) {
      const hardConstraints: readonly [SchedulingConstraint, ...SchedulingConstraint[]] = [
        firstConstraint,
        ...remainingConstraints
      ];
      const requiresSerialization = hardConstraints.some(
        (constraint) =>
          constraint.type !== 'ordered-resource' && constraint.type !== 'producer-consumer'
      );
      const conflict: HardTaskConflict = {
        taskA: a.taskId,
        taskB: b.taskId,
        score,
        reasons: sortedReasons,
        severity: 'hard',
        constraints: hardConstraints,
        recommendedAction: requiresSerialization ? 'serialize' : 'stagger'
      };
      return conflict;
    }

    const conflict: RiskTaskConflict = {
      taskA: a.taskId,
      taskB: b.taskId,
      score,
      reasons: sortedReasons,
      severity: score === 0 ? 'none' : 'soft',
      constraints: [],
      recommendedAction: recommendedRiskAction(score, this.#configuration)
    };
    return conflict;
  }

  #compareCodeImpact(
    a: PredictedTaskImpact,
    b: PredictedTaskImpact,
    graph: RepositoryGraph,
    reasons: ConflictReason[],
    constraints: SchedulingConstraint[]
  ): void {
    const sameSymbols = intersect(a.symbolsWritten, b.symbolsWritten);
    if (sameSymbols.length > 0) {
      addReason(reasons, {
        type: 'same-symbol',
        score: this.#configuration.weights.sameSymbol,
        detail: 'Both tasks may write the same symbol.',
        resourceIds: sameSymbols
      });
      constraints.push({
        type: 'same-symbol-write',
        detail: 'Writes to the same symbol must be serialized.',
        resourceIds: sameSymbols
      });
    }

    const projectScopeOverlaps = [
      ...[...b.filesWritten].filter((fileId) => {
        const projectId = graph.files.get(fileId)?.projectId;
        return projectId !== undefined && a.explicitProjectsWritten.has(projectId);
      }),
      ...[...a.filesWritten].filter((fileId) => {
        const projectId = graph.files.get(fileId)?.projectId;
        return projectId !== undefined && b.explicitProjectsWritten.has(projectId);
      })
    ];
    const sameFiles = [
      ...new Set([...intersect(a.filesWritten, b.filesWritten), ...projectScopeOverlaps])
    ].toSorted(compareStrings);
    if (sameFiles.length > 0) {
      const sameSymbolFileIds = new Set(
        sameSymbols
          .map((symbolId) => graph.symbols.get(symbolId)?.fileId)
          .filter((fileId): fileId is string => fileId !== undefined)
      );
      const siblingSymbolFiles = sameFiles.filter(
        (fileId) =>
          a.symbolDerivedFilesWritten.has(fileId) &&
          b.symbolDerivedFilesWritten.has(fileId) &&
          !hasWholeFileWriteScope(a, fileId, graph) &&
          !hasWholeFileWriteScope(b, fileId, graph) &&
          !sameSymbolFileIds.has(fileId)
      );
      const wholeFileConflicts = sameFiles.filter((fileId) => !siblingSymbolFiles.includes(fileId));
      if (siblingSymbolFiles.length > 0) {
        addReason(reasons, {
          type: 'same-file-different-symbol',
          score: this.#configuration.weights.sameFileDifferentSymbol,
          detail: 'Both tasks may write distinct symbols in the same file.',
          resourceIds: siblingSymbolFiles
        });
      }
      if (wholeFileConflicts.length > 0) {
        addReason(reasons, {
          type: 'same-file',
          score: this.#configuration.weights.sameFile,
          detail: 'At least one task may write the whole file scope.',
          resourceIds: wholeFileConflicts
        });
      }
    }

    const aProducesForB = [
      ...intersect(a.symbolsWritten, b.symbolsRead),
      ...intersect(a.filesWritten, b.filesRead)
    ].toSorted(compareStrings);
    const bProducesForA = [
      ...intersect(b.symbolsWritten, a.symbolsRead),
      ...intersect(b.filesWritten, a.filesRead)
    ].toSorted(compareStrings);
    const producerConsumerResources = [...aProducesForB, ...bProducesForA];
    if (producerConsumerResources.length > 0) {
      addReason(reasons, {
        type: 'producer-consumer',
        score: this.#configuration.weights.producerConsumer,
        detail:
          aProducesForB.length > 0 && bProducesForA.length > 0
            ? 'Both tasks may write repository facts consumed by the other.'
            : `${aProducesForB.length > 0 ? a.taskId : b.taskId} may write repository facts consumed by ${aProducesForB.length > 0 ? b.taskId : a.taskId}.`,
        resourceIds: producerConsumerResources
      });
      if (aProducesForB.length > 0 && bProducesForA.length === 0) {
        constraints.push({
          type: 'producer-consumer',
          detail: `${a.taskId} produces repository facts for ${b.taskId}.`,
          resourceIds: aProducesForB,
          producerTaskId: a.taskId,
          consumerTaskId: b.taskId
        });
      } else if (bProducesForA.length > 0 && aProducesForB.length === 0) {
        constraints.push({
          type: 'producer-consumer',
          detail: `${b.taskId} produces repository facts for ${a.taskId}.`,
          resourceIds: bProducesForA,
          producerTaskId: b.taskId,
          consumerTaskId: a.taskId
        });
      }
    }

    const generatedFiles = [
      ...intersect(a.filesWritten, union(b.filesRead, b.filesWritten)),
      ...intersect(b.filesWritten, union(a.filesRead, a.filesWritten))
    ].filter((fileId) => graph.files.get(fileId)?.isGenerated === true);
    if (generatedFiles.length > 0) {
      addReason(reasons, {
        type: 'generated-code',
        score: this.#configuration.weights.generatedCode,
        detail: 'The overlapping write scope includes generated code.',
        resourceIds: generatedFiles
      });
    }
  }

  #compareSharedResources(
    a: PredictedTaskImpact,
    b: PredictedTaskImpact,
    reasons: ConflictReason[],
    constraints: SchedulingConstraint[]
  ): void {
    const sharedResourceIds = intersect(a.sharedResources, b.sharedResources);
    const accessesA = modesByResource(a);
    const accessesB = modesByResource(b);
    for (const resourceId of sharedResourceIds) {
      const modesA = accessesA.get(resourceId) ?? new Set<SharedResourceAccessMode>(['coordinate']);
      const modesB = accessesB.get(resourceId) ?? new Set<SharedResourceAccessMode>(['coordinate']);
      const definition = this.#registry.get(resourceId);
      const hasWriteIntent = containsWriteIntent(modesA) || containsWriteIntent(modesB);
      if (
        !hasWriteIntent &&
        (definition === undefined || definition.concurrency === 'producer-controlled')
      ) {
        continue;
      }

      if (definition?.concurrency === 'producer-controlled') {
        const aWrites = modesA.has('write');
        const bWrites = modesB.has('write');
        const directional =
          aWrites !== bWrites &&
          ((aWrites && modesB.has('read')) || (bWrites && modesA.has('read')));
        addReason(reasons, {
          type: directional ? 'producer-consumer' : 'shared-resource',
          score: directional
            ? this.#configuration.weights.producerConsumer
            : this.#configuration.weights.sharedResource,
          detail: directional
            ? `A producer write must complete before the consumer reads ${resourceId}.`
            : `Producer-controlled resource ${resourceId} has competing write or coordination intent.`,
          resourceIds: [resourceId]
        });
        if (directional) {
          constraints.push({
            type: 'producer-consumer',
            detail: `${aWrites ? a.taskId : b.taskId} produces ${resourceId} for ${aWrites ? b.taskId : a.taskId}.`,
            resourceIds: [resourceId],
            producerTaskId: aWrites ? a.taskId : b.taskId,
            consumerTaskId: aWrites ? b.taskId : a.taskId
          });
        } else {
          constraints.push({
            type: 'producer-controlled-resource',
            detail: `Competing writes to ${resourceId} must be serialized.`,
            resourceIds: [resourceId]
          });
        }
        continue;
      }

      addReason(reasons, {
        type: 'shared-resource',
        score: this.#configuration.weights.sharedResource,
        detail:
          definition === undefined
            ? `Both tasks coordinate through unregistered resource ${resourceId}.`
            : `Both tasks access ${definition.concurrency} resource ${resourceId}.`,
        resourceIds: [resourceId]
      });

      if (definition?.concurrency === 'exclusive') {
        constraints.push({
          type: 'exclusive-resource',
          detail: `Shared resource ${resourceId} permits only one active user.`,
          resourceIds: [resourceId]
        });
      } else if (definition?.concurrency === 'ordered') {
        constraints.push({
          type: 'ordered-resource',
          detail: `Shared resource ${resourceId} must be accessed in task order.`,
          resourceIds: [resourceId]
        });
      }
    }
  }

  #compareProjectRelationships(
    a: PredictedTaskImpact,
    b: PredictedTaskImpact,
    reasons: ConflictReason[]
  ): void {
    const sameProjects = intersect(a.projectsWritten, b.projectsWritten);
    if (sameProjects.length > 0) {
      addReason(reasons, {
        type: 'same-project',
        score: this.#configuration.weights.sameProject,
        detail: 'Both tasks may write the same project.',
        resourceIds: sameProjects
      });
    }

    const relatedProjects = [
      ...downstreamProjectsTouchedByOtherTask(a, b),
      ...downstreamProjectsTouchedByOtherTask(b, a)
    ];
    if (relatedProjects.length > 0) {
      addReason(reasons, {
        type: 'upstream-downstream-project',
        score: this.#configuration.weights.upstreamDownstreamProject,
        detail: 'One task touches a project downstream from the other task write scope.',
        resourceIds: relatedProjects
      });
    }
  }

  #compareRiskSignals(
    a: PredictedTaskImpact,
    b: PredictedTaskImpact,
    reasons: ConflictReason[]
  ): void {
    const downstreamFromA = downstreamProjectsTouchedByOtherTask(a, b);
    const downstreamFromB = downstreamProjectsTouchedByOtherTask(b, a);
    const publicApiRelatedProjects = [
      ...(a.riskSignals.some((signal) => signal.type === 'public-api-touch')
        ? downstreamFromA
        : []),
      ...(b.riskSignals.some((signal) => signal.type === 'public-api-touch') ? downstreamFromB : [])
    ];
    if (publicApiRelatedProjects.length > 0) {
      addReason(reasons, {
        type: 'public-api-touch',
        score: this.#configuration.weights.publicApiTouch,
        detail: 'An exported symbol may be touched while downstream projects are in scope.',
        resourceIds: publicApiRelatedProjects
      });
    }
    const highFanOutRelatedProjects = [
      ...(a.riskSignals.some((signal) => signal.type === 'high-fan-out') ? downstreamFromA : []),
      ...(b.riskSignals.some((signal) => signal.type === 'high-fan-out') ? downstreamFromB : [])
    ];
    if (highFanOutRelatedProjects.length > 0) {
      addReason(reasons, {
        type: 'high-fan-out',
        score: this.#configuration.weights.highFanOut,
        detail: 'At least one task has a high-fan-out predicted impact.',
        resourceIds: highFanOutRelatedProjects
      });
    }
  }
}
