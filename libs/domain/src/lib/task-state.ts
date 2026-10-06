import { z } from 'zod';

export const taskStateSchema = z.enum([
  'PENDING',
  'READY',
  'RUNNING',
  'BLOCKED',
  'VERIFYING',
  'INTEGRATING',
  'COMPLETED',
  'FAILED',
  'CANCELLED'
]);

export type TaskState = z.infer<typeof taskStateSchema>;
export const TaskState = taskStateSchema.enum;

const allowedTransitions = {
  PENDING: [TaskState.READY, TaskState.CANCELLED],
  READY: [TaskState.RUNNING, TaskState.CANCELLED],
  RUNNING: [TaskState.BLOCKED, TaskState.VERIFYING, TaskState.FAILED, TaskState.CANCELLED],
  BLOCKED: [TaskState.READY, TaskState.FAILED, TaskState.CANCELLED],
  VERIFYING: [TaskState.INTEGRATING, TaskState.FAILED, TaskState.CANCELLED],
  INTEGRATING: [TaskState.COMPLETED, TaskState.FAILED, TaskState.CANCELLED],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: []
} as const satisfies Record<TaskState, readonly TaskState[]>;

export const canTransitionTaskState = (from: TaskState, to: TaskState): boolean =>
  (allowedTransitions[from] as readonly TaskState[]).includes(to);

export class InvalidTaskStateTransitionError extends Error {
  readonly from: TaskState;
  readonly to: TaskState;

  constructor(from: TaskState, to: TaskState) {
    super(`Invalid task state transition: ${from} -> ${to}`);
    this.name = 'InvalidTaskStateTransitionError';
    this.from = from;
    this.to = to;
  }
}

export const assertTaskStateTransition = (from: TaskState, to: TaskState): void => {
  if (!canTransitionTaskState(from, to)) {
    throw new InvalidTaskStateTransitionError(from, to);
  }
};
