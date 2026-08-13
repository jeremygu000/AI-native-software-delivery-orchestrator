import { describe, expect, it } from 'vitest';

import { taskRepairAttemptSchema } from './task-repair-attempt.js';

const subject = {
  builderAttemptId: 'builder-1',
  outputAttemptId: 'builder-1',
  workspaceId: 'workspace-1',
  workspaceRevision: 1,
  workspaceChangeFingerprint: `sha256:${'1'.repeat(64)}`,
  impactFingerprint: `sha256:${'2'.repeat(64)}`,
  verificationFingerprint: `sha256:${'3'.repeat(64)}`
};

const attempt = {
  id: 'repair-1',
  runId: 'run-1',
  taskId: 'task-1',
  agentId: 'repair-agent',
  workspaceId: 'workspace-1',
  parentReviewIteration: 1,
  parentReviewSubject: subject,
  repairIteration: 1,
  state: 'PREPARING' as const,
  revision: 1
};

describe('TaskRepairAttempt', () => {
  it('accepts a prepared repair lineage with a parent review subject', () => {
    expect(taskRepairAttemptSchema.parse(attempt)).toMatchObject({
      state: 'PREPARING',
      parentReviewSubject: subject
    });
  });

  it('requires lease blocker evidence only while blocked', () => {
    expect(
      taskRepairAttemptSchema.parse({
        ...attempt,
        state: 'BLOCKED',
        revision: 2,
        startedAt: new Date(),
        blocker: { type: 'lease', leaseId: 'owner-lease' }
      })
    ).toMatchObject({ state: 'BLOCKED' });
    expect(() =>
      taskRepairAttemptSchema.parse({
        ...attempt,
        state: 'BLOCKED',
        revision: 2,
        startedAt: new Date()
      })
    ).toThrow();
    expect(() =>
      taskRepairAttemptSchema.parse({
        ...attempt,
        blocker: { type: 'lease', leaseId: 'owner-lease' }
      })
    ).toThrow();
  });

  it.each([
    {
      label: 'running without started evidence',
      value: { ...attempt, state: 'RUNNING' }
    },
    {
      label: 'preparing with completion evidence',
      value: { ...attempt, completedAt: new Date() }
    },
    {
      label: 'completed without completion evidence',
      value: { ...attempt, state: 'COMPLETED', startedAt: new Date() }
    },
    {
      label: 'completed with failure evidence',
      value: {
        ...attempt,
        state: 'COMPLETED',
        startedAt: new Date(),
        completedAt: new Date(),
        failure: { type: 'execution-failed', detail: 'Unexpected.' }
      }
    },
    {
      label: 'failed without failure evidence',
      value: { ...attempt, state: 'FAILED', completedAt: new Date() }
    }
  ])('rejects $label', ({ value }) => {
    expect(() => taskRepairAttemptSchema.parse(value)).toThrow();
  });
});
