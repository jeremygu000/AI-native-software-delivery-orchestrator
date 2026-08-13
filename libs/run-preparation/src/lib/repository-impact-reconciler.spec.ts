import type {
  TaskImpactReconciliationRequest,
  WriteLease
} from '@ai-native-software-delivery-orchestrator/domain';
import type { RepositoryGraph } from '@ai-native-software-delivery-orchestrator/domain';
import { describe, expect, it } from 'vitest';

import { RepositoryResourceResolver } from './local-runtime-starter.js';
import { RepositoryImpactReconciler } from './repository-impact-reconciler.js';

const graph: RepositoryGraph = {
  repositoryPath: '/repository',
  projects: new Map([
    [
      'core',
      {
        id: 'core',
        name: 'core',
        root: '.',
        packageJsonPath: 'package.json',
        dependencies: [],
        scripts: {},
        sourceRoots: ['.'],
        tsconfigPaths: []
      }
    ]
  ]),
  projectDependencies: [],
  files: new Map([
    [
      'core:approved.txt',
      { id: 'core:approved.txt', projectId: 'core', path: 'approved.txt', isGenerated: false }
    ],
    [
      'core:extra.txt',
      { id: 'core:extra.txt', projectId: 'core', path: 'extra.txt', isGenerated: false }
    ]
  ]),
  symbols: new Map(),
  fileDependencies: [],
  symbolReferences: [],
  diagnostics: []
};

const request = (): TaskImpactReconciliationRequest => ({
  runId: 'run-1',
  taskId: 'task-1',
  impact: {
    predicted: {
      taskId: 'task-1',
      projectsRead: new Set(),
      projectsWritten: new Set(),
      explicitProjectsWritten: new Set(),
      filesRead: new Set(),
      filesWritten: new Set(['core:approved.txt']),
      explicitFilesWritten: new Set(['core:approved.txt']),
      globFilesWritten: new Set(),
      symbolDerivedFilesWritten: new Set(),
      symbolsRead: new Set(),
      symbolsWritten: new Set(),
      sharedResources: new Set(),
      sharedResourceAccesses: [],
      downstreamProjects: new Set(),
      riskSignals: []
    }
  },
  leases: [
    {
      id: 'lease-approved',
      runId: 'run-1',
      agentId: 'agent-1',
      taskId: 'task-1',
      resource: { type: 'file', projectId: 'core', fileId: 'core:approved.txt' },
      mode: 'exclusive',
      version: 1,
      state: 'ACTIVE',
      acquiredAt: new Date('2026-08-13T00:00:00.000Z'),
      lastHeartbeatAt: new Date('2026-08-13T00:00:00.000Z')
    }
  ],
  workspace: {
    id: 'workspace-1',
    runId: 'run-1',
    taskId: 'task-1',
    integrationRepositoryPath: '/repository',
    workspacePath: '/workspace',
    branchName: 'task-1',
    baseRef: 'base',
    integrationRef: 'main',
    revision: 1,
    phase: 'READY_TO_INTEGRATE'
  }
});

const reconciler = (
  changes: readonly { readonly kind: 'created' | 'modified' | 'deleted'; readonly path: string }[]
) =>
  new RepositoryImpactReconciler({
    changes: { inspect: async () => changes },
    resources: new RepositoryResourceResolver(graph)
  });

describe('RepositoryImpactReconciler', () => {
  it('records actual Git changes rather than trusting agent-reported impact', async () => {
    const result = await reconciler([{ kind: 'modified', path: 'approved.txt' }]).reconcile({
      ...request(),
      reportedImpact: {
        taskId: 'task-1',
        filesRead: new Set(),
        filesCreated: new Set(),
        filesWritten: new Set(),
        filesDeleted: new Set(),
        symbolsWritten: new Set(),
        dependencyRequests: new Set(),
        manifestFilesChanged: new Set(),
        generatedFilesChanged: new Set()
      }
    });

    expect(result).toMatchObject({
      observed: { filesWritten: new Set(['core:approved.txt']) },
      reconciliation: { status: 'within-predicted-scope' }
    });
  });

  it('preserves leased scope expansion evidence for later scheduling policy', async () => {
    const base = request();
    const expanded = {
      ...base,
      leases: [
        ...base.leases,
        {
          ...base.leases[0],
          id: 'lease-extra',
          resource: { type: 'file' as const, projectId: 'core', fileId: 'core:extra.txt' }
        } satisfies WriteLease
      ]
    };

    await expect(
      reconciler([{ kind: 'created', path: 'extra.txt' }]).reconcile(expanded)
    ).resolves.toMatchObject({
      reconciliation: {
        status: 'runtime-scope-expanded',
        expandedFileIds: new Set(['core:extra.txt'])
      }
    });
  });

  it('fails closed when the actual change has no active lease', async () => {
    await expect(
      reconciler([{ kind: 'modified', path: 'extra.txt' }]).reconcile(request())
    ).resolves.toMatchObject({
      reconciliation: { status: 'unleased-change', unleasedFileIds: new Set(['core:extra.txt']) }
    });
  });
});
