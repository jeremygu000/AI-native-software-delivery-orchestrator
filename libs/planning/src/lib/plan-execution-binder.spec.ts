import type {
  RepositoryContext,
  RepositoryGraph,
  RepositorySnapshot,
  RepositorySnapshotProvider
} from '@ai-native-software-delivery-orchestrator/domain';
import { describe, expect, it } from 'vitest';

import {
  areEquivalentApprovalClaims,
  createPlanApproval,
  type PlanApproval,
  type PlanApprovalClaim,
  type PlanApprovalStore
} from './plan-approval.js';
import { approvalTestArtifact, approvalTestGraph } from './plan-artifact.fixture.js';
import {
  parsePlanExecutionIntent,
  PlanExecutionBinder,
  type RepositoryFactsProvider
} from './plan-execution-binder.js';
import { fingerprintPlanValue } from './plan-artifact.js';
import type { PlanArtifact, PlanArtifactStore } from './plan-artifact.js';
import { RepositorySnapshotChangedError } from './plan-artifact.js';

class MemoryArtifactStore implements PlanArtifactStore {
  constructor(readonly artifact?: PlanArtifact) {}

  async save(): Promise<void> {}

  async load(artifactId: string, revision: number): Promise<PlanArtifact | undefined> {
    return this.artifact?.artifactId === artifactId && this.artifact.revision === revision
      ? this.artifact
      : undefined;
  }
}

class MemoryApprovalStore implements PlanApprovalStore {
  readonly #approvals = new Map<string, PlanApproval>();
  readonly #claims = new Map<string, PlanApprovalClaim>();

  constructor(approval?: PlanApproval) {
    if (approval !== undefined) {
      this.#approvals.set(approval.approvalId, approval);
    }
  }

  async save(approval: PlanApproval): Promise<void> {
    this.#approvals.set(approval.approvalId, approval);
  }

  async load(approvalId: string): Promise<PlanApproval | undefined> {
    return this.#approvals.get(approvalId);
  }

  async claim(claim: PlanApprovalClaim): Promise<PlanApprovalClaim> {
    const existing = this.#claims.get(claim.approvalId);
    if (existing !== undefined) {
      if (areEquivalentApprovalClaims(existing, claim)) {
        return existing;
      }
      throw new Error('approval already claimed');
    }
    this.#claims.set(claim.approvalId, claim);
    return claim;
  }

  async loadClaim(approvalId: string): Promise<PlanApprovalClaim | undefined> {
    return this.#claims.get(approvalId);
  }
}

class SequenceSnapshotProvider implements RepositorySnapshotProvider {
  readonly #snapshots: RepositorySnapshot[];

  constructor(...snapshots: RepositorySnapshot[]) {
    this.#snapshots = [...snapshots];
  }

  async capture(): Promise<RepositorySnapshot> {
    const snapshot = this.#snapshots.shift();
    if (snapshot === undefined) {
      throw new Error('No snapshot configured');
    }
    return snapshot;
  }
}

class StaticFactsProvider implements RepositoryFactsProvider {
  constructor(readonly graph: RepositoryGraph) {}

  async analyze(_repository: RepositoryContext): Promise<RepositoryGraph> {
    return this.graph;
  }
}

const approvalFor = (artifact = approvalTestArtifact()): PlanApproval =>
  createPlanApproval({
    approvalId: 'approval-1',
    artifact,
    approvedBy: 'reviewer@example.com',
    approvedAt: '2026-08-13T01:00:00.000Z'
  });

const binderFor = (options: {
  artifact?: PlanArtifact;
  approval?: PlanApproval;
  snapshots?: readonly RepositorySnapshot[];
  repositoryGraph?: RepositoryGraph;
  approvalStore?: MemoryApprovalStore;
}) => {
  const artifact = options.artifact ?? approvalTestArtifact();
  const snapshot: RepositorySnapshot = {
    repositoryId: artifact.repository.repositoryId,
    repositoryRoot: artifact.repository.repositoryRoot,
    baseCommit: artifact.repository.baseCommit,
    workingTreeFingerprint: artifact.repository.workingTreeFingerprint,
    dirty: artifact.repository.dirty
  };
  return new PlanExecutionBinder({
    artifactStore: new MemoryArtifactStore(artifact),
    approvalStore: options.approvalStore ?? new MemoryApprovalStore(options.approval),
    snapshotProvider: new SequenceSnapshotProvider(...(options.snapshots ?? [snapshot, snapshot])),
    factsProvider: new StaticFactsProvider(options.repositoryGraph ?? approvalTestGraph()),
    now: () => new Date('2026-08-13T02:00:00.000Z')
  });
};

