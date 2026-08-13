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
      { runId: 'run-1', taskId: 'task-1', iteration: 1, review: { recommendation: 'accept' } }
    ]);
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
