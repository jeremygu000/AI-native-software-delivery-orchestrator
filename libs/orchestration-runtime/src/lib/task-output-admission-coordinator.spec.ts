import type {
  RepositorySnapshotProvider,
  TaskCodeReviewStore,
  TaskVerificationEvidenceStore
} from '@ai-native-software-delivery-orchestrator/domain';
import { describe, expect, it } from 'vitest';

import { TaskCodeReviewCollector } from './task-code-review-collector.js';
import { TaskOutputAdmissionCoordinator } from './task-output-admission-coordinator.js';

const workspace = {
  id: 'workspace-1',
  runId: 'run-1',
  taskId: 'task-1',
  integrationRepositoryPath: '/integration',
  workspacePath: '/workspace',
  branchName: 'task-1',
  baseRef: 'base',
  integrationRef: 'main',
  revision: 1,
  phase: 'READY_TO_INTEGRATE' as const
};

const builderAttempt = {
  id: 'attempt-1',
  runId: 'run-1',
  taskId: 'task-1',
  agentId: 'agent-1',
  workspaceId: 'workspace-1',
  leasePlanFingerprint: 'lease-1',
  state: 'COMPLETED' as const,
  revision: 2,
  startedAt: new Date('2026-08-13T00:00:00.000Z'),
  completedAt: new Date('2026-08-13T00:01:00.000Z')
};

const impact = {
  predicted: {
    taskId: 'task-1',
    projectsRead: new Set<string>(),
    projectsWritten: new Set<string>(),
    explicitProjectsWritten: new Set<string>(),
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
};

describe('TaskOutputAdmissionCoordinator', () => {
  it('persists exact verification and review evidence before admitting accepted output', async () => {
    const reviews: Parameters<TaskCodeReviewStore['persistReview']>[0][] = [];
    const verification: Parameters<
      TaskVerificationEvidenceStore['persistVerificationEvidence']
    >[0][] = [];
    const collector = new TaskCodeReviewCollector({
      reviewer: {
        review: async () => ({ recommendation: 'accept', summary: 'Approved.', findings: [] })
      },
      store: {
        persistReview: async (record) => {
          reviews.push(record);
        },
        recoverReviews: async () => reviews
      }
    });
    const snapshots: RepositorySnapshotProvider = {
      capture: async () => ({
        repositoryId: 'repository-1',
        repositoryRoot: '/workspace',
        baseCommit: 'a'.repeat(40),
        workingTreeFingerprint: `sha256:${'1'.repeat(64)}`,
        dirty: true
      })
    };
    const coordinator = new TaskOutputAdmissionCoordinator({
      snapshots,
      subjects: {
        createSubject: ({
          builderAttempt: attempt,
          outputAttemptId,
          workspace: current,
          verificationFingerprint
        }) => ({
          builderAttemptId: attempt.id,
          outputAttemptId,
          workspaceId: current.id,
          workspaceRevision: current.revision,
          workspaceChangeFingerprint: `sha256:${'1'.repeat(64)}`,
          impactFingerprint: `sha256:${'2'.repeat(64)}`,
          verificationFingerprint
        })
      },
      reviews: collector,
      reviewStore: {
        persistReview: async (record) => {
          reviews.push(record);
        },
        recoverReviews: async () => reviews
      },
      verificationEvidence: {
        persistVerificationEvidence: async (evidence) => {
          verification.push(evidence);
        },
        recoverVerificationEvidence: async () => verification
      },
      createEvidenceId: () => 'verification-1',
      createVerificationEvidence: ({
        id,
        attempt,
        workspace: current,
        snapshot,
        verificationPolicyFingerprint,
        verifiedAt
      }) => ({
        id,
        runId: attempt.runId,
        taskId: attempt.taskId,
        attemptId: attempt.id,
        workspaceId: current.id,
        workspaceRevision: current.revision,
        workspaceChangeFingerprint: snapshot.workingTreeFingerprint,
        verificationPolicyFingerprint,
        status: 'passed',
        verifiedAt: verifiedAt.toISOString(),
        fingerprint: `sha256:${'3'.repeat(64)}`
      })
    });

    const result = await coordinator.reviewBuilder({
      runId: 'run-1',
      task: {
        id: 'task-1',
        title: 'Task',
        goal: 'Complete task',
        dependencies: [],
        expectedReads: [],
        expectedWrites: [],
        sharedResources: [],
        verification: []
      },
      builderAttempt,
      workspace,
      impact,
      verificationPolicyFingerprint: `sha256:${'4'.repeat(64)}`,
      repository: { files: new Map(), symbols: new Map() }
    });
    await coordinator.assertIntegrationAdmission({
      runId: 'run-1',
      taskId: 'task-1',
      subject: result.subject
    });

    await expect(
      coordinator.assertRepairAdmission({
        runId: 'run-1',
        taskId: 'task-1',
        iteration: 1,
        subject: result.subject
      })
    ).rejects.toThrow('No repair review matches');

    expect(verification).toHaveLength(1);
    expect(reviews).toMatchObject([
      { taskId: 'task-1', iteration: 1, subject: { outputAttemptId: 'attempt-1' } }
    ]);
  });

  it('rejects content drift after review before integration', async () => {
    const reviews: Parameters<TaskCodeReviewStore['persistReview']>[0][] = [
      {
        runId: 'run-1',
        taskId: 'task-1',
        iteration: 1,
        subject: {
          builderAttemptId: 'attempt-1',
          outputAttemptId: 'attempt-1',
          workspaceId: 'workspace-1',
          workspaceRevision: 1,
          workspaceChangeFingerprint: `sha256:${'1'.repeat(64)}`,
          impactFingerprint: `sha256:${'2'.repeat(64)}`,
          verificationFingerprint: `sha256:${'3'.repeat(64)}`
        },
        review: { recommendation: 'accept', summary: 'Approved.', findings: [] }
      }
    ];
    const snapshots: RepositorySnapshotProvider = {
      capture: async () => ({
        repositoryId: 'repository-1',
        repositoryRoot: '/workspace',
        baseCommit: 'a'.repeat(40),
        workingTreeFingerprint: `sha256:${'9'.repeat(64)}`,
        dirty: true
      })
    };
    const coordinator = new TaskOutputAdmissionCoordinator({
      snapshots,
      subjects: { createSubject: () => reviews[0].subject! },
      reviews: new TaskCodeReviewCollector({
        reviewer: { review: async () => reviews[0].review },
        store: { persistReview: async () => undefined, recoverReviews: async () => reviews }
      }),
      reviewStore: { persistReview: async () => undefined, recoverReviews: async () => reviews },
      verificationEvidence: {
        persistVerificationEvidence: async () => undefined,
        recoverVerificationEvidence: async () => []
      },
      createEvidenceId: () => 'unused',
      createVerificationEvidence: () => {
        throw new Error('Not used by pre-integration drift validation.');
      }
    });

    await expect(
      coordinator.assertCurrentIntegrationAdmission({
        runId: 'run-1',
        taskId: 'task-1',
        workspace,
        subject: reviews[0].subject!
      })
    ).rejects.toThrow('Task output changed after review');
  });
});
