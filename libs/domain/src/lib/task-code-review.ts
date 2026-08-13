import { z } from 'zod';

import type { TaskImpact } from './conflict.js';
import type { AgentExecutionAttempt } from './agent-execution.js';
import type { RepositoryGraph } from './repository-graph.js';
import type { RepositorySnapshot } from './repository-graph.js';
import type { TaskContract } from './task-contract.js';
import type { TaskWorkspace } from './workspace.js';

const nonEmptyStringSchema = z.string().trim().min(1);
const fingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const taskCodeReviewSubjectSchema = z.object({
  builderAttemptId: nonEmptyStringSchema,
  outputAttemptId: nonEmptyStringSchema,
  workspaceId: nonEmptyStringSchema,
  workspaceRevision: z.int().positive(),
  workspaceChangeFingerprint: fingerprintSchema,
  impactFingerprint: fingerprintSchema,
  verificationFingerprint: fingerprintSchema
});

export type TaskCodeReviewSubject = z.infer<typeof taskCodeReviewSubjectSchema>;

export interface TaskCodeReviewSubjectProvider {
  createSubject(request: {
    readonly builderAttempt: AgentExecutionAttempt;
    readonly outputAttemptId: string;
    readonly workspace: TaskWorkspace;
    readonly impact: TaskImpact;
    readonly workspaceSnapshot: RepositorySnapshot;
    readonly verificationFingerprint: string;
  }): TaskCodeReviewSubject;
}

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
  readonly builderAttempt: AgentExecutionAttempt;
  readonly subject: TaskCodeReviewSubject;
  readonly repository: Pick<RepositoryGraph, 'files' | 'symbols'>;
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

export const assertTaskCodeReviewFindingEvidence = (
  review: TaskCodeReview,
  repository: Pick<RepositoryGraph, 'files' | 'symbols'>
): void => {
  const issues: z.core.$ZodIssue[] = [];
  for (const [findingIndex, finding] of review.findings.entries()) {
    for (const [fileIndex, fileId] of finding.fileIds.entries()) {
      if (!repository.files.has(fileId)) {
        issues.push({
          code: 'custom',
          path: ['findings', findingIndex, 'fileIds', fileIndex],
          message: `Code review references unknown file: ${fileId}`
        });
      }
    }
    for (const [symbolIndex, symbolId] of finding.symbolIds.entries()) {
      if (!repository.symbols.has(symbolId)) {
        issues.push({
          code: 'custom',
          path: ['findings', findingIndex, 'symbolIds', symbolIndex],
          message: `Code review references unknown symbol: ${symbolId}`
        });
      }
    }
  }
  if (issues.length > 0) {
    throw new TaskCodeReviewError(issues);
  }
};
