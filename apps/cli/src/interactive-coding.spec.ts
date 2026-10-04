import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSubscriptionCredentialStore } from '@ai-native-software-delivery-orchestrator/agent-runtime';
import { authorityConfigurationFingerprint } from '@ai-native-software-delivery-orchestrator/persistence';
import { prepareApprovedWorkspaces } from '@ai-native-software-delivery-orchestrator/temporal-worker/operator-workspaces';
import { resolveCliReviewPolicy } from './review-policy.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPlanApproval,
  createPlanApprovalClaim,
  fingerprintPlanValue,
  createPlanArtifact,
  createCodeReviewPolicy,
  PlanExecutionBindingError,
  type CodeReviewPolicy
} from '@ai-native-software-delivery-orchestrator/planning';
import { createForgeProgram } from './app.js';
import {
  startInteractiveCoding,
  type InteractiveCodingDependencies
} from './interactive-coding.js';
import { ModelSelectionCancelled } from './model-selection.js';
import {
  integrationTaskIds,
  renderPlanDetails,
  renderRunCompletion
} from './interactive-render.js';
vi.mock('@ai-native-software-delivery-orchestrator/temporal-worker/operator-workspaces', () => ({
  prepareApprovedWorkspaces: vi.fn(async () => {})
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(prepareApprovedWorkspaces).mockClear();
});
const artifactForPolicy = (policy: CodeReviewPolicy, repositoryPath = '/repo') =>
  createPlanArtifact({
    artifactId: 'selection-plan',
    revision: 1,
    createdAt: '2026-10-04T00:00:00Z',
    source: { type: 'user-request', content: 'Change one file.' },
    repository: {
      repositoryPath,
      projects: new Map(),
      files: new Map(),
      symbols: new Map(),
      projectDependencies: [],
      fileDependencies: [],
      symbolReferences: [],
      diagnostics: []
    },
    repositorySnapshot: {
      repositoryId: `sha256:${'1'.repeat(64)}`,
      repositoryRoot: repositoryPath,
      baseCommit: '2'.repeat(40),
      workingTreeFingerprint: `sha256:${'3'.repeat(64)}`,
      dirty: false
    },
    sharedResourcePolicy: [],
    verificationPolicy: { version: 1 },
    codeReviewPolicy: policy,
    preparedPlan: {
      attempts: 1,
      specification: {
        tasks: [
          {
            id: 'task',
            title: 'Change',
            goal: 'Change safely',
            dependencies: [],
            expectedReads: [],
            expectedWrites: [],
            sharedResources: [],
            verification: []
          }
        ]
      },
      impacts: [
        {
          taskId: 'task',
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
          sharedResources: new Set(),
          sharedResourceAccesses: [],
          downstreamProjects: new Set(),
          riskSignals: []
        }
      ],
      hardConflicts: [],
      riskConflicts: [],
      executionPlan: { waves: [{ index: 0, taskIds: ['task'] }] },
      schedule: { maxConcurrency: 1 },
      semanticReview: {
        recommendation: 'accept',
        summary: 'Covered',
        requirements: [
          { requirement: 'Change', status: 'covered', taskIds: ['task'], detail: 'Covered' }
        ]
      }
    }
  });

const fixture = (
  policy = createCodeReviewPolicy({ provider: 'deepseek', model: 'deepseek-flash' }),
  repositoryPath = '/repo'
) => {
  const artifact = artifactForPolicy(policy, repositoryPath);
  const choices = [0, 0, 2, 0, 0, 1, 0]; // root, task, profile, profile-confirm, consent, action, approval
  const calls: string[] = [];
  const terminal = {
    isInteractive: true,
    write: vi.fn(),
    prompt: vi.fn(async () => '/repo'),
    multiline: vi.fn(async () => 'Change one file.'),
    choose: vi.fn(async () => {
      const choice = choices.shift();
      if (choice === undefined) {
        throw new ModelSelectionCancelled();
      }
      return choice;
    })
  };
  const status = {
    runId: 'run',
    state: 'COMPLETED',
    createdAt: '',
    correlation: { runId: 'run' },
    tasks: [],
    leases: [],
    timeline: []
  };
  const dependencies: InteractiveCodingDependencies = {
    terminal,
    cwd: '/repo',
    environment: { FORGE_MODEL_API_KEY: 'configured' },
    validateRepository: vi.fn(async () => repositoryPath),
    planSource: vi.fn(async () => {
      calls.push('plan');
      return artifact;
    }),
    approvePlan: vi.fn(async (request) => {
      calls.push('approve');
      return createPlanApproval({ ...request, artifact, approvedAt: '2026-10-04T00:00:00Z' });
    }),
    bindPlan: vi.fn(async (request) => {
      calls.push('bind');
      const boundAt = '2026-10-04T00:00:00Z';
      const approval = createPlanApproval({
        approvalId: request.approvalId,
        artifact,
        approvedBy: 'test',
        approvedAt: boundAt
      });
      const payload = {
        schemaVersion: 1 as const,
        runId: request.runId,
        boundAt,
        artifact,
        approval,
        approvalClaim: createPlanApprovalClaim({
          approval,
          runId: request.runId,
          claimedAt: boundAt
        })
      };
      return { ...payload, executionFingerprint: fingerprintPlanValue(payload) };
    }),
    checkWorker: vi.fn(async () => {
      calls.push('check');
    }),
    setup: vi.fn(async () => {
      calls.push('setup');
    }),
    runPlan: vi.fn(async () => {
      calls.push('run');
    }),
    statusRun: vi.fn(async () => status),
    cancelRun: vi.fn(async () => ({ runId: 'run', state: 'CANCEL_REQUESTED' })),
    createId: (() => {
      const ids = ['approval', 'run'];
      return () => ids.shift()!;
    })()
  };
  return { dependencies, terminal, choices, calls, artifact, status };
};
describe('Interactive coding frontend', () => {
  it('refuses bare non-TTY invocation before any application operations', async () => {
    const f = fixture();
    f.terminal.isInteractive = false;
    await expect(
      createForgeProgram({
        interactiveTerminal: f.terminal,
        planSource: f.dependencies.planSource
      }).parseAsync(['node', 'forge'])
    ).rejects.toThrow('requires a terminal');
    expect(f.dependencies.planSource).not.toHaveBeenCalled();
  });
  it('routes bare TTY through the same injected operations and carries exact IDs/profile', async () => {
    const f = fixture();
    await createForgeProgram({
      interactiveTerminal: f.terminal,
      modelEnvironment: f.dependencies.environment,
      validateInteractiveRepository: f.dependencies.validateRepository,
      planSource: f.dependencies.planSource,
      approvePlan: f.dependencies.approvePlan,
      bindPlan: f.dependencies.bindPlan,
      runPlan: f.dependencies.runPlan,
      statusRun: f.dependencies.statusRun,
      cancelRun: f.dependencies.cancelRun,
      checkInteractiveWorker: f.dependencies.checkWorker,
      setupInteractiveRun: f.dependencies.setup
    }).parseAsync(['node', 'forge']);
    expect(f.calls).toEqual(['plan', 'check', 'approve', 'bind', 'setup', 'run']);
    const plan = vi.mocked(f.dependencies.planSource).mock.calls[0][0];
    const bind = vi.mocked(f.dependencies.bindPlan).mock.calls[0][0];
    const run = vi.mocked(f.dependencies.runPlan).mock.calls[0][0];
    expect(plan).toMatchObject({
      source: { type: 'user-request', content: 'Change one file.' },
      semanticReviewAuthorized: true,
      reviewProvider: 'deepseek',
      reviewModel: 'deepseek-flash',
      reasoningEffort: 'high'
    });
    expect(run).toMatchObject(bind);
    expect(vi.mocked(f.dependencies.approvePlan).mock.calls[0][0].approvalId).toBe(bind.approvalId);
    expect(vi.mocked(f.dependencies.setup).mock.calls[0][0]).toMatchObject(run);
  });
  it('carries subscription medium through plan/bind/run despite a conflicting ambient effort', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'forge-interactive-profile-')));
    try {
      await new FileSubscriptionCredentialStore(directory).save('github-copilot', {
        access: 'smoke-access',
        refresh: 'smoke-refresh',
        expires: 1
      });
      const environment = {
        FORGE_SUBSCRIPTION_AUTH_DIRECTORY: directory,
        FORGE_MODEL_REASONING_EFFORT: 'high'
      };
      const f = fixture(
        resolveCliReviewPolicy('github-copilot', 'gpt-6.1-sol', 'medium', environment).policy
      );
      f.choices[2] = 0;
      await startInteractiveCoding({ ...f.dependencies, environment });
      for (const operation of [
        f.dependencies.planSource,
        f.dependencies.bindPlan,
        f.dependencies.runPlan
      ]) {
        expect(operation).toHaveBeenCalledWith(
          expect.objectContaining({
            reviewProvider: 'github-copilot',
            reviewModel: 'gpt-6.1-sol',
            reasoningEffort: 'medium'
          })
        );
      }
      expect(environment.FORGE_MODEL_REASONING_EFFORT).toBe('high');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('prepares initial dispatch before trusted setup, then launches with an explicit false prepare-only flag', async () => {
    const f = fixture(undefined, process.cwd());
    const authority = {
      backend: 'postgres' as const,
      connectionString: 'postgres://forge_runtime:private@localhost/forge',
      schema: 'forge',
      role: 'forge_runtime'
    };
    for (const [key, value] of Object.entries({
      FORGE_WORKER_AUTHORITY_MODE: 'global',
      FORGE_AUTHORITY_BACKEND: 'postgres',
      FORGE_POSTGRES_CONNECTION_STRING: authority.connectionString,
      FORGE_POSTGRES_SCHEMA: authority.schema,
      FORGE_POSTGRES_ROLE: authority.role,
      FORGE_AUTHORITY_ID: authorityConfigurationFingerprint(authority),
      FORGE_PREPARE_ONLY: 'true'
    })) {
      vi.stubEnv(key, value);
    }
    await createForgeProgram({
      interactiveTerminal: f.terminal,
      modelEnvironment: f.dependencies.environment,
      validateInteractiveRepository: f.dependencies.validateRepository,
      planSource: f.dependencies.planSource,
      approvePlan: f.dependencies.approvePlan,
      bindPlan: f.dependencies.bindPlan,
      runPlan: f.dependencies.runPlan,
      statusRun: f.dependencies.statusRun,
      cancelRun: f.dependencies.cancelRun,
      checkInteractiveWorker: f.dependencies.checkWorker
    }).parseAsync(['node', 'forge']);
    const requests = vi.mocked(f.dependencies.runPlan).mock.calls.map(([request]) => request);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.prepareOnly).toBe(true);
    expect(requests[1]?.prepareOnly).toBe(false);
    expect(prepareApprovedWorkspaces).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: requests[0]?.runId,
        approvalId: requests[0]?.approvalId,
        artifactId: f.artifact.artifactId,
        artifactRevision: f.artifact.revision,
        authorizeWorkspaceCreation: true,
        runtimeConnectionString: authority.connectionString,
        runtimeSchema: 'forge'
      })
    );
    const order = vi.mocked(f.dependencies.runPlan).mock.invocationCallOrder;
    expect(vi.mocked(prepareApprovedWorkspaces).mock.invocationCallOrder[0]).toBeGreaterThan(
      order[0]
    );
    expect(vi.mocked(prepareApprovedWorkspaces).mock.invocationCallOrder[0]).toBeLessThan(order[1]);
  });
  it('leaves explicit automation outside the root menu', async () => {
    const f = fixture();
    const analyze = vi.fn(async () => ({
      providerId: 'test',
      graph: {
        repositoryPath: '/repo',
        projects: new Map(),
        files: new Map(),
        symbols: new Map(),
        projectDependencies: [],
        fileDependencies: [],
        symbolReferences: [],
        diagnostics: []
      }
    }));
    await createForgeProgram({
      interactiveTerminal: f.terminal,
      analyzeRepository: analyze,
      writeOutput: vi.fn()
    }).parseAsync(['node', 'forge', 'analyze', '/repo']);
    expect(analyze).toHaveBeenCalled();
    expect(f.terminal.choose).not.toHaveBeenCalled();
  });
  it('cancels before planning without creating artifacts/approvals/runs', async () => {
    const f = fixture();
    f.choices.splice(0);
    await expect(startInteractiveCoding(f.dependencies)).rejects.toBeInstanceOf(
      ModelSelectionCancelled
    );
    expect(f.calls).toEqual([]);
  });
  it('requires semantic consent before calling planner', async () => {
    const f = fixture();
    f.choices[4] = 1;
    await startInteractiveCoding(f.dependencies);
    expect(f.calls).toEqual([]);
  });
  it('allows cancellation after an immutable plan without approval or setup', async () => {
    const f = fixture();
    f.choices[5] = 3;
    await startInteractiveCoding(f.dependencies);
    expect(f.calls).toEqual(['plan']);
  });
  it('reviews details and revises through new planning without mutating the old artifact', async () => {
    const f = fixture();
    const before = JSON.stringify(f.artifact);
    f.choices.splice(5, 2, 0, 2, 0, 3);
    await startInteractiveCoding(f.dependencies);
    expect(f.calls).toEqual(['plan', 'plan']);
    expect(JSON.stringify(f.artifact)).toBe(before);
    expect(f.terminal.write.mock.calls.flat().join('')).toContain('Requirements coverage');
  });
  it('refuses unavailable deployment before approval', async () => {
    const f = fixture();
    vi.mocked(f.dependencies.checkWorker).mockRejectedValueOnce(new Error('unavailable'));
    await expect(startInteractiveCoding(f.dependencies)).rejects.toThrow('not ready');
    expect(f.dependencies.approvePlan).not.toHaveBeenCalled();
  });
  it('does not launch on stale binding and requires explicit re-plan', async () => {
    const f = fixture();
    vi.mocked(f.dependencies.bindPlan).mockRejectedValueOnce(
      new PlanExecutionBindingError('drift')
    );
    f.choices.push(1);
    await startInteractiveCoding(f.dependencies);
    expect(f.dependencies.setup).not.toHaveBeenCalled();
    expect(f.dependencies.runPlan).not.toHaveBeenCalled();
  });
  it('does not launch or retry after operator setup failure', async () => {
    const f = fixture();
    vi.mocked(f.dependencies.setup).mockRejectedValueOnce(new Error('secret diagnostic'));
    await expect(startInteractiveCoding(f.dependencies)).rejects.toThrow('refused');
    expect(f.dependencies.runPlan).not.toHaveBeenCalled();
    expect(f.terminal.write.mock.calls.flat().join('')).not.toContain('secret diagnostic');
  });
  it('does not create another run after an ambiguous launch response', async () => {
    const f = fixture();
    vi.mocked(f.dependencies.runPlan).mockRejectedValueOnce(new Error('network'));
    await expect(startInteractiveCoding(f.dependencies)).rejects.toThrow('refused');
    expect(f.dependencies.runPlan).toHaveBeenCalledTimes(1);
    expect(f.terminal.write.mock.calls.flat().join('')).toContain('may have succeeded');
  });
  it('requests durable cancellation exactly once for SIGINT during execution', async () => {
    const f = fixture();
    vi.mocked(f.dependencies.statusRun).mockImplementationOnce(async () => {
      process.emit('SIGINT');
      return { ...f.status, state: 'ACTIVE' };
    });
    const before = process.listenerCount('SIGINT');
    await expect(
      startInteractiveCoding({ ...f.dependencies, wait: async () => {} })
    ).rejects.toBeInstanceOf(ModelSelectionCancelled);
    expect(f.dependencies.cancelRun).toHaveBeenCalledTimes(1);
    expect(f.dependencies.cancelRun).toHaveBeenCalledWith({
      runId: 'run',
      runDirectory: expect.any(String)
    });
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
  it('preserves UNKNOWN recovery and does not report successful cancellation after failure', async () => {
    const f = fixture();
    vi.mocked(f.dependencies.statusRun).mockImplementationOnce(async () => {
      process.emit('SIGINT');
      throw new Error('status unavailable');
    });
    vi.mocked(f.dependencies.cancelRun).mockRejectedValueOnce(new Error('unknown'));
    await expect(startInteractiveCoding(f.dependencies)).rejects.toBeInstanceOf(
      ModelSelectionCancelled
    );
    expect(f.dependencies.cancelRun).toHaveBeenCalledTimes(1);
    const output = f.terminal.write.mock.calls.flat().join('');
    expect(output).toContain('could not be fully confirmed');
    expect(output).not.toContain('Cancellation requested');
  });
  it('reports durable failed outcome without retry', async () => {
    const f = fixture();
    f.status.state = 'FAILED';
    await expect(startInteractiveCoding(f.dependencies)).rejects.toThrow('ended FAILED');
    expect(f.dependencies.runPlan).toHaveBeenCalledTimes(1);
    expect(f.terminal.write.mock.calls.flat().join('')).toContain('Run outcome: FAILED');
  });
  it('authorizes the exact writing subset without granting Git integration to a read-only task', () => {
    const f = fixture();
    const task = f.artifact.decision.specification.tasks[0];
    const artifact = {
      ...f.artifact,
      decision: {
        ...f.artifact.decision,
        specification: {
          tasks: [
            task,
            { ...task, id: 'write', expectedWrites: [{ type: 'glob' as const, value: 'src/*' }] }
          ]
        }
      }
    };
    expect(integrationTaskIds(artifact)).toEqual(['write']);
  });
  it('only authorizes writing tasks and renders existing plan/read-model evidence', () => {
    const f = fixture();
    expect(integrationTaskIds(f.artifact)).toEqual([]);
    expect(renderPlanDetails(f.artifact)).toContain('Expected writes: none');
    expect(renderRunCompletion(f.status)).toContain('Durable integration events: 0');
  });
});
