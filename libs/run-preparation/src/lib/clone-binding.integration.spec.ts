import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RepositoryGraph } from '@ai-native-software-delivery-orchestrator/domain';
import {
  areEquivalentApprovalClaims,
  createPlanApproval,
  createPlanArtifact,
  PlanExecutionBinder,
  type PlanApproval,
  type PlanApprovalClaim,
  type PlanApprovalStore,
  type PlanArtifact,
  type PlanArtifactStore
} from '@ai-native-software-delivery-orchestrator/planning';
import { GitRepositorySnapshotProvider } from '@ai-native-software-delivery-orchestrator/workspace-git';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RunPreparation } from './run-preparation.js';

const directories: string[] = [];
const git = (cwd: string, args: readonly string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

class ArtifactStore implements PlanArtifactStore {
  constructor(readonly artifact: PlanArtifact) {}
  async save(): Promise<void> {}
  async load(): Promise<PlanArtifact> {
    return this.artifact;
  }
}

class ApprovalStore implements PlanApprovalStore {
  claimValue: PlanApprovalClaim | undefined;
  constructor(readonly approval: PlanApproval) {}
  async save(): Promise<void> {}
  async load(): Promise<PlanApproval> {
    return this.approval;
  }
  async claim(claim: PlanApprovalClaim): Promise<PlanApprovalClaim> {
    if (this.claimValue !== undefined && !areEquivalentApprovalClaims(this.claimValue, claim)) {
      throw new Error('approval already claimed');
    }
    this.claimValue = claim;
    return claim;
  }
  async loadClaim(): Promise<PlanApprovalClaim | undefined> {
    return this.claimValue;
  }
}

const graph = (repositoryPath: string): RepositoryGraph => ({
  repositoryPath,
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
  files: new Map(),
  symbols: new Map(),
  fileDependencies: [],
  symbolReferences: [],
  diagnostics: []
});

const preparedPlan = {
  attempts: 1,
  specification: {
    tasks: [
      {
        id: 'task-1',
        title: 'Change core',
        goal: 'Change core',
        dependencies: [],
        expectedReads: [],
        expectedWrites: [{ type: 'project' as const, value: 'core' }],
        sharedResources: [],
        verification: [{ type: 'package-script' as const, packageName: 'core', script: 'test' }]
      }
    ]
  },
  impacts: [
    {
      taskId: 'task-1',
      projectsRead: new Set<string>(),
      projectsWritten: new Set(['core']),
      explicitProjectsWritten: new Set(['core']),
      filesRead: new Set<string>(),
      filesWritten: new Set<string>(),
      explicitFilesWritten: new Set<string>(),
      globFilesWritten: new Set<string>(),
      symbolDerivedFilesWritten: new Set<string>(),
      symbolsRead: new Set<string>(),
      symbolsWritten: new Set<string>(),
      sharedResources: new Set<string>(),
      sharedResourceAccesses: [],
      downstreamProjects: new Set<string>(),
      riskSignals: []
    }
  ],
  hardConflicts: [],
  riskConflicts: [],
  executionPlan: { waves: [{ index: 0, taskIds: ['task-1'] }] },
  schedule: { maxConcurrency: 1 },
  semanticReview: {
    recommendation: 'accept' as const,
    summary: 'Covered.',
    requirements: [
      {
        requirement: 'Change core.',
        status: 'covered' as const,
        taskIds: ['task-1'],
        detail: 'Covered.'
      }
    ]
  }
};

afterEach(() => {
  for (const directory of directories.splice(0).toReversed()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('same-origin clone execution binding', () => {
  it('rejects a real second clone before claiming approval even when origin and bytes match', async () => {
    const remote = mkdtempSync(join(tmpdir(), 'forge-clone-remote-'));
    const seed = mkdtempSync(join(tmpdir(), 'forge-clone-seed-'));
    const clones = mkdtempSync(join(tmpdir(), 'forge-clones-'));
    directories.push(remote, seed, clones);
    git(remote, ['init', '--bare']);
    git(seed, ['init', '--initial-branch=main']);
    git(seed, ['config', 'user.email', 'test@example.com']);
    git(seed, ['config', 'user.name', 'Test User']);
    writeFileSync(
      join(seed, 'package.json'),
      JSON.stringify({
        name: 'core',
        version: '1.0.0',
        scripts: { test: 'node -e "process.exit(0)"' }
      })
    );
    git(seed, ['add', '.']);
    git(seed, ['commit', '-m', 'base']);
    git(seed, ['remote', 'add', 'origin', remote]);
    git(seed, ['push', '-u', 'origin', 'main']);
    git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    git(clones, ['clone', remote, 'clone-a']);
    git(clones, ['clone', remote, 'clone-b']);
    const cloneA = join(clones, 'clone-a');
    const cloneB = join(clones, 'clone-b');
    const snapshotProvider = new GitRepositorySnapshotProvider();
    const snapshotA = await snapshotProvider.capture({ repositoryPath: cloneA });
    const snapshotB = await snapshotProvider.capture({ repositoryPath: cloneB });
    expect(snapshotB.repositoryId).toBe(snapshotA.repositoryId);
    expect(snapshotB.workingTreeFingerprint).toBe(snapshotA.workingTreeFingerprint);
    const artifact = createPlanArtifact({
      artifactId: 'plan-1',
      revision: 1,
      createdAt: '2026-08-13T00:00:00.000Z',
      source: { type: 'user-request', content: 'Change core.' },
      repository: graph(cloneA),
      repositorySnapshot: snapshotA,
      sharedResourcePolicy: [],
      verificationPolicy: { version: 1 },
      preparedPlan
    });
    const approval = createPlanApproval({
      approvalId: 'approval-1',
      artifact,
      approvedBy: 'reviewer',
      approvedAt: '2026-08-13T01:00:00.000Z'
    });
    const approvalStore = new ApprovalStore(approval);
    const binder = new PlanExecutionBinder({
      artifactStore: new ArtifactStore(artifact),
      approvalStore,
      snapshotProvider,
      factsProvider: { analyze: async () => graph(cloneB) }
    });

    await expect(
      binder.bind({
        artifactId: artifact.artifactId,
        artifactRevision: artifact.revision,
        approvalId: approval.approvalId,
        runId: 'run-1',
        repository: { repositoryPath: cloneB },
        sharedResourcePolicy: [],
        verificationPolicy: { version: 1 }
      })
    ).rejects.toMatchObject({ mismatches: ['repository-root'] });
    expect(approvalStore.claimValue).toBeUndefined();
  });

  it('revalidates a real repository snapshot before provisioning an integration checkout', async () => {
    const repositoryPath = mkdtempSync(join(tmpdir(), 'forge-fresh-binding-'));
    directories.push(repositoryPath);
    git(repositoryPath, ['init', '--initial-branch=main']);
    git(repositoryPath, ['config', 'user.email', 'test@example.com']);
    git(repositoryPath, ['config', 'user.name', 'Test User']);
    writeFileSync(
      join(repositoryPath, 'package.json'),
      JSON.stringify({
        name: 'core',
        version: '1.0.0',
        scripts: { test: 'node -e "process.exit(0)"' }
      })
    );
    git(repositoryPath, ['add', '.']);
    git(repositoryPath, ['commit', '-m', 'base']);
    const snapshotProvider = new GitRepositorySnapshotProvider();
    const snapshot = await snapshotProvider.capture({ repositoryPath });
    const artifact = createPlanArtifact({
      artifactId: 'plan-1',
      revision: 1,
      createdAt: '2026-08-13T00:00:00.000Z',
      source: { type: 'user-request', content: 'Change core.' },
      repository: graph(repositoryPath),
      repositorySnapshot: snapshot,
      sharedResourcePolicy: [],
      verificationPolicy: { version: 1 },
      preparedPlan
    });
    const approval = createPlanApproval({
      approvalId: 'approval-1',
      artifact,
      approvedBy: 'reviewer',
      approvedAt: '2026-08-13T01:00:00.000Z'
    });
    const binder = new PlanExecutionBinder({
      artifactStore: new ArtifactStore(artifact),
      approvalStore: new ApprovalStore(approval),
      snapshotProvider,
      factsProvider: { analyze: async () => graph(repositoryPath) }
    });
    const bindRequest = {
      artifactId: artifact.artifactId,
      artifactRevision: artifact.revision,
      approvalId: approval.approvalId,
      runId: 'run-1',
      repository: { repositoryPath },
      sharedResourcePolicy: [],
      verificationPolicy: { version: 1 }
    };
    const intent = await binder.bind(bindRequest);
    writeFileSync(join(repositoryPath, 'dirty.txt'), 'changed after approval\n');
    const provision = vi.fn();
    const preparation = new RunPreparation({
      authority: { revalidate: () => binder.bind(bindRequest) },
      checkouts: { provision },
      bindings: { bind: vi.fn() },
      runtime: { startOrResumeRun: vi.fn() }
    });

    await expect(preparation.start(intent)).rejects.toMatchObject({
      mismatches: expect.arrayContaining(['repository-dirty-state'])
    });
    expect(provision).not.toHaveBeenCalled();
  });
});
