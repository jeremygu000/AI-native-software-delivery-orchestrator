import { z } from 'zod';

import { agentExecutionFailureSchema, agentSessionRefSchema } from './agent-execution.js';
import { taskCodeReviewSubjectSchema } from './task-code-review.js';

const nonEmptyStringSchema = z.string().trim().min(1);

export const taskRepairAttemptStateSchema = z.enum([
  'PREPARING',
  'STARTING',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'UNKNOWN'
]);

export const taskRepairAttemptSchema = z
  .object({
    id: nonEmptyStringSchema,
    runId: nonEmptyStringSchema,
    taskId: nonEmptyStringSchema,
    agentId: nonEmptyStringSchema,
    workspaceId: nonEmptyStringSchema,
    parentReviewIteration: z.int().positive(),
    parentReviewSubject: taskCodeReviewSubjectSchema,
    repairIteration: z.int().positive(),
    state: taskRepairAttemptStateSchema,
    revision: z.int().positive(),
    sessionRef: agentSessionRefSchema.optional(),
    startedAt: z.date().optional(),
    completedAt: z.date().optional(),
    failure: agentExecutionFailureSchema.optional()
  })
  .superRefine((attempt, context) => {
    const requiresStartedAt =
      attempt.state === 'STARTING' || attempt.state === 'RUNNING' || attempt.state === 'COMPLETED';
    if (requiresStartedAt && attempt.startedAt === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['startedAt'],
        message: `${attempt.state} repair attempt requires startedAt`
      });
    }
    if (
      (attempt.state === 'PREPARING' ||
        attempt.state === 'STARTING' ||
        attempt.state === 'RUNNING') &&
      attempt.completedAt !== undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['completedAt'],
        message: `${attempt.state} repair attempt cannot have completedAt`
      });
    }
    if (attempt.state === 'COMPLETED') {
      if (attempt.completedAt === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['completedAt'],
          message: 'COMPLETED repair attempt requires completedAt'
        });
      }
      if (attempt.failure !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['failure'],
          message: 'COMPLETED repair attempt cannot have failure'
        });
      }
    }
    if (
      (attempt.state === 'FAILED' || attempt.state === 'UNKNOWN') &&
      attempt.failure === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['failure'],
        message: `${attempt.state} repair attempt requires failure`
      });
    }
  });

export type TaskRepairAttempt = z.infer<typeof taskRepairAttemptSchema>;

export interface TaskRepairExecutionResult {
  readonly attempt: TaskRepairAttempt;
  readonly reviewSubject: import('./task-code-review.js').TaskCodeReviewSubject;
  readonly review: import('./task-code-review.js').TaskCodeReview;
  readonly verification: import('./task-verification-evidence.js').TaskVerificationEvidence;
}
