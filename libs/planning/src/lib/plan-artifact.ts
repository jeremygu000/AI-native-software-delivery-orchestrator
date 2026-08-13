import { createHash } from 'node:crypto';

import type {
  PredictedTaskImpact,
  RepositoryGraph,
  RepositorySnapshot
} from '@ai-native-software-delivery-orchestrator/domain';
import {
  scheduleOptionsSchema,
  taskConflictSchema,
  taskSpecificationSchema
} from '@ai-native-software-delivery-orchestrator/domain';
import { z } from 'zod';

import {
  planningSourceSchema,
  type PlanningSource,
  type PreparedOrchestrationPlan
} from './autonomous-plan-phase.js';
import { semanticPlanReviewSchema } from './semantic-plan-review.js';

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const stableStringsSchema = z.array(z.string()).superRefine((values, context) => {
  const stable = [...new Set(values)].toSorted();
  if (stable.length !== values.length || stable.some((value, index) => value !== values[index])) {
    context.addIssue({ code: 'custom', message: 'Values must be unique and sorted' });
  }
});

const repositorySnapshotSchema = z.object({
  repositoryId: digestSchema,
  repositoryRoot: z.string().trim().min(1),
  baseCommit: z.string().regex(/^[0-9a-f]{40,64}$/),
  workingTreeFingerprint: digestSchema,
  dirty: z.boolean()
});

const serializedImpactSchema = z.object({
  taskId: z.string().trim().min(1),
  projectsRead: stableStringsSchema,
  projectsWritten: stableStringsSchema,
  explicitProjectsWritten: stableStringsSchema,
  filesRead: stableStringsSchema,
  filesWritten: stableStringsSchema,
  explicitFilesWritten: stableStringsSchema,
  globFilesWritten: stableStringsSchema,
  symbolDerivedFilesWritten: stableStringsSchema,
  symbolsRead: stableStringsSchema,
  symbolsWritten: stableStringsSchema,
  sharedResources: stableStringsSchema,
  sharedResourceAccesses: z.array(
    z.object({
      resourceId: z.string().trim().min(1),
      modes: z.array(z.enum(['read', 'write', 'coordinate']))
    })
  ),
  downstreamProjects: stableStringsSchema,
  riskSignals: z.array(
    z.object({
      type: z.enum([
        'public-api-touch',
        'public-api-signature-change',
        'generated-artifact',
        'high-fan-out',
        'ambiguous-selector'
      ]),
      detail: z.string()
    })
  )
});

const executionPlanSchema = z.object({
  waves: z.array(
    z.object({
      index: z.int().nonnegative(),
      taskIds: z.array(z.string().trim().min(1))
    })
  )
});

