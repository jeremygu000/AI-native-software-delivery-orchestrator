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

export const agentExecutionAttemptSchema = z.object({
  id: nonEmptyStringSchema,
  runId: nonEmptyStringSchema,
  taskId: nonEmptyStringSchema,
  agentId: nonEmptyStringSchema,
  workspaceId: nonEmptyStringSchema,
  state: agentExecutionAttemptStateSchema,
  revision: z.int().positive(),
  sessionRef: agentSessionRefSchema.optional(),
  startedAt: z.date().optional(),
  completedAt: z.date().optional(),
  failure: agentExecutionFailureSchema.optional()
});

export type AgentExecutionAttempt = z.infer<typeof agentExecutionAttemptSchema>;
