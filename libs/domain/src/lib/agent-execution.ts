import { z } from 'zod';

const nonEmptyStringSchema = z.string().trim().min(1);

export const agentSessionRefSchema = z.object({
  backend: nonEmptyStringSchema,
  value: nonEmptyStringSchema
});

export type AgentSessionRef = z.infer<typeof agentSessionRefSchema>;

export const agentExecutionFailureSchema = z.object({
  type: z.enum(['execution-failed', 'unknown-outcome', 'cancelled']),
  detail: nonEmptyStringSchema
});

export type AgentExecutionFailure = z.infer<typeof agentExecutionFailureSchema>;

export const agentExecutionAttemptStateSchema = z.enum([
  'PREPARING',
  'STARTING',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'UNKNOWN'
]);

export type AgentExecutionAttemptState = z.infer<typeof agentExecutionAttemptStateSchema>;

export const agentExecutionAttemptSchema = z
  .object({
    id: nonEmptyStringSchema,
    runId: nonEmptyStringSchema,
    taskId: nonEmptyStringSchema,
    agentId: nonEmptyStringSchema,
    workspaceId: nonEmptyStringSchema,
    leasePlanFingerprint: nonEmptyStringSchema,
    commandPolicyFingerprint: nonEmptyStringSchema.optional(),
    trustedCommandPath: nonEmptyStringSchema.optional(),
    state: agentExecutionAttemptStateSchema,
    revision: z.int().positive(),
    sessionRef: agentSessionRefSchema.optional(),
    startedAt: z.date().optional(),
    completedAt: z.date().optional(),
    failure: agentExecutionFailureSchema.optional()
  })
  .superRefine((attempt, context) => {
    const require = (condition: boolean, field: keyof typeof attempt, message: string): void => {
      if (!condition) {
        context.addIssue({ code: 'custom', path: [field], message });
      }
    };
    const forbid = (condition: boolean, field: keyof typeof attempt, message: string): void => {
      if (condition) {
        context.addIssue({ code: 'custom', path: [field], message });
      }
    };
    if (attempt.state === 'PREPARING') {
      forbid(
        attempt.startedAt !== undefined,
        'startedAt',
        'PREPARING attempt cannot have startedAt'
      );
      forbid(
        attempt.completedAt !== undefined,
        'completedAt',
        'PREPARING attempt cannot have completedAt'
      );
      forbid(attempt.failure !== undefined, 'failure', 'PREPARING attempt cannot have failure');
      return;
    }
    if (attempt.state === 'STARTING' || attempt.state === 'RUNNING') {
      require(attempt.startedAt !==
        undefined, 'startedAt', `${attempt.state} attempt requires startedAt`);
      forbid(
        attempt.completedAt !== undefined,
        'completedAt',
        `${attempt.state} attempt cannot have completedAt`
      );
      forbid(
        attempt.failure !== undefined,
        'failure',
        `${attempt.state} attempt cannot have failure`
      );
      return;
    }
    if (attempt.state === 'COMPLETED') {
      require(attempt.startedAt !== undefined, 'startedAt', 'COMPLETED attempt requires startedAt');
      require(attempt.completedAt !==
        undefined, 'completedAt', 'COMPLETED attempt requires completedAt');
      forbid(attempt.failure !== undefined, 'failure', 'COMPLETED attempt cannot have failure');
      return;
    }
    require(attempt.completedAt !==
      undefined, 'completedAt', `${attempt.state} attempt requires completedAt`);
    require(attempt.failure !== undefined, 'failure', `${attempt.state} attempt requires failure`);
  });

export type AgentExecutionAttempt = z.infer<typeof agentExecutionAttemptSchema>;
