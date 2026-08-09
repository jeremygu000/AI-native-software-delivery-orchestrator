import type { TaskContract } from '@ai-native-software-delivery-orchestrator/domain';

export type TaskGraphIssue =
  | {
      readonly type: 'duplicate-task';
      readonly taskId: string;
    }
  | {
      readonly type: 'duplicate-dependency';
      readonly taskId: string;
      readonly dependencyId: string;
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

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const compareTasks = (a: TaskContract, b: TaskContract): number => {
  const priorityDifference = (b.priority ?? 0) - (a.priority ?? 0);
  return priorityDifference !== 0 ? priorityDifference : compareIds(a.id, b.id);
};

class TaskPriorityQueue {
  readonly #tasks: TaskContract[] = [];

  get size(): number {
    return this.#tasks.length;
  }

  enqueue(task: TaskContract): void {
    this.#tasks.push(task);
    let index = this.#tasks.length - 1;

    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      const parent = this.#tasks[parentIndex];
      if (compareTasks(parent, task) <= 0) {
        break;
      }
      this.#tasks[index] = parent;
      index = parentIndex;
    }

    this.#tasks[index] = task;
  }

  dequeue(): TaskContract {
    const first = this.#tasks[0];
    const last = this.#tasks.pop()!;
    if (this.#tasks.length === 0) {
      return first;
    }

    let index = 0;
    while (true) {
      const leftIndex = index * 2 + 1;
      const rightIndex = leftIndex + 1;
      const left = this.#tasks[leftIndex];
      if (left === undefined) {
        break;
      }
      const right = this.#tasks[rightIndex];
      const nextIndex =
        right !== undefined && compareTasks(right, left) < 0 ? rightIndex : leftIndex;
      const next = this.#tasks[nextIndex];
      if (compareTasks(next, last) >= 0) {
        break;
      }

      this.#tasks[index] = next;
      index = nextIndex;
    }

    this.#tasks[index] = last;
    return first;
  }
}

const buildUniqueTaskMap = (tasks: readonly TaskContract[]): Map<string, TaskContract> => {
  const taskById = new Map<string, TaskContract>();
  for (const task of tasks) {
    if (!taskById.has(task.id)) {
      taskById.set(task.id, task);
    }
  }
  return taskById;
};

const buildAdjacency = (
  taskById: ReadonlyMap<string, TaskContract>
): ReadonlyMap<string, readonly string[]> => {
  const adjacency = new Map<string, readonly string[]>();
  for (const taskId of [...taskById.keys()].toSorted(compareIds)) {
    const task = taskById.get(taskId)!;
    const dependencies = new Set(
      task.dependencies.filter(
        (dependencyId) => dependencyId !== taskId && taskById.has(dependencyId)
      )
    );
    adjacency.set(taskId, [...dependencies].toSorted(compareIds));
  }
  return adjacency;
};

interface TraversalFrame {
  readonly taskId: string;
  nextDependencyIndex: number;
}

const buildFinishingOrder = (
  taskIds: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>
): readonly string[] => {
  const visited = new Set<string>();
  const finishingOrder: string[] = [];

  for (const startTaskId of taskIds) {
    if (visited.has(startTaskId)) {
      continue;
    }

    visited.add(startTaskId);
    const stack: TraversalFrame[] = [{ taskId: startTaskId, nextDependencyIndex: 0 }];

    while (stack.length > 0) {
      const frame = stack.at(-1)!;
      const dependencies = adjacency.get(frame.taskId) ?? [];
      const dependencyId = dependencies[frame.nextDependencyIndex];
      if (dependencyId !== undefined) {
        frame.nextDependencyIndex += 1;
        if (!visited.has(dependencyId)) {
          visited.add(dependencyId);
          stack.push({ taskId: dependencyId, nextDependencyIndex: 0 });
        }
        continue;
      }

      finishingOrder.push(frame.taskId);
      stack.pop();
    }
  }

  return finishingOrder;
};