const request = {
  artifactId: 'plan-1',
  artifactRevision: 1,
  approvalId: 'approval-1',
  runId: 'run-1',
  repository: { repositoryPath: '/repo' },
  sharedResourcePolicy: [],
  verificationPolicy: { version: 1 },
  codeReviewPolicy: {
    version: 1,
    reviewer: {
      implementation: 'pi-task-code-reviewer',
      agentBackend: 'pi',
      model: { provider: 'test-provider', id: 'test-model' },
      toolProfile: 'workspace-read-only-v1',
      outputSchemaVersion: 1,
      promptVersion: 'v1'
    }
  }
};

describe('PlanExecutionBinder', () => {
  it('binds one exact approval after repository facts and authority revalidation', async () => {
    const artifact = approvalTestArtifact();
    const intent = await binderFor({ artifact, approval: approvalFor(artifact) }).bind(request);

    expect(parsePlanExecutionIntent(intent)).toEqual(intent);
    expect(intent).toMatchObject({
      runId: 'run-1',
      boundAt: '2026-08-13T02:00:00.000Z',
      artifact: { artifactId: 'plan-1', revision: 1 },
      approval: { approvalId: 'approval-1' },
      approvalClaim: { approvalId: 'approval-1', runId: 'run-1' }
    });
  });

  it('fails closed for missing artifacts and approvals', async () => {
    await expect(
      binderFor({ artifact: approvalTestArtifact(), approval: undefined }).bind(request)
    ).rejects.toThrow('Plan approval not found');
    await expect(
      new PlanExecutionBinder({
        artifactStore: new MemoryArtifactStore(),
        approvalStore: new MemoryApprovalStore(),
        snapshotProvider: new SequenceSnapshotProvider(),
        factsProvider: new StaticFactsProvider(approvalTestGraph())
      }).bind(request)
    ).rejects.toThrow('Plan artifact not found');
  });

  it('rejects approval for a different immutable artifact', async () => {
    const approval = approvalFor(approvalTestArtifact('plan-2'));
    await expect(binderFor({ approval }).bind(request)).rejects.toMatchObject({
      mismatches: ['artifact-id', 'plan-fingerprint']
    });
  });

  it('reports repository and authority mismatches before claiming approval', async () => {
    const artifact = approvalTestArtifact();
    const approvalStore = new MemoryApprovalStore(approvalFor(artifact));
    const changedSnapshot: RepositorySnapshot = {
      repositoryId: `sha256:${'4'.repeat(64)}`,
      repositoryRoot: '/other-clone',
      baseCommit: '5'.repeat(40),
      workingTreeFingerprint: `sha256:${'6'.repeat(64)}`,
      dirty: true
    };
    const binder = binderFor({
      artifact,
      approvalStore,
      snapshots: [changedSnapshot, changedSnapshot],
      repositoryGraph: { ...approvalTestGraph(), diagnostics: [] }
    });

    await expect(
      binder.bind({
        ...request,
        sharedResourcePolicy: [{ id: 'changed' }],
        verificationPolicy: { version: 2 },
        codeReviewPolicy: request.codeReviewPolicy
      })
    ).rejects.toMatchObject({
      mismatches: [
        'repository-id',
        'repository-root',
        'base-commit',
        'working-tree',
        'repository-dirty-state',
        'shared-resource-policy',
        'verification-policy'
      ]
    });
    await expect(approvalStore.loadClaim('approval-1')).resolves.toBeUndefined();
  });

  it('rejects semantic code review policy drift before claiming approval', async () => {
    const artifact = approvalTestArtifact();
    const approvalStore = new MemoryApprovalStore(approvalFor(artifact));
    await expect(
      binderFor({ artifact, approvalStore }).bind({
        ...request,
        codeReviewPolicy: {
          ...request.codeReviewPolicy,
          reviewer: {
            ...request.codeReviewPolicy.reviewer,
            model: { provider: 'test-provider', id: 'changed-model' }
          }
        }
      })
    ).rejects.toMatchObject({ mismatches: ['code-review-policy'] });
    await expect(approvalStore.loadClaim('approval-1')).resolves.toBeUndefined();
  });

  it('rejects an equivalent clone at a different physical repository root', async () => {
    const artifact = approvalTestArtifact();
    const approvalStore = new MemoryApprovalStore(approvalFor(artifact));
    const differentClone: RepositorySnapshot = {
      repositoryId: artifact.repository.repositoryId,
      repositoryRoot: '/other-clone',
      baseCommit: artifact.repository.baseCommit,
      workingTreeFingerprint: artifact.repository.workingTreeFingerprint,
      dirty: artifact.repository.dirty
    };

    await expect(
      binderFor({
        artifact,
        approvalStore,
        snapshots: [differentClone, differentClone]
      }).bind(request)
    ).rejects.toMatchObject({ mismatches: ['repository-root'] });
    await expect(approvalStore.loadClaim('approval-1')).resolves.toBeUndefined();
  });

  it('rejects a repository whose dirty state alone differs from the approved snapshot', async () => {
    const artifact = approvalTestArtifact();
    const approvalStore = new MemoryApprovalStore(approvalFor(artifact));
    const changedDirtyState: RepositorySnapshot = {
      repositoryId: artifact.repository.repositoryId,
      repositoryRoot: artifact.repository.repositoryRoot,
      baseCommit: artifact.repository.baseCommit,
      workingTreeFingerprint: artifact.repository.workingTreeFingerprint,
      dirty: !artifact.repository.dirty
    };

    await expect(
      binderFor({
        artifact,
        approvalStore,
        snapshots: [changedDirtyState, changedDirtyState]
      }).bind(request)
    ).rejects.toMatchObject({ mismatches: ['repository-dirty-state'] });
    await expect(approvalStore.loadClaim('approval-1')).resolves.toBeUndefined();
  });

  it('rejects changed Repository Facts even when Git evidence is unchanged', async () => {
    const artifact = approvalTestArtifact();
    const originalGraph = approvalTestGraph();
    const changedGraph: RepositoryGraph = {
      ...originalGraph,
      projects: new Map([
        ...originalGraph.projects,
        [
          'new-project',
          {
            id: 'new-project',
            name: 'new-project',
            root: '.',
            packageJsonPath: 'package.json',
            dependencies: [],
            scripts: {},
            sourceRoots: [],
            tsconfigPaths: []
          }
        ]
      ])
    };

    await expect(
      binderFor({ artifact, approval: approvalFor(artifact), repositoryGraph: changedGraph }).bind(
        request
      )
    ).rejects.toMatchObject({ mismatches: ['repository-facts'] });
  });

  it('rejects a repository that changes while binding facts are rebuilt', async () => {
    const artifact = approvalTestArtifact();
    const first: RepositorySnapshot = {
      repositoryId: artifact.repository.repositoryId,
      repositoryRoot: artifact.repository.repositoryRoot,
      baseCommit: artifact.repository.baseCommit,
      workingTreeFingerprint: artifact.repository.workingTreeFingerprint,
      dirty: false
    };
    await expect(
      binderFor({
        artifact,
        approval: approvalFor(artifact),
        snapshots: [first, { ...first, dirty: true }]
      }).bind(request)
    ).rejects.toBeInstanceOf(RepositorySnapshotChangedError);
  });

  it('allows idempotent rebinding to one run and rejects approval replay for another run', async () => {
    const artifact = approvalTestArtifact();
    const approvalStore = new MemoryApprovalStore(approvalFor(artifact));
    const first = await binderFor({ artifact, approvalStore }).bind(request);
    const second = await binderFor({ artifact, approvalStore }).bind(request);

    expect(second.executionFingerprint).toBe(first.executionFingerprint);
    await expect(
      binderFor({ artifact, approvalStore }).bind({ ...request, runId: 'run-2' })
    ).rejects.toThrow('approval already claimed');
  });

  it('detects execution intent tampering', async () => {
    const artifact = approvalTestArtifact();
    const intent = await binderFor({ artifact, approval: approvalFor(artifact) }).bind(request);

    expect(() => parsePlanExecutionIntent({ ...intent, runId: 'run-2' })).toThrow(
      'Execution approval claim does not match its approval and run'
    );

    const tamperedPayload = {
      schemaVersion: intent.schemaVersion,
      runId: intent.runId,
      boundAt: intent.boundAt,
      artifact: intent.artifact,
      approval: { ...intent.approval, approvedBy: 'attacker@example.com' },
      approvalClaim: intent.approvalClaim
    };
    expect(() =>
      parsePlanExecutionIntent({
        ...tamperedPayload,
        executionFingerprint: fingerprintPlanValue(tamperedPayload)
      })
    ).toThrow('Approval fingerprint does not match its content');
  });
});
