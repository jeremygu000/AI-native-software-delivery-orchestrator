import { DeterministicConflictEngine } from '@ai-native-software-delivery-orchestrator/conflict-engine';
import type {
  RepositoryGraph,
  Scheduler,
  TaskContract
} from '@ai-native-software-delivery-orchestrator/domain';
import { SchedulerInputError } from '@ai-native-software-delivery-orchestrator/domain';
import { DeterministicScheduler } from '@ai-native-software-delivery-orchestrator/scheduler';
import {
  RepositoryTaskImpactAnalyzer,
  SharedResourceRegistry
} from '@ai-native-software-delivery-orchestrator/task-impact';
import { describe, expect, it, vi } from 'vitest';

import {
  AutonomousPlanPhase,
  AutonomousPlanningError,
  type PlannerAgent,
  type PlannerProposalRequest,
  type PlanningDiagnostic
} from './autonomous-plan-phase.js';

const graph: RepositoryGraph = {
  repositoryPath: '/repo',
  projects: new Map([
    [
      'project:api',
      {
        id: 'project:api',
        name: 'api',
        root: 'apps/api',
        packageJsonPath: 'apps/api/package.json',
        dependencies: [],
        scripts: { test: 'vitest run' },
        sourceRoots: ['apps/api/src'],
        tsconfigPaths: ['apps/api/tsconfig.json']
      }
    ]
  ]),
  projectDependencies: [],
  files: new Map([
    [
      'project:api:apps/api/src/a.ts',
      {
        id: 'project:api:apps/api/src/a.ts',
        projectId: 'project:api',
        path: 'apps/api/src/a.ts',
        isGenerated: false
      }
    ],
    [
      'project:api:apps/api/src/b.ts',
      {
        id: 'project:api:apps/api/src/b.ts',
        projectId: 'project:api',
        path: 'apps/api/src/b.ts',
        isGenerated: false
      }
    ]
  ]),
  symbols: new Map(),
  fileDependencies: [],
  symbolReferences: [],
  diagnostics: []
};

const registry = new SharedResourceRegistry({
  resources: [
    {
      id: 'database-schema',
      files: [],
      paths: ['database/**'],
      concurrency: 'exclusive'
    }
  ]
});

const task = (overrides: Partial<TaskContract> = {}): TaskContract => ({
  id: 'task-a',
  title: 'Change A',
  goal: 'Change file A safely',
  dependencies: [],
  expectedReads: [],
  expectedWrites: [{ type: 'file', value: 'apps/api/src/a.ts' }],
  sharedResources: [],
  verification: [{ type: 'package-script', packageName: 'api', script: 'test' }],
  ...overrides
});

const specification = (...tasks: readonly TaskContract[]) => ({ tasks });

const createPhase = (planner: PlannerAgent) =>
  new AutonomousPlanPhase({
    planner,
    impactAnalyzer: new RepositoryTaskImpactAnalyzer(registry),
    conflictAnalyzer: new DeterministicConflictEngine(registry),
    scheduler: new DeterministicScheduler()
  });

const request = {
  source: { type: 'user-request' as const, content: 'Change A and B.' },
  repository: graph,
  options: { maxAttempts: 3, schedule: { maxConcurrency: 2 } }
};

