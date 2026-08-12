import type { PreparedOrchestrationPlan, PlanningSource } from './autonomous-plan-phase.js';
import type {
  FileNode,
  ProjectNode,
  RepositoryGraph,
  RepositorySnapshot,
  SymbolNode,
  TaskContract
} from '@ai-native-software-delivery-orchestrator/domain';
import { describe, expect, it } from 'vitest';

import {
  assertStableRepositorySnapshot,
  canonicalPlanJson,
  createPlanArtifact,
  fingerprintPlanValue,
  parsePlanArtifact,
  PlanArtifactIntegrityError,
  RepositorySnapshotChangedError,
  repositoryBindingMismatches,
  repositoryFactsFingerprint
} from './plan-artifact.js';

const task: TaskContract = {
  id: 'task-a',
  title: 'Change A',
  goal: 'Change file A safely',
  dependencies: [],
  expectedReads: [],
  expectedWrites: [{ type: 'file', value: 'src/a.ts' }],
  sharedResources: [],
  verification: [{ type: 'package-script', packageName: 'core', script: 'test' }]
};

const taskB: TaskContract = {
  ...task,
  id: 'task-b',
  title: 'Change B',
  goal: 'Change file B safely',
  dependencies: ['task-a'],
  expectedWrites: [{ type: 'file', value: 'src/b.ts' }]
};

const graph = (reverse = false): RepositoryGraph => {
  const projects: Array<readonly [string, ProjectNode]> = [
    [
      'core',
      {
        id: 'core',
        name: 'core',
        root: '.',
        packageJsonPath: 'package.json',
        dependencies: [],
        scripts: { typecheck: 'tsc -b', test: 'vitest run' },
        sourceRoots: ['src'],
        tsconfigPaths: ['tsconfig.json']
      }
    ],
    [
      'ui',
      {
        id: 'ui',
        name: 'ui',
        root: 'apps/ui',
        packageJsonPath: 'apps/ui/package.json',
        dependencies: [
          {
            name: 'core',
            version: 'workspace:*',
            kind: 'dependency',
            workspaceProtocol: true
          },
          {
            name: 'external',
            version: '1.0.0',
            kind: 'dev-dependency',
            workspaceProtocol: false
          }
        ],
        scripts: { test: 'vitest run' },
        sourceRoots: ['apps/ui/src'],
        tsconfigPaths: ['apps/ui/tsconfig.json']
      }
    ]
  ];
  const files: Array<readonly [string, FileNode]> = [
    [
      'core:src/a.ts',
      { id: 'core:src/a.ts', projectId: 'core', path: 'src/a.ts', isGenerated: false }
    ],
    [
      'core:src/b.ts',
      { id: 'core:src/b.ts', projectId: 'core', path: 'src/b.ts', isGenerated: false }
    ],
    [
      'ui:apps/ui/src/view.ts',
      {
        id: 'ui:apps/ui/src/view.ts',
        projectId: 'ui',
        path: 'apps/ui/src/view.ts',
        isGenerated: false
      }
    ]
  ];
  const symbols: Array<readonly [string, SymbolNode]> = [
    [
      'core:src/a.ts:value',
      {
        id: 'core:src/a.ts:value',
        fileId: 'core:src/a.ts',
        name: 'value',
        path: 'value',
        kind: 'variable',
        exported: true
      }
    ],
    [
      'ui:apps/ui/src/view.ts:View',
      {
        id: 'ui:apps/ui/src/view.ts:View',
        fileId: 'ui:apps/ui/src/view.ts',
        name: 'View',
        path: 'View',
        kind: 'function',
        exported: true
      }
    ]
  ];
  return {
    repositoryPath: '/repo',
    projects: new Map(reverse ? projects.toReversed() : projects),
    projectDependencies: [
      { from: 'ui', to: 'core', sources: ['typescript-import', 'package-dependency'] },
      { from: 'core', to: 'ui', sources: ['manual'] }
    ],
    files: new Map(reverse ? files.toReversed() : files),
    symbols: new Map(reverse ? symbols.toReversed() : symbols),
    fileDependencies: [
      { from: 'core:src/a.ts', to: 'core:src/b.ts' },
      { from: 'ui:apps/ui/src/view.ts', to: 'core:src/a.ts' }
    ],
    symbolReferences: [
      { from: 'ui:apps/ui/src/view.ts:View', to: 'core:src/a.ts:value' },
      { from: 'core:src/a.ts:value', to: 'ui:apps/ui/src/view.ts:View' }
    ],
    diagnostics: [
      {
        code: 'EMPTY_TYPESCRIPT_PROJECT',
        severity: 'warning',
        projectId: 'core',
        message: 'Empty project.',
        configPaths: ['z.json', 'a.json']
      },
      {
        code: 'UNCOVERED_TYPESCRIPT_FILES',
        severity: 'warning',
        projectId: 'ui',
        message: 'Uncovered files.',
        configPaths: ['ui.json'],
        filePaths: ['z.ts', 'a.ts']
      }
    ]
  };
};

