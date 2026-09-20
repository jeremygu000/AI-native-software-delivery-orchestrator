import { areWritableResourcesConflicting } from '@ai-native-software-delivery-orchestrator/domain';
import type {
  HardTaskConflict,
  TaskLeasePlan,
  WritableResource
} from '@ai-native-software-delivery-orchestrator/domain';

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const resourceId = (resource: WritableResource): string =>
  resource.type === 'shared-resource'
    ? resource.resourceId
    : resource.type === 'project'
      ? resource.projectId
      : resource.fileId;

/**
 * Turns observed write-scope expansion into deterministic hard conflicts against
 * other persisted task lease plans. The caller atomically assigns the effective
 * scheduler sequence when recording these runtime discoveries.
 */
export const runtimeScopeExpansionConflicts = (request: {
  readonly taskId: string;
  readonly expandedResources: readonly WritableResource[];
  readonly bindings: readonly { readonly taskId: string; readonly leasePlan: TaskLeasePlan }[];
  readonly existingHardConflicts: readonly HardTaskConflict[];
}): readonly HardTaskConflict[] => {
  const conflicts: HardTaskConflict[] = [];
  for (const binding of [...request.bindings]
    .filter((candidate) => candidate.taskId !== request.taskId)
    .toSorted((left, right) => compareIds(left.taskId, right.taskId))) {
    const conflictingResources = request.expandedResources.filter((resource) =>
      binding.leasePlan.predictedResources.some((otherResource) =>
        areWritableResourcesConflicting(resource, otherResource)
      )
    );
    if (conflictingResources.length === 0) {
      continue;
    }
    const [taskA, taskB] = [request.taskId, binding.taskId].toSorted(compareIds);
    if (
      request.existingHardConflicts.some(
        (conflict) =>
          conflict.taskA === taskA &&
          conflict.taskB === taskB &&
          conflict.constraints.some((constraint) => constraint.type === 'runtime-scope-expansion')
      )
    ) {
      continue;
    }
    const resourceIds = conflictingResources.map(resourceId).toSorted(compareIds);
    conflicts.push({
      taskA,
      taskB,
      score: 100,
      severity: 'hard',
      reasons: [
        {
          type: 'same-file',
          score: 100,
          detail: 'Observed runtime scope conflicts with another task lease-plan resource.',
          resourceIds
        }
      ],
      constraints: [
        {
          type: 'runtime-scope-expansion',
          detail: 'Observed runtime scope expansion must be reconciled before future dispatch.',
          resourceIds
        }
      ],
      recommendedAction: 'serialize'
    });
  }
  return conflicts;
};