describe('AutonomousPlanPhase', () => {
  it('turns a valid planner proposal into analyzed, conflict-aware scheduler input', async () => {
    const planner: PlannerAgent = {
      propose: vi.fn().mockResolvedValue(
        specification(
          task(),
          task({
            id: 'task-b',
            title: 'Change B',
            goal: 'Change file B safely',
            expectedWrites: [{ type: 'file', value: 'apps/api/src/b.ts' }]
          })
        )
      )
    };

    const result = await createPhase(planner).create(request);

    expect(result.attempts).toBe(1);
    expect(result.impacts.map((impact) => impact.taskId)).toEqual(['task-a', 'task-b']);
    expect(result.hardConflicts).toEqual([]);
    expect(result.riskConflicts).toHaveLength(1);
    expect(result.executionPlan.waves).toEqual([{ index: 0, taskIds: ['task-a', 'task-b'] }]);
  });

  it('accepts a fenced JSON response and sends deterministic contract diagnostics for revision', async () => {
    const proposals = [
      '{"tasks":[{"id":"task-a"}]}',
      `\`\`\`json\n${JSON.stringify(specification(task()))}\n\`\`\``
    ];
    const propose = vi.fn(async (_request: PlannerProposalRequest) => proposals.shift());

    const result = await createPhase({ propose }).create(request);

    expect(result.attempts).toBe(2);
    const secondRequest = propose.mock.calls[1][0];
    expect(secondRequest.previousDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'INVALID_TASK_CONTRACT', path: ['tasks', '0', 'title'] })
      ])
    );
  });

  it('requests revision for missing dependencies before impact analysis', async () => {
    const propose = vi
      .fn()
      .mockResolvedValueOnce(specification(task({ dependencies: ['missing'] })))
      .mockResolvedValueOnce(specification(task()));

    await expect(createPhase({ propose }).create(request)).resolves.toMatchObject({ attempts: 2 });
    expect(propose.mock.calls[1][0].previousDiagnostics).toEqual([
      {
        code: 'INVALID_TASK_GRAPH',
        detail:
          'Invalid task graph: {"type":"missing-dependency","taskId":"task-a","dependencyId":"missing"}',
        issue: { type: 'missing-dependency', taskId: 'task-a', dependencyId: 'missing' }
      }
    ]);
  });

  it('requests revision for dependency cycles', async () => {
    const propose = vi
      .fn()
      .mockResolvedValueOnce(
        specification(
          task({ id: 'task-a', dependencies: ['task-b'] }),
          task({ id: 'task-b', dependencies: ['task-a'] })
        )
      )
      .mockResolvedValueOnce(specification(task()));

    await createPhase({ propose }).create(request);

    expect(propose.mock.calls[1][0].previousDiagnostics).toEqual([
      expect.objectContaining({
        code: 'INVALID_TASK_GRAPH',
        issue: { type: 'cycle', taskIds: ['task-a', 'task-b'] }
      })
    ]);
  });

  it('rejects selectors that do not resolve to one exact repository fact', async () => {
    const propose = vi
      .fn()
      .mockResolvedValueOnce(
        specification(
          task({ expectedWrites: [{ type: 'file', value: 'apps/api/src/missing.ts' }] })
        )
      )
      .mockResolvedValueOnce(specification(task()));

    await createPhase({ propose }).create(request);

    expect(propose.mock.calls[1][0].previousDiagnostics).toEqual([
      {
        code: 'UNRESOLVED_SELECTOR',
        detail: 'Selector file:apps/api/src/missing.ts matched 0 repository facts.',
        taskId: 'task-a'
      }
    ]);
  });

  it('rejects unknown shared resources and reports every unknown ID', async () => {
    const propose = vi
      .fn()
      .mockResolvedValueOnce(
        specification(task({ sharedResources: ['unknown-b', 'unknown-a', 'unknown-b'] }))
      )
      .mockResolvedValueOnce(specification(task()));

    await createPhase({ propose }).create(request);

    expect(propose.mock.calls[1][0].previousDiagnostics).toEqual([
      {
        code: 'UNKNOWN_SHARED_RESOURCE',
        detail: 'Unknown shared resource IDs: unknown-a, unknown-b',
        taskId: 'task-a',
        resourceIds: ['unknown-a', 'unknown-b']
      }
    ]);
  });

  it('rejects package-script verification that is not present in repository facts', async () => {
    const propose = vi
      .fn()
      .mockResolvedValueOnce(
        specification(
          task({
            verification: [{ type: 'package-script', packageName: 'api', script: 'missing-script' }]
          })
        )
      )
      .mockResolvedValueOnce(specification(task()));

    await createPhase({ propose }).create(request);

    expect(propose.mock.calls[1][0].previousDiagnostics).toEqual([
      {
        code: 'INVALID_VERIFICATION',
        detail: 'Package api does not define script missing-script.',
        taskId: 'task-a'
      }
    ]);
  });

  it('rejects package-script verification for an unknown package', async () => {
    const propose = vi
      .fn()
      .mockResolvedValueOnce(
        specification(
          task({
            verification: [
              { type: 'package-script', packageName: 'missing-package', script: 'test' }
            ]
          })
        )
      )
      .mockResolvedValueOnce(
        specification(task({ verification: [{ type: 'command', command: 'pnpm check' }] }))
      );

    await createPhase({ propose }).create(request);

    expect(propose.mock.calls[1][0].previousDiagnostics).toEqual([
      {
        code: 'INVALID_VERIFICATION',
        detail: 'Package missing-package matched 0 repository projects.',
        taskId: 'task-a'
      }
    ]);
  });

  it('keeps hard conflicts structurally separate from numeric risk conflicts', async () => {
    const result = await createPhase({
      propose: async () =>
        specification(
          task({ sharedResources: ['database-schema'] }),
          task({
            id: 'task-b',
            title: 'Also change A',
            goal: 'Change the same file',
            sharedResources: ['database-schema']
          })
        )
    }).create(request);

    expect(result.hardConflicts).toHaveLength(1);
    expect(result.hardConflicts[0]).toMatchObject({ severity: 'hard' });
    expect(result.riskConflicts).toEqual([]);
    expect(result.executionPlan.waves).toEqual([
      { index: 0, taskIds: ['task-a'] },
      { index: 1, taskIds: ['task-b'] }
    ]);
  });

  it('fails closed with the last diagnostics after the revision budget is exhausted', async () => {
    const seenDiagnostics: PlanningDiagnostic[][] = [];
    const phase = createPhase({
      propose: async ({ previousDiagnostics }) => {
        seenDiagnostics.push([...previousDiagnostics]);
        return 'not json';
      }
    });

    const error = await phase
      .create({ ...request, options: { maxAttempts: 2, schedule: { maxConcurrency: 2 } } })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AutonomousPlanningError);
    expect(error).toMatchObject({
      attempts: 2,
      diagnostics: [
        {
          code: 'INVALID_PLANNER_OUTPUT',
          detail: 'Planner output must be one JSON object containing a tasks array.'
        }
      ]
    });
    expect(seenDiagnostics).toEqual([
      [],
      [
        {
          code: 'INVALID_PLANNER_OUTPUT',
          detail: 'Planner output must be one JSON object containing a tasks array.'
        }
      ]
    ]);
  });

  it('does not convert planner infrastructure failures into revision requests', async () => {
    const failure = new Error('provider unavailable');

    await expect(
      createPhase({ propose: async () => Promise.reject(failure) }).create(request)
    ).rejects.toBe(failure);
  });

  it('requests planner revision when the scheduler rejects an otherwise valid plan', async () => {
    let schedulerCalls = 0;
    const scheduler: Scheduler = {
      createInitialPlan: () => {
        schedulerCalls += 1;
        if (schedulerCalls === 1) {
          throw new SchedulerInputError('directional constraints form a cycle');
        }
        return { waves: [{ index: 0, taskIds: ['task-a'] }] };
      },
      reevaluate: () => ({ taskDecisions: [] })
    };
    const propose = vi.fn(async (_request: PlannerProposalRequest) => specification(task()));
    const phase = new AutonomousPlanPhase({
      planner: { propose },
      impactAnalyzer: new RepositoryTaskImpactAnalyzer(registry),
      conflictAnalyzer: new DeterministicConflictEngine(registry),
      scheduler
    });

    await expect(
      phase.create({
        ...request,
        sharedResourceIds: ['z', 'a', 'z'],
        options: { schedule: { maxConcurrency: 1 } }
      })
    ).resolves.toMatchObject({ attempts: 2, schedule: { maxConcurrency: 1 } });
    expect(propose.mock.calls[0][0].sharedResourceIds).toEqual(['a', 'z']);
    expect(propose.mock.calls[1][0].previousDiagnostics).toEqual([
      {
        code: 'UNSCHEDULABLE_PLAN',
        detail: 'directional constraints form a cycle'
      }
    ]);
  });

  it('does not convert unexpected scheduler failures into planner revision requests', async () => {
    const failure = new TypeError('scheduler implementation defect');
    const scheduler: Scheduler = {
      createInitialPlan: () => {
        throw failure;
      },
      reevaluate: () => ({ taskDecisions: [] })
    };
    const phase = new AutonomousPlanPhase({
      planner: { propose: async () => specification(task()) },
      impactAnalyzer: new RepositoryTaskImpactAnalyzer(registry),
      conflictAnalyzer: new DeterministicConflictEngine(registry),
      scheduler
    });

    await expect(phase.create(request)).rejects.toBe(failure);
  });

  it('does not hide unexpected impact-analyzer failures', async () => {
    const failure = new Error('repository facts unavailable');
    const phase = new AutonomousPlanPhase({
      planner: { propose: async () => specification(task()) },
      impactAnalyzer: { analyze: async () => Promise.reject(failure) },
      conflictAnalyzer: new DeterministicConflictEngine(registry),
      scheduler: new DeterministicScheduler()
    });

    await expect(phase.create(request)).rejects.toBe(failure);
  });

  it('sorts multiple selector diagnostics and ignores other risk signals', async () => {
    const generatedGraph: RepositoryGraph = {
      ...graph,
      files: new Map([...graph.files].map(([id, file]) => [id, { ...file, isGenerated: true }]))
    };
    const phase = createPhase({
      propose: async () =>
        specification(
          task({
            expectedWrites: [
              { type: 'file', value: 'missing-z.ts' },
              { type: 'file', value: 'missing-a.ts' },
              { type: 'file', value: 'apps/api/src/a.ts' }
            ]
          })
        )
    });

    await expect(
      phase.create({
        ...request,
        repository: generatedGraph,
        options: { maxAttempts: 1, schedule: { maxConcurrency: 1 } }
      })
    ).rejects.toMatchObject({
      diagnostics: [
        expect.objectContaining({ detail: expect.stringContaining('missing-a.ts') }),
        expect.objectContaining({ detail: expect.stringContaining('missing-z.ts') })
      ]
    });
  });
});