const source: PlanningSource = { type: 'markdown-spec', content: 'Change A.', path: 'request.md' };

const snapshot: RepositorySnapshot = {
  repositoryId: `sha256:${'1'.repeat(64)}`,
  repositoryRoot: '/repo',
  baseCommit: '2'.repeat(40),
  workingTreeFingerprint: `sha256:${'3'.repeat(64)}`,
  dirty: true
};

const preparedPlan: PreparedOrchestrationPlan = {
  attempts: 1,
  specification: { tasks: [task] },
  impacts: [
    {
      taskId: 'task-a',
      projectsRead: new Set(['core']),
      projectsWritten: new Set(['core']),
      explicitProjectsWritten: new Set(),
      filesRead: new Set(),
      filesWritten: new Set(['core:src/a.ts']),
      explicitFilesWritten: new Set(['core:src/a.ts']),
      globFilesWritten: new Set(),
      symbolDerivedFilesWritten: new Set(),
      symbolsRead: new Set(),
      symbolsWritten: new Set(),
      sharedResources: new Set(),
      sharedResourceAccesses: [],
      downstreamProjects: new Set(),
      riskSignals: []
    }
  ],
  hardConflicts: [],
  riskConflicts: [],
  executionPlan: { waves: [{ index: 0, taskIds: ['task-a'] }] },
  schedule: { maxConcurrency: 1 },
  semanticReview: {
    recommendation: 'accept',
    summary: 'The request is covered.',
    requirements: [
      {
        requirement: 'Change A.',
        status: 'covered',
        taskIds: ['task-a'],
        detail: 'Task A covers the requested change.'
      }
    ]
  }
};

const createArtifact = (overrides: Partial<Parameters<typeof createPlanArtifact>[0]> = {}) =>
  createPlanArtifact({
    artifactId: 'plan-1',
    revision: 1,
    createdAt: '2026-08-12T00:00:00.000Z',
    source,
    repository: graph(),
    repositorySnapshot: snapshot,
    sharedResourcePolicy: [],
    verificationPolicy: { version: 1, rules: ['package-script-required'] },
    preparedPlan,
    ...overrides
  });

const twoTaskPlan = (): PreparedOrchestrationPlan => ({
  ...preparedPlan,
  specification: { tasks: [task, taskB] },
  impacts: [
    preparedPlan.impacts[0],
    {
      ...preparedPlan.impacts[0],
      taskId: 'task-b',
      filesWritten: new Set(['core:src/b.ts']),
      explicitFilesWritten: new Set(['core:src/b.ts'])
    }
  ],
  executionPlan: {
    waves: [
      { index: 0, taskIds: ['task-a'] },
      { index: 1, taskIds: ['task-b'] }
    ]
  }
});

const hardConflict = {
  taskA: 'task-a',
  taskB: 'task-b',
  score: 100,
  reasons: [],
  severity: 'hard' as const,
  constraints: [
    {
      type: 'same-symbol-write' as const,
      detail: 'Same symbol.',
      resourceIds: ['symbol-a']
    }
  ] as const,
  recommendedAction: 'serialize' as const
};

const riskConflict = {
  taskA: 'task-b',
  taskB: 'task-a',
  score: 10,
  reasons: [],
  severity: 'soft' as const,
  constraints: [] as const,
  recommendedAction: 'guarded-parallel' as const
};

