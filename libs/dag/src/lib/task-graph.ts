import type { TaskContract } from '@apra-amcos-admin-coding-orchestrator/domain';

export type TaskGraphIssue =
  | {
      readonly type: 'duplicate-task';
      readonly taskId: string;
    }
  | {
      readonly type: 'missing-dependency';
      readonly taskId: string;
      readonly dependencyId: string;
    }
  | {
      readonly type: 'self-dependency';
      readonly taskId: string;
    }
  | {
      readonly type: 'cycle';
      readonly taskIds: readonly string[];
    };

export interface TaskGraphValidationResult {
  readonly valid: boolean;
  readonly issues: readonly TaskGraphIssue[];
}

export class InvalidTaskGraphError extends Error {
  readonly issues: readonly TaskGraphIssue[];

  constructor(issues: readonly TaskGraphIssue[]) {
    super(`Invalid task graph: ${issues.map((issue) => issue.type).join(', ')}`);
    this.name = 'InvalidTaskGraphError';
    this.issues = issues;
  }
}

const compareTasks = (a: TaskContract, b: TaskContract): number => {
  const priorityDifference = (b.priority ?? 0) - (a.priority ?? 0);
  return priorityDifference !== 0 ? priorityDifference : a.id.localeCompare(b.id);
};

const buildUniqueTaskMap = (tasks: readonly TaskContract[]): Map<string, TaskContract> => {
  const taskById = new Map<string, TaskContract>();
  for (const task of tasks) {
    if (!taskById.has(task.id)) {
      taskById.set(task.id, task);
    }
  }
  return taskById;
};

const detectCycle = (
  taskById: ReadonlyMap<string, TaskContract>
): readonly string[] | undefined => {
  const stateByTask = new Map<string, 'visiting' | 'visited'>();
  const stack: string[] = [];

  const visit = (taskId: string): readonly string[] | undefined => {
    const state = stateByTask.get(taskId);
    if (state === 'visiting') {
      const cycleStart = stack.indexOf(taskId);
      return [...stack.slice(cycleStart), taskId];
    }
    if (state === 'visited') {
      return undefined;
    }

    stateByTask.set(taskId, 'visiting');
    stack.push(taskId);

    const task = taskById.get(taskId);
    const dependencies = task?.dependencies.filter((id) => taskById.has(id)).toSorted() ?? [];
    for (const dependencyId of dependencies) {
      const cycle = visit(dependencyId);
      if (cycle !== undefined) {
        return cycle;
      }
    }

    stack.pop();
    stateByTask.set(taskId, 'visited');
    return undefined;
  };

  for (const taskId of [...taskById.keys()].toSorted()) {
    const cycle = visit(taskId);
    if (cycle !== undefined) {
      return cycle;
    }
  }

  return undefined;
};

export const validateTaskGraph = (tasks: readonly TaskContract[]): TaskGraphValidationResult => {
  const issues: TaskGraphIssue[] = [];
  const taskById = buildUniqueTaskMap(tasks);
  const seenTaskIds = new Set<string>();

  for (const task of tasks) {
    if (seenTaskIds.has(task.id)) {
      issues.push({ type: 'duplicate-task', taskId: task.id });
    }
    seenTaskIds.add(task.id);
  }

  for (const task of taskById.values()) {
    for (const dependencyId of task.dependencies) {
      if (dependencyId === task.id) {
        issues.push({ type: 'self-dependency', taskId: task.id });
      } else if (!taskById.has(dependencyId)) {
        issues.push({ type: 'missing-dependency', taskId: task.id, dependencyId });
      }
    }
  }

  const cycle = detectCycle(taskById);
  if (cycle !== undefined) {
    issues.push({ type: 'cycle', taskIds: cycle });
  }

  return { valid: issues.length === 0, issues };
};

const assertValidTaskGraph = (tasks: readonly TaskContract[]): Map<string, TaskContract> => {
  const validation = validateTaskGraph(tasks);
  if (!validation.valid) {
    throw new InvalidTaskGraphError(validation.issues);
  }
  return buildUniqueTaskMap(tasks);
};

export const topologicalSort = (tasks: readonly TaskContract[]): readonly string[] => {
  const taskById = assertValidTaskGraph(tasks);
  const remainingDependencies = new Map<string, number>();
  const dependentsByTask = new Map<string, string[]>();

  for (const task of taskById.values()) {
    remainingDependencies.set(task.id, task.dependencies.length);
    for (const dependencyId of task.dependencies) {
      const dependents = dependentsByTask.get(dependencyId) ?? [];
      dependents.push(task.id);
      dependentsByTask.set(dependencyId, dependents);
    }
  }

  let ready = [...taskById.values()]
    .filter((task) => task.dependencies.length === 0)
    .toSorted(compareTasks);
  const orderedTaskIds: string[] = [];

  while (ready.length > 0) {
    const task = ready.shift();
    if (task === undefined) {
      break;
    }
    orderedTaskIds.push(task.id);

    for (const dependentId of dependentsByTask.get(task.id)?.toSorted() ?? []) {
      const dependencyCount = (remainingDependencies.get(dependentId) ?? 0) - 1;
      remainingDependencies.set(dependentId, dependencyCount);
      if (dependencyCount === 0) {
        const dependent = taskById.get(dependentId);
        if (dependent !== undefined) {
          ready = [...ready, dependent].toSorted(compareTasks);
        }
      }
    }
  }

  return orderedTaskIds;
};

export const getReadyTaskIds = (
  tasks: readonly TaskContract[],
  completedTaskIds: ReadonlySet<string>,
  unavailableTaskIds: ReadonlySet<string> = new Set()
): readonly string[] => {
  assertValidTaskGraph(tasks);

  return tasks
    .filter((task) => !completedTaskIds.has(task.id))
    .filter((task) => !unavailableTaskIds.has(task.id))
    .filter((task) => task.dependencies.every((dependencyId) => completedTaskIds.has(dependencyId)))
    .toSorted(compareTasks)
    .map((task) => task.id);
};
