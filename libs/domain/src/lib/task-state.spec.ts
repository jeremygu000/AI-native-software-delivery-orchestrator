import { describe, expect, it } from 'vitest';

import {
  assertTaskStateTransition,
  canTransitionTaskState,
  InvalidTaskStateTransitionError
} from './task-state.js';

describe('task state transitions', () => {
  it('allows the normal verified completion lifecycle', () => {
    expect(canTransitionTaskState('PENDING', 'READY')).toBe(true);
    expect(canTransitionTaskState('READY', 'RUNNING')).toBe(true);
    expect(canTransitionTaskState('RUNNING', 'VERIFYING')).toBe(true);
    expect(canTransitionTaskState('VERIFYING', 'COMPLETED')).toBe(true);
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
});