export const planArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    revision: z.int().positive(),
    createdAt: z.iso.datetime({ offset: true }),
    source: planningSourceSchema,
    sourceFingerprint: digestSchema,
    repository: repositorySnapshotSchema.extend({ factsFingerprint: digestSchema }),
    authority: z.object({
      sharedResourcePolicyFingerprint: digestSchema,
      verificationPolicyFingerprint: digestSchema,
      codeReviewPolicyFingerprint: digestSchema
    }),
    decision: z.object({
      attempts: z.int().positive(),
      specification: taskSpecificationSchema,
      impacts: z.array(serializedImpactSchema),
      hardConflicts: z.array(taskConflictSchema),
      riskConflicts: z.array(taskConflictSchema),
      executionPlan: executionPlanSchema,
      schedule: scheduleOptionsSchema,
      semanticReview: semanticPlanReviewSchema
    }),
    planFingerprint: digestSchema
  })
  .superRefine((artifact, context) => {
    const taskIds = new Set(artifact.decision.specification.tasks.map((task) => task.id));
    const impactTaskIds = artifact.decision.impacts.map((impact) => impact.taskId);
    const waveTaskIds = artifact.decision.executionPlan.waves.flatMap((wave) => wave.taskIds);
    const waveByTask = new Map<string, number>();
    const addTaskSetIssue = (collection: readonly string[], path: (string | number)[]) => {
      const identities = new Set(collection);
      if (
        identities.size !== collection.length ||
        identities.size !== taskIds.size ||
        [...taskIds].some((taskId) => !identities.has(taskId))
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Collection must contain every task ID exactly once',
          path
        });
      }
    };
    addTaskSetIssue(impactTaskIds, ['decision', 'impacts']);
    addTaskSetIssue(waveTaskIds, ['decision', 'executionPlan', 'waves']);

    for (const [waveIndex, wave] of artifact.decision.executionPlan.waves.entries()) {
      if (wave.index !== waveIndex) {
        context.addIssue({
          code: 'custom',
          message: 'Execution wave indices must be contiguous and zero-based',
          path: ['decision', 'executionPlan', 'waves', waveIndex, 'index']
        });
      }
      if (wave.taskIds.length > artifact.decision.schedule.maxConcurrency) {
        context.addIssue({
          code: 'custom',
          message: 'Execution wave exceeds schedule maxConcurrency',
          path: ['decision', 'executionPlan', 'waves', waveIndex, 'taskIds']
        });
      }
      for (const taskId of wave.taskIds) {
        waveByTask.set(taskId, waveIndex);
      }
    }
    for (const [taskIndex, task] of artifact.decision.specification.tasks.entries()) {
      const taskWave = waveByTask.get(task.id);
      for (const [dependencyIndex, dependencyId] of task.dependencies.entries()) {
        const dependencyWave = waveByTask.get(dependencyId);
        if (taskWave !== undefined && dependencyWave !== undefined && dependencyWave >= taskWave) {
          context.addIssue({
            code: 'custom',
            message: `Execution wave places dependency ${dependencyId} no earlier than ${task.id}`,
            path: ['decision', 'specification', 'tasks', taskIndex, 'dependencies', dependencyIndex]
          });
        }
      }
    }

    const conflictPairs = new Set<string>();
    const validateConflict = (
      conflict: (typeof artifact.decision.hardConflicts)[number],
      collection: 'hardConflicts' | 'riskConflicts',
      index: number
    ) => {
      if (conflict.taskA === conflict.taskB) {
        context.addIssue({
          code: 'custom',
          message: 'Task conflict cannot reference the same task twice',
          path: ['decision', collection, index]
        });
      }
      const pair = canonicalPlanJson([conflict.taskA, conflict.taskB].toSorted());
      if (conflictPairs.has(pair)) {
        context.addIssue({
          code: 'custom',
          message: 'Duplicate task conflict pair',
          path: ['decision', collection, index]
        });
      }
      conflictPairs.add(pair);
    };

    for (const [index, conflict] of artifact.decision.hardConflicts.entries()) {
      validateConflict(conflict, 'hardConflicts', index);
      if (conflict.severity !== 'hard') {
        context.addIssue({
          code: 'custom',
          message: 'Hard conflict collection contains a risk conflict',
          path: ['decision', 'hardConflicts', index]
        });
      }
      if (!taskIds.has(conflict.taskA) || !taskIds.has(conflict.taskB)) {
        context.addIssue({
          code: 'custom',
          message: 'Hard conflict references an unknown task',
          path: ['decision', 'hardConflicts', index]
        });
      }
    }
    for (const [index, conflict] of artifact.decision.riskConflicts.entries()) {
      validateConflict(conflict, 'riskConflicts', index);
      if (conflict.severity === 'hard') {
        context.addIssue({
          code: 'custom',
          message: 'Risk conflict collection contains a hard conflict',
          path: ['decision', 'riskConflicts', index]
        });
      }
      if (!taskIds.has(conflict.taskA) || !taskIds.has(conflict.taskB)) {
        context.addIssue({
          code: 'custom',
          message: 'Risk conflict references an unknown task',
          path: ['decision', 'riskConflicts', index]
        });
      }
    }
    for (const [
      requirementIndex,
      requirement
    ] of artifact.decision.semanticReview.requirements.entries()) {
      for (const [taskIndex, taskId] of requirement.taskIds.entries()) {
        if (!taskIds.has(taskId)) {
          context.addIssue({
            code: 'custom',
            message: `Semantic review references unknown task: ${taskId}`,
            path: [
              'decision',
              'semanticReview',
              'requirements',
              requirementIndex,
              'taskIds',
              taskIndex
            ]
          });
        }
      }
    }

    for (const [impactIndex, impact] of artifact.decision.impacts.entries()) {
      const accessIdentities = impact.sharedResourceAccesses.map((access) =>
        canonicalPlanJson(access)
      );
      const riskIdentities = impact.riskSignals.map((risk) => canonicalPlanJson(risk));
      for (const [collection, identities] of [
        ['sharedResourceAccesses', accessIdentities],
        ['riskSignals', riskIdentities]
      ] as const) {
        const stable = [...new Set(identities)].toSorted();
        if (
          stable.length !== identities.length ||
          stable.some((identity, index) => identity !== identities[index])
        ) {
          context.addIssue({
            code: 'custom',
            message: `${collection} must be unique and sorted`,
            path: ['decision', 'impacts', impactIndex, collection]
          });
        }
      }
      for (const [accessIndex, access] of impact.sharedResourceAccesses.entries()) {
        const stableModes = [...new Set(access.modes)].toSorted();
        if (
          stableModes.length !== access.modes.length ||
          stableModes.some((mode, index) => mode !== access.modes[index])
        ) {
          context.addIssue({
            code: 'custom',
            message: 'Shared-resource access modes must be unique and sorted',
            path: [
              'decision',
              'impacts',
              impactIndex,
              'sharedResourceAccesses',
              accessIndex,
              'modes'
            ]
          });
        }
      }
    }
  });

