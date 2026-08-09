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

const allowedTransitions = {
  PENDING: ['READY', 'CANCELLED'],
  READY: ['RUNNING', 'CANCELLED'],
  RUNNING: ['BLOCKED', 'VERIFYING', 'FAILED', 'CANCELLED'],
  BLOCKED: ['READY', 'FAILED', 'CANCELLED'],
  VERIFYING: ['INTEGRATING', 'FAILED', 'CANCELLED'],
  INTEGRATING: ['COMPLETED', 'FAILED', 'CANCELLED'],
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
