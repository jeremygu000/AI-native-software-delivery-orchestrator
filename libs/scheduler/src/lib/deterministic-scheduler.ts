import {
  type HardTaskConflict,
  type RiskTaskConflict,
  type Scheduler,
  type SchedulerDecision,
  type SchedulerDecisionReason,
  type SchedulerEvent,
  type SchedulerRuntimeBlocker,
  type SchedulerSnapshot,
  type SchedulerTaskDecision,
  type ScheduleOptions,
  type TaskContract,
  type TaskState,
  SchedulerInputError,
  scheduleOptionsSchema,
  schedulerEventSchema,
  schedulerSnapshotSchema
} from '@ai-native-software-delivery-orchestrator/domain';
import { validateTaskGraph } from '@ai-native-software-delivery-orchestrator/dag';

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const compareTasks = (a: TaskContract, b: TaskContract): number => {
  const priorityDifference = (b.priority ?? 0) - (a.priority ?? 0);
  return priorityDifference === 0 ? compareIds(a.id, b.id) : priorityDifference;
};

const terminalStates = new Set<TaskState>(['COMPLETED', 'FAILED', 'CANCELLED']);
const runnableStates = new Set<TaskState>(['PENDING', 'READY']);

type CancellableTaskState = Exclude<TaskState, 'COMPLETED' | 'FAILED' | 'CANCELLED'>;

const isCancellableTaskState = (state: TaskState): state is CancellableTaskState =>
  !terminalStates.has(state);

const isDeferringRisk = (
  conflict: RiskTaskConflict
): conflict is RiskTaskConflict & { readonly recommendedAction: 'stagger' | 'serialize' } =>
  conflict.recommendedAction === 'stagger' || conflict.recommendedAction === 'serialize';

const isAllowedRisk = (
  conflict: RiskTaskConflict
): conflict is RiskTaskConflict & { readonly recommendedAction: 'parallel' | 'guarded-parallel' } =>
  conflict.recommendedAction === 'parallel' || conflict.recommendedAction === 'guarded-parallel';

const sameRuntimeBlocker = (a: SchedulerRuntimeBlocker, b: SchedulerRuntimeBlocker): boolean => {
  switch (a.type) {
    case 'lease':
      return b.type === 'lease' && a.leaseId === b.leaseId;
    case 'runtime-conflict':
      return b.type === 'runtime-conflict' && a.conflictId === b.conflictId;
  }
  return false;
};

interface SchedulingInputs {
  readonly taskById: ReadonlyMap<string, TaskContract>;
  readonly hardConflicts: readonly HardTaskConflict[];
  readonly riskConflicts: readonly RiskTaskConflict[];
  readonly options: ScheduleOptions;
}

const toTaskStateMap = (snapshot: SchedulerSnapshot): Map<string, TaskState> => {
  const taskStates = new Map<string, TaskState>();
  for (const taskState of snapshot.taskStates) {
    if (taskStates.has(taskState.taskId)) {
      throw new SchedulerInputError(`Duplicate snapshot task state: ${taskState.taskId}`);
    }
    taskStates.set(taskState.taskId, taskState.state);
  }
  return taskStates;
};

const toRuntimeBlockMap = (
  snapshot: SchedulerSnapshot,
  taskStates: ReadonlyMap<string, TaskState>
): Map<string, SchedulerRuntimeBlocker[]> => {
  const blocks = new Map<string, SchedulerRuntimeBlocker[]>();
  for (const runtimeBlock of snapshot.runtimeBlocks) {
    if (blocks.has(runtimeBlock.taskId)) {
      throw new SchedulerInputError(`Duplicate runtime block record: ${runtimeBlock.taskId}`);
    }
    if (taskStates.get(runtimeBlock.taskId) !== 'BLOCKED') {
      throw new SchedulerInputError(`Runtime block requires BLOCKED state: ${runtimeBlock.taskId}`);
    }
    blocks.set(runtimeBlock.taskId, [...runtimeBlock.blockers]);
  }
  return blocks;
};

