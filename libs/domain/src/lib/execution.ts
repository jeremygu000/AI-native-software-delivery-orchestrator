import type { TaskConflict } from './conflict.js';
import type { TaskContract } from './task-contract.js';

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
  readonly conflictThreshold: number;
}

export interface Scheduler {
  schedule(
    tasks: readonly TaskContract[],
    conflicts: readonly TaskConflict[],
    options: ScheduleOptions
  ): ExecutionPlan;
}
