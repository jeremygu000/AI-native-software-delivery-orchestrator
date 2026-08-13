import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  PreparedOrchestrationPlan,
  PlanArtifact
} from '@ai-native-software-delivery-orchestrator/planning';
import {
  createPlanApproval,
  createPlanApprovalClaim,
  createPlanArtifact
} from '@ai-native-software-delivery-orchestrator/planning';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fileSystemHooks = vi.hoisted(() => ({
  afterMkdir: undefined as (() => Promise<void>) | undefined,
  unlinkError: undefined as Error | undefined
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      const result = await actual.mkdir(...args);
      await fileSystemHooks.afterMkdir?.();
      return result;
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      if (fileSystemHooks.unlinkError !== undefined) {
        throw fileSystemHooks.unlinkError;
      }
      return actual.unlink(...args);
    }
  };
});

import {
  JsonFilePlanApprovalStore,
  JsonFilePlanArtifactStore,
  PlanApprovalStoreError,
  PlanArtifactStoreError,
  resolvePlanArtifactDirectory
} from './json-file-plan-artifact-store.js';

const directories: string[] = [];

const createDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'forge-plans-'));
  directories.push(directory);
  return directory;
};

const preparedPlan: PreparedOrchestrationPlan = {
  attempts: 1,
  specification: {
    tasks: [
      {
        id: 'task-a',
        title: 'Change A',
        goal: 'Change A safely',
        dependencies: [],
        expectedReads: [],
        expectedWrites: [],
        sharedResources: [],
        verification: [{ type: 'package-script', packageName: 'core', script: 'test' }]
      }
    ]
  },
  impacts: [
    {
      taskId: 'task-a',
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
  executionPlan: { waves: [{ index: 0, taskIds: ['task-a'] }] },
  schedule: { maxConcurrency: 1 },
  semanticReview: {
    recommendation: 'accept',
    summary: 'Covered.',
    requirements: [
      {
        requirement: 'Change A.',
        status: 'covered',
        taskIds: ['task-a'],
        detail: 'Task A covers it.'
      }
    ]
  }
};

const artifact = (content = 'Change A.'): PlanArtifact =>
  createPlanArtifact({
    artifactId: 'plan-1',
    revision: 1,
    createdAt: '2026-08-12T00:00:00.000Z',
    source: { type: 'user-request', content },
    repository: {
      repositoryPath: '/repo',
      projects: new Map(),
      projectDependencies: [],
      files: new Map(),
      symbols: new Map(),
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
    codeReviewPolicy: {
      version: 1,
      reviewer: {
        implementation: 'test',
        agentBackend: 'pi',
        model: { provider: 'test', id: 'test' },
        toolProfile: 'workspace-read-only-v1',
        outputSchemaVersion: 1,
        promptVersion: 'v1'
      }
    },
    preparedPlan
  });

afterEach(async () => {
  fileSystemHooks.afterMkdir = undefined;
  fileSystemHooks.unlinkError = undefined;
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('JsonFilePlanArtifactStore', () => {
  it('atomically saves and recovers a verified plan artifact', async () => {
    const directory = await createDirectory();
    const store = new JsonFilePlanArtifactStore(directory);
    const plan = artifact();

    await store.save(plan);

    expect(await store.load('plan-1', 1)).toEqual(plan);
    expect(JSON.parse(await readFile(store.pathFor('plan-1', 1), 'utf8'))).toEqual(plan);
  });

  it('treats concurrent identical saves as idempotent', async () => {
    const store = new JsonFilePlanArtifactStore(await createDirectory());
    const plan = artifact();

    await expect(
      Promise.all([store.save(plan), store.save(plan), store.save(plan)])
    ).resolves.toEqual([undefined, undefined, undefined]);
  });

  it('rejects replacement of an existing artifact revision', async () => {
    const store = new JsonFilePlanArtifactStore(await createDirectory());
    await store.save(artifact());

    await expect(store.save(artifact('Different source.'))).rejects.toThrow(
      'Plan artifact revision is immutable'
    );
  });

  it('preserves an immutability error when temporary-file cleanup also fails', async () => {
    const store = new JsonFilePlanArtifactStore(await createDirectory());
    await store.save(artifact());
    fileSystemHooks.unlinkError = Object.assign(new Error('cleanup failed'), { code: 'EACCES' });

    await expect(store.save(artifact('Different source.'))).rejects.toThrow(
      'Plan artifact revision is immutable'
    );
  });

  it('reports temporary-file cleanup failure when publication otherwise succeeds', async () => {
    const store = new JsonFilePlanArtifactStore(await createDirectory());
    const plan = artifact();
    fileSystemHooks.unlinkError = Object.assign(new Error('cleanup failed'), { code: 'EACCES' });

    await expect(store.save(plan)).rejects.toThrow('cleanup failed');
    fileSystemHooks.unlinkError = undefined;
    await expect(store.load('plan-1', 1)).resolves.toEqual(plan);
  });

  it('fails closed on corrupted content and a file whose key disagrees with its payload', async () => {
    const directory = await createDirectory();
    const store = new JsonFilePlanArtifactStore(directory);
    await writeFile(store.pathFor('plan-1', 1), '{', 'utf8');
    await expect(store.load('plan-1', 1)).rejects.toBeInstanceOf(SyntaxError);

    await writeFile(store.pathFor('other-plan', 1), JSON.stringify(artifact()), 'utf8');
    await expect(store.load('other-plan', 1)).rejects.toThrow('does not match its file name');
  });

  it('returns undefined for a missing artifact and rejects path traversal identities', async () => {
    const store = new JsonFilePlanArtifactStore(await createDirectory());

    await expect(store.load('plan-1', 1)).resolves.toBeUndefined();
    expect(() => store.pathFor('../escape', 1)).toThrow(PlanArtifactStoreError);
    expect(() => store.pathFor('plan-1', 0)).toThrow(PlanArtifactStoreError);
  });

  it('defaults outside the repository and rejects direct or symlinked in-repository storage', async () => {
    const repositoryRoot = await createDirectory();
    const forgeHome = await createDirectory();
    const aliasRoot = await createDirectory();
    const snapshot = {
      repositoryId: `sha256:${'a'.repeat(64)}`,
      repositoryRoot,
      baseCommit: 'b'.repeat(40),
      workingTreeFingerprint: `sha256:${'c'.repeat(64)}`,
      dirty: false
    };

    await expect(resolvePlanArtifactDirectory(snapshot, undefined, forgeHome)).resolves.toBe(
      join(await realpath(forgeHome), 'plans', 'a'.repeat(64))
    );
    await expect(
      resolvePlanArtifactDirectory(snapshot, join(repositoryRoot, '.forge/plans'), forgeHome)
    ).rejects.toThrow('must be outside the analyzed repository');

    const repositoryAlias = join(aliasRoot, 'repository-alias');
    await symlink(repositoryRoot, repositoryAlias);
    await expect(
      resolvePlanArtifactDirectory(snapshot, join(repositoryAlias, 'plans'), forgeHome)
    ).rejects.toThrow('must be outside the analyzed repository');
  });

  it('rechecks confinement during save after a previously missing ancestor becomes a symlink', async () => {
    const repositoryRoot = await createDirectory();
    const externalRoot = await createDirectory();
    const snapshot = {
      repositoryId: `sha256:${'a'.repeat(64)}`,
      repositoryRoot,
      baseCommit: 'b'.repeat(40),
      workingTreeFingerprint: `sha256:${'c'.repeat(64)}`,
      dirty: false
    };
    const missingAncestor = join(externalRoot, 'future');
    const requestedDirectory = join(missingAncestor, 'plans');
    const resolvedDirectory = await resolvePlanArtifactDirectory(snapshot, requestedDirectory);
    fileSystemHooks.afterMkdir = async () => {
      fileSystemHooks.afterMkdir = undefined;
      await rm(missingAncestor, { recursive: true });
      await symlink(repositoryRoot, missingAncestor);
    };

    await expect(
      new JsonFilePlanArtifactStore(resolvedDirectory, repositoryRoot).save(artifact())
    ).rejects.toThrow('resolved inside the analyzed repository during save');
    await expect(
      readFile(join(repositoryRoot, 'plans', 'plan-1.r1.json'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('JsonFilePlanApprovalStore', () => {
  const approval = () =>
    createPlanApproval({
      approvalId: 'approval-1',
      artifact: artifact(),
      approvedBy: 'reviewer@example.com',
      approvedAt: '2026-08-13T01:00:00.000Z'
    });

  it('atomically saves and loads an exact approval', async () => {
    const store = new JsonFilePlanApprovalStore(await createDirectory());
    const record = approval();

    await store.save(record);

    await expect(store.load('approval-1')).resolves.toEqual(record);
    expect(JSON.parse(await readFile(store.pathFor('approval-1'), 'utf8'))).toEqual(record);
  });

  it('treats identical approval retries as idempotent and rejects replacement', async () => {
    const store = new JsonFilePlanApprovalStore(await createDirectory());
    const record = approval();
    await expect(Promise.all([store.save(record), store.save(record)])).resolves.toEqual([
      undefined,
      undefined
    ]);

    await expect(
      store.save(
        createPlanApproval({
          approvalId: 'approval-1',
          artifact: artifact(),
          approvedBy: 'other-reviewer@example.com',
          approvedAt: '2026-08-13T01:00:00.000Z'
        })
      )
    ).rejects.toThrow('Plan approval is immutable');
  });

  it('claims an approval once, permits same-run retry, and rejects cross-run replay', async () => {
    const store = new JsonFilePlanApprovalStore(await createDirectory());
    const record = approval();
    await store.save(record);
    const first = createPlanApprovalClaim({
      approval: record,
      runId: 'run-1',
      claimedAt: '2026-08-13T02:00:00.000Z'
    });
    const retry = createPlanApprovalClaim({
      approval: record,
      runId: 'run-1',
      claimedAt: '2026-08-13T03:00:00.000Z'
    });

    await expect(store.claim(first)).resolves.toEqual(first);
    await expect(store.claim(retry)).resolves.toEqual(first);
    await expect(store.loadClaim('approval-1')).resolves.toEqual(first);
    await expect(
      store.claim(
        createPlanApprovalClaim({
          approval: record,
          runId: 'run-2',
          claimedAt: '2026-08-13T03:00:00.000Z'
        })
      )
    ).rejects.toThrow('already claimed by another run');
  });

  it('atomically grants only one of two simultaneous cross-run claims', async () => {
    const store = new JsonFilePlanApprovalStore(await createDirectory());
    const record = approval();
    await store.save(record);
    const claims = ['run-1', 'run-2'].map((runId) =>
      createPlanApprovalClaim({
        approval: record,
        runId,
        claimedAt: '2026-08-13T02:00:00.000Z'
      })
    );

    const results = await Promise.allSettled(claims.map((claim) => store.claim(claim)));

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const persisted = await store.loadClaim('approval-1');
    expect(persisted).toBeDefined();
    expect(['run-1', 'run-2']).toContain(persisted?.runId);
  });

  it('fails closed for corrupted records, mismatched keys, and traversal IDs', async () => {
    const directory = await createDirectory();
    const store = new JsonFilePlanApprovalStore(directory);
    await writeFile(store.pathFor('approval-1'), '{', 'utf8');
    await expect(store.load('approval-1')).rejects.toBeInstanceOf(SyntaxError);

    await writeFile(store.pathFor('approval-2'), JSON.stringify(approval()), 'utf8');
    await expect(store.load('approval-2')).rejects.toThrow('does not match its file name');
    expect(() => store.pathFor('../escape')).toThrow(PlanApprovalStoreError);
    expect(() => store.claimPathFor('../escape')).toThrow(PlanApprovalStoreError);
  });

  it('uses approval-specific errors when storage resolves inside the repository', async () => {
    const repositoryRoot = await createDirectory();
    const store = new JsonFilePlanApprovalStore(join(repositoryRoot, 'approvals'), repositoryRoot);

    await expect(store.save(approval())).rejects.toBeInstanceOf(PlanApprovalStoreError);
  });

  it.each(['approval', 'claim'] as const)(
    'rechecks confinement when an %s store ancestor becomes a repository symlink',
    async (operation) => {
      const repositoryRoot = await createDirectory();
      const externalRoot = await createDirectory();
      const missingAncestor = join(externalRoot, 'future');
      const directory = join(missingAncestor, 'plans');
      const store = new JsonFilePlanApprovalStore(directory, repositoryRoot);
      const record = approval();
      if (operation === 'claim') {
        await store.save(record);
      }
      fileSystemHooks.afterMkdir = async () => {
        fileSystemHooks.afterMkdir = undefined;
        await rm(missingAncestor, { recursive: true });
        await symlink(repositoryRoot, missingAncestor);
      };

      const action =
        operation === 'approval'
          ? store.save(record)
          : store.claim(
              createPlanApprovalClaim({
                approval: record,
                runId: 'run-1',
                claimedAt: '2026-08-13T02:00:00.000Z'
              })
            );

      await expect(action).rejects.toBeInstanceOf(PlanApprovalStoreError);
      const escapedPath =
        operation === 'approval'
          ? join(repositoryRoot, 'plans', 'approval.approval-1.json')
          : join(repositoryRoot, 'plans', 'approval.approval-1.claim.json');
      await expect(readFile(escapedPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );
});