const matchesPair = (
  taskId: string,
  conflict: HardTaskConflict | RiskTaskConflict
): string | undefined =>
  conflict.taskA === taskId
    ? conflict.taskB
    : conflict.taskB === taskId
      ? conflict.taskA
      : undefined;

const producerIdsFor = (
  taskId: string,
  conflicts: readonly HardTaskConflict[]
): readonly string[] =>
  conflicts
    .flatMap((conflict) =>
      conflict.constraints.flatMap((constraint) =>
        constraint.type === 'producer-consumer' && constraint.consumerTaskId === taskId
          ? [constraint.producerTaskId]
          : []
      )
    )
    .toSorted(compareIds);

const dependentIdsByTask = (
  tasks: ReadonlyMap<string, TaskContract>,
  conflicts: readonly HardTaskConflict[]
): ReadonlyMap<string, readonly string[]> => {
  const dependents = new Map<string, Set<string>>();
  for (const task of tasks.values()) {
    for (const dependencyId of task.dependencies) {
      const ids = dependents.get(dependencyId) ?? new Set<string>();
      ids.add(task.id);
      dependents.set(dependencyId, ids);
    }
  }
  for (const conflict of conflicts) {
    for (const constraint of conflict.constraints) {
      if (constraint.type === 'producer-consumer') {
        const ids = dependents.get(constraint.producerTaskId) ?? new Set<string>();
        ids.add(constraint.consumerTaskId);
        dependents.set(constraint.producerTaskId, ids);
      }
    }
  }
  return new Map([...dependents].map(([taskId, ids]) => [taskId, [...ids].toSorted(compareIds)]));
};

const hasSchedulingCycle = (
  tasks: ReadonlyMap<string, TaskContract>,
  conflicts: readonly HardTaskConflict[]
): boolean => {
  const remainingDependencies = new Map<string, number>();
  const dependentsByTask = new Map<string, Set<string>>();
  for (const task of tasks.values()) {
    remainingDependencies.set(task.id, task.dependencies.length);
    for (const dependencyId of task.dependencies) {
      const dependents = dependentsByTask.get(dependencyId) ?? new Set<string>();
      dependents.add(task.id);
      dependentsByTask.set(dependencyId, dependents);
    }
  }
  for (const conflict of conflicts) {
    for (const constraint of conflict.constraints) {
      if (constraint.type !== 'producer-consumer') {
        continue;
      }
      const dependents = dependentsByTask.get(constraint.producerTaskId) ?? new Set<string>();
      if (!dependents.has(constraint.consumerTaskId)) {
        dependents.add(constraint.consumerTaskId);
        dependentsByTask.set(constraint.producerTaskId, dependents);
        remainingDependencies.set(
          constraint.consumerTaskId,
          (remainingDependencies.get(constraint.consumerTaskId) ?? 0) + 1
        );
      }
    }
  }
  const ready = [...remainingDependencies]
    .flatMap(([taskId, dependencyCount]) => (dependencyCount === 0 ? [taskId] : []))
    .toSorted(compareIds);
  let processed = 0;
  while (ready.length > 0) {
    const taskId = ready.shift()!;
    processed += 1;
    for (const dependentId of dependentsByTask.get(taskId) ?? []) {
      const dependencyCount = remainingDependencies.get(dependentId)! - 1;
      remainingDependencies.set(dependentId, dependencyCount);
      if (dependencyCount === 0) {
        ready.push(dependentId);
        ready.sort(compareIds);
      }
    }
  }
  return processed !== tasks.size;
};

const asReason = <T extends SchedulerDecisionReason>(reason: T): T => reason;

