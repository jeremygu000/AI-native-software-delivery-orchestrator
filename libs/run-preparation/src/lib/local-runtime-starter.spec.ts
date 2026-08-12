import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PiSessionGateway } from '@ai-native-software-delivery-orchestrator/agent-runtime';
import type {
  RepositoryGraph,
  RunAuthorityEvidence
} from '@ai-native-software-delivery-orchestrator/domain';
import { DrizzleSqliteOrchestrationPersistence } from '@ai-native-software-delivery-orchestrator/persistence';
import type { StartRuntimeRunRequest } from '@ai-native-software-delivery-orchestrator/orchestration-runtime';
import { GitIntegrationCheckoutProvisioner } from '@ai-native-software-delivery-orchestrator/workspace-git';
import { afterEach, describe, expect, it } from 'vitest';

import {
  LocalRuntimeStarter,
  PnpmTaskVerifier,
  RepositoryResourceResolver
} from './local-runtime-starter.js';

const directories: string[] = [];
const git = (cwd: string, args: readonly string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const createRepository = (): { readonly path: string; readonly commit: string } => {
  const path = mkdtempSync(join(tmpdir(), 'forge-local-runtime-source-'));
  directories.push(path);
  git(path, ['init', '--initial-branch=main']);
  git(path, ['config', 'user.email', 'test@example.com']);
  git(path, ['config', 'user.name', 'Test User']);
  writeFileSync(
    join(path, 'package.json'),
    JSON.stringify({
      name: 'core',
      version: '1.0.0',
      scripts: { test: 'node -e "process.exit(0)"' }
    })
  );
  writeFileSync(join(path, 'value.txt'), 'approved\n');
  git(path, ['add', '.']);
  git(path, ['commit', '-m', 'approved']);
  return { path, commit: git(path, ['rev-parse', 'HEAD']) };
};

const authority = (commit: string): RunAuthorityEvidence => ({
  artifactId: 'plan-1',
  artifactRevision: 1,
  approvalId: 'approval-1',
  planFingerprint: `sha256:${'1'.repeat(64)}`,
  approvalFingerprint: `sha256:${'2'.repeat(64)}`,
  claimFingerprint: `sha256:${'3'.repeat(64)}`,
  executionFingerprint: `sha256:${'4'.repeat(64)}`,
  repositoryRoot: '/source',
  baseCommit: commit,
  workingTreeFingerprint: `sha256:${'5'.repeat(64)}`,
  repositoryFactsFingerprint: `sha256:${'6'.repeat(64)}`,
  sharedResourcePolicyFingerprint: `sha256:${'7'.repeat(64)}`,
  verificationPolicyFingerprint: `sha256:${'8'.repeat(64)}`
});

afterEach(() => {
  for (const directory of directories.splice(0).toReversed()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('LocalRuntimeStarter', () => {
  it('executes a controlled Pi edit through real worktrees, verification, integration, and SQLite', async () => {
    const repository = createRepository();
    const runRoot = mkdtempSync(join(tmpdir(), 'forge-local-runtime-runs-'));
    directories.push(runRoot);
    const checkout = await new GitIntegrationCheckoutProvisioner(runRoot).provision({
      runId: 'run-1',
      sourceRepositoryPath: repository.path,
      baseCommit: repository.commit
    });
    const graph: RepositoryGraph = {
      repositoryPath: repository.path,
      projects: new Map([
        [
          'core',
          {
            id: 'core',
            name: 'core',
            root: '.',
            packageJsonPath: 'package.json',
            dependencies: [],
            scripts: { test: 'node -e "process.exit(0)"' },
            sourceRoots: ['.'],
            tsconfigPaths: []
          }
        ]
      ]),
      projectDependencies: [],
      files: new Map([
        [
          'core:value.txt',
          { id: 'core:value.txt', projectId: 'core', path: 'value.txt', isGenerated: false }
        ]
      ]),
      symbols: new Map(),
      fileDependencies: [],
      symbolReferences: [],
      diagnostics: []
    };
    const gateway: PiSessionGateway = {
      start: async ({ executeTool, onStarted }) => {
        await onStarted('session-1');
        const result = await executeTool({
          name: 'forge_edit',
          path: 'value.txt',
          expected: 'approved\n',
          replacement: 'executed\n'
        });
        expect(result.isError).not.toBe(true);
        return { sessionId: 'session-1' };
      }
    };
    const predicted = {
      taskId: 'task-1',
      projectsRead: new Set<string>(),
      projectsWritten: new Set<string>(),
      explicitProjectsWritten: new Set<string>(),
      filesRead: new Set<string>(),
      filesWritten: new Set(['core:value.txt']),
      explicitFilesWritten: new Set(['core:value.txt']),
      globFilesWritten: new Set<string>(),
      symbolDerivedFilesWritten: new Set<string>(),
      symbolsRead: new Set<string>(),
      symbolsWritten: new Set<string>(),
      sharedResources: new Set<string>(),
      sharedResourceAccesses: [],
      downstreamProjects: new Set<string>(),
      riskSignals: []
    };
    const request: StartRuntimeRunRequest = {
      run: {
        id: 'run-1',
        repositoryId: `sha256:${'9'.repeat(64)}`,
        state: 'ACTIVE',
        createdAt: '2026-08-13T00:00:00.000Z',
        authority: authority(repository.commit)
      },
      tasks: [
        {
          id: 'task-1',
          title: 'Edit value',
          goal: 'Edit the approved file',
          dependencies: [],
          expectedReads: [],
          expectedWrites: [{ type: 'file', value: 'core:value.txt' }],
          sharedResources: [],
          verification: [{ type: 'package-script', packageName: 'core', script: 'test' }]
        }
      ],
      hardConflicts: [],
      riskConflicts: [],
      scheduleOptions: { maxConcurrency: 1 },
      taskBindings: [
        {
          taskId: 'task-1',
          agentId: 'agent-1',
          leasePlan: {
            taskId: 'task-1',
            predictedResources: [{ type: 'file', projectId: 'core', fileId: 'core:value.txt' }],
            source: 'predicted-impact'
          },
          impact: { predicted },
          workspace: {
            id: 'workspace-1',
            runId: 'run-1',
            taskId: 'task-1',
            integrationRepositoryPath: checkout.repositoryPath,
            workspacePath: join(runRoot, 'run-1', 'tasks', 'task-1'),
            branchName: 'forge/task/run-1/task-1',
            baseRef: checkout.baseCommit,
            integrationRef: checkout.integrationRef
          }
        }
      ]
    };
    const databasePath = join(runRoot, 'run-1', 'run.sqlite');
    const runtime = new LocalRuntimeStarter({ graph, databasePath, gateway });

    const result = await runtime.startOrResumeRun(request);
    const retried = await runtime.startOrResumeRun(request);
    runtime.close();

    expect(result).toMatchObject({
      run: {
        state: 'COMPLETED',
        authority: { executionFingerprint: request.run.authority.executionFingerprint }
      },
      snapshot: { taskStates: [{ taskId: 'task-1', state: 'COMPLETED' }] }
    });
    expect(readFileSync(join(checkout.repositoryPath, 'value.txt'), 'utf8')).toBe('executed\n');
    expect(retried.run.state).toBe('COMPLETED');
    const persistence = new DrizzleSqliteOrchestrationPersistence(databasePath);
    await expect(persistence.recoverRun('run-1')).resolves.toMatchObject({
      run: { authority: request.run.authority },
      workspaces: [{ workspace: { phase: 'INTEGRATED' } }],
      attempts: [{ attempt: { state: 'COMPLETED', sessionRef: { value: 'session-1' } } }]
    });
    persistence.close();
  });

  it('resolves existing and new files to their most specific project boundary', () => {
    const graph: RepositoryGraph = {
      repositoryPath: '/repository',
      projects: new Map([
        [
          'root',
          {
            id: 'root',
            name: 'root',
            root: '.',
            packageJsonPath: 'package.json',
            dependencies: [],
            scripts: {},
            sourceRoots: [],
            tsconfigPaths: []
          }
        ],
        [
          'api',
          {
            id: 'api',
            name: 'api',
            root: 'packages/api/',
            packageJsonPath: 'packages/api/package.json',
            dependencies: [],
            scripts: {},
            sourceRoots: [],
            tsconfigPaths: []
          }
        ]
      ]),
      projectDependencies: [],
      files: new Map([
        [
          'api:known.ts',
          {
            id: 'api:known.ts',
            projectId: 'api',
            path: 'packages/api/known.ts',
            isGenerated: false
          }
        ]
      ]),
      symbols: new Map(),
      fileDependencies: [],
      symbolReferences: [],
      diagnostics: []
    };
    const resolver = new RepositoryResourceResolver(graph);

    expect(resolver.resolve('packages/api/known.ts')).toEqual({
      type: 'file',
      projectId: 'api',
      fileId: 'api:known.ts'
    });
    expect(resolver.resolve('packages/api/new.ts')).toEqual({
      type: 'file',
      projectId: 'api',
      fileId: 'api:packages/api/new.ts'
    });
    expect(resolver.fileId('root-new.ts')).toBe('root:root-new.ts');
    expect(() =>
      new RepositoryResourceResolver({ ...graph, projects: new Map(), files: new Map() }).resolve(
        'unowned.ts'
      )
    ).toThrow('does not belong to an approved project');
    const databaseDirectory = mkdtempSync(join(tmpdir(), 'forge-default-gateway-'));
    directories.push(databaseDirectory);
    const starter = new LocalRuntimeStarter({
      graph,
      databasePath: join(databaseDirectory, 'run.sqlite')
    });
    starter.close();
  });

  it('fails closed for free-form and failing package verification rules', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'forge-verifier-'));
    directories.push(workspacePath);
    writeFileSync(
      join(workspacePath, 'package.json'),
      JSON.stringify({
        name: 'core',
        version: '1.0.0',
        scripts: {
          pass: 'node -e "process.exit(0)"',
          fail: 'node -e "process.exit(2)"'
        }
      })
    );
    const workspace = {
      id: 'workspace-1',
      runId: 'run-1',
      taskId: 'task-1',
      integrationRepositoryPath: workspacePath,
      workspacePath,
      branchName: 'task-1',
      baseRef: 'main',
      integrationRef: 'main',
      revision: 1,
      phase: 'READY_TO_INTEGRATE' as const
    };
    const verifier = new PnpmTaskVerifier();

    const previousNodeOptions = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = '--definitely-not-a-valid-node-option';
    try {
      await expect(
        verifier.verify({
          runId: 'run-1',
          workspace,
          task: {
            id: 'task-1',
            title: 'Task',
            goal: 'Task',
            dependencies: [],
            expectedReads: [],
            expectedWrites: [],
            sharedResources: [],
            verification: [{ type: 'package-script', packageName: 'core', script: 'pass' }]
          }
        })
      ).resolves.toEqual({ status: 'passed' });
    } finally {
      if (previousNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS;
      } else {
        process.env.NODE_OPTIONS = previousNodeOptions;
      }
    }

    await expect(
      verifier.verify({
        runId: 'run-1',
        workspace,
        task: {
          id: 'task-1',
          title: 'Task',
          goal: 'Task',
          dependencies: [],
          expectedReads: [],
          expectedWrites: [],
          sharedResources: [],
          verification: [{ type: 'command', command: 'anything' }]
        }
      })
    ).resolves.toMatchObject({ status: 'failed', detail: expect.stringContaining('only') });
    await expect(
      verifier.verify({
        runId: 'run-1',
        workspace,
        task: {
          id: 'task-1',
          title: 'Task',
          goal: 'Task',
          dependencies: [],
          expectedReads: [],
          expectedWrites: [],
          sharedResources: [],
          verification: [{ type: 'package-script', packageName: 'core', script: 'fail' }]
        }
      })
    ).resolves.toMatchObject({ status: 'failed', detail: expect.stringContaining('core:fail') });
  });
});