const reverseAdjacency = (
  taskIds: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>
): ReadonlyMap<string, readonly string[]> => {
  const reversed = new Map(taskIds.map((taskId) => [taskId, [] as string[]]));
  for (const [taskId, dependencies] of adjacency) {
    for (const dependencyId of dependencies) {
      reversed.get(dependencyId)!.push(taskId);
    }
  }
  return new Map(
    [...reversed].map(([taskId, dependents]) => [taskId, dependents.toSorted(compareIds)])
  );
};

const findCycleComponents = (
  taskById: ReadonlyMap<string, TaskContract>
): readonly (readonly string[])[] => {
  const taskIds = [...taskById.keys()].toSorted(compareIds);
  const adjacency = buildAdjacency(taskById);
  const finishingOrder = buildFinishingOrder(taskIds, adjacency);
  const reversed = reverseAdjacency(taskIds, adjacency);
  const visited = new Set<string>();
  const components: string[][] = [];

  for (const startTaskId of finishingOrder.toReversed()) {
    if (visited.has(startTaskId)) {
      continue;
    }

    const component: string[] = [];
    const stack = [startTaskId];
    visited.add(startTaskId);
    while (stack.length > 0) {
      const taskId = stack.pop()!;
      component.push(taskId);
      for (const dependentId of reversed.get(taskId)?.toReversed() ?? []) {
        if (!visited.has(dependentId)) {
          visited.add(dependentId);
          stack.push(dependentId);
        }
      }
    }

    if (component.length > 1) {
      components.push(component.toSorted(compareIds));
    }
  }

  return components.toSorted((a, b) => compareIds(a[0], b[0]));
};

export const validateTaskGraph = (tasks: readonly TaskContract[]): TaskGraphValidationResult => {
  const issues: TaskGraphIssue[] = [];
  const taskById = buildUniqueTaskMap(tasks);
  const taskCounts = new Map<string, number>();

  for (const task of tasks) {
    taskCounts.set(task.id, (taskCounts.get(task.id) ?? 0) + 1);
  }
  for (const [taskId, count] of [...taskCounts].toSorted(([a], [b]) => compareIds(a, b))) {
    if (count > 1) {
      issues.push({ type: 'duplicate-task', taskId });
    }
  }

  for (const task of [...taskById.values()].toSorted(compareTasks)) {
    const dependencyCounts = new Map<string, number>();
    for (const dependencyId of task.dependencies) {
      dependencyCounts.set(dependencyId, (dependencyCounts.get(dependencyId) ?? 0) + 1);
    }

    for (const [dependencyId, count] of [...dependencyCounts].toSorted(([a], [b]) =>
      compareIds(a, b)
    )) {
      if (count > 1) {
        issues.push({ type: 'duplicate-dependency', taskId: task.id, dependencyId });
      }
      if (dependencyId === task.id) {
        issues.push({ type: 'self-dependency', taskId: task.id });
      } else if (!taskById.has(dependencyId)) {
        issues.push({ type: 'missing-dependency', taskId: task.id, dependencyId });
      }
    }
  }

  for (const taskIds of findCycleComponents(taskById)) {
    issues.push({ type: 'cycle', taskIds });
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

  const ready = new TaskPriorityQueue();
  for (const task of taskById.values()) {
    if (task.dependencies.length === 0) {
      ready.enqueue(task);
    }
  }
  const orderedTaskIds: string[] = [];

  while (ready.size > 0) {
    const task = ready.dequeue();
    orderedTaskIds.push(task.id);

    for (const dependentId of dependentsByTask.get(task.id)?.toSorted(compareIds) ?? []) {
      const dependencyCount = (remainingDependencies.get(dependentId) ?? 0) - 1;
      remainingDependencies.set(dependentId, dependencyCount);
      if (dependencyCount === 0) {
        const dependent = taskById.get(dependentId);
        if (dependent !== undefined) {
          ready.enqueue(dependent);
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