export class DeterministicScheduler implements Scheduler {
  createInitialPlan(
    tasks: readonly TaskContract[],
    hardConflicts: readonly HardTaskConflict[],
    riskConflicts: readonly RiskTaskConflict[],
    options: ScheduleOptions
  ) {
    const inputs = this.#validateInputs(tasks, hardConflicts, riskConflicts, options);
    const states: Map<string, TaskState> = new Map(
      [...inputs.taskById.keys()].map((taskId) => [taskId, 'PENDING'])
    );
    const waves: string[][] = [];

    while ([...states.values()].some((state) => state === 'PENDING')) {
      const selected = this.#select(states, new Map(), inputs).startTaskIds;
      if (selected.length === 0) {
        throw new SchedulerInputError('Initial plan cannot make progress');
      }
      for (const taskId of selected) {
        states.set(taskId, 'COMPLETED');
      }
      waves.push([...selected]);
    }

    return { waves: waves.map((taskIds, index) => ({ index, taskIds })) };
  }

  reevaluate(
    event: SchedulerEvent,
    snapshot: SchedulerSnapshot,
    tasks: readonly TaskContract[],
    hardConflicts: readonly HardTaskConflict[],
    riskConflicts: readonly RiskTaskConflict[],
    options: ScheduleOptions
  ): SchedulerDecision {
    const inputs = this.#validateInputs(tasks, hardConflicts, riskConflicts, options);
    const parsedEvent = schedulerEventSchema.parse(event);
    const parsedSnapshot = schedulerSnapshotSchema.parse(snapshot);
    const states = toTaskStateMap(parsedSnapshot);
    const blocks = toRuntimeBlockMap(parsedSnapshot, states);
    const decisions: SchedulerTaskDecision[] = [];

    if ('taskId' in parsedEvent && !inputs.taskById.has(parsedEvent.taskId)) {
      throw new SchedulerInputError(`Unknown scheduler event task: ${parsedEvent.taskId}`);
    }
    this.#validateSnapshotTaskIds(states, inputs.taskById);
    if (
      'taskId' in parsedEvent &&
      'state' in parsedEvent &&
      states.get(parsedEvent.taskId) !== parsedEvent.state
    ) {
      throw new SchedulerInputError(
        `${parsedEvent.type} event requires ${parsedEvent.state} snapshot state: ${parsedEvent.taskId}`
      );
    }
    this.#applyRuntimeEvent(parsedEvent, states, blocks, decisions);
    this.#cancelTerminalDependants(parsedEvent, states, inputs, decisions);

    const selection = this.#select(states, blocks, inputs);
    decisions.push(...selection.decisions);
    return { taskDecisions: decisions };
  }

