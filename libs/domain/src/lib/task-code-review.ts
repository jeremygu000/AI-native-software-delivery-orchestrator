import { z } from 'zod';

import type { TaskImpact } from './conflict.js';
import type { TaskContract } from './task-contract.js';
import type { TaskWorkspace } from './workspace.js';

const nonEmptyStringSchema = z.string().trim().min(1);

export const taskCodeReviewFindingSchema = z.object({
  id: nonEmptyStringSchema,
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  fileIds: z.array(nonEmptyStringSchema).min(1),
  symbolIds: z.array(nonEmptyStringSchema),
  description: nonEmptyStringSchema,
  requirementReference: nonEmptyStringSchema.optional()
});

export const taskCodeReviewSchema = z
  .object({
    recommendation: z.enum(['accept', 'repair']),
    summary: nonEmptyStringSchema,
    findings: z.array(taskCodeReviewFindingSchema)
  })
  .superRefine((review, context) => {
    const findingIds = new Set<string>();
    for (const [index, finding] of review.findings.entries()) {
      if (findingIds.has(finding.id)) {
        context.addIssue({
          code: 'custom',
          path: ['findings', index, 'id'],
          message: 'Code review finding IDs must be unique'
        });
      }
      findingIds.add(finding.id);
    }
    if (review.recommendation === 'accept' && review.findings.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['recommendation'],
        message: 'An accepted code review cannot contain findings'
      });
    }
    if (review.recommendation === 'repair' && review.findings.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['recommendation'],
        message: 'A repair recommendation requires at least one finding'
      });
    }
  });

export type TaskCodeReview = z.infer<typeof taskCodeReviewSchema>;

export interface TaskCodeReviewRequest {
  readonly runId: string;
  readonly task: TaskContract;
  readonly workspace: TaskWorkspace;
  readonly impact: TaskImpact;
  readonly iteration: number;
}

export interface TaskCodeReviewer {
  review(request: TaskCodeReviewRequest): Promise<unknown>;
}

export class TaskCodeReviewError extends Error {
  readonly issues: readonly z.core.$ZodIssue[];

  constructor(issues: readonly z.core.$ZodIssue[]) {
    super('Task code reviewer returned an invalid structured review');
    this.name = 'TaskCodeReviewError';
    this.issues = issues;
  }
}

export const parseTaskCodeReview = (value: unknown): TaskCodeReview => {
  let candidate = value;
  if (typeof value === 'string') {
    try {
      candidate = JSON.parse(value) as unknown;
    } catch {
      throw new TaskCodeReviewError([
        { code: 'custom', path: [], message: 'Task code review must be one JSON object' }
      ]);
    }
  }
  const parsed = taskCodeReviewSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new TaskCodeReviewError(parsed.error.issues);
  }
  return parsed.data;
};
