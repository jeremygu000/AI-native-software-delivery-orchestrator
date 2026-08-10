import type {
  FileNode,
  PredictedTaskImpact,
  ProjectNode,
  RepositoryGraph,
  SharedResourceAccess,
  SymbolNode
} from '@ai-native-software-delivery-orchestrator/domain';
import { taskContractSchema } from '@ai-native-software-delivery-orchestrator/domain';
import {
  RepositoryTaskImpactAnalyzer,
  SharedResourceRegistry
} from '@ai-native-software-delivery-orchestrator/task-impact';
import { describe, expect, it } from 'vitest';

import {
  conflictEngineConfigSchema,
  defaultConflictEngineConfig,
  DeterministicConflictEngine
} from './conflict-engine.js';

const projects: readonly ProjectNode[] = ['core', 'consumer', 'other'].map((id) => ({
  id,
  name: id,
  root: `packages/${id}`,
  packageJsonPath: `packages/${id}/package.json`,
  dependencies: [],
  scripts: {},
  sourceRoots: [`packages/${id}/src`],
  tsconfigPaths: [`packages/${id}/tsconfig.json`]
}));

const files: readonly FileNode[] = [
  { id: 'core:file', projectId: 'core', path: 'packages/core/src/index.ts', isGenerated: false },
  {
    id: 'core:generated',
    projectId: 'core',
    path: 'packages/core/src/generated.ts',
    isGenerated: true
  },
  {
    id: 'consumer:file',
    projectId: 'consumer',
    path: 'packages/consumer/src/index.ts',
    isGenerated: false
  },
  { id: 'other:file', projectId: 'other', path: 'packages/other/src/index.ts', isGenerated: false }
];

const symbols: readonly SymbolNode[] = [
  {
    id: 'core:file:Service.first',
    fileId: 'core:file',
    name: 'first',
    path: 'Service.first',
    kind: 'method',
    exported: true
  },
  {
    id: 'core:file:Service.second',
    fileId: 'core:file',
    name: 'second',
    path: 'Service.second',
    kind: 'method',
    exported: true
  }
];

const graph: RepositoryGraph = {
  repositoryPath: '/fixture',
  projects: new Map(projects.map((project) => [project.id, project])),
  projectDependencies: [{ from: 'consumer', to: 'core', sources: ['typescript-import'] }],
  files: new Map(files.map((file) => [file.id, file])),
  symbols: new Map(symbols.map((symbol) => [symbol.id, symbol])),
  fileDependencies: [],
  symbolReferences: [],
  diagnostics: []
};

const registry = new SharedResourceRegistry({
  resources: [
    { id: 'lockfile', files: ['pnpm-lock.yaml'], concurrency: 'exclusive' },
    { id: 'migrations', paths: ['migrations/**'], concurrency: 'ordered' },
    { id: 'generated-code', paths: ['generated/**'], concurrency: 'producer-controlled' },
    { id: 'core-stream', paths: ['packages/core/src/**'], concurrency: 'ordered' }
  ]
});

const impact = (
  taskId: string,
  overrides: Partial<PredictedTaskImpact> = {},
  sharedResourceAccesses: readonly SharedResourceAccess[] = []
): PredictedTaskImpact => ({
  taskId,
  projectsRead: new Set(),
  projectsWritten: new Set(),
  explicitProjectsWritten: new Set(),
  filesRead: new Set(),
  filesWritten: new Set(),
  explicitFilesWritten: new Set(),
  globFilesWritten: new Set(),
  symbolDerivedFilesWritten: new Set(),
  symbolsRead: new Set(),
  symbolsWritten: new Set(),
  sharedResources: new Set(sharedResourceAccesses.map((access) => access.resourceId)),
  sharedResourceAccesses,
  downstreamProjects: new Set(),
  riskSignals: [],
  ...overrides
});

