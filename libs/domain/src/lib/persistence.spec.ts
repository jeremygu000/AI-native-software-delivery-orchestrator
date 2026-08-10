import { describe, expect, it } from 'vitest';

import { taskConflictSchema, taskImpactSchema } from './conflict.js';
import { taskDecisionsWithTransitions } from './persistence.js';

describe('persistence contracts', () => {
  it('keeps state-transition decisions separate from non-mutating deferrals', () => {
    expect(
      taskDecisionsWithTransitions([
        {
          taskId: 'A',
          action: 'defer',
          reasons: [{ type: 'max-concurrency-reached', maxConcurrency: 1, runningTaskIds: ['B'] }]
        },
        {
          taskId: 'B',
          action: 'start',
          fromState: 'READY',
          toState: 'RUNNING',
          reasons: [{ type: 'selected-by-priority', priority: 1 }]
        }
      ])
    ).toEqual([
      {
        taskId: 'B',
        action: 'start',
        fromState: 'READY',
        toState: 'RUNNING',
        reasons: [{ type: 'selected-by-priority', priority: 1 }]
      }
    ]);
  });

  it('enforces complete persisted conflict and impact shapes', () => {
    expect(
      taskConflictSchema.safeParse({
        taskA: 'A',
        taskB: 'B',
        score: 1,
        reasons: [],
        severity: 'hard',
        constraints: [],
        recommendedAction: 'stagger'
      }).success
    ).toBe(false);
    expect(taskImpactSchema.safeParse({ predicted: { taskId: 'A' } }).success).toBe(false);
  });
});
