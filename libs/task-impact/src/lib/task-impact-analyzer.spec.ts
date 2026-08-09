import type {
  FileNode,
  ProjectNode,
  RepositoryGraph,
  SymbolNode
} from '@ai-native-software-delivery-orchestrator/domain';
import { taskContractSchema } from '@ai-native-software-delivery-orchestrator/domain';
import { describe, expect, it } from 'vitest';

import { SharedResourceRegistry } from './shared-resource-registry.js';
import { RepositoryTaskImpactAnalyzer, TaskImpactAnalysisError } from './task-impact-analyzer.js';

const projects: readonly ProjectNode[] = [
  {
    id: 'core',
    name: '@fixture/core',
    root: 'packages/core',
    packageJsonPath: 'packages/core/package.json',
    dependencies: [],
    scripts: {},
    sourceRoots: ['packages/core/src'],
    tsconfigPaths: ['packages/core/tsconfig.json']
  },
  {
    id: 'consumer',
    name: '@fixture/consumer',
    root: 'packages/consumer',
    packageJsonPath: 'packages/consumer/package.json',
    dependencies: [],
    scripts: {},
    sourceRoots: ['packages/consumer/src'],
    tsconfigPaths: ['packages/consumer/tsconfig.json']
  },
  {
    id: 'app',
    name: '@fixture/app',
    root: 'apps/app',
    packageJsonPath: 'apps/app/package.json',
    dependencies: [],
    scripts: {},
    sourceRoots: ['apps/app/src'],
    tsconfigPaths: ['apps/app/tsconfig.json']
  }
];

const files: readonly FileNode[] = [
  { id: 'core:index', projectId: 'core', path: 'packages/core/src/index.ts', isGenerated: false },
  {
    id: 'core:generated',
    projectId: 'core',
    path: 'packages/core/src/generated/model.ts',
    isGenerated: true
  },
  {
    id: 'consumer:index',
    projectId: 'consumer',
    path: 'packages/consumer/src/index.ts',
    isGenerated: false
  },
  {
    id: 'core:migration',
    projectId: 'core',
    path: 'packages/core/migrations/003-add-value.ts',
    isGenerated: false
  },
  { id: 'app:index', projectId: 'app', path: 'apps/app/src/index.ts', isGenerated: false }
];

const symbols: readonly SymbolNode[] = [
  {
    id: 'core:index:Service.search',
    fileId: 'core:index',
    name: 'search',
    path: 'Service.search',
    kind: 'method',
    exported: true
  },
  {
    id: 'consumer:index:search',
    fileId: 'consumer:index',
    name: 'search',
    path: 'Consumer.search',
    kind: 'method',
    exported: false
  },
  {
    id: 'consumer:index:run',
    fileId: 'consumer:index',
    name: 'run',
    path: 'Consumer.run',
    kind: 'method',
    exported: true
  },
  {
    id: 'core:migration:MigrationRunner.up',
    fileId: 'core:migration',
    name: 'up',
    path: 'MigrationRunner.up',
    kind: 'method',
    exported: true
  }
];

const graph: RepositoryGraph = {
  repositoryPath: '/fixture',
  projects: new Map(projects.map((project) => [project.id, project])),
  projectDependencies: [
    { from: 'app', to: 'consumer', sources: ['typescript-import'] },
    { from: 'consumer', to: 'core', sources: ['typescript-import'] }
  ],
  files: new Map(files.map((file) => [file.id, file])),
  symbols: new Map(symbols.map((symbol) => [symbol.id, symbol])),
  fileDependencies: [],
  symbolReferences: [],
  diagnostics: []
};

const registry = new SharedResourceRegistry({
  resources: [
    { id: 'manifests', files: [], paths: ['**/package.json'], concurrency: 'exclusive' },
    {
      id: 'generated-code',
      files: [],
      paths: ['**/generated/**'],
      concurrency: 'producer-controlled'
    },
    { id: 'migrations', files: [], paths: ['**/migrations/**'], concurrency: 'ordered' },
    { id: 'release-channel', files: [], paths: [], concurrency: 'exclusive' }
  ]
});

describe('SharedResourceRegistry', () => {
  it('validates unique resource IDs and matches exact files and glob paths', () => {
    expect(
      () =>
        new SharedResourceRegistry({
          resources: [
            { id: 'duplicate', files: ['pnpm-lock.yaml'], concurrency: 'exclusive' },
            { id: 'duplicate', paths: ['migrations/**'], concurrency: 'ordered' }
          ]
        })
    ).toThrow('Duplicate shared resource ID');

    const localRegistry = new SharedResourceRegistry({
      resources: [
        { id: 'lockfile', files: ['./pnpm-lock.yaml'], concurrency: 'exclusive' },
        { id: 'migrations', paths: ['migrations/**'], concurrency: 'ordered' }
      ]
    });

    expect(localRegistry.matchingFile('pnpm-lock.yaml').map((item) => item.id)).toEqual([
      'lockfile'
    ]);
    expect(localRegistry.matchingFile('migrations/001.sql').map((item) => item.id)).toEqual([
      'migrations'
    ]);
    expect(localRegistry.matchingGlob('migrations/**').map((item) => item.id)).toEqual([
      'migrations'
    ]);
    expect(localRegistry.list().map((item) => item.id)).toEqual(['lockfile', 'migrations']);
    expect(localRegistry.get('missing')).toBeUndefined();
  });
});