describe('DeterministicConflictEngine', () => {
  it('preserves an ordered-resource constraint across symbol and file selectors', async () => {
    const analyzer = new RepositoryTaskImpactAnalyzer(registry);
    const engine = new DeterministicConflictEngine(registry);
    const symbolTask = taskContractSchema.parse({
      id: 'symbol-task',
      title: 'Change a symbol',
      goal: 'Update one producer symbol',
      dependencies: [],
      expectedReads: [],
      expectedWrites: [{ type: 'symbol', value: 'Service.first' }],
      sharedResources: [],
      verification: []
    });
    const fileTask = taskContractSchema.parse({
      id: 'file-task',
      title: 'Change another file',
      goal: 'Update another file in the ordered stream',
      dependencies: [],
      expectedReads: [],
      expectedWrites: [{ type: 'file', value: 'packages/core/src/generated.ts' }],
      sharedResources: [],
      verification: []
    });

    const symbolImpact = await analyzer.analyze(symbolTask, graph);
    const fileImpact = await analyzer.analyze(fileTask, graph);
    const conflict = engine.compare(symbolImpact, fileImpact, graph);

    expect(symbolImpact.sharedResources.has('core-stream')).toBe(true);
    expect(fileImpact.sharedResources.has('core-stream')).toBe(true);
    expect(conflict.severity).toBe('hard');
    expect(conflict.constraints).toContainEqual(
      expect.objectContaining({ type: 'ordered-resource', resourceIds: ['core-stream'] })
    );
    expect(conflict.recommendedAction).toBe('stagger');
  });

  it('returns a stable no-conflict result for independent tasks', () => {
    const engine = new DeterministicConflictEngine(registry);

    expect(
      engine.compare(
        impact('b', { projectsWritten: new Set(['other']) }),
        impact('a', { projectsWritten: new Set(['core']) }),
        graph
      )
    ).toEqual({
      taskA: 'a',
      taskB: 'b',
      score: 0,
      reasons: [],
      severity: 'none',
      constraints: [],
      recommendedAction: 'parallel'
    });
  });

  it('makes an exact same-symbol write hard even when its configured score is zero', () => {
    const engine = new DeterministicConflictEngine(registry, {
      ...defaultConflictEngineConfig,
      weights: { ...defaultConflictEngineConfig.weights, sameSymbol: 0, sameFile: 0 }
    });
    const common = {
      projectsWritten: new Set(['core']),
      filesWritten: new Set(['core:file']),
      symbolsWritten: new Set(['core:file:Service.first'])
    };

    const conflict = engine.compare(impact('a', common), impact('b', common), graph);

    expect(conflict.severity).toBe('hard');
    expect(conflict.score).toBe(15);
    expect(conflict.constraints).toContainEqual(
      expect.objectContaining({ type: 'same-symbol-write' })
    );
    expect(conflict.recommendedAction).toBe('serialize');
  });

  it('scores sibling-symbol writes in one file without inventing a hard constraint', () => {
    const engine = new DeterministicConflictEngine(registry);

    const conflict = engine.compare(
      impact('a', {
        projectsWritten: new Set(['core']),
        filesWritten: new Set(['core:file']),
        symbolDerivedFilesWritten: new Set(['core:file']),
        symbolsWritten: new Set(['core:file:Service.first'])
      }),
      impact('b', {
        projectsWritten: new Set(['core']),
        filesWritten: new Set(['core:file']),
        symbolDerivedFilesWritten: new Set(['core:file']),
        symbolsWritten: new Set(['core:file:Service.second'])
      }),
      graph
    );

    expect(conflict.severity).toBe('soft');
    expect(conflict.score).toBe(45);
    expect(conflict.reasons.map((reason) => reason.type)).toEqual([
      'same-file-different-symbol',
      'same-project'
    ]);
    expect(conflict.recommendedAction).toBe('guarded-parallel');
  });

  it('does not downgrade explicit whole-file ownership to sibling-symbol risk', () => {
    const engine = new DeterministicConflictEngine(registry);
    const conflict = engine.compare(
      impact('a', {
        projectsWritten: new Set(['core']),
        filesWritten: new Set(['core:file']),
        explicitFilesWritten: new Set(['core:file']),
        symbolDerivedFilesWritten: new Set(['core:file']),
        symbolsWritten: new Set(['core:file:Service.first'])
      }),
      impact('b', {
        projectsWritten: new Set(['core']),
        filesWritten: new Set(['core:file']),
        symbolDerivedFilesWritten: new Set(['core:file']),
        symbolsWritten: new Set(['core:file:Service.second'])
      }),
      graph
    );

    expect(conflict.reasons.map((reason) => reason.type)).toContain('same-file');
    expect(conflict.reasons.map((reason) => reason.type)).not.toContain(
      'same-file-different-symbol'
    );
  });

  it.each([
    {
      label: 'project selector',
      broaderImpact: {
        projectsWritten: new Set(['core']),
        explicitProjectsWritten: new Set(['core'])
      }
    },
    {
      label: 'glob selector',
      broaderImpact: {
        projectsWritten: new Set(['core']),
        filesWritten: new Set(['core:file']),
        globFilesWritten: new Set(['core:file'])
      }
    }
  ])('treats a $label covering a symbol file as whole-file conflict', ({ broaderImpact }) => {
    const engine = new DeterministicConflictEngine(registry);
    const conflict = engine.compare(
      impact('broad', broaderImpact),
      impact('symbol', {
        projectsWritten: new Set(['core']),
        filesWritten: new Set(['core:file']),
        symbolDerivedFilesWritten: new Set(['core:file']),
        symbolsWritten: new Set(['core:file:Service.second'])
      }),
      graph
    );

    expect(conflict.reasons.map((reason) => reason.type)).toContain('same-file');
    expect(conflict.reasons.map((reason) => reason.type)).not.toContain(
      'same-file-different-symbol'
    );
  });

  it.each([
    ['lockfile', 'exclusive-resource', 'serialize'],
    ['migrations', 'ordered-resource', 'stagger'],
    ['generated-code', 'producer-controlled-resource', 'serialize']
  ] as const)(
    'enforces the %s registry policy as a structural constraint',
    (resourceId, type, action) => {
      const engine = new DeterministicConflictEngine(registry);
      const access = [{ resourceId, modes: ['write'] as const }];

      const conflict = engine.compare(impact('a', {}, access), impact('b', {}, access), graph);

      expect(conflict.severity).toBe('hard');
      expect(conflict.constraints).toContainEqual(expect.objectContaining({ type }));
      expect(conflict.recommendedAction).toBe(action);
    }
  );

  it('permits concurrent producer-controlled reads but treats unregistered coordination as risk', () => {
    const engine = new DeterministicConflictEngine(registry);
    const reads = [{ resourceId: 'generated-code', modes: ['read'] as const }];
    const unknown = [{ resourceId: 'unknown', modes: ['coordinate'] as const }];

    expect(engine.compare(impact('a', {}, reads), impact('b', {}, reads), graph).severity).toBe(
      'none'
    );
    const conflict = engine.compare(impact('a', {}, unknown), impact('b', {}, unknown), graph);
    expect(conflict.severity).toBe('soft');
    expect(conflict.score).toBe(70);
    expect(conflict.recommendedAction).toBe('stagger');
  });

  it.each([
    ['a-producer', 'z-consumer'],
    ['z-producer', 'a-consumer']
  ])(
    'preserves producer %s to consumer %s direction independently of canonical pair order',
    (producerTaskId, consumerTaskId) => {
      const engine = new DeterministicConflictEngine(registry);
      const writes = [{ resourceId: 'generated-code', modes: ['write'] as const }];
      const reads = [{ resourceId: 'generated-code', modes: ['read'] as const }];

      const conflict = engine.compare(
        impact(producerTaskId, {}, writes),
        impact(consumerTaskId, {}, reads),
        graph
      );

      expect(conflict.severity).toBe('hard');
      expect(conflict.constraints).toContainEqual({
        type: 'producer-consumer',
        detail: `${producerTaskId} produces generated-code for ${consumerTaskId}.`,
        resourceIds: ['generated-code'],
        producerTaskId,
        consumerTaskId
      });
      expect(conflict.recommendedAction).toBe('stagger');
    }
  );

  it('enforces exclusive access even when both task contracts declare reads', () => {
    const engine = new DeterministicConflictEngine(registry);
    const reads = [{ resourceId: 'lockfile', modes: ['read'] as const }];

    const conflict = engine.compare(impact('a', {}, reads), impact('b', {}, reads), graph);

    expect(conflict.severity).toBe('hard');
    expect(conflict.constraints).toContainEqual(
      expect.objectContaining({ type: 'exclusive-resource' })
    );
  });

  it('reports producer-consumer, generated-code, project propagation, and API-touch reasons', () => {
    const engine = new DeterministicConflictEngine(registry);
    const conflict = engine.compare(
      impact('producer', {
        projectsWritten: new Set(['core']),
        filesWritten: new Set(['core:generated']),
        symbolsWritten: new Set(['core:file:Service.first']),
        downstreamProjects: new Set(['consumer']),
        riskSignals: [
          { type: 'public-api-touch', detail: 'exported symbol touched' },
          { type: 'high-fan-out', detail: 'many consumers' }
        ]
      }),
      impact('consumer', {
        projectsRead: new Set(['consumer']),
        filesRead: new Set(['core:generated']),
        symbolsRead: new Set(['core:file:Service.first'])
      }),
      graph
    );

    expect(conflict.score).toBe(100);
    expect(conflict.reasons.map((reason) => reason.type)).toEqual([
      'generated-code',
      'high-fan-out',
      'producer-consumer',
      'public-api-touch',
      'upstream-downstream-project'
    ]);
    expect(conflict.recommendedAction).toBe('serialize');
  });

  it('does not create pairwise risk from fan-out signals when the other task is independent', () => {
    const engine = new DeterministicConflictEngine(registry);
    const conflict = engine.compare(
      impact('core-change', {
        projectsWritten: new Set(['core']),
        downstreamProjects: new Set(['consumer']),
        riskSignals: [
          { type: 'public-api-touch', detail: 'exported symbol touched' },
          { type: 'high-fan-out', detail: 'many consumers' }
        ]
      }),
      impact('independent', { projectsWritten: new Set(['other']) }),
      graph
    );

    expect(conflict.severity).toBe('none');
    expect(conflict.score).toBe(0);
  });

  it('distinguishes unscoped same-file and generated overlapping writes', () => {
    const engine = new DeterministicConflictEngine(registry);
    const common = {
      projectsWritten: new Set(['core']),
      filesWritten: new Set(['core:generated'])
    };

    const conflict = engine.compare(impact('a', common), impact('b', common), graph);

    expect(conflict.reasons.map((reason) => reason.type)).toEqual([
      'generated-code',
      'same-file',
      'same-project'
    ]);
    expect(conflict.score).toBe(100);
  });
});

describe('conflictEngineConfigSchema', () => {
  it('rejects non-monotonic action thresholds', () => {
    expect(() =>
      conflictEngineConfigSchema.parse({
        ...defaultConflictEngineConfig,
        thresholds: { guardedParallel: 50, stagger: 40, serialize: 90 }
      })
    ).toThrow('monotonically increasing');
  });

  it('keeps a zero-score result parallel when guardedParallel is configured as zero', () => {
    const engine = new DeterministicConflictEngine(registry, {
      ...defaultConflictEngineConfig,
      thresholds: { guardedParallel: 0, stagger: 60, serialize: 90 }
    });

    const conflict = engine.compare(impact('a'), impact('b'), graph);

    expect(conflict.severity).toBe('none');
    expect(conflict.score).toBe(0);
    expect(conflict.recommendedAction).toBe('parallel');
  });
});