describe('PlanArtifact', () => {
  it('creates a JSON-safe immutable decision artifact bound to every authority input', () => {
    const artifact = createArtifact();

    expect(artifact).toMatchObject({
      schemaVersion: 1,
      artifactId: 'plan-1',
      revision: 1,
      repository: { baseCommit: snapshot.baseCommit, dirty: true },
      decision: { impacts: [{ filesWritten: ['core:src/a.ts'] }] }
    });
    expect(JSON.parse(JSON.stringify(artifact))).toEqual(artifact);
    expect(parsePlanArtifact(artifact)).toEqual(artifact);
  });

  it('is stable across RepositoryGraph map insertion order', () => {
    expect(repositoryFactsFingerprint(graph())).toBe(repositoryFactsFingerprint(graph(true)));
  });

  it('canonicalizes JSON keys and rejects unsupported or non-finite authority values', () => {
    expect(canonicalPlanJson({ z: 1, omitted: undefined, a: [null, true, 'value'] })).toBe(
      '{"a":[null,true,"value"],"z":1}'
    );
    expect(fingerprintPlanValue({ a: 1, b: 2 })).toBe(fingerprintPlanValue({ b: 2, a: 1 }));
    expect(() => canonicalPlanJson(Number.NaN)).toThrow('Non-finite number at $');
    expect(() => canonicalPlanJson(new Set(['unsupported']))).toThrow('Unsupported value at $');
    expect(() => canonicalPlanJson(Symbol('unsupported'))).toThrow('Unsupported value at $');
  });

  it('detects source and decision tampering even when the structure remains valid', () => {
    const artifact = createArtifact();

    expect(() =>
      parsePlanArtifact({ ...artifact, source: { ...source, content: 'Changed.' } })
    ).toThrow(PlanArtifactIntegrityError);
    expect(() =>
      parsePlanArtifact({
        ...artifact,
        decision: { ...artifact.decision, schedule: { maxConcurrency: 2 } }
      })
    ).toThrow('Plan fingerprint does not match artifact content');
  });

  it('changes the plan fingerprint when policy authority changes', () => {
    const first = createArtifact();
    const second = createArtifact({
      sharedResourcePolicy: [{ id: 'lockfile', concurrency: 'exclusive' }]
    });

    expect(second.authority.sharedResourcePolicyFingerprint).not.toBe(
      first.authority.sharedResourcePolicyFingerprint
    );
    expect(second.planFingerprint).not.toBe(first.planFingerprint);
  });

  it('normalizes shared-resource accesses, modes, and risk signals before fingerprinting', () => {
    const impact = {
      ...preparedPlan.impacts[0],
      sharedResourceAccesses: [
        { resourceId: 'z-resource', modes: ['write', 'read', 'write'] as const },
        { resourceId: 'a-resource', modes: ['coordinate'] as const }
      ],
      riskSignals: [
        { type: 'high-fan-out' as const, detail: 'Z risk.' },
        { type: 'ambiguous-selector' as const, detail: 'A risk.' }
      ]
    };
    const first = createArtifact({ preparedPlan: { ...preparedPlan, impacts: [impact] } });
    const second = createArtifact({
      preparedPlan: {
        ...preparedPlan,
        impacts: [
          {
            ...impact,
            sharedResourceAccesses: impact.sharedResourceAccesses.toReversed(),
            riskSignals: impact.riskSignals.toReversed()
          }
        ]
      }
    });

    expect(first.decision.impacts[0].sharedResourceAccesses).toEqual([
      { resourceId: 'a-resource', modes: ['coordinate'] },
      { resourceId: 'z-resource', modes: ['read', 'write'] }
    ]);
    expect(first.decision.impacts[0].riskSignals).toEqual([
      { type: 'ambiguous-selector', detail: 'A risk.' },
      { type: 'high-fan-out', detail: 'Z risk.' }
    ]);
    expect(second.planFingerprint).toBe(first.planFingerprint);
  });

  it('reports every repository binding mismatch without treating a commit as the whole snapshot', () => {
    const artifact = createArtifact();
    const originalGraph = graph();
    const addedFile: FileNode = {
      id: 'core:src/c.ts',
      projectId: 'core',
      path: 'src/c.ts',
      isGenerated: false
    };
    const changedGraph: RepositoryGraph = {
      ...originalGraph,
      files: new Map<string, FileNode>([...originalGraph.files, ['core:src/c.ts', addedFile]])
    };

    expect(
      repositoryBindingMismatches(
        artifact,
        {
          ...snapshot,
          repositoryId: `sha256:${'4'.repeat(64)}`,
          baseCommit: '5'.repeat(40),
          workingTreeFingerprint: `sha256:${'6'.repeat(64)}`
        },
        changedGraph
      )
    ).toEqual(['repository-id', 'base-commit', 'working-tree', 'repository-facts']);
    expect(repositoryBindingMismatches(artifact, snapshot, graph())).toEqual([]);
  });

  it('rejects a repository that changes while facts are being analyzed', () => {
    expect(assertStableRepositorySnapshot(snapshot, { ...snapshot })).toEqual(snapshot);
    for (const changed of [
      { repositoryId: `sha256:${'8'.repeat(64)}` },
      { repositoryRoot: '/other' },
      { baseCommit: '8'.repeat(40) },
      { workingTreeFingerprint: `sha256:${'9'.repeat(64)}` },
      { dirty: false }
    ]) {
      expect(() => assertStableRepositorySnapshot(snapshot, { ...snapshot, ...changed })).toThrow(
        RepositorySnapshotChangedError
      );
    }
  });

  it('rejects non-canonical set serialization and hard/risk collection confusion', () => {
    const artifact = createArtifact();
    expect(() =>
      parsePlanArtifact({
        ...artifact,
        decision: {
          ...artifact.decision,
          impacts: [{ ...artifact.decision.impacts[0], filesWritten: ['z', 'a'] }]
        }
      })
    ).toThrow('Values must be unique and sorted');

    expect(() =>
      parsePlanArtifact({
        ...artifact,
        decision: { ...artifact.decision, riskConflicts: [hardConflict] }
      })
    ).toThrow('Risk conflict collection contains a hard conflict');
  });

  it('rejects incomplete task impacts, duplicate waves, and unknown semantic references', () => {
    const artifact = createArtifact();
    expect(() =>
      parsePlanArtifact({
        ...artifact,
        decision: { ...artifact.decision, impacts: [] }
      })
    ).toThrow('Collection must contain every task ID exactly once');
    expect(() =>
      parsePlanArtifact({
        ...artifact,
        decision: {
          ...artifact.decision,
          executionPlan: { waves: [{ index: 1, taskIds: ['task-a', 'task-a'] }] }
        }
      })
    ).toThrow();
    expect(() =>
      parsePlanArtifact({
        ...artifact,
        decision: {
          ...artifact.decision,
          semanticReview: {
            ...artifact.decision.semanticReview,
            requirements: [
              {
                ...artifact.decision.semanticReview.requirements[0],
                taskIds: ['unknown-task']
              }
            ]
          }
        }
      })
    ).toThrow('Semantic review references unknown task');
  });

  it('rejects conflict endpoints outside the specification and a risk in the hard collection', () => {
    const artifact = createArtifact();
    const risk = {
      taskA: 'task-a',
      taskB: 'unknown-task',
      score: 10,
      reasons: [],
      severity: 'soft' as const,
      constraints: [] as const,
      recommendedAction: 'guarded-parallel' as const
    };
    expect(() =>
      parsePlanArtifact({
        ...artifact,
        decision: { ...artifact.decision, hardConflicts: [risk] }
      })
    ).toThrow('Hard conflict collection contains a risk conflict');
    expect(() =>
      parsePlanArtifact({
        ...artifact,
        decision: { ...artifact.decision, riskConflicts: [risk] }
      })
    ).toThrow('Risk conflict references an unknown task');
  });

  it('rejects self-conflicts and duplicate unordered conflict pairs across collections', () => {
    const artifact = createArtifact({ preparedPlan: twoTaskPlan() });
    expect(() =>
      parsePlanArtifact({
        ...artifact,
        decision: {
          ...artifact.decision,
          hardConflicts: [{ ...hardConflict, taskB: 'task-a' }]
        }
      })
    ).toThrow('Task conflict cannot reference the same task twice');
    expect(() =>
      parsePlanArtifact({
        ...artifact,
        decision: {
          ...artifact.decision,
          hardConflicts: [hardConflict],
          riskConflicts: [riskConflict]
        }
      })
    ).toThrow('Duplicate task conflict pair');
  });

  it('rejects waves that violate dependencies or exceed the declared concurrency', () => {
    const artifact = createArtifact({ preparedPlan: twoTaskPlan() });
    expect(() =>
      parsePlanArtifact({
        ...artifact,
        decision: {
          ...artifact.decision,
          executionPlan: {
            waves: [
              { index: 0, taskIds: ['task-b'] },
              { index: 1, taskIds: ['task-a'] }
            ]
          }
        }
      })
    ).toThrow('Execution wave places dependency task-a no earlier than task-b');
    expect(() =>
      parsePlanArtifact({
        ...artifact,
        decision: {
          ...artifact.decision,
          executionPlan: { waves: [{ index: 0, taskIds: ['task-a', 'task-b'] }] }
        }
      })
    ).toThrow('Execution wave exceeds schedule maxConcurrency');
  });
});
