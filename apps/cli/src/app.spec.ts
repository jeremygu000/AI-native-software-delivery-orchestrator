import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  AutonomousPlanningError,
  type PlanApproval,
  PlanExecutionBindingError,
  type PlanExecutionIntent
} from '@ai-native-software-delivery-orchestrator/planning';
import {
  analyzeRepository,
  ProjectGraphError
} from '@ai-native-software-delivery-orchestrator/repository-analysis';

import { createForgeProgram, loadSharedResourceRegistry } from './app.js';

const fixturePath = resolve(import.meta.dirname, '../../../fixtures/pnpm-workspace');
const sharedResourceFixturePath = resolve(
  import.meta.dirname,
  '../../../fixtures/shared-resources.json'
);

describe('forge analyze', () => {
  it('analyzes a real pnpm workspace and prints a stable project graph', async () => {
    let output = '';
    const program = createForgeProgram({
      cwd: fixturePath,
      writeOutput: (value) => {
        output += value;
      }
    });

    await program.parseAsync(['node', 'forge', 'analyze', '.']);

    const result: unknown = JSON.parse(output);
    expect(result).toEqual({
      provider: 'pnpm-workspace',
      repositoryPath: fixturePath,
      counts: {
        projects: 4,
        files: 3,
        symbols: 7,
        projectDependencies: 3,
        fileDependencies: 2,
        symbolReferences: 4,
        diagnostics: 1
      },
      projects: [
        {
          id: '@fixture/root',
          name: '@fixture/root',
          root: '.',
          packageJsonPath: 'package.json',
          dependencies: [],
          scripts: {},
          sourceRoots: [],
          tsconfigPaths: ['tsconfig.json']
        },
        {
          id: '@fixture/web',
          name: '@fixture/web',
          root: 'apps/web',
          packageJsonPath: 'apps/web/package.json',
          dependencies: [
            {
              name: '@fixture/core',
              version: 'workspace:*',
              kind: 'dependency',
              workspaceProtocol: true
            },
            {
              name: '@fixture/utils',
              version: 'workspace:^',
              kind: 'dev-dependency',
              workspaceProtocol: true
            },
            {
              name: 'external-package',
              version: '1.0.0',
              kind: 'dependency',
              workspaceProtocol: false
            }
          ],
          scripts: {},
          sourceRoots: ['apps/web/src'],
          tsconfigPaths: ['apps/web/tsconfig.json']
        },
        {
          id: '@fixture/core',
          name: '@fixture/core',
          root: 'packages/core',
          packageJsonPath: 'packages/core/package.json',
          dependencies: [
            {
              name: '@fixture/utils',
              version: 'workspace:*',
              kind: 'peer-dependency',
              workspaceProtocol: true
            }
          ],
          scripts: {},
          sourceRoots: ['packages/core/src'],
          tsconfigPaths: ['packages/core/tsconfig.json']
        },
        {
          id: '@fixture/utils',
          name: '@fixture/utils',
          root: 'packages/utils',
          packageJsonPath: 'packages/utils/package.json',
          dependencies: [],
          scripts: {},
          sourceRoots: ['packages/utils/src'],
          tsconfigPaths: ['packages/utils/tsconfig.json']
        }
      ],
      projectDependencies: [
        {
          from: '@fixture/core',
          to: '@fixture/utils',
          sources: ['package-dependency', 'typescript-import', 'workspace-protocol']
        },
        {
          from: '@fixture/web',
          to: '@fixture/core',
          sources: ['package-dependency', 'typescript-import', 'workspace-protocol']
        },
        {
          from: '@fixture/web',
          to: '@fixture/utils',
          sources: ['package-dependency', 'workspace-protocol']
        }
      ],
      diagnostics: [
        {
          code: 'EMPTY_TYPESCRIPT_PROJECT',
          severity: 'warning',
          projectId: '@fixture/root',
          message: 'Project @fixture/root produced no owned TypeScript source files',
          configPaths: ['tsconfig.json']
        }
      ]
    });
  });

  it('prints structured project graph errors', async () => {
    let errorOutput = '';
    const program = createForgeProgram({
      analyzeRepository: async () => {
        throw new ProjectGraphError('INVALID_REPOSITORY', 'Repository is unavailable');
      }
    });
    program.exitOverride();
    program.configureOutput({
      writeErr: (value) => {
        errorOutput += value;
      }
    });

    await expect(program.parseAsync(['node', 'forge', 'analyze', '.'])).rejects.toMatchObject({
      code: 'commander.error'
    });
    expect(errorOutput).toContain('INVALID_REPOSITORY: Repository is unavailable');
  });

  it('does not mask unexpected analysis errors', async () => {
    const failure = new Error('native analyzer failed');
    const program = createForgeProgram({
      analyzeRepository: async () => {
        throw failure;
      }
    });

    await expect(program.parseAsync(['node', 'forge', 'analyze', '.'])).rejects.toBe(failure);
  });

  it('prints complete graph details only when requested', async () => {
    let output = '';
    const program = createForgeProgram({
      cwd: fixturePath,
      writeOutput: (value) => {
        output += value;
      }
    });

    await program.parseAsync(['node', 'forge', 'analyze', '.', '--full']);

    const result: unknown = JSON.parse(output);
    expect(result).toEqual(
      expect.objectContaining({
        files: expect.arrayContaining([expect.objectContaining({ path: 'apps/web/src/index.ts' })]),
        symbols: expect.arrayContaining([expect.objectContaining({ path: 'CoreService.run' })]),
        fileDependencies: expect.any(Array),
        symbolReferences: expect.any(Array)
      })
    );
  });

  it('uses the process working directory and standard output by default', async () => {
    const analysis = await analyzeRepository(fixturePath);
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const program = createForgeProgram({
      analyzeRepository: async () => analysis
    });

    try {
      await program.parseAsync(['node', 'forge', 'analyze', fixturePath]);
      expect(output).toHaveBeenCalledWith(expect.stringContaining('"provider": "pnpm-workspace"'));
    } finally {
      output.mockRestore();
    }
  });

  it('plans against an explicit repository and prints the durable artifact identity', async () => {
    let output = '';
    const planRepository = vi.fn(async () => ({
      schemaVersion: 1 as const,
      artifactId: 'plan-1',
      revision: 1,
      createdAt: '2026-08-12T00:00:00.000Z',
      source: {
        type: 'markdown-spec' as const,
        content: 'Change A.',
        path: '/workspace/request.md'
      },
      sourceFingerprint: `sha256:${'1'.repeat(64)}`,
      repository: {
        repositoryId: `sha256:${'2'.repeat(64)}`,
        repositoryRoot: '/workspace/repo',
        baseCommit: '3'.repeat(40),
        workingTreeFingerprint: `sha256:${'4'.repeat(64)}`,
        dirty: false,
        factsFingerprint: `sha256:${'5'.repeat(64)}`
      },
      authority: {
        sharedResourcePolicyFingerprint: `sha256:${'6'.repeat(64)}`,
        verificationPolicyFingerprint: `sha256:${'7'.repeat(64)}`
      },
      decision: {
        attempts: 2,
        semanticReview: {
          recommendation: 'accept' as const,
          summary: 'The requested change is covered.',
          requirements: [
            {
              requirement: 'Change A.',
              status: 'covered' as const,
              taskIds: ['task-a'],
              detail: 'Task A implements the request.'
            }
          ]
        },
        specification: { tasks: [] },
        impacts: [],
        hardConflicts: [],
        riskConflicts: [],
        executionPlan: { waves: [{ index: 0, taskIds: ['task-a'] }] },
        schedule: { maxConcurrency: 4 }
      },
      planFingerprint: `sha256:${'8'.repeat(64)}`
    }));
    const program = createForgeProgram({
      cwd: '/workspace',
      planRepository,
      writeOutput: (value) => {
        output += value;
      }
    });

    await program.parseAsync([
      'node',
      'forge',
      'plan',
      'request.md',
      '--repository',
      'repo',
      '--shared-resources',
      'shared-resources.json',
      '--max-attempts',
      '5',
      '--max-concurrency',
      '4',
      '--plan-directory',
      'artifacts',
      '--semantic-review'
    ]);

    expect(planRepository).toHaveBeenCalledWith({
      specificationPath: '/workspace/request.md',
      repositoryPath: '/workspace/repo',
      sharedResourcesPath: '/workspace/shared-resources.json',
      maxAttempts: 5,
      maxConcurrency: 4,
      planDirectory: '/workspace/artifacts',
      semanticReviewAuthorized: true
    });
    expect(JSON.parse(output)).toMatchObject({
      artifactId: 'plan-1',
      revision: 1,
      decision: {
        attempts: 2,
        semanticReview: { recommendation: 'accept' },
        schedule: { maxConcurrency: 4 }
      }
    });
  });

  it('prints deterministic planning rejection diagnostics', async () => {
    let errorOutput = '';
    const program = createForgeProgram({
      planRepository: async () => {
        throw new AutonomousPlanningError(2, [
          { code: 'INVALID_PLANNER_OUTPUT', detail: 'Expected JSON.' }
        ]);
      }
    });
    program.exitOverride();
    program.configureOutput({
      writeErr: (value) => {
        errorOutput += value;
      }
    });

    await expect(
      program.parseAsync(['node', 'forge', 'plan', 'request.md', '--semantic-review'])
    ).rejects.toMatchObject({
      code: 'commander.error'
    });
    expect(errorOutput).toContain('PLANNING_REJECTED');
    expect(errorOutput).toContain('INVALID_PLANNER_OUTPUT');
  });

  it('explains that unknown shared resources require a CLI policy file', async () => {
    let errorOutput = '';
    const program = createForgeProgram({
      planRepository: async () => {
        throw new AutonomousPlanningError(1, [
          {
            code: 'UNKNOWN_SHARED_RESOURCE',
            detail: 'Unknown shared resource: lockfile',
            taskId: 'task-a',
            resourceIds: ['lockfile']
          }
        ]);
      }
    });
    program.exitOverride();
    program.configureOutput({
      writeErr: (value) => {
        errorOutput += value;
      }
    });

    await expect(
      program.parseAsync(['node', 'forge', 'plan', 'request.md', '--semantic-review'])
    ).rejects.toMatchObject({ code: 'commander.error' });
    expect(errorOutput).toContain('No shared-resource policy was configured');
    expect(errorOutput).toContain('--shared-resources <path>');
  });

  it('loads shared-resource policy for the real CLI composition root', async () => {
    const registry = await loadSharedResourceRegistry(sharedResourceFixturePath);

    expect(registry.list()).toEqual([
      {
        id: 'lockfile',
        files: ['pnpm-lock.yaml'],
        paths: ['packages/*/package.json'],
        concurrency: 'exclusive'
      }
    ]);
    expect((await loadSharedResourceRegistry(undefined)).list()).toEqual([]);
  });

  it('propagates missing, malformed, and invalid shared-resource policy errors', async () => {
    await expect(
      loadSharedResourceRegistry(join(tmpdir(), 'forge-missing-shared-resources.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' });

    const directory = await mkdtemp(join(tmpdir(), 'forge-shared-resources-'));
    const malformedPath = join(directory, 'malformed.json');
    const invalidPath = join(directory, 'invalid.json');
    try {
      await writeFile(malformedPath, '{', 'utf8');
      await writeFile(invalidPath, JSON.stringify({ resources: [{ id: '' }] }), 'utf8');

      await expect(loadSharedResourceRegistry(malformedPath)).rejects.toBeInstanceOf(SyntaxError);
      await expect(loadSharedResourceRegistry(invalidPath)).rejects.toMatchObject({
        name: 'ZodError'
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not mask planner infrastructure errors', async () => {
    const failure = new Error('model unavailable');
    const program = createForgeProgram({
      planRepository: async () => Promise.reject(failure)
    });

    await expect(
      program.parseAsync(['node', 'forge', 'plan', 'request.md', '--semantic-review'])
    ).rejects.toBe(failure);
  });

  it('requires explicit consent before sending a plan to the semantic reviewer', async () => {
    const planRepository = vi.fn();
    const program = createForgeProgram({ planRepository });
    program.commands.find((command) => command.name() === 'plan')!.exitOverride();

    await expect(program.parseAsync(['node', 'forge', 'plan', 'request.md'])).rejects.toMatchObject(
      {
        code: 'commander.missingMandatoryOptionValue'
      }
    );
    expect(planRepository).not.toHaveBeenCalled();
  });

  it('rejects invalid positive-integer plan options before invoking planning', async () => {
    const planRepository = vi.fn();
    const program = createForgeProgram({ planRepository });

    await expect(
      program.parseAsync([
        'node',
        'forge',
        'plan',
        'request.md',
        '--max-attempts',
        '0',
        '--semantic-review'
      ])
    ).rejects.toThrow('Expected a positive integer, received 0');
    expect(planRepository).not.toHaveBeenCalled();
  });

  it('creates an exact approval through the CLI composition boundary', async () => {
    let output = '';
    const approval = {
      schemaVersion: 1,
      approvalId: 'approval-1',
      artifactId: 'plan-1',
      artifactRevision: 2,
      planFingerprint: `sha256:${'1'.repeat(64)}`,
      approvedBy: 'reviewer@example.com',
      approvedAt: '2026-08-13T01:00:00.000Z',
      approvalFingerprint: `sha256:${'2'.repeat(64)}`
    } as const satisfies PlanApproval;
    const approvePlan = vi.fn(async () => approval);
    const program = createForgeProgram({
      cwd: '/workspace',
      approvePlan,
      writeOutput: (value) => {
        output += value;
      }
    });

    await program.parseAsync([
      'node',
      'forge',
      'approve',
      'plan-1',
      '--revision',
      '2',
      '--approval-id',
      'approval-1',
      '--approved-by',
      'reviewer@example.com',
      '--repository',
      'repo',
      '--plan-directory',
      'artifacts'
    ]);

    expect(approvePlan).toHaveBeenCalledWith({
      artifactId: 'plan-1',
      artifactRevision: 2,
      approvalId: 'approval-1',
      approvedBy: 'reviewer@example.com',
      repositoryPath: '/workspace/repo',
      planDirectory: '/workspace/artifacts'
    });
    expect(JSON.parse(output)).toEqual(approval);
  });

  it('binds an approved plan without assembling runtime task bindings in the CLI', async () => {
    let output = '';
    // This test isolates CLI routing; schema integrity is covered by PlanExecutionBinder tests.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const intent = {
      schemaVersion: 1,
      runId: 'run-1',
      boundAt: '2026-08-13T02:00:00.000Z',
      artifact: { artifactId: 'plan-1' },
      approval: { approvalId: 'approval-1' },
      approvalClaim: { approvalId: 'approval-1', runId: 'run-1' },
      executionFingerprint: `sha256:${'3'.repeat(64)}`
    } as unknown as PlanExecutionIntent;
    const bindPlan = vi.fn(async () => intent);
    const program = createForgeProgram({
      cwd: '/workspace',
      bindPlan,
      writeOutput: (value) => {
        output += value;
      }
    });

    await program.parseAsync([
      'node',
      'forge',
      'bind',
      'plan-1',
      '--approval',
      'approval-1',
      '--run-id',
      'run-1',
      '--revision',
      '2',
      '--repository',
      'repo',
      '--shared-resources',
      'shared-resources.json',
      '--plan-directory',
      'artifacts'
    ]);

    expect(bindPlan).toHaveBeenCalledWith({
      artifactId: 'plan-1',
      artifactRevision: 2,
      approvalId: 'approval-1',
      runId: 'run-1',
      repositoryPath: '/workspace/repo',
      sharedResourcesPath: '/workspace/shared-resources.json',
      planDirectory: '/workspace/artifacts'
    });
    expect(JSON.parse(output)).toEqual(intent);
  });

  it('requires approval actor and binding identities before invoking adapters', async () => {
    const approvePlan = vi.fn();
    const bindPlan = vi.fn();
    const approveProgram = createForgeProgram({ approvePlan, bindPlan });
    approveProgram.commands.find((command) => command.name() === 'approve')!.exitOverride();

    await expect(
      approveProgram.parseAsync(['node', 'forge', 'approve', 'plan-1'])
    ).rejects.toMatchObject({ code: 'commander.missingMandatoryOptionValue' });

    const bindProgram = createForgeProgram({ approvePlan, bindPlan });
    bindProgram.commands.find((command) => command.name() === 'bind')!.exitOverride();
    await expect(bindProgram.parseAsync(['node', 'forge', 'bind', 'plan-1'])).rejects.toMatchObject(
      {
        code: 'commander.missingMandatoryOptionValue'
      }
    );
    expect(approvePlan).not.toHaveBeenCalled();
    expect(bindPlan).not.toHaveBeenCalled();
  });

  it('prints deterministic execution-binding rejection diagnostics', async () => {
    let errorOutput = '';
    const program = createForgeProgram({
      bindPlan: async () => {
        throw new PlanExecutionBindingError('Repository changed', [
          'working-tree',
          'verification-policy'
        ]);
      }
    });
    program.exitOverride();
    program.configureOutput({
      writeErr: (value) => {
        errorOutput += value;
      }
    });

    await expect(
      program.parseAsync([
        'node',
        'forge',
        'bind',
        'plan-1',
        '--approval',
        'approval-1',
        '--run-id',
        'run-1'
      ])
    ).rejects.toMatchObject({ code: 'commander.error' });
    expect(errorOutput).toContain('BINDING_REJECTED: Repository changed');
    expect(errorOutput).toContain('working-tree');
    expect(errorOutput).toContain('verification-policy');
  });
});
