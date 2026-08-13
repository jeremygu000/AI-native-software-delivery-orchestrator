import { describe, expect, it } from 'vitest';

import {
  assertTaskReviewIntegrationAdmission,
  TaskReviewIntegrationAdmissionError
} from './task-review-integration-admission.js';

const subject = {
  builderAttemptId: 'attempt-1',
  workspaceId: 'workspace-1',
  workspaceRevision: 1,
  workspaceChangeFingerprint: `sha256:${'1'.repeat(64)}`,
  impactFingerprint: `sha256:${'2'.repeat(64)}`,
  verificationFingerprint: `sha256:${'3'.repeat(64)}`
};

describe('TaskReviewIntegrationAdmission', () => {
  it('admits only an exact accepted review subject', () => {
    expect(() =>
      assertTaskReviewIntegrationAdmission({
        taskId: 'task-1',
        subject,
        reviews: [
          {
            runId: 'run-1',
            taskId: 'task-1',
            iteration: 1,
            subject,
            review: { recommendation: 'accept', summary: 'Accepted.', findings: [] }
          }
        ]
      })
    ).not.toThrow();
  });

  it('rejects stale, repair, and legacy review evidence', () => {
    for (const review of [
      {
        runId: 'run-1',
        taskId: 'task-1',
        iteration: 1,
        subject: { ...subject, workspaceChangeFingerprint: `sha256:${'4'.repeat(64)}` },
        review: { recommendation: 'accept' as const, summary: 'Stale.', findings: [] }
      },
      {
        runId: 'run-1',
        taskId: 'task-1',
        iteration: 1,
        subject,
        review: {
          recommendation: 'repair' as const,
          summary: 'Repair.',
          findings: [
            {
              id: 'finding-1',
              severity: 'high' as const,
              fileIds: ['core:value.txt'],
              symbolIds: [],
              description: 'Repair required.'
            }
          ]
        }
      },
      {
        runId: 'run-1',
        taskId: 'task-1',
        iteration: 1,
        review: { recommendation: 'accept' as const, summary: 'Legacy.', findings: [] }
      }
    ]) {
      expect(() =>
        assertTaskReviewIntegrationAdmission({ taskId: 'task-1', subject, reviews: [review] })
      ).toThrow(TaskReviewIntegrationAdmissionError);
    }
  });
});
