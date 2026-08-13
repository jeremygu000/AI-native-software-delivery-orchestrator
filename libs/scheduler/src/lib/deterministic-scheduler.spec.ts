import type {
  HardTaskConflict,
  RiskTaskConflict,
  SchedulerEvent,
  SchedulerSnapshot,
  TaskContract,
  TaskState
} from '@ai-native-software-delivery-orchestrator/domain';
import { SchedulerInputError } from '@ai-native-software-delivery-orchestrator/domain';
import { describe, expect, it } from 'vitest';

import { DeterministicScheduler } from './deterministic-scheduler.js';

const scheduler = new DeterministicScheduler();

const task = (
  id: string,
  dependencies: readonly string[] = [],
  priority?: number
): TaskContract => ({
  id,
  title: id,
  goal: `Complete ${id}`,
  dependencies: [...dependencies],
  expectedReads: [],
  expectedWrites: [],
  sharedResources: [],
  verification: [],
  priority
});

const snapshot = (
  states: Readonly<Record<string, TaskState>>,
  runtimeBlocks: SchedulerSnapshot['runtimeBlocks'] = []
): SchedulerSnapshot => ({
  taskStates: Object.entries(states).map(([taskId, state]) => ({ taskId, state })),
  runtimeBlocks
});

// A release with no matching blocker is a valid evidence-only reevaluation trigger.
const event = (taskId = 'A'): SchedulerEvent => ({
  type: 'lease-stale',
  taskId,
  leaseId: 'lease-trigger'
});

const hardConflict = (
  taskA: string,
  taskB: string,
  type: Exclude<
    HardTaskConflict['constraints'][number]['type'],
    'producer-consumer'
  > = 'same-symbol-write',
  score = 100
): HardTaskConflict => ({
  taskA,
  taskB,
  score,
  severity: 'hard',
  reasons: [],
  constraints: [
    {
      type,
      detail: `${taskA} conflicts with ${taskB}`,
      resourceIds: ['resource']
    }
  ],
  recommendedAction: type === 'ordered-resource' ? 'stagger' : 'serialize'
});

const producerConflict = (producerTaskId: string, consumerTaskId: string): HardTaskConflict => ({
  taskA: [producerTaskId, consumerTaskId].toSorted()[0],
  taskB: [producerTaskId, consumerTaskId].toSorted()[1],
  score: 0,
  severity: 'hard',
  reasons: [],
  constraints: [
    {
      type: 'producer-consumer',
      detail: `${producerTaskId} produces before ${consumerTaskId}`,
      resourceIds: ['generated-output'],
      producerTaskId,
      consumerTaskId
    }
  ],
  recommendedAction: 'stagger'
});

const riskConflict = (
  taskA: string,
  taskB: string,
  recommendedAction: RiskTaskConflict['recommendedAction']
): RiskTaskConflict => ({
  taskA,
  taskB,
  score: recommendedAction === 'parallel' ? 0 : 25,
  severity: recommendedAction === 'parallel' ? 'none' : 'soft',
  reasons: [],
  constraints: [],
  recommendedAction
});

const startIds = (decision: ReturnType<DeterministicScheduler['reevaluate']>): readonly string[] =>
  decision.taskDecisions
    .filter((taskDecision) => taskDecision.action === 'start')
    .map((taskDecision) => taskDecision.taskId);

