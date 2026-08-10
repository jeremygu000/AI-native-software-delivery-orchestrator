import { describe, expect, it } from 'vitest';

import {
  scheduleOptionsSchema,
  schedulerDecisionReasonSchema,
  schedulerEventSchema,
  schedulerSnapshotSchema,
  schedulerTaskDecisionSchema
} from './execution.js';

describe('scheduler contracts', () => {
  it('parses every supported scheduler event with replay evidence', () => {
    expect(
      [
        { type: 'task-completed', taskId: 'A', state: 'COMPLETED' },
        { type: 'task-failed', taskId: 'A', state: 'FAILED' },
        { type: 'workspace-integrated', taskId: 'A', state: 'COMPLETED' },
        { type: 'verification-completed', taskId: 'A', state: 'INTEGRATING' },
        { type: 'lease-blocked', taskId: 'A', leaseId: 'lease-1' },
        { type: 'lease-released', taskId: 'A', leaseId: 'lease-1' },
        { type: 'lease-stale', taskId: 'A', leaseId: 'lease-1' },
        { type: 'runtime-conflict-discovered', taskId: 'A', conflictId: 'conflict-1' },
        { type: 'runtime-conflict-resolved', taskId: 'A', conflictId: 'conflict-1' }
      ].map((event) => schedulerEventSchema.parse(event))
    ).toHaveLength(9);
  });

  it('rejects runtime events without their blocker identity', () => {
    expect(schedulerEventSchema.safeParse({ type: 'lease-released', taskId: 'A' }).success).toBe(
      false
    );
    expect(
      schedulerEventSchema.safeParse({ type: 'runtime-conflict-discovered', taskId: 'A' }).success
    ).toBe(false);
  });

  it('requires every observation event to carry its deterministic post-state', () => {
    expect(schedulerEventSchema.safeParse({ type: 'task-completed', taskId: 'A' }).success).toBe(
      false
    );
    expect(
      schedulerEventSchema.safeParse({
        type: 'verification-completed',
        taskId: 'A',
        state: 'COMPLETED'
      }).success
    ).toBe(false);
  });

  it('keeps snapshots serializable and associates blocked tasks with exact blockers', () => {
    expect(
      schedulerSnapshotSchema.parse({
        taskStates: [
          { taskId: 'A', state: 'COMPLETED' },
          { taskId: 'B', state: 'BLOCKED' }
        ],
        runtimeBlocks: [
          {
            taskId: 'B',
            blockers: [
              { type: 'lease', leaseId: 'lease-1' },
              { type: 'runtime-conflict', conflictId: 'conflict-1' }
            ]
          }
        ]
      })
    ).toEqual({
      taskStates: [
        { taskId: 'A', state: 'COMPLETED' },
        { taskId: 'B', state: 'BLOCKED' }
      ],
      runtimeBlocks: [
        {
          taskId: 'B',
          blockers: [
            { type: 'lease', leaseId: 'lease-1' },
            { type: 'runtime-conflict', conflictId: 'conflict-1' }
          ]
        }
      ]
    });
  });

  it('uses structured per-task reasons and legal state-transition decisions', () => {
    const reason = schedulerDecisionReasonSchema.parse({
      type: 'producer-must-complete',
      producerTaskIds: ['producer']
    });
    const decision = schedulerTaskDecisionSchema.parse({
      taskId: 'consumer',
      action: 'defer',
      reasons: [reason]
    });

    expect(decision).toEqual({
      taskId: 'consumer',
      action: 'defer',
      reasons: [{ type: 'producer-must-complete', producerTaskIds: ['producer'] }]
    });
    expect(
      schedulerTaskDecisionSchema.safeParse({
        taskId: 'A',
        action: 'start',
        fromState: 'PENDING',
        toState: 'RUNNING',
        reasons: [{ type: 'selected-by-priority', priority: 0 }]
      }).success
    ).toBe(false);
  });

  it('represents propagated cancellation independently from dependency failure', () => {
    expect(
      schedulerDecisionReasonSchema.parse({
        type: 'dependency-cancelled',
        cancelledTaskIds: ['cancelled-prerequisite']
      })
    ).toEqual({
      type: 'dependency-cancelled',
      cancelledTaskIds: ['cancelled-prerequisite']
    });
  });

  it('requires a positive integer concurrency limit', () => {
    expect(scheduleOptionsSchema.safeParse({ maxConcurrency: 1 }).success).toBe(true);
    expect(scheduleOptionsSchema.safeParse({ maxConcurrency: 0 }).success).toBe(false);
    expect(scheduleOptionsSchema.safeParse({ maxConcurrency: 1.5 }).success).toBe(false);
  });
});
