import type {
  TaskCodeReviewRequest,
  TaskCodeReviewStore
} from '@ai-native-software-delivery-orchestrator/domain';
import { describe, expect, it } from 'vitest';

import { TaskCodeReviewCollector } from './task-code-review-collector.js';

const request: TaskCodeReviewRequest = {
  runId: 'run-1',
  task: {
    id: 'task-1',
    title: 'Validate values',
    goal: 'Validate values before persistence',
    dependencies: [],
    expectedReads: [],
    expectedWrites: [],
    sharedResources: [],
    verification: []
  },
  workspace: {
    id: 'workspace-1',
    runId: 'run-1',
    taskId: 'task-1',
    integrationRepositoryPath: '/integration',
    workspacePath: '/workspace',
    branchName: 'task-1',
    baseRef: 'base',
    integrationRef: 'main',
    revision: 1,
    phase: 'READY_TO_INTEGRATE'
  },
  impact: {
    predicted: {
      taskId: 'task-1',
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
  },
  builderAttempt: {
    id: 'attempt-1',
    runId: 'run-1',
    taskId: 'task-1',
    agentId: 'agent-1',
    workspaceId: 'workspace-1',
    leasePlanFingerprint: 'lease-plan-1',
    state: 'COMPLETED',
    revision: 1,
    startedAt: new Date('2026-08-13T00:00:00.000Z'),
    completedAt: new Date('2026-08-13T00:01:00.000Z')
  },
  subject: {
    builderAttemptId: 'attempt-1',
    workspaceId: 'workspace-1',
    workspaceRevision: 1,
    workspaceChangeFingerprint: `sha256:${'1'.repeat(64)}`,
    impactFingerprint: `sha256:${'2'.repeat(64)}`,
    verificationFingerprint: `sha256:${'3'.repeat(64)}`
  },
  repository: {
    files: new Map([
      [
        'core:value.txt',
        { id: 'core:value.txt', projectId: 'core', path: 'value.txt', isGenerated: false }
      ]
    ]),
    symbols: new Map()
  },
  iteration: 1
};

describe('TaskCodeReviewCollector', () => {
  it('persists a parsed structured review as durable evidence', async () => {
    const records: Parameters<TaskCodeReviewStore['persistReview']>[0][] = [];
    const collector = new TaskCodeReviewCollector({
      reviewer: {
        review: async () =>
          '{"recommendation":"accept","summary":"Implementation matches the task.","findings":[]}'
      },
      store: {
        persistReview: async (record) => {
          records.push(record);
        },
        recoverReviews: async () => records
      }
    });

    await expect(collector.collect(request)).resolves.toMatchObject({ recommendation: 'accept' });
    expect(records).toMatchObject([
      {
        runId: 'run-1',
        taskId: 'task-1',
        iteration: 1,
        subject: { builderAttemptId: 'attempt-1' },
        review: { recommendation: 'accept' }
      }
    ]);
  });

  it('rejects hallucinated finding resource references before persistence', async () => {
    let persisted = false;
    const collector = new TaskCodeReviewCollector({
      reviewer: {
        review: async () =>
          JSON.stringify({
            recommendation: 'repair',
            summary: 'Repair required.',
            findings: [
              {
                id: 'finding-1',
                severity: 'high',
                fileIds: ['unknown:file.ts'],
                symbolIds: ['unknown:symbol'],
                description: 'Not real.'
              }
            ]
          })
      },
      store: {
        persistReview: async () => {
          persisted = true;
        },
        recoverReviews: async () => []
      }
    });

    await expect(collector.collect(request)).rejects.toThrow('invalid structured review');
    expect(persisted).toBe(false);
  });

  it('fails before persistence when reviewer output is malformed', async () => {
    let persisted = false;
    const collector = new TaskCodeReviewCollector({
      reviewer: { review: async () => 'not JSON' },
      store: {
        persistReview: async () => {
          persisted = true;
        },
        recoverReviews: async () => []
      }
    });

    await expect(collector.collect(request)).rejects.toThrow('invalid structured review');
    expect(persisted).toBe(false);
  });
});