  #validateInputs(
    tasks: readonly TaskContract[],
    hardConflicts: readonly HardTaskConflict[],
    riskConflicts: readonly RiskTaskConflict[],
    options: ScheduleOptions
  ): SchedulingInputs {
    const validation = validateTaskGraph(tasks);
    if (!validation.valid) {
      throw new SchedulerInputError(
        `Invalid task graph: ${validation.issues.map((issue) => issue.type).join(', ')}`
      );
    }
    const parsedOptions = scheduleOptionsSchema.parse(options);
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    for (const conflict of [...hardConflicts, ...riskConflicts]) {
      if (
        !taskById.has(conflict.taskA) ||
        !taskById.has(conflict.taskB) ||
        conflict.taskA === conflict.taskB
      ) {
        throw new SchedulerInputError(
          `Invalid conflict task pair: ${conflict.taskA}, ${conflict.taskB}`
        );
      }
      if (conflict.severity === 'hard') {
        for (const constraint of conflict.constraints) {
          if (constraint.type !== 'producer-consumer') {
            continue;
          }
          if (
            !taskById.has(constraint.producerTaskId) ||
            !taskById.has(constraint.consumerTaskId) ||
            constraint.producerTaskId === constraint.consumerTaskId ||
            ![conflict.taskA, conflict.taskB].includes(constraint.producerTaskId) ||
            ![conflict.taskA, conflict.taskB].includes(constraint.consumerTaskId)
          ) {
            throw new SchedulerInputError(
              `Invalid producer-consumer constraint: ${constraint.producerTaskId}, ${constraint.consumerTaskId}`
            );
          }
        }
      }
    }
    if (hasSchedulingCycle(taskById, hardConflicts)) {
      throw new SchedulerInputError(
        'Functional and producer scheduling constraints contain a cycle'
      );
    }
    return { taskById, hardConflicts, riskConflicts, options: parsedOptions };
  }

  #validateSnapshotTaskIds(
    states: ReadonlyMap<string, TaskState>,
    tasks: ReadonlyMap<string, TaskContract>
  ): void {
    for (const taskId of tasks.keys()) {
      if (!states.has(taskId)) {
        throw new SchedulerInputError(`Missing snapshot task state: ${taskId}`);
      }
    }
    for (const taskId of states.keys()) {
      if (!tasks.has(taskId)) {
        throw new SchedulerInputError(`Unknown snapshot task: ${taskId}`);
      }
    }
  }

  #applyRuntimeEvent(
    event: SchedulerEvent,
    states: Map<string, TaskState>,
    blocks: Map<string, SchedulerRuntimeBlocker[]>,
    decisions: SchedulerTaskDecision[]
  ): void {
    if (!('taskId' in event)) {
      return;
    }
    const blocker =
      event.type === 'lease-blocked'
        ? { type: 'lease' as const, leaseId: event.leaseId }
        : event.type === 'runtime-conflict-discovered'
          ? { type: 'runtime-conflict' as const, conflictId: event.conflictId }
          : undefined;
    if (blocker !== undefined) {
      const state = states.get(event.taskId);
      if (state === 'BLOCKED') {
        const taskBlockers = blocks.get(event.taskId);
        if (taskBlockers === undefined) {
          throw new SchedulerInputError(
            `BLOCKED task is missing runtime blockers: ${event.taskId}`
          );
        }
        if (!taskBlockers.some((taskBlocker) => sameRuntimeBlocker(taskBlocker, blocker))) {
          blocks.set(event.taskId, [...taskBlockers, blocker]);
        }
        return;
      }
      if (state !== 'RUNNING') {
        throw new SchedulerInputError(`Runtime block requires RUNNING state: ${event.taskId}`);
      }
      states.set(event.taskId, 'BLOCKED');
      blocks.set(event.taskId, [blocker]);
      decisions.push({
        taskId: event.taskId,
        action: 'block',
        fromState: 'RUNNING',
        toState: 'BLOCKED',
        reasons: [asReason({ type: 'runtime-blocked', blockers: [blocker] })]
      });
      return;
    }

    const releasedBlocker =
      event.type === 'lease-released' || event.type === 'lease-stale'
        ? { type: 'lease' as const, leaseId: event.leaseId }
        : event.type === 'runtime-conflict-resolved'
          ? { type: 'runtime-conflict' as const, conflictId: event.conflictId }
          : undefined;
    if (releasedBlocker === undefined) {
      return;
    }
    for (const [taskId, taskBlockers] of [...blocks].toSorted(([a], [b]) => compareIds(a, b))) {
      const remaining = taskBlockers.filter(
        (taskBlocker) => !sameRuntimeBlocker(taskBlocker, releasedBlocker)
      );
      if (remaining.length > 0) {
        blocks.set(taskId, remaining);
        continue;
      }
      blocks.delete(taskId);
      if (states.get(taskId) === 'BLOCKED') {
        states.set(taskId, 'READY');
        decisions.push({
          taskId,
          action: 'unblock',
          fromState: 'BLOCKED',
          toState: 'READY',
          reasons: [asReason({ type: 'runtime-blocker-released', blockers: [releasedBlocker] })]
        });
      }
    }
  }

  #cancelTerminalDependants(
    event: SchedulerEvent,
    states: Map<string, TaskState>,
    inputs: SchedulingInputs,
    decisions: SchedulerTaskDecision[]
  ): void {
    const terminalCauses = new Map<string, 'FAILED' | 'CANCELLED'>();
    for (const [taskId, state] of states) {
      if (state === 'FAILED' || state === 'CANCELLED') {
        terminalCauses.set(taskId, state);
      }
    }
    const dependents = dependentIdsByTask(inputs.taskById, inputs.hardConflicts);
    const terminalCausesByTask = new Map<string, Map<string, 'FAILED' | 'CANCELLED'>>();
    const queue = [...terminalCauses]
      .toSorted(([a], [b]) => compareIds(a, b))
      .map(([taskId, state]) => ({ taskId, causeTaskId: taskId, causeState: state }));
    while (queue.length > 0) {
      const { taskId, causeTaskId, causeState } = queue.shift()!;
      for (const dependentId of dependents.get(taskId) ?? []) {
        if (terminalStates.has(states.get(dependentId)!)) {
          continue;
        }
        const causes =
          terminalCausesByTask.get(dependentId) ?? new Map<string, 'FAILED' | 'CANCELLED'>();
        if (causes.has(causeTaskId)) {
          continue;
        }
        causes.set(causeTaskId, causeState);
        terminalCausesByTask.set(dependentId, causes);
        queue.push({ taskId: dependentId, causeTaskId, causeState });
      }
    }
    for (const taskId of [...terminalCausesByTask.keys()].toSorted(compareIds)) {
      const fromState = states.get(taskId)!;
      if (!isCancellableTaskState(fromState)) {
        continue;
      }
      states.set(taskId, 'CANCELLED');
      const causes = terminalCausesByTask.get(taskId)!;
      const failedTaskIds = [...causes]
        .flatMap(([causeTaskId, state]) => (state === 'FAILED' ? [causeTaskId] : []))
        .toSorted(compareIds);
      const cancelledTaskIds = [...causes]
        .flatMap(([causeTaskId, state]) => (state === 'CANCELLED' ? [causeTaskId] : []))
        .toSorted(compareIds);
      decisions.push({
        taskId,
        action: 'cancel',
        fromState,
        toState: 'CANCELLED',
        reasons: [
          ...(failedTaskIds.length > 0
            ? [asReason({ type: 'dependency-failed' as const, failedTaskIds })]
            : []),
          ...(cancelledTaskIds.length > 0
            ? [asReason({ type: 'dependency-cancelled' as const, cancelledTaskIds })]
            : [])
        ]
      });
    }
  }

  #select(
    states: Map<string, TaskState>,
    blocks: ReadonlyMap<string, readonly SchedulerRuntimeBlocker[]>,
    inputs: SchedulingInputs
  ): {
    readonly startTaskIds: readonly string[];
    readonly decisions: readonly SchedulerTaskDecision[];
  } {
    const decisions: SchedulerTaskDecision[] = [];
    const selected: string[] = [];
    const runningTaskIds = [...states]
      .flatMap(([taskId, state]) => (state === 'RUNNING' ? [taskId] : []))
      .toSorted(compareIds);
    const candidateTasks: TaskContract[] = [];

    for (const task of [...inputs.taskById.values()].toSorted(compareTasks)) {
      const state = states.get(task.id)!;
      if (terminalStates.has(state) || state === 'RUNNING') {
        continue;
      }
      const runtimeBlockers = blocks.get(task.id);
      if (state === 'BLOCKED' || runtimeBlockers !== undefined) {
        if (runtimeBlockers === undefined) {
          throw new SchedulerInputError(`BLOCKED task is missing runtime blockers: ${task.id}`);
        }
        decisions.push({
          taskId: task.id,
          action: 'defer',
          reasons: [asReason({ type: 'runtime-blocked', blockers: [...runtimeBlockers] })]
        });
        continue;
      }
      if (!runnableStates.has(state)) {
        decisions.push({
          taskId: task.id,
          action: 'defer',
          reasons: [asReason({ type: 'task-state-not-runnable', taskState: state })]
        });
        continue;
      }
      const incompleteDependencies = task.dependencies.filter(
        (dependencyId) => states.get(dependencyId) !== 'COMPLETED'
      );
      if (incompleteDependencies.length > 0) {
        decisions.push({
          taskId: task.id,
          action: 'defer',
          reasons: [
            asReason({
              type: 'dependency-incomplete',
              dependencyTaskIds: incompleteDependencies.toSorted(compareIds)
            })
          ]
        });
        continue;
      }
      const incompleteProducers = producerIdsFor(task.id, inputs.hardConflicts).filter(
        (producerTaskId) => states.get(producerTaskId) !== 'COMPLETED'
      );
      if (incompleteProducers.length > 0) {
        decisions.push({
          taskId: task.id,
          action: 'defer',
          reasons: [
            asReason({
              type: 'producer-must-complete',
              producerTaskIds: incompleteProducers.toSorted(compareIds)
            })
          ]
        });
        continue;
      }
      candidateTasks.push(task);
    }

    for (const task of candidateTasks) {
      const activeTaskIds = [...runningTaskIds, ...selected];
      if (activeTaskIds.length >= inputs.options.maxConcurrency) {
        decisions.push({
          taskId: task.id,
          action: 'defer',
          reasons: [
            asReason({
              type: 'max-concurrency-reached',
              maxConcurrency: inputs.options.maxConcurrency,
              runningTaskIds: activeTaskIds.toSorted(compareIds)
            })
          ]
        });
        continue;
      }
      const hardConflicts = inputs.hardConflicts.filter((conflict) => {
        const otherTaskId = matchesPair(task.id, conflict);
        return otherTaskId !== undefined && activeTaskIds.includes(otherTaskId);
      });
      if (hardConflicts.length > 0) {
        decisions.push({
          taskId: task.id,
          action: 'defer',
          reasons: [
            asReason({
              type: 'hard-conflict',
              conflictingTaskIds: hardConflicts
                .flatMap((conflict) => matchesPair(task.id, conflict))
                .filter((taskId): taskId is string => taskId !== undefined)
                .toSorted(compareIds),
              constraintTypes: hardConflicts
                .flatMap((conflict) => conflict.constraints.map((constraint) => constraint.type))
                .toSorted(compareIds)
            })
          ]
        });
        continue;
      }
      const activeRisks = inputs.riskConflicts.filter((conflict) => {
        const otherTaskId = matchesPair(task.id, conflict);
        return otherTaskId !== undefined && activeTaskIds.includes(otherTaskId);
      });
      const deferringRisks = activeRisks.filter(isDeferringRisk);
      if (deferringRisks.length > 0) {
        decisions.push({
          taskId: task.id,
          action: 'defer',
          reasons: [
            asReason({
              type: 'risk-policy-deferred',
              conflictingTaskIds: deferringRisks
                .flatMap((conflict) => matchesPair(task.id, conflict))
                .filter((taskId): taskId is string => taskId !== undefined)
                .toSorted(compareIds),
              recommendedActions: deferringRisks
                .map((conflict) => conflict.recommendedAction)
                .toSorted(compareIds)
            })
          ]
        });
        continue;
      }
      if (states.get(task.id) === 'PENDING') {
        decisions.push({
          taskId: task.id,
          action: 'ready',
          fromState: 'PENDING',
          toState: 'READY',
          reasons: [
            asReason({ type: 'dependencies-completed', dependencyTaskIds: task.dependencies })
          ]
        });
      }
      decisions.push({
        taskId: task.id,
        action: 'start',
        fromState: 'READY',
        toState: 'RUNNING',
        reasons: [
          asReason({ type: 'selected-by-priority', priority: task.priority ?? 0 }),
          ...activeRisks.filter(isAllowedRisk).map((conflict) =>
            asReason({
              type: 'risk-policy-allowed' as const,
              conflictingTaskIds: [matchesPair(task.id, conflict)!],
              recommendedActions: [conflict.recommendedAction]
            })
          )
        ]
      });
      selected.push(task.id);
    }
    return { startTaskIds: selected, decisions };
  }
}
