import type { HardTaskConflict, RiskTaskConflict } from './conflict.js';
import type { TaskContract } from './task-contract.js';
import type { TaskState } from './task-state.js';

export interface ExecutionWave {
  readonly index: number;
  readonly taskIds: readonly string[];
  readonly reason?: string;
}

export interface ExecutionPlan {
  readonly waves: readonly ExecutionWave[];
}

export interface ScheduleOptions {
  readonly maxConcurrency: number;
}

export type SchedulerEventType =
  | 'task-completed'
  | 'task-failed'
  | 'lease-released'
  | 'lease-blocked'
  | 'lease-stale'
  | 'runtime-conflict-discovered'
  | 'workspace-integrated'
  | 'verification-completed';

export interface SchedulerEvent {
  readonly type: SchedulerEventType;
  readonly taskId: string;
}

export interface SchedulerSnapshot {
  readonly taskStates: ReadonlyMap<string, TaskState>;
  readonly runningTaskIds: ReadonlySet<string>;
}

export interface SchedulerDecision {
  readonly startTaskIds: readonly string[];
  readonly blockedTaskIds: readonly string[];
  readonly reasons: readonly string[];
}

export interface Scheduler {
  createInitialPlan(
    tasks: readonly TaskContract[],
    hardConflicts: readonly HardTaskConflict[],
    riskConflicts: readonly RiskTaskConflict[],
    options: ScheduleOptions
  ): ExecutionPlan;
  reevaluate(
    event: SchedulerEvent,
    snapshot: SchedulerSnapshot,
    tasks: readonly TaskContract[],
    hardConflicts: readonly HardTaskConflict[],
    riskConflicts: readonly RiskTaskConflict[],
    options: ScheduleOptions
  ): SchedulerDecision;
}