describe('DeterministicScheduler', () => {
  it('creates a priority-stable explanatory plan without using it as runtime state', () => {
    expect(
      scheduler.createInitialPlan([task('B', [], 1), task('A', [], 1), task('C', ['A'])], [], [], {
        maxConcurrency: 2
      })
    ).toEqual({
      waves: [
        { index: 0, taskIds: ['A', 'B'] },
        { index: 1, taskIds: ['C'] }
      ]
    });
  });

  it('starts independent ready tasks up to remaining capacity in priority and ID order', () => {
    const tasks = [task('B', [], 2), task('A', [], 2), task('C')];

    const decision = scheduler.reevaluate(
      event(),
      snapshot({ A: 'READY', B: 'READY', C: 'READY' }),
      tasks,
      [],
      [],
      {
        maxConcurrency: 2
      }
    );

    expect(startIds(decision)).toEqual(['A', 'B']);
    expect(decision.taskDecisions).toContainEqual({
      taskId: 'C',
      action: 'defer',
      reasons: [{ type: 'max-concurrency-reached', maxConcurrency: 2, runningTaskIds: ['A', 'B'] }]
    });
  });

  it('counts already running tasks against maximum concurrency', () => {
    const tasks = [task('A'), task('B'), task('C')];

    const decision = scheduler.reevaluate(
      event('A'),
      snapshot({ A: 'RUNNING', B: 'READY', C: 'READY' }),
      tasks,
      [],
      [],
      {
        maxConcurrency: 2
      }
    );

    expect(startIds(decision)).toEqual(['B']);
    expect(decision.taskDecisions).toContainEqual({
      taskId: 'C',
      action: 'defer',
      reasons: [{ type: 'max-concurrency-reached', maxConcurrency: 2, runningTaskIds: ['A', 'B'] }]
    });
  });

  it('defers functional dependants until every declared dependency completes', () => {
    const tasks = [task('A'), task('B'), task('C', ['A', 'B'])];

    const decision = scheduler.reevaluate(
      event('A'),
      snapshot({ A: 'COMPLETED', B: 'RUNNING', C: 'PENDING' }),
      tasks,
      [],
      [],
      {
        maxConcurrency: 3
      }
    );

    expect(startIds(decision)).toEqual([]);
    expect(decision.taskDecisions).toEqual([
      {
        taskId: 'C',
        action: 'defer',
        reasons: [{ type: 'dependency-incomplete', dependencyTaskIds: ['B'] }]
      }
    ]);
  });

  it('enforces hard conflicts even when their explanatory score is zero', () => {
    const tasks = [task('A'), task('B')];

    const decision = scheduler.reevaluate(
      event('A'),
      snapshot({ A: 'RUNNING', B: 'READY' }),
      tasks,
      [hardConflict('A', 'B', 'same-symbol-write', 0)],
      [],
      { maxConcurrency: 2 }
    );

    expect(startIds(decision)).toEqual([]);
    expect(decision.taskDecisions).toEqual([
      {
        taskId: 'B',
        action: 'defer',
        reasons: [
          {
            type: 'hard-conflict',
            conflictingTaskIds: ['A'],
            constraintTypes: ['same-symbol-write']
          }
        ]
      }
    ]);
  });

  it.each(['VERIFYING', 'INTEGRATING'] as const)(
    'defers a new conflicting task while the other task is %s',
    (activeState) => {
      const decision = scheduler.reevaluate(
        event('A'),
        snapshot({ A: activeState, B: 'READY' }),
        [task('A'), task('B')],
        [hardConflict('A', 'B')],
        [],
        { maxConcurrency: 2 }
      );

      expect(startIds(decision)).toEqual([]);
      expect(decision.taskDecisions).toContainEqual({
        taskId: 'B',
        action: 'defer',
        reasons: [
          {
            type: 'hard-conflict',
            conflictingTaskIds: ['A'],
            constraintTypes: ['same-symbol-write']
          }
        ]
      });
    }
  );

  it('applies hard serialization and risk staggering by priority then stable task ID', () => {
    const tasks = [task('C', [], 5), task('B', [], 5), task('A')];
    const decision = scheduler.reevaluate(
      event(),
      snapshot({ A: 'READY', B: 'READY', C: 'READY' }),
      tasks,
      [hardConflict('B', 'C')],
      [riskConflict('A', 'B', 'stagger')],
      { maxConcurrency: 3 }
    );

    expect(startIds(decision)).toEqual(['B']);
    expect(decision.taskDecisions).toContainEqual({
      taskId: 'A',
      action: 'defer',
      reasons: [
        {
          type: 'risk-policy-deferred',
          conflictingTaskIds: ['B'],
          recommendedActions: ['stagger']
        }
      ]
    });
    expect(decision.taskDecisions).toContainEqual({
      taskId: 'C',
      action: 'defer',
      reasons: [
        {
          type: 'hard-conflict',
          conflictingTaskIds: ['B'],
          constraintTypes: ['same-symbol-write']
        }
      ]
    });
  });

  it('enforces exclusive and ordered resources without treating their scores as thresholds', () => {
    const tasks = [task('A'), task('B'), task('C')];
    const decision = scheduler.reevaluate(
      event('A'),
      snapshot({ A: 'RUNNING', B: 'READY', C: 'READY' }),
      tasks,
      [
        hardConflict('A', 'B', 'exclusive-resource', 0),
        hardConflict('A', 'C', 'ordered-resource', 0)
      ],
      [],
      { maxConcurrency: 3 }
    );

    expect(startIds(decision)).toEqual([]);
    expect(decision.taskDecisions).toContainEqual({
      taskId: 'B',
      action: 'defer',
      reasons: [
        {
          type: 'hard-conflict',
          conflictingTaskIds: ['A'],
          constraintTypes: ['exclusive-resource']
        }
      ]
    });
    expect(decision.taskDecisions).toContainEqual({
      taskId: 'C',
      action: 'defer',
      reasons: [
        { type: 'hard-conflict', conflictingTaskIds: ['A'], constraintTypes: ['ordered-resource'] }
      ]
    });
  });

  it('allows parallel and guarded-parallel risks while retaining a structured audit reason', () => {
    const tasks = [task('A'), task('B'), task('C')];
    const decision = scheduler.reevaluate(
      event(),
      snapshot({ A: 'READY', B: 'READY', C: 'READY' }),
      tasks,
      [],
      [riskConflict('A', 'B', 'parallel'), riskConflict('A', 'C', 'guarded-parallel')],
      { maxConcurrency: 3 }
    );

    expect(startIds(decision)).toEqual(['A', 'B', 'C']);
    expect(decision.taskDecisions).toContainEqual({
      taskId: 'C',
      action: 'start',
      fromState: 'READY',
      toState: 'RUNNING',
      reasons: [
        { type: 'selected-by-priority', priority: 0 },
        {
          type: 'risk-policy-allowed',
          conflictingTaskIds: ['A'],
          recommendedActions: ['guarded-parallel']
        }
      ]
    });
  });

  it('allows sibling-symbol soft risk according to the guarded-parallel policy', () => {
    const tasks = [task('A'), task('B')];
    const decision = scheduler.reevaluate(
      event(),
      snapshot({ A: 'READY', B: 'READY' }),
      tasks,
      [],
      [riskConflict('A', 'B', 'guarded-parallel')],
      { maxConcurrency: 2 }
    );

    expect(startIds(decision)).toEqual(['A', 'B']);
  });

  it('preserves producer direction when lexical ordering is reversed', () => {
    const tasks = [task('A-consumer'), task('Z-producer')];
    const conflict = producerConflict('Z-producer', 'A-consumer');

    const waiting = scheduler.reevaluate(
      event('Z-producer'),
      snapshot({ 'A-consumer': 'READY', 'Z-producer': 'READY' }),
      tasks,
      [conflict],
      [],
      { maxConcurrency: 2 }
    );
    const released = scheduler.reevaluate(
      event('Z-producer'),
      snapshot({ 'A-consumer': 'READY', 'Z-producer': 'COMPLETED' }),
      tasks,
      [conflict],
      [],
      { maxConcurrency: 2 }
    );

    expect(startIds(waiting)).toEqual(['Z-producer']);
    expect(waiting.taskDecisions).toContainEqual({
      taskId: 'A-consumer',
      action: 'defer',
      reasons: [{ type: 'producer-must-complete', producerTaskIds: ['Z-producer'] }]
    });
    expect(startIds(released)).toEqual(['A-consumer']);
  });

  it('preserves producer direction when lexical ordering happens to align', () => {
    const tasks = [task('A-producer'), task('Z-consumer')];
    const conflict = producerConflict('A-producer', 'Z-consumer');
    const waiting = scheduler.reevaluate(
      event('A-producer'),
      snapshot({ 'A-producer': 'READY', 'Z-consumer': 'READY' }),
      tasks,
      [conflict],
      [],
      { maxConcurrency: 2 }
    );

    expect(startIds(waiting)).toEqual(['A-producer']);
    expect(waiting.taskDecisions).toContainEqual({
      taskId: 'Z-consumer',
      action: 'defer',
      reasons: [{ type: 'producer-must-complete', producerTaskIds: ['A-producer'] }]
    });
  });

  it('cancels every functional and producer dependant after failure', () => {
    const tasks = [task('A'), task('B', ['A']), task('C', ['B']), task('D')];
    const decision = scheduler.reevaluate(
      { type: 'task-failed', taskId: 'A', state: 'FAILED' },
      snapshot({ A: 'FAILED', B: 'READY', C: 'PENDING', D: 'READY' }),
      tasks,
      [],
      [],
      { maxConcurrency: 2 }
    );

    expect(decision.taskDecisions).toContainEqual({
      taskId: 'B',
      action: 'cancel',
      fromState: 'READY',
      toState: 'CANCELLED',
      reasons: [{ type: 'dependency-failed', failedTaskIds: ['A'] }]
    });
    expect(decision.taskDecisions).toContainEqual({
      taskId: 'C',
      action: 'cancel',
      fromState: 'PENDING',
      toState: 'CANCELLED',
      reasons: [{ type: 'dependency-failed', failedTaskIds: ['A'] }]
    });
    expect(startIds(decision)).toEqual(['D']);
  });

  it('cancels a directional consumer when its producer fails', () => {
    const tasks = [task('producer'), task('consumer')];
    const decision = scheduler.reevaluate(
      { type: 'task-failed', taskId: 'producer', state: 'FAILED' },
      snapshot({ producer: 'FAILED', consumer: 'READY' }),
      tasks,
      [producerConflict('producer', 'consumer')],
      [],
      { maxConcurrency: 2 }
    );

    expect(decision.taskDecisions).toEqual([
      {
        taskId: 'consumer',
        action: 'cancel',
        fromState: 'READY',
        toState: 'CANCELLED',
        reasons: [{ type: 'dependency-failed', failedTaskIds: ['producer'] }]
      }
    ]);
  });

  it('blocks only a running task and unblocks only tasks matched to the released runtime evidence', () => {
    const tasks = [task('A'), task('B'), task('C')];
    const blocked = scheduler.reevaluate(
      { type: 'lease-blocked', taskId: 'A', leaseId: 'lease-1' },
      snapshot({ A: 'RUNNING', B: 'BLOCKED', C: 'READY' }, [
        { taskId: 'B', blockers: [{ type: 'lease', leaseId: 'lease-2' }] }
      ]),
      tasks,
      [],
      [],
      { maxConcurrency: 2 }
    );
    const unblocked = scheduler.reevaluate(
      { type: 'lease-released', taskId: 'A', leaseId: 'lease-1' },
      snapshot({ A: 'BLOCKED', B: 'BLOCKED', C: 'READY' }, [
        { taskId: 'A', blockers: [{ type: 'lease', leaseId: 'lease-1' }] },
        { taskId: 'B', blockers: [{ type: 'lease', leaseId: 'lease-2' }] }
      ]),
      tasks,
      [],
      [],
      { maxConcurrency: 2 }
    );

    expect(blocked.taskDecisions).toContainEqual({
      taskId: 'A',
      action: 'block',
      fromState: 'RUNNING',
      toState: 'BLOCKED',
      reasons: [{ type: 'runtime-blocked', blockers: [{ type: 'lease', leaseId: 'lease-1' }] }]
    });
    expect(unblocked.taskDecisions).toContainEqual({
      taskId: 'A',
      action: 'unblock',
      fromState: 'BLOCKED',
      toState: 'READY',
      reasons: [
        { type: 'runtime-blocker-released', blockers: [{ type: 'lease', leaseId: 'lease-1' }] }
      ]
    });
    expect(unblocked.taskDecisions).not.toContainEqual(
      expect.objectContaining({ taskId: 'B', action: 'unblock' })
    );
  });

  it('requires every blocker to release and supports runtime-conflict releases', () => {
    const tasks = [task('A')];
    const stillBlocked = scheduler.reevaluate(
      { type: 'lease-released', taskId: 'A', leaseId: 'lease-1' },
      snapshot({ A: 'BLOCKED' }, [
        {
          taskId: 'A',
          blockers: [
            { type: 'lease', leaseId: 'lease-1' },
            { type: 'runtime-conflict', conflictId: 'conflict-1' }
          ]
        }
      ]),
      tasks,
      [],
      [],
      { maxConcurrency: 1 }
    );
    const unblocked = scheduler.reevaluate(
      { type: 'runtime-conflict-resolved', taskId: 'A', conflictId: 'conflict-1' },
      snapshot({ A: 'BLOCKED' }, [
        { taskId: 'A', blockers: [{ type: 'runtime-conflict', conflictId: 'conflict-1' }] }
      ]),
      tasks,
      [],
      [],
      { maxConcurrency: 1 }
    );

    expect(stillBlocked.taskDecisions).toEqual([
      {
        taskId: 'A',
        action: 'defer',
        reasons: [
          {
            type: 'runtime-blocked',
            blockers: [{ type: 'runtime-conflict', conflictId: 'conflict-1' }]
          }
        ]
      }
    ]);
    expect(unblocked.taskDecisions).toContainEqual({
      taskId: 'A',
      action: 'unblock',
      fromState: 'BLOCKED',
      toState: 'READY',
      reasons: [
        {
          type: 'runtime-blocker-released',
          blockers: [{ type: 'runtime-conflict', conflictId: 'conflict-1' }]
        }
      ]
    });
  });

  it('rejects a task-failed event whose snapshot has not applied the FAILED state', () => {
    expect(() =>
      scheduler.reevaluate(
        { type: 'task-failed', taskId: 'producer', state: 'FAILED' },
        snapshot({ producer: 'RUNNING', consumer: 'READY' }),
        [task('producer'), task('consumer', ['producer'])],
        [],
        [],
        { maxConcurrency: 2 }
      )
    ).toThrow('task-failed event requires FAILED snapshot state: producer');
  });

  it.each([
    { event: { type: 'task-completed', taskId: 'A', state: 'COMPLETED' }, actualState: 'READY' },
    { event: { type: 'task-failed', taskId: 'A', state: 'FAILED' }, actualState: 'RUNNING' },
    {
      event: { type: 'verification-completed', taskId: 'A', state: 'INTEGRATING' },
      actualState: 'VERIFYING'
    },
    {
      event: { type: 'workspace-integrated', taskId: 'A', state: 'COMPLETED' },
      actualState: 'INTEGRATING'
    }
  ] satisfies readonly { event: SchedulerEvent; actualState: TaskState }[])(
    'rejects an observation whose snapshot does not reflect its post-state',
    ({ event: observationEvent, actualState }) => {
      expect(() =>
        scheduler.reevaluate(observationEvent, snapshot({ A: actualState }), [task('A')], [], [], {
          maxConcurrency: 1
        })
      ).toThrow(
        `${observationEvent.type} event requires ${observationEvent.state} snapshot state: A`
      );
    }
  );

  it('accumulates distinct blockers from successive runtime events without repeating a state transition', () => {
    const tasks = [task('A')];
    const leaseBlocked = scheduler.reevaluate(
      { type: 'lease-blocked', taskId: 'A', leaseId: 'lease-1' },
      snapshot({ A: 'RUNNING' }),
      tasks,
      [],
      [],
      { maxConcurrency: 1 }
    );
    const conflictBlocked = scheduler.reevaluate(
      { type: 'runtime-conflict-discovered', taskId: 'A', conflictId: 'conflict-1' },
      snapshot({ A: 'BLOCKED' }, [
        { taskId: 'A', blockers: [{ type: 'lease', leaseId: 'lease-1' }] }
      ]),
      tasks,
      [],
      [],
      { maxConcurrency: 1 }
    );
    const leaseReleased = scheduler.reevaluate(
      { type: 'lease-released', taskId: 'A', leaseId: 'lease-1' },
      snapshot({ A: 'BLOCKED' }, [
        {
          taskId: 'A',
          blockers: [
            { type: 'lease', leaseId: 'lease-1' },
            { type: 'runtime-conflict', conflictId: 'conflict-1' }
          ]
        }
      ]),
      tasks,
      [],
      [],
      { maxConcurrency: 1 }
    );
    const conflictReleased = scheduler.reevaluate(
      { type: 'runtime-conflict-resolved', taskId: 'A', conflictId: 'conflict-1' },
      snapshot({ A: 'BLOCKED' }, [
        { taskId: 'A', blockers: [{ type: 'runtime-conflict', conflictId: 'conflict-1' }] }
      ]),
      tasks,
      [],
      [],
      { maxConcurrency: 1 }
    );

    expect(leaseBlocked.taskDecisions).toContainEqual(
      expect.objectContaining({ taskId: 'A', action: 'block' })
    );
    expect(conflictBlocked.taskDecisions).toEqual([
      {
        taskId: 'A',
        action: 'defer',
        reasons: [
          {
            type: 'runtime-blocked',
            blockers: [
              { type: 'lease', leaseId: 'lease-1' },
              { type: 'runtime-conflict', conflictId: 'conflict-1' }
            ]
          }
        ]
      }
    ]);
    expect(leaseReleased.taskDecisions).toEqual([
      {
        taskId: 'A',
        action: 'defer',
        reasons: [
          {
            type: 'runtime-blocked',
            blockers: [{ type: 'runtime-conflict', conflictId: 'conflict-1' }]
          }
        ]
      }
    ]);
    expect(conflictReleased.taskDecisions).toContainEqual(
      expect.objectContaining({ taskId: 'A', action: 'unblock' })
    );
  });

  it('broadcasts a released blocker to every blocked waiter while retaining the reporting task identity', () => {
    const tasks = [task('owner'), task('waiter-a'), task('waiter-b')];
    const decision = scheduler.reevaluate(
      { type: 'lease-released', taskId: 'owner', leaseId: 'lease-1' },
      snapshot({ owner: 'COMPLETED', 'waiter-a': 'BLOCKED', 'waiter-b': 'BLOCKED' }, [
        { taskId: 'waiter-a', blockers: [{ type: 'lease', leaseId: 'lease-1' }] },
        { taskId: 'waiter-b', blockers: [{ type: 'lease', leaseId: 'lease-1' }] }
      ]),
      tasks,
      [],
      [],
      { maxConcurrency: 2 }
    );

    expect(decision.taskDecisions).toContainEqual(
      expect.objectContaining({ taskId: 'waiter-a', action: 'unblock' })
    );
    expect(decision.taskDecisions).toContainEqual(
      expect.objectContaining({ taskId: 'waiter-b', action: 'unblock' })
    );
    expect(decision.taskDecisions).not.toContainEqual(
      expect.objectContaining({ taskId: 'owner', action: 'unblock' })
    );
  });

  it('starts a true dependant as soon as its only dependency completes without waiting for its preview wave peer', () => {
    const tasks = [task('A'), task('B'), task('C', ['A'])];
    const plan = scheduler.createInitialPlan(tasks, [], [], { maxConcurrency: 2 });
    const decision = scheduler.reevaluate(
      event('A'),
      snapshot({ A: 'COMPLETED', B: 'RUNNING', C: 'PENDING' }),
      tasks,
      [],
      [],
      { maxConcurrency: 2 }
    );

    expect(plan.waves).toEqual([
      { index: 0, taskIds: ['A', 'B'] },
      { index: 1, taskIds: ['C'] }
    ]);
    expect(startIds(decision)).toEqual(['C']);
  });

  it('returns deeply equal decisions for identical inputs', () => {
    const tasks = [task('A'), task('B')];
    const inputs = [
      event(),
      snapshot({ A: 'READY', B: 'READY' }),
      tasks,
      [],
      [],
      { maxConcurrency: 2 }
    ] as const;

    expect(scheduler.reevaluate(...inputs)).toEqual(scheduler.reevaluate(...inputs));
  });

  it('rejects invalid task graphs, invalid concurrency, incomplete snapshots, and invalid runtime transitions', () => {
    expect(() =>
      scheduler.reevaluate(event(), snapshot({ A: 'READY' }), [task('A', ['missing'])], [], [], {
        maxConcurrency: 1
      })
    ).toThrow(SchedulerInputError);
    expect(() =>
      scheduler.reevaluate(event(), snapshot({ A: 'READY' }), [task('A')], [], [], {
        maxConcurrency: 0
      })
    ).toThrow();
    expect(() =>
      scheduler.reevaluate(event(), snapshot({ A: 'READY' }), [task('A'), task('B')], [], [], {
        maxConcurrency: 1
      })
    ).toThrow(SchedulerInputError);
    expect(() =>
      scheduler.reevaluate(
        { type: 'lease-blocked', taskId: 'A', leaseId: 'lease-1' },
        snapshot({ A: 'READY' }),
        [task('A')],
        [],
        [],
        { maxConcurrency: 1 }
      )
    ).toThrow(SchedulerInputError);
  });

  it('rejects invalid conflicts, producer constraints, cycles, and malformed snapshots', () => {
    const tasks = [task('A'), task('B')];
    const malformed = producerConflict('A', 'B');
    const invalidProducer = {
      ...malformed,
      constraints: [{ ...malformed.constraints[0], producerTaskId: 'missing' }]
    } as HardTaskConflict;

    const invalidCalls = [
      () =>
        scheduler.createInitialPlan(tasks, [hardConflict('A', 'missing')], [], {
          maxConcurrency: 2
        }),
      () => scheduler.createInitialPlan(tasks, [hardConflict('A', 'A')], [], { maxConcurrency: 2 }),
      () => scheduler.createInitialPlan(tasks, [invalidProducer], [], { maxConcurrency: 2 }),
      () =>
        scheduler.createInitialPlan(
          tasks,
          [producerConflict('A', 'B'), producerConflict('B', 'A')],
          [],
          { maxConcurrency: 2 }
        ),
      () =>
        scheduler.reevaluate(
          event(),
          {
            taskStates: [
              { taskId: 'A', state: 'READY' },
              { taskId: 'A', state: 'READY' },
              { taskId: 'B', state: 'READY' }
            ],
            runtimeBlocks: []
          },
          tasks,
          [],
          [],
          { maxConcurrency: 2 }
        ),
      () =>
        scheduler.reevaluate(
          event(),
          {
            taskStates: [
              { taskId: 'A', state: 'BLOCKED' },
              { taskId: 'B', state: 'READY' }
            ],
            runtimeBlocks: [
              { taskId: 'A', blockers: [{ type: 'lease', leaseId: 'lease-1' }] },
              { taskId: 'A', blockers: [{ type: 'lease', leaseId: 'lease-2' }] }
            ]
          },
          tasks,
          [],
          [],
          { maxConcurrency: 2 }
        ),
      () =>
        scheduler.reevaluate(
          event(),
          {
            taskStates: [
              { taskId: 'A', state: 'READY' },
              { taskId: 'B', state: 'READY' }
            ],
            runtimeBlocks: [{ taskId: 'A', blockers: [{ type: 'lease', leaseId: 'lease-1' }] }]
          },
          tasks,
          [],
          [],
          { maxConcurrency: 2 }
        ),
      () =>
        scheduler.reevaluate(
          event(),
          snapshot({ A: 'READY', B: 'READY', extra: 'READY' }),
          tasks,
          [],
          [],
          { maxConcurrency: 2 }
        ),
      () =>
        scheduler.reevaluate(
          { type: 'task-completed', taskId: 'missing', state: 'COMPLETED' },
          snapshot({ A: 'READY', B: 'READY' }),
          tasks,
          [],
          [],
          { maxConcurrency: 2 }
        )
    ];

    for (const invalidCall of invalidCalls) {
      expect(invalidCall).toThrow(SchedulerInputError);
    }
  });

  it('reports non-runnable state and rejects a BLOCKED task without recorded blockers', () => {
    const tasks = [task('A'), task('B')];
    const decision = scheduler.reevaluate(
      event('A'),
      snapshot({ A: 'VERIFYING', B: 'READY' }),
      tasks,
      [],
      [],
      { maxConcurrency: 2 }
    );

    expect(decision.taskDecisions).toContainEqual({
      taskId: 'A',
      action: 'defer',
      reasons: [{ type: 'task-state-not-runnable', taskState: 'VERIFYING' }]
    });
    expect(() =>
      scheduler.reevaluate(event('A'), snapshot({ A: 'BLOCKED', B: 'READY' }), tasks, [], [], {
        maxConcurrency: 2
      })
    ).toThrow(SchedulerInputError);
  });
  it('records only the terminal prerequisites that cause each cancellation', () => {
    const tasks = [task('A'), task('B'), task('C', ['A']), task('D', ['B'])];
    const decision = scheduler.reevaluate(
      event('A'),
      snapshot({ A: 'FAILED', B: 'FAILED', C: 'READY', D: 'READY' }),
      tasks,
      [],
      [],
      { maxConcurrency: 2 }
    );

    expect(decision.taskDecisions).toContainEqual({
      taskId: 'C',
      action: 'cancel',
      fromState: 'READY',
      toState: 'CANCELLED',
      reasons: [{ type: 'dependency-failed', failedTaskIds: ['A'] }]
    });
    expect(decision.taskDecisions).toContainEqual({
      taskId: 'D',
      action: 'cancel',
      fromState: 'READY',
      toState: 'CANCELLED',
      reasons: [{ type: 'dependency-failed', failedTaskIds: ['B'] }]
    });
  });

  it('propagates pre-existing cancellation without mislabeling it as failure', () => {
    const tasks = [task('A'), task('B', ['A'])];
    const decision = scheduler.reevaluate(
      event('A'),
      snapshot({ A: 'CANCELLED', B: 'READY' }),
      tasks,
      [],
      [],
      { maxConcurrency: 2 }
    );

    expect(decision.taskDecisions).toEqual([
      {
        taskId: 'B',
        action: 'cancel',
        fromState: 'READY',
        toState: 'CANCELLED',
        reasons: [{ type: 'dependency-cancelled', cancelledTaskIds: ['A'] }]
      }
    ]);
  });
});