export type PlanArtifact = z.infer<typeof planArtifactSchema>;

export interface CreatePlanArtifactRequest {
  readonly artifactId: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly source: PlanningSource;
  readonly repository: RepositoryGraph;
  readonly repositorySnapshot: RepositorySnapshot;
  readonly sharedResourcePolicy: unknown;
  readonly verificationPolicy: unknown;
  readonly codeReviewPolicy: unknown;
  readonly preparedPlan: PreparedOrchestrationPlan;
}

export interface PlanArtifactStore {
  save(artifact: PlanArtifact): Promise<void>;
  load(artifactId: string, revision: number): Promise<PlanArtifact | undefined>;
}

export type RepositoryBindingMismatch =
  | 'repository-id'
  | 'repository-root'
  | 'base-commit'
  | 'working-tree'
  | 'repository-dirty-state'
  | 'repository-facts';

export class PlanArtifactIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanArtifactIntegrityError';
  }
}

export class RepositorySnapshotChangedError extends Error {
  constructor() {
    super('Repository changed while facts were being analyzed; planning must be retried');
    this.name = 'RepositorySnapshotChangedError';
  }
}

type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
interface JsonObject {
  readonly [key: string]: JsonValue;
}

const canonicalJsonValue = (value: unknown, path = '$'): JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new PlanArtifactIntegrityError(`Non-finite number at ${path}`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalJsonValue(item, `${path}[${index}]`));
  }
  if (typeof value === 'object' && value !== null) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new PlanArtifactIntegrityError(`Unsupported value at ${path}`);
    }
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonicalJsonValue(item, `${path}.${key}`)])
    );
  }
  throw new PlanArtifactIntegrityError(`Unsupported value at ${path}`);
};

export const canonicalPlanJson = (value: unknown): string =>
  JSON.stringify(canonicalJsonValue(value));

export const fingerprintPlanValue = (value: unknown): string =>
  `sha256:${createHash('sha256').update(canonicalPlanJson(value)).digest('hex')}`;

const sorted = (values: ReadonlySet<string>): readonly string[] => [...values].toSorted();
const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const serializeImpact = (impact: PredictedTaskImpact) => ({
  ...impact,
  projectsRead: sorted(impact.projectsRead),
  projectsWritten: sorted(impact.projectsWritten),
  explicitProjectsWritten: sorted(impact.explicitProjectsWritten),
  filesRead: sorted(impact.filesRead),
  filesWritten: sorted(impact.filesWritten),
  explicitFilesWritten: sorted(impact.explicitFilesWritten),
  globFilesWritten: sorted(impact.globFilesWritten),
  symbolDerivedFilesWritten: sorted(impact.symbolDerivedFilesWritten),
  symbolsRead: sorted(impact.symbolsRead),
  symbolsWritten: sorted(impact.symbolsWritten),
  sharedResources: sorted(impact.sharedResources),
  sharedResourceAccesses: impact.sharedResourceAccesses
    .map((access) => ({
      ...access,
      modes: [...new Set(access.modes)].toSorted()
    }))
    .toSorted((left, right) => compareText(canonicalPlanJson(left), canonicalPlanJson(right))),
  downstreamProjects: sorted(impact.downstreamProjects),
  riskSignals: [...impact.riskSignals].toSorted((left, right) =>
    compareText(canonicalPlanJson(left), canonicalPlanJson(right))
  )
});

const graphFacts = (graph: RepositoryGraph): unknown => ({
  projects: [...graph.projects.values()]
    .toSorted((left, right) => compareText(left.id, right.id))
    .map((project) => ({
      ...project,
      dependencies: [...project.dependencies].toSorted((left, right) =>
        compareText(canonicalPlanJson(left), canonicalPlanJson(right))
      ),
      scripts: Object.fromEntries(
        Object.entries(project.scripts).toSorted(([left], [right]) => compareText(left, right))
      ),
      sourceRoots: [...project.sourceRoots].toSorted(),
      tsconfigPaths: [...project.tsconfigPaths].toSorted()
    })),
  projectDependencies: [...graph.projectDependencies]
    .map((edge) => ({ ...edge, sources: [...edge.sources].toSorted() }))
    .toSorted((left, right) => compareText(canonicalPlanJson(left), canonicalPlanJson(right))),
  files: [...graph.files.values()].toSorted((left, right) => compareText(left.id, right.id)),
  symbols: [...graph.symbols.values()].toSorted((left, right) => compareText(left.id, right.id)),
  fileDependencies: [...graph.fileDependencies].toSorted((left, right) =>
    compareText(canonicalPlanJson(left), canonicalPlanJson(right))
  ),
  symbolReferences: [...graph.symbolReferences].toSorted((left, right) =>
    compareText(canonicalPlanJson(left), canonicalPlanJson(right))
  ),
  diagnostics: [...graph.diagnostics]
    .map((diagnostic) => ({
      ...diagnostic,
      configPaths: [...diagnostic.configPaths].toSorted(),
      ...(diagnostic.filePaths === undefined
        ? {}
        : { filePaths: [...diagnostic.filePaths].toSorted() })
    }))
    .toSorted((left, right) => compareText(canonicalPlanJson(left), canonicalPlanJson(right)))
});