describe('RepositoryTaskImpactAnalyzer', () => {
  it('resolves selectors, ancestry, downstream projects, resource rules, and honest risk signals', async () => {
    const analyzer = new RepositoryTaskImpactAnalyzer(registry, { highFanOutProjectCount: 2 });
    const task = taskContractSchema.parse({
      id: 'change-search',
      title: 'Change search internals',
      goal: 'Improve search behavior',
      dependencies: [],
      expectedReads: [
        { type: 'project', value: '@fixture/consumer' },
        { type: 'symbol', value: 'Consumer.run' },
        { type: 'shared-resource', value: 'generated-code' }
      ],
      expectedWrites: [
        { type: 'symbol', value: 'Service.search' },
        { type: 'glob', value: '**/generated/**' },
        { type: 'file', value: 'packages/core/package.json' }
      ],
      sharedResources: ['release-channel'],
      verification: []
    });

    const impact = await analyzer.analyze(task, graph);

    expect([...impact.projectsRead]).toEqual(['consumer']);
    expect([...impact.projectsWritten]).toEqual(['core']);
    expect([...impact.filesRead]).toEqual(['consumer:index']);
    expect([...impact.filesWritten]).toEqual(['core:generated', 'core:index']);
    expect([...impact.symbolsRead]).toEqual(['consumer:index:run']);
    expect([...impact.symbolsWritten]).toEqual(['core:index:Service.search']);
    expect([...impact.sharedResources]).toEqual(['generated-code', 'manifests', 'release-channel']);
    expect(impact.sharedResourceAccesses).toEqual([
      { resourceId: 'generated-code', modes: ['read', 'write'] },
      { resourceId: 'manifests', modes: ['read', 'write'] },
      { resourceId: 'release-channel', modes: ['coordinate'] }
    ]);
    expect([...impact.downstreamProjects]).toEqual(['app', 'consumer']);
    expect(impact.riskSignals.map((signal) => signal.type)).toEqual([
      'generated-artifact',
      'high-fan-out',
      'public-api-touch'
    ]);
    expect(
      impact.riskSignals.find((signal) => signal.type === 'public-api-touch')?.detail
    ).toContain('no signature change is claimed');
  });

  it('reports unresolved and ambiguous exact selectors without treating glob fan-out as ambiguous', async () => {
    const analyzer = new RepositoryTaskImpactAnalyzer(registry);
    const task = taskContractSchema.parse({
      id: 'ambiguous',
      title: 'Exercise selector diagnostics',
      goal: 'Keep predictions explainable',
      dependencies: [],
      expectedReads: [
        { type: 'symbol', value: 'search' },
        { type: 'file', value: 'missing.ts' },
        { type: 'project', value: 'missing-project' },
        { type: 'glob', value: '**/src/index.ts' }
      ],
      expectedWrites: [],
      sharedResources: [],
      verification: []
    });

    const impact = await analyzer.analyze(task, graph);

    expect(impact.riskSignals).toHaveLength(3);
    expect(impact.riskSignals.map((signal) => signal.detail)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('symbol:search matched 2'),
        expect.stringContaining('file:missing.ts matched 0'),
        expect.stringContaining('project:missing-project matched 0')
      ])
    );
    expect([...impact.filesRead]).toEqual(['app:index', 'consumer:index', 'core:index']);
  });

  it('applies registry rules to symbol and whole-project selectors', async () => {
    const analyzer = new RepositoryTaskImpactAnalyzer(registry);
    const symbolTask = taskContractSchema.parse({
      id: 'symbol-migration',
      title: 'Change migration runner',
      goal: 'Update a migration symbol',
      dependencies: [],
      expectedReads: [],
      expectedWrites: [{ type: 'symbol', value: 'MigrationRunner.up' }],
      sharedResources: [],
      verification: []
    });
    const projectTask = taskContractSchema.parse({
      id: 'project-change',
      title: 'Change the core project',
      goal: 'Update the project scope',
      dependencies: [],
      expectedReads: [],
      expectedWrites: [{ type: 'project', value: 'core' }],
      sharedResources: [],
      verification: []
    });

    const symbolImpact = await analyzer.analyze(symbolTask, graph);
    const projectImpact = await analyzer.analyze(projectTask, graph);

    expect(symbolImpact.sharedResourceAccesses).toContainEqual({
      resourceId: 'migrations',
      modes: ['write']
    });
    expect([...projectImpact.sharedResources]).toEqual([
      'generated-code',
      'manifests',
      'migrations'
    ]);
    expect(projectImpact.filesWritten.size).toBe(0);
  });

  it('fails fast with stable structured evidence for explicitly unknown resources', async () => {
    const analyzer = new RepositoryTaskImpactAnalyzer(registry);
    const task = taskContractSchema.parse({
      id: 'unknown-resources',
      title: 'Use unknown resources',
      goal: 'Reject unsafe configuration typos',
      dependencies: [],
      expectedReads: [{ type: 'shared-resource', value: 'alpha-unknown' }],
      expectedWrites: [],
      sharedResources: ['zeta-unknown'],
      verification: []
    });

    await expect(analyzer.analyze(task, graph)).rejects.toMatchObject({
      name: 'TaskImpactAnalysisError',
      message: 'Unknown shared resource IDs: alpha-unknown, zeta-unknown',
      code: 'UNKNOWN_SHARED_RESOURCE',
      resourceIds: ['alpha-unknown', 'zeta-unknown']
    } satisfies Partial<TaskImpactAnalysisError>);
  });
});
