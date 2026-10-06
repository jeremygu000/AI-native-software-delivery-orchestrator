import { z } from 'zod';
import { CompletionStage } from './completion-values.js';

export const taskViewSchema = z.object({
  id: z.string(),
  title: z.string(),
  goal: z.string(),
  description: z.string().optional(),
  state: z.string(),
  stage: z.enum(CompletionStage).optional(),
  plannedFiles: z.array(z.string()),
  actualFiles: z.array(z.string()),
  diff: z.string().optional(),
  verification: z.object({ status: z.string(), detail: z.string().optional() }).optional(),
  review: z
    .object({
      recommendation: z.string(),
      summary: z.string(),
      findings: z.array(z.object({ path: z.string(), detail: z.string() }))
    })
    .optional(),
  failure: z.string().optional(),
  worktree: z.string().optional(),
  integratedCommit: z.string().optional()
});
export const runViewSchema = z.object({
  planId: z.string(),
  approved: z.boolean(),
  repository: z.string(),
  repositoryCommit: z.string(),
  runId: z.string().optional(),
  state: z.string(),
  recordedRunState: z.string().optional(),
  stateSource: z.enum(['plan', 'run-record', 'task-events']).optional(),
  execution: z.string().optional(),
  verificationMode: z.string().optional(),
  reviewMode: z.string().optional(),
  finalRepository: z
    .object({
      status: z.enum(['passed', 'failed']),
      detail: z.string().optional(),
      head: z.string(),
      clean: z.boolean()
    })
    .optional(),
  tasks: z.array(taskViewSchema),
  edges: z.array(
    z.object({
      id: z.string(),
      source: z.string(),
      target: z.string(),
      kind: z.enum(['dependency', 'conflict']),
      label: z.string()
    })
  ),
  warnings: z.array(z.string())
});
export const planListingSchema = z.array(
  z.object({ id: z.string(), approved: z.boolean(), runId: z.string().optional() })
);
export type TaskView = z.infer<typeof taskViewSchema>;
export type RunView = z.infer<typeof runViewSchema>;
