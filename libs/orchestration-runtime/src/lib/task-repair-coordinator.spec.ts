import type {
  TaskRepairAdmissionStore,
  TaskRepairResumeStore
} from '@ai-native-software-delivery-orchestrator/domain';
import { describe, expect, it } from 'vitest';

import {
  TaskRepairAdmissionError,
  TaskRepairBudgetError,
  TaskRepairCoordinator
} from './task-repair-coordinator.js';

const subject = {
  builderAttemptId: 'builder-1',
  outputAttemptId: 'builder-1',
  workspaceId: 'workspace-1',
  workspaceRevision: 1,
  workspaceChangeFingerprint: `sha256:${'1'.repeat(64)}`,
  impactFingerprint: `sha256:${'2'.repeat(64)}`,
  verificationFingerprint: `sha256:${'3'.repeat(64)}`
};

const repairReview = {
  recommendation: 'repair' as const,
  summary: 'Repair required.',
  findings: [
    {
      id: 'finding-1',
      severity: 'high' as const,
      fileIds: ['core:value.txt'],
      symbolIds: [],
      description: 'Value validation is missing.'
    }
  ]
};

const store = (): TaskRepairAdmissionStore &
  TaskRepairResumeStore & { readonly records: any[] } => {
  const records: any[] = [];
  return {
    records,
    persistRepairAttempt: async (record) => {
      const index = records.findIndex(({ attempt }) => attempt.id === record.attempt.id);
      if (index >= 0) {
        records[index] = record;
      } else {
        records.push(record);
      }
    },
    recoverRepairAttempts: async (runId) => records.filter((record) => record.runId === runId),
    admitRepairAttempt: async ({ attempt, maxRepairs }) => {
      const taskAttempts = records.filter(
        ({ attempt: stored }) => stored.taskId === attempt.taskId
      );
      const existing = taskAttempts.find(
        ({ attempt: stored }) =>
          stored.parentReviewIteration === attempt.parentReviewIteration &&
          JSON.stringify(stored.parentReviewSubject) === JSON.stringify(attempt.parentReviewSubject)
      );
      if (existing !== undefined) {
        return existing.attempt;
      }
      if (taskAttempts.length >= maxRepairs) {
        throw new Error(`Repair budget exhausted for task: ${attempt.taskId}`);
      }
      const admitted = { ...attempt, repairIteration: taskAttempts.length + 1 };
      records.push({ runId: attempt.runId, attempt: admitted });
      return admitted;
    },
    resumeRepairAttempt: async ({ attemptId, expectedRevision }) => {
      const record = records.find(({ attempt }) => attempt.id === attemptId);
      if (record === undefined) {
        return { status: 'not-found' as const };
      }
      if (record.attempt.revision !== expectedRevision) {
        return { status: 'version-conflict' as const, actualRevision: record.attempt.revision };
      }
      if (record.attempt.state !== 'BLOCKED') {
        return { status: 'not-blocked' as const, state: record.attempt.state };
      }
      const attempt = {
        ...record.attempt,
        state: 'PREPARING' as const,
        revision: record.attempt.revision + 1,
        blocker: undefined
      };
      records[records.indexOf(record)] = { ...record, attempt };
      return { status: 'resumed' as const, attempt };
    }
  };
};

describe('TaskRepairCoordinator', () => {
  it('rejects a non-positive repair budget', () => {
    expect(
      () =>
        new TaskRepairCoordinator({
          store: store(),
          maxRepairs: 0,
          createId: () => 'unused'
        })
    ).toThrow(TaskRepairBudgetError);
  });

  it('creates a separate bounded repair lineage from its parent review subject', async () => {
    const evidence = store();
    const coordinator = new TaskRepairCoordinator({
      store: evidence,
      maxRepairs: 1,
      createId: () => 'repair-1',
      now: () => new Date('2026-08-13T00:00:00.000Z')
    });

    const prepared = await coordinator.prepare({
      runId: 'run-1',
      taskId: 'task-1',
      agentId: 'repair-agent',
      workspaceId: 'workspace-1',
      reviewIteration: 1,
      review: repairReview,
      subject
    });
    const started = await coordinator.markStarted(prepared, { backend: 'pi', value: 'session-1' });
    const completed = await coordinator.complete(started);

    expect(completed).toMatchObject({
      id: 'repair-1',
      repairIteration: 1,
      parentReviewIteration: 1,
      parentReviewSubject: subject,
      state: 'COMPLETED',
      sessionRef: { value: 'session-1' }
    });
    await expect(
      coordinator.prepare({
        runId: 'run-1',
        taskId: 'task-1',
        agentId: 'repair-agent',
        workspaceId: 'workspace-1',
        reviewIteration: 1,
        review: repairReview,
        subject
      })
    ).resolves.toMatchObject({ id: 'repair-1', repairIteration: 1 });
    await expect(
      coordinator.prepare({
        runId: 'run-1',
        taskId: 'task-1',
        agentId: 'repair-agent',
        workspaceId: 'workspace-1',
        reviewIteration: 2,
        review: repairReview,
        subject
      })
    ).rejects.toThrow(TaskRepairBudgetError);
  });

  it('rejects an accepted review and persists failed repair evidence separately', async () => {
    const evidence = store();
    const coordinator = new TaskRepairCoordinator({
      store: evidence,
      maxRepairs: 2,
      createId: () => 'repair-1',
      now: () => new Date('2026-08-13T00:00:00.000Z')
    });
    await expect(
      coordinator.prepare({
        runId: 'run-1',
        taskId: 'task-1',
        agentId: 'repair-agent',
        workspaceId: 'workspace-1',
        reviewIteration: 1,
        review: { recommendation: 'accept', summary: 'Accepted.', findings: [] },
        subject
      })
    ).rejects.toThrow(TaskRepairAdmissionError);
    const prepared = await coordinator.prepare({
      runId: 'run-1',
      taskId: 'task-1',
      agentId: 'repair-agent',
      workspaceId: 'workspace-1',
      reviewIteration: 1,
      review: repairReview,
      subject
    });
    await expect(coordinator.fail(prepared, 'Repair command failed.')).resolves.toMatchObject({
      state: 'FAILED',
      failure: { type: 'execution-failed' }
    });
  });

  it('persists repair BLOCKED evidence and resumes the same attempt with compare-and-swap', async () => {
    const evidence = store();
    const coordinator = new TaskRepairCoordinator({
      store: evidence,
      maxRepairs: 1,
      createId: () => 'repair-1',
      now: () => new Date('2026-08-13T00:00:00.000Z')
    });
    const prepared = await coordinator.prepare({
      runId: 'run-1',
      taskId: 'task-1',
      agentId: 'repair-agent',
      workspaceId: 'workspace-1',
      reviewIteration: 1,
      review: repairReview,
      subject
    });
    const starting = await coordinator.markStarting(prepared);
    const running = await coordinator.markStarted(starting);
    const blocked = await coordinator.markBlocked(running, 'owner-lease');
    await expect(coordinator.resume(blocked)).resolves.toMatchObject({
      id: 'repair-1',
      state: 'PREPARING',
      revision: blocked.revision + 1
    });
    await expect(coordinator.resume(blocked)).rejects.toThrow(TaskRepairAdmissionError);
  });
});