export const repositoryFactsFingerprint = (graph: RepositoryGraph): string =>
  fingerprintPlanValue(graphFacts(graph));

const artifactPayload = (artifact: unknown): unknown => artifact;

export const createPlanArtifact = (request: CreatePlanArtifactRequest): PlanArtifact => {
  const source = planningSourceSchema.parse(request.source);
  const repositorySnapshot = repositorySnapshotSchema.parse(request.repositorySnapshot);
  const decision = {
    attempts: request.preparedPlan.attempts,
    specification: request.preparedPlan.specification,
    impacts: request.preparedPlan.impacts
      .map(serializeImpact)
      .toSorted((left, right) => compareText(left.taskId, right.taskId)),
    hardConflicts: [...request.preparedPlan.hardConflicts],
    riskConflicts: [...request.preparedPlan.riskConflicts],
    executionPlan: request.preparedPlan.executionPlan,
    schedule: request.preparedPlan.schedule,
    semanticReview: request.preparedPlan.semanticReview
  };
  const payload = {
    schemaVersion: 1 as const,
    artifactId: request.artifactId,
    revision: request.revision,
    createdAt: request.createdAt,
    source,
    sourceFingerprint: fingerprintPlanValue(source),
    repository: {
      ...repositorySnapshot,
      factsFingerprint: repositoryFactsFingerprint(request.repository)
    },
    authority: {
      sharedResourcePolicyFingerprint: fingerprintPlanValue(request.sharedResourcePolicy),
      verificationPolicyFingerprint: fingerprintPlanValue(request.verificationPolicy),
      codeReviewPolicyFingerprint: fingerprintPlanValue(request.codeReviewPolicy)
    },
    decision
  };
  return planArtifactSchema.parse({
    ...payload,
    planFingerprint: fingerprintPlanValue(artifactPayload(payload))
  });
};

export const parsePlanArtifact = (candidate: unknown): PlanArtifact => {
  const artifact = planArtifactSchema.parse(candidate);
  if (artifact.sourceFingerprint !== fingerprintPlanValue(artifact.source)) {
    throw new PlanArtifactIntegrityError('Plan source fingerprint does not match its content');
  }
  const { planFingerprint, ...payload } = artifact;
  if (planFingerprint !== fingerprintPlanValue(artifactPayload(payload))) {
    throw new PlanArtifactIntegrityError('Plan fingerprint does not match artifact content');
  }
  return artifact;
};

export const repositoryBindingMismatches = (
  artifact: PlanArtifact,
  snapshot: RepositorySnapshot,
  graph: RepositoryGraph
): readonly RepositoryBindingMismatch[] => {
  const mismatches: RepositoryBindingMismatch[] = [];
  if (artifact.repository.repositoryId !== snapshot.repositoryId) {
    mismatches.push('repository-id');
  }
  if (artifact.repository.repositoryRoot !== snapshot.repositoryRoot) {
    mismatches.push('repository-root');
  }
  if (artifact.repository.baseCommit !== snapshot.baseCommit) {
    mismatches.push('base-commit');
  }
  if (artifact.repository.workingTreeFingerprint !== snapshot.workingTreeFingerprint) {
    mismatches.push('working-tree');
  }
  if (artifact.repository.dirty !== snapshot.dirty) {
    mismatches.push('repository-dirty-state');
  }
  if (artifact.repository.factsFingerprint !== repositoryFactsFingerprint(graph)) {
    mismatches.push('repository-facts');
  }
  return mismatches;
};

export const assertStableRepositorySnapshot = (
  before: RepositorySnapshot,
  after: RepositorySnapshot
): RepositorySnapshot => {
  if (
    before.repositoryId !== after.repositoryId ||
    before.repositoryRoot !== after.repositoryRoot ||
    before.baseCommit !== after.baseCommit ||
    before.workingTreeFingerprint !== after.workingTreeFingerprint ||
    before.dirty !== after.dirty
  ) {
    throw new RepositorySnapshotChangedError();
  }
  return after;
};
