import { describe, expect, it } from 'vitest';

import type { HardTaskConflict, RiskTaskConflict } from './conflict.js';
import type { Scheduler, SchedulerEvent } from './execution.js';

const hardConflict: HardTaskConflict = {
  taskA: 'A',
  taskB: 'B',
  score: 1,
  severity: 'hard',
  reasons: [],
  constraints: [
    {
      type: 'same-symbol-write',
      detail: 'Both tasks write the same symbol',
      resourceIds: ['catalog:product.ts:Product']
    }
  ],
  recommendedAction: 'serialize'
};

const riskConflict: RiskTaskConflict = {
  taskA: 'A',
  taskB: 'C',
  score: 40,
  severity: 'soft',
  reasons: [],
  constraints: [],
  recommendedAction: 'guarded-parallel'
};

describe('scheduler contracts', () => {
  it('keeps hard constraints separate from scored risk conflicts', () => {
    const scheduler: Scheduler = {
      createInitialPlan: (_tasks, hardConflicts, riskConflicts) => {
        expect(hardConflicts).toEqual([hardConflict]);
        expect(riskConflicts).toEqual([riskConflict]);
        return { waves: [] };
      },
      reevaluate: (_event, _snapshot, _tasks, hardConflicts, riskConflicts) => {
        expect(hardConflicts).toEqual([hardConflict]);
        expect(riskConflicts).toEqual([riskConflict]);
        return { startTaskIds: [], blockedTaskIds: [], reasons: [] };
      }
    };

    scheduler.createInitialPlan([], [hardConflict], [riskConflict], { maxConcurrency: 2 });
    scheduler.reevaluate(
      { type: 'lease-stale', taskId: 'A' },
      { taskStates: new Map(), runningTaskIds: new Set() },
      [],
      [hardConflict],
      [riskConflict],
      { maxConcurrency: 2 }
    );
  });

  it('represents stale-lease reevaluation explicitly', () => {
    const event: SchedulerEvent = { type: 'lease-stale', taskId: 'A' };

    expect(event).toEqual({ type: 'lease-stale', taskId: 'A' });
  });
});

const invalidHardConflict = {
  taskA: 'A',
  taskB: 'B',
  score: 100,
  severity: 'hard',
  reasons: [],
  // @ts-expect-error Hard conflicts must contain at least one structural scheduling constraint.
  constraints: [],
  recommendedAction: 'serialize'
} satisfies HardTaskConflict;

void invalidHardConflict;

const invalidHardAction = {
  ...hardConflict,
  // @ts-expect-error Hard conflicts cannot recommend parallel execution.
  recommendedAction: 'parallel'
} satisfies HardTaskConflict;

const invalidRiskConstraint = {
  ...riskConflict,
  // @ts-expect-error Scored risk conflicts cannot carry structural scheduling constraints.
  constraints: hardConflict.constraints
} satisfies RiskTaskConflict;

void invalidHardAction;
void invalidRiskConstraint;
