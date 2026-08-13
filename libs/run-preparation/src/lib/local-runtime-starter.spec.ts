import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PiSessionGateway } from '@ai-native-software-delivery-orchestrator/agent-runtime';
import type {
  AgentCommandSandbox,
  RepositoryGraph,
  RunAuthorityEvidence
} from '@ai-native-software-delivery-orchestrator/domain';
import { DrizzleSqliteOrchestrationPersistence } from '@ai-native-software-delivery-orchestrator/persistence';
import {
  codeReviewPolicyFingerprint,
  fingerprintPlanValue
} from '@ai-native-software-delivery-orchestrator/planning';
import type { StartRuntimeRunRequest } from '@ai-native-software-delivery-orchestrator/orchestration-runtime';
import { GitIntegrationCheckoutProvisioner } from '@ai-native-software-delivery-orchestrator/workspace-git';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LocalRuntimeStarter,
  SandboxedPackageScriptVerifier,
  RepositoryResourceResolver
} from './local-runtime-starter.js';

const directories: string[] = [];
const verificationPolicy = {
  version: 2,
  autonomousRules: ['package-script-required', 'free-form-command-forbidden'],
  packageScriptRunner: 'npm-from-pinned-node-image',
  executionProfile: {
    kind: 'docker-read-only',
    image: 'node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43',
    assurance: 'production-validation',
    network: 'deny',
    workspaceAccess: 'read-only',
    processTree: 'container',
    memoryBytes: 1_073_741_824,
    cpuCount: 2,
    pidLimit: 256
  }
} as const;
const codeReviewPolicy = {
  version: 1,
  reviewer: {
    implementation: 'pi-task-code-reviewer',
    agentBackend: 'pi',
    model: { provider: 'test-provider', id: 'test-model' },
    toolProfile: 'workspace-read-only-v1',
    outputSchemaVersion: 1,
    promptVersion: 'v1'
  }
} as const;
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
  verificationPolicyFingerprint: fingerprintPlanValue(verificationPolicy),
  codeReviewPolicyFingerprint: codeReviewPolicyFingerprint(codeReviewPolicy)
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
    const executeVerification = vi.fn<AgentCommandSandbox['execute']>(async () => ({
      status: 'completed',
      exitCode: 0,
      stdout: '',
      stderr: ''
    }));
    const wrongRuntime = new LocalRuntimeStarter({
      graph,
      databasePath,
      gateway,
      verificationPolicy: {
        ...verificationPolicy,
        executionProfile: {
          ...verificationPolicy.executionProfile,
          image:
            'example.invalid/changed-verifier@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        }
      },
      codeReviewPolicy,
      verificationSandbox: { execute: executeVerification }
    });
    await expect(wrongRuntime.startOrResumeRun(request)).rejects.toThrow(
      'Runtime verification policy does not match durable execution authority'
    );
    wrongRuntime.close();
    const wrongReviewRuntime = new LocalRuntimeStarter({
      graph,
      databasePath,
      gateway,
      verificationPolicy,
      codeReviewPolicy: {
        ...codeReviewPolicy,
        reviewer: {
          ...codeReviewPolicy.reviewer,
          model: { provider: 'test-provider', id: 'changed-model' }
        }
      },
      verificationSandbox: { execute: executeVerification }
    });
    await expect(wrongReviewRuntime.startOrResumeRun(request)).rejects.toThrow(
      'Runtime code review policy does not match durable execution authority'
    );
    wrongReviewRuntime.close();
    const runtime = new LocalRuntimeStarter({
      graph,
      databasePath,
      gateway,
      verificationPolicy,
      codeReviewPolicy,
      verificationSandbox: { execute: executeVerification }
    });

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
    expect(executeVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: verificationPolicy.executionProfile,
        executable: 'npm',
        args: ['--prefix', '.', 'run', 'test'],
        environment: { CI: '1', HOME: '/tmp', npm_config_cache: '/tmp/npm-cache' }
      })
    );
    expect(retried.run.state).toBe('COMPLETED');
    const persistence = new DrizzleSqliteOrchestrationPersistence(databasePath);
    await expect(persistence.recoverRun('run-1')).resolves.toMatchObject({
      run: { authority: request.run.authority },
      workspaces: [{ workspace: { phase: 'INTEGRATED' } }],
      attempts: [{ attempt: { state: 'COMPLETED', sessionRef: { value: 'session-1' } } }],
      impacts: [
        {
          impact: {
            observed: { filesWritten: new Set(['core:value.txt']) },
            reconciliation: { status: 'within-predicted-scope' }
          }
        }
      ]
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
      databasePath: join(databaseDirectory, 'run.sqlite'),
      verificationPolicy,
      codeReviewPolicy
    });
    starter.close();
  });

  it('delegates package scripts only to the approved sandbox and fails closed', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'forge-verifier-'));
    directories.push(workspacePath);
    const hostWritePath = join(workspacePath, 'verification-host-write.txt');
    writeFileSync(
      join(workspacePath, 'package.json'),
      JSON.stringify({
        name: 'core',
        version: '1.0.0',
        scripts: {
          pass: `node -e "require('node:fs').writeFileSync('${hostWritePath}', 'escaped')"`,
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
    const execute = vi
      .fn<AgentCommandSandbox['execute']>()
      .mockResolvedValueOnce({ status: 'completed', exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({
        status: 'failed',
        detail: 'sandbox could not start',
        stdout: '',
        stderr: ''
      });
    const verifier = new SandboxedPackageScriptVerifier({
      policy: verificationPolicy,
      graph: {
        repositoryPath: workspacePath,
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
              sourceRoots: [],
              tsconfigPaths: []
            }
          ]
        ]),
        projectDependencies: [],
        files: new Map(),
        symbols: new Map(),
        fileDependencies: [],
        symbolReferences: [],
        diagnostics: []
      },
      sandbox: { execute }
    });

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
    expect(() => readFileSync(hostWritePath, 'utf8')).toThrow();
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        profile: verificationPolicy.executionProfile,
        executable: 'npm',
        args: ['--prefix', '.', 'run', 'pass'],
        cwd: workspacePath,
        environment: { CI: '1', HOME: '/tmp', npm_config_cache: '/tmp/npm-cache' },
        trustedPath: '/usr/local/bin:/usr/bin:/bin',
        timeoutMs: 600_000,
        maxOutputBytes: 1024 * 1024,
        containerName: expect.stringMatching(/^forge-verify-/)
      })
    );

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
          verification: [{ type: 'package-script', packageName: 'unknown', script: 'test' }]
        }
      })
    ).resolves.toMatchObject({
      status: 'failed',
      detail: expect.stringContaining('not present in approved Repository Facts')
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('rejects a verification Docker image without an immutable digest', () => {
    const graph: RepositoryGraph = {
      repositoryPath: '/repository',
      projects: new Map(),
      projectDependencies: [],
      files: new Map(),
      symbols: new Map(),
      fileDependencies: [],
      symbolReferences: [],
      diagnostics: []
    };

    expect(
      () =>
        new SandboxedPackageScriptVerifier({
          graph,
          policy: {
            ...verificationPolicy,
            executionProfile: {
              ...verificationPolicy.executionProfile,
              image: 'node:24-alpine'
            }
          }
        })
    ).toThrow('Verification Docker image must use a sha256 digest');
  });

  it.runIf(process.env.FORGE_DOCKER_TEST === '1')(
    'denies a mutable package script write in the real Docker verification sandbox',
    async () => {
      const workspacePath = mkdtempSync(join(tmpdir(), 'forge-docker-verifier-'));
      directories.push(workspacePath);
      const forbiddenPath = join(workspacePath, 'forbidden.txt');
      writeFileSync(
        join(workspacePath, 'package.json'),
        JSON.stringify({
          name: 'core',
          version: '1.0.0',
          scripts: {
            verify:
              "node -e \"console.error('VERIFICATION_SCRIPT_STARTED'); require('node:fs').writeFileSync('forbidden.txt', 'escaped')\""
          }
        })
      );
      const verifier = new SandboxedPackageScriptVerifier({
        policy: verificationPolicy,
        graph: {
          repositoryPath: workspacePath,
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
                sourceRoots: [],
                tsconfigPaths: []
              }
            ]
          ]),
          projectDependencies: [],
          files: new Map(),
          symbols: new Map(),
          fileDependencies: [],
          symbolReferences: [],
          diagnostics: []
        }
      });

      await expect(
        verifier.verify({
          runId: 'run-1',
          workspace: {
            id: 'workspace-1',
            runId: 'run-1',
            taskId: 'task-1',
            integrationRepositoryPath: workspacePath,
            workspacePath,
            branchName: 'task-1',
            baseRef: 'main',
            integrationRef: 'main',
            revision: 1,
            phase: 'READY_TO_INTEGRATE'
          },
          task: {
            id: 'task-1',
            title: 'Task',
            goal: 'Task',
            dependencies: [],
            expectedReads: [],
            expectedWrites: [],
            sharedResources: [],
            verification: [{ type: 'package-script', packageName: 'core', script: 'verify' }]
          }
        })
      ).resolves.toMatchObject({
        status: 'failed',
        detail: expect.stringContaining('VERIFICATION_SCRIPT_STARTED')
      });
      expect(() => readFileSync(forbiddenPath, 'utf8')).toThrow();
    }
  );
});
