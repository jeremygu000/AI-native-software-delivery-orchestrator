import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCodeReviewPolicy,
  createPlanArtifact,
  createPlanApproval,
  type CodeReviewPolicy
} from '@ai-native-software-delivery-orchestrator/planning';
import {
  JsonFilePlanArtifactStore,
  JsonFilePlanApprovalStore
} from '@ai-native-software-delivery-orchestrator/persistence';
import { prepareApprovedWorkspaces } from './operator-workspaces.js';
const probes = vi.hoisted(() => ({
  connects: vi.fn(),
  closes: vi.fn(),
  recover: vi.fn(),
  admit: vi.fn(),
  arm: vi.fn(),
  issue: vi.fn(),
  creation: vi.fn(),
  persist: vi.fn(),
  settle: vi.fn(),
  handoff: vi.fn(),
  attest: vi.fn(),
  exec: vi.fn(),
  observerOpen: vi.fn(),
  handoffConnect: vi.fn()
}));
vi.mock('node:child_process', () => ({ execFileSync: probes.exec }));
vi.mock('@ai-native-software-delivery-orchestrator/postgres-persistence', async (original) => ({
  ...(await original<object>()),
  PostgresOrchestrationPersistence: {
    connect: async (configuration: unknown) => {
      probes.connects(configuration);
      return { recoverRun: probes.recover, persistWorkspace: probes.persist, close: probes.closes };
    }
  },
  PostgresGlobalMutationAuthority: {
    connect: async (configuration: unknown) => {
      probes.connects(configuration);
      return { recoverGlobalRunScope: async () => 'scope', close: probes.closes };
    }
  },
  PostgresWorkspaceSetupAdmission: {
    connect: async (configuration: unknown) => {
      probes.connects(configuration);
      return {
        admit: probes.admit,
        arm: probes.arm,
        executeWorkspaceCreation: probes.creation,
        close: probes.closes
      };
    }
  },
  PostgresExecutionGenerationIssuer: {
    connect: async (configuration: unknown) => {
      probes.connects(configuration);
      return { issue: probes.issue, close: probes.closes };
    }
  }
}));
vi.mock('./postgres-workspace-recovery.js', () => ({
  openPostgresWorkspaceRecoveryObserver: async () => {
    probes.observerOpen();
    return { observer: {}, close: probes.closes };
  }
}));
vi.mock('./postgres-workspace-handoff.js', () => ({
  PostgresWorkspaceHandoff: {
    connect: async () => {
      probes.handoffConnect();
      return { settle: probes.settle, handoff: probes.handoff, close: probes.closes };
    }
  }
}));
vi.mock('./workspace-recovery-attestation.js', () => ({
  WorkspaceRecoveryAttestor: class {
    attest = probes.attest;
  }
}));
vi.mock('@ai-native-software-delivery-orchestrator/workspace-git', () => ({
  GitWorkspaceManager: class {
    async create(workspace: unknown) {
      return workspace;
    }
  },
  GitWorkspaceStateInspector: class {
    async inspect() {}
  },
  DockerWorkspaceGenerationSupervisor: class {
    async launch() {
      return {};
    }
  }
}));
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const path of directories.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});
beforeEach(() => {
  vi.resetAllMocks();
  probes.admit.mockResolvedValue({ status: 'granted', token: 'token' });
  probes.creation.mockImplementation(async (_request: unknown, create: () => Promise<void>) =>
    create()
  );
  probes.handoff.mockResolvedValue({ claimId: 'child' });
  probes.attest.mockResolvedValue({ id: 'signed-evidence' });
  probes.exec.mockReturnValue('container-id');
  probes.closes.mockResolvedValue(undefined);
});
const artifactForPolicy = (policy: CodeReviewPolicy) =>
  createPlanArtifact({
    artifactId: 'selection-plan',
    revision: 1,
    createdAt: '2026-10-04T00:00:00Z',
    source: { type: 'user-request', content: 'Change one file.' },
    repository: {
      repositoryPath: '/repo',
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
      repositoryRoot: '/repo',
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

const setup = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forge-operator-')));
  directories.push(root);
  const plans = join(root, 'plans');
  await mkdir(join(root, '.local'));
  const pair = generateKeyPairSync('ed25519');
  await writeFile(
    join(root, '.local/setup-private.pem'),
    pair.privateKey.export({ type: 'pkcs8', format: 'pem' })
  );
  await writeFile(
    join(root, '.env.local'),
    'FORGE_POSTGRES_CONNECTION_STRING=postgres://forge_runtime:runtime@localhost/forge\nFORGE_POSTGRES_SCHEMA=forge\nLOCAL_FORGE_RUNTIME_PASSWORD=runtime\nLOCAL_FORGE_ISSUER_PASSWORD=issuer\nLOCAL_FORGE_RECOVERY_PASSWORD=recovery\nLOCAL_FORGE_SETUP_PASSWORD=setup\n'
  );
  const artifact = artifactForPolicy(
    createCodeReviewPolicy({ provider: 'deepseek', model: 'deepseek-flash' })
  );
  const approval = createPlanApproval({
    artifact,
    approvalId: 'approval',
    approvedBy: 'human',
    approvedAt: '2026-10-04T00:00:00Z'
  });
  await new JsonFilePlanArtifactStore(plans).save(artifact);
  await new JsonFilePlanApprovalStore(plans).save(approval);
  const binding = {
    taskId: 'task',
    workspace: {
      id: 'workspace',
      workspacePath: root,
      integrationRepositoryPath: root,
      integrationRef: 'main',
      baseRef: 'main'
    },
    leasePlan: { predictedResources: [] }
  };
  probes.recover.mockResolvedValue({
    run: { authority: { approvalId: 'approval' } },
    attempts: [
      {
        attempt: {
          id: 'attempt',
          taskId: 'task',
          state: 'PREPARING',
          leasePlanFingerprint: 'fingerprint'
        }
      }
    ],
    taskBindings: [binding]
  });
  return {
    root,
    plans,
    request: {
      root,
      runId: 'run',
      artifactId: artifact.artifactId,
      approvalId: 'approval',
      artifactRevision: artifact.revision,
      planDirectory: plans,
      approvedBy: 'interactive-human',
      authorizeWorkspaceCreation: true as const,
      runtimeConnectionString: 'postgres://forge_runtime:runtime@localhost/forge',
      runtimeSchema: 'forge'
    }
  };
};
describe('Extracted approved operator setup', () => {
  it('keeps exact signed setup, independent role connections and published evidence before handoff', async () => {
    const f = await setup();
    const stages: string[] = [];
    await prepareApprovedWorkspaces({ ...f.request, onStage: (stage) => stages.push(stage) });
    expect(stages).toEqual([
      'operator-config',
      'plan-evidence-load',
      'postgres-runtime-connect',
      'global-authority-connect',
      'setup-admission-connect',
      'issuer-connect',
      'setup-key-load',
      'recovery-key-load',
      'recovery-observer-open',
      'workspace-handoff-connect',
      'recover-run',
      'recover-global-scope',
      'setup-approval',
      'setup-admit',
      'generation-issue',
      'workspace-arm',
      'git-permit',
      'git-branch',
      'git-worktree',
      'workspace-persist',
      'git-permit-finalize',
      'supervisor-launch',
      'recovery-evidence-check',
      'recovery-attestation',
      'recovery-evidence-save',
      'setup-settle',
      'execution-child-handoff',
      'setup-evidence-save',
      'operator-cleanup'
    ]);
    expect(probes.connects.mock.calls.map(([configuration]) => configuration.role)).toEqual([
      'forge_runtime',
      'forge_runtime',
      'forge_setup',
      'forge_issuer'
    ]);
    const request = probes.admit.mock.calls[0][0];
    expect(request.setupApproval.approvedBy).toBe('interactive-human');
    expect(request.executionApproval.approvalId).toBe('approval');
    expect(request.authorization.signature).toEqual(expect.any(String));
    expect(probes.issue).toHaveBeenCalledOnce();
    expect(probes.arm).toHaveBeenCalledOnce();
    expect(probes.persist).toHaveBeenCalledOnce();
    expect(probes.settle).toHaveBeenCalledOnce();
    expect(probes.handoff).toHaveBeenCalledOnce();
    expect(probes.closes).toHaveBeenCalledTimes(6);
    const evidence = await readFile(join(f.root, '.local/run-task-recovery.json'), 'utf8');
    expect(evidence).toContain('signed-evidence');
    expect(probes.exec.mock.calls.every(([command]) => ['git', 'docker'].includes(command))).toBe(
      true
    );
  });
  it('refuses authority mismatch before any database client or mutation', async () => {
    const f = await setup();
    const stages: string[] = [];
    await expect(
      prepareApprovedWorkspaces({
        ...f.request,
        runtimeSchema: 'other',
        onStage: (stage) => stages.push(stage)
      })
    ).rejects.toThrow('does not match');
    expect(stages).toEqual(['operator-config']);
    expect(probes.connects).not.toHaveBeenCalled();
    expect(probes.exec).not.toHaveBeenCalled();
  });
  it('retains fail-closed setup admission without running Git or minting generations', async () => {
    const f = await setup();
    const stages: string[] = [];
    probes.admit.mockResolvedValueOnce({ status: 'blocked' });
    await expect(
      prepareApprovedWorkspaces({ ...f.request, onStage: (stage) => stages.push(stage) })
    ).rejects.toThrow('independent recovery');
    expect(stages.at(-1)).toBe('setup-admit');
    expect(probes.exec).not.toHaveBeenCalled();
    expect(probes.issue).not.toHaveBeenCalled();
    expect(probes.closes).toHaveBeenCalledTimes(6);
  });
  it('closes already opened clients if signing material is absent', async () => {
    const f = await setup();
    const stages: string[] = [];
    await rm(join(f.root, '.local/setup-private.pem'));
    await expect(
      prepareApprovedWorkspaces({ ...f.request, onStage: (stage) => stages.push(stage) })
    ).rejects.toThrow();
    expect(stages.at(-1)).toBe('setup-key-load');
    expect(probes.closes).toHaveBeenCalledTimes(4);
    expect(probes.admit).not.toHaveBeenCalled();
  });
  it('preserves saved settlement evidence and refuses a second handoff', async () => {
    const f = await setup();
    const stages: string[] = [];
    await writeFile(join(f.root, '.local/run-task-recovery.json'), 'existing-evidence');
    await expect(
      prepareApprovedWorkspaces({ ...f.request, onStage: (stage) => stages.push(stage) })
    ).rejects.toThrow('do not mint');
    expect(stages.at(-1)).toBe('recovery-evidence-check');
    expect(probes.settle).not.toHaveBeenCalled();
    expect(await readFile(join(f.root, '.local/run-task-recovery.json'), 'utf8')).toBe(
      'existing-evidence'
    );
  });
  it('reports a rejected recovery handoff connection before admission without disclosing its error', async () => {
    const f = await setup();
    const stages: string[] = [];
    probes.handoffConnect.mockImplementationOnce(() => {
      throw new Error('postgres://forge_recovery:private-password@neon.example/neondb');
    });
    await expect(
      prepareApprovedWorkspaces({ ...f.request, onStage: (stage) => stages.push(stage) })
    ).rejects.toThrow();
    expect(stages.at(-1)).toBe('workspace-handoff-connect');
    expect(JSON.stringify(stages)).not.toContain('private-password');
    expect(probes.admit).not.toHaveBeenCalled();
    expect(probes.issue).not.toHaveBeenCalled();
    expect(probes.exec).not.toHaveBeenCalled();
    expect(probes.closes).toHaveBeenCalledTimes(5);
  });
  it('attributes a permit failure after worktree persistence to permit finalization', async () => {
    const f = await setup();
    const stages: string[] = [];
    probes.creation.mockImplementationOnce(
      async (_request: unknown, create: () => Promise<void>) => {
        await create();
        throw new Error('private permit diagnostic');
      }
    );
    await expect(
      prepareApprovedWorkspaces({ ...f.request, onStage: (stage) => stages.push(stage) })
    ).rejects.toThrow('private permit diagnostic');
    expect(stages.at(-1)).toBe('git-permit-finalize');
    expect(probes.persist).toHaveBeenCalledOnce();
    expect(probes.attest).not.toHaveBeenCalled();
    expect(probes.handoff).not.toHaveBeenCalled();
  });
  it('does not let a failing diagnostics callback change successful setup', async () => {
    const f = await setup();
    await prepareApprovedWorkspaces({
      ...f.request,
      onStage: () => {
        throw new Error('observer failed');
      }
    });
    expect(probes.admit).toHaveBeenCalledOnce();
    expect(probes.handoff).toHaveBeenCalledOnce();
  });
});
