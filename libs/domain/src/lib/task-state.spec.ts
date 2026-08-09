import { describe, expect, it } from 'vitest';

import {
  assertTaskStateTransition,
  canTransitionTaskState,
  InvalidTaskStateTransitionError,
  taskStateSchema
} from './task-state.js';

describe('task state transitions', () => {
  it('allows the normal verified completion lifecycle', () => {
    expect(canTransitionTaskState('PENDING', 'READY')).toBe(true);
    expect(canTransitionTaskState('READY', 'RUNNING')).toBe(true);
    expect(canTransitionTaskState('RUNNING', 'VERIFYING')).toBe(true);
    expect(canTransitionTaskState('VERIFYING', 'INTEGRATING')).toBe(true);
    expect(canTransitionTaskState('INTEGRATING', 'COMPLETED')).toBe(true);
    expect(() => assertTaskStateTransition('PENDING', 'READY')).not.toThrow();
  });

  it('allows a blocked task to become ready again', () => {
    expect(canTransitionTaskState('RUNNING', 'BLOCKED')).toBe(true);
    expect(canTransitionTaskState('BLOCKED', 'READY')).toBe(true);
  });

  it('rejects arbitrary and terminal state transitions', () => {
    expect(() => assertTaskStateTransition('PENDING', 'COMPLETED')).toThrow(
      InvalidTaskStateTransitionError
    );
    expect(canTransitionTaskState('COMPLETED', 'READY')).toBe(false);
  });

  it('matches the complete allowed transition matrix', () => {
    const allowed = new Set([
      'PENDING->READY',
      'PENDING->CANCELLED',
      'READY->RUNNING',
      'READY->CANCELLED',
      'RUNNING->BLOCKED',
      'RUNNING->VERIFYING',
      'RUNNING->FAILED',
      'RUNNING->CANCELLED',
      'BLOCKED->READY',
      'BLOCKED->FAILED',
      'BLOCKED->CANCELLED',
      'VERIFYING->INTEGRATING',
      'VERIFYING->FAILED',
      'VERIFYING->CANCELLED',
      'INTEGRATING->COMPLETED',
      'INTEGRATING->FAILED',
      'INTEGRATING->CANCELLED'
    ]);

    for (const from of taskStateSchema.options) {
      for (const to of taskStateSchema.options) {
        expect(canTransitionTaskState(from, to)).toBe(allowed.has(`${from}->${to}`));
      }
    }
  });
});
