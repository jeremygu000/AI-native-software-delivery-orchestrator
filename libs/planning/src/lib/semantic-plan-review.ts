import type {
  RepositoryGraph,
  TaskSpecification
} from '@ai-native-software-delivery-orchestrator/domain';
import { z } from 'zod';

import type { PlanningSource } from './autonomous-plan-phase.js';

const nonEmptyStringSchema = z.string().trim().min(1);
const stableTaskIdsSchema = z
  .array(nonEmptyStringSchema)
  .transform((taskIds) => [...new Set(taskIds)].toSorted());

const coveredRequirementSchema = z.object({
  requirement: nonEmptyStringSchema,
  status: z.literal('covered'),
  taskIds: stableTaskIdsSchema.pipe(z.array(nonEmptyStringSchema).min(1)),
  detail: nonEmptyStringSchema
});

const uncoveredRequirementSchema = z.object({
  requirement: nonEmptyStringSchema,
  status: z.enum(['missing', 'ambiguous']),
  taskIds: stableTaskIdsSchema,
  detail: nonEmptyStringSchema
});

export const semanticPlanReviewSchema = z
  .object({
    recommendation: z.enum(['accept', 'revise']),
    summary: nonEmptyStringSchema,
    requirements: z
      .array(z.discriminatedUnion('status', [coveredRequirementSchema, uncoveredRequirementSchema]))
      .min(1)
  })
  .superRefine((review, context) => {
    const requirements = new Set<string>();
    for (const [index, requirement] of review.requirements.entries()) {
      const identity = requirement.requirement.toLowerCase();
      if (requirements.has(identity)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate semantic requirement: ${requirement.requirement}`,
          path: ['requirements', index, 'requirement']
        });
      }
      requirements.add(identity);
    }

    const hasGap = review.requirements.some((requirement) => requirement.status !== 'covered');
    if (review.recommendation === 'accept' && hasGap) {
      context.addIssue({
        code: 'custom',
        message: 'An accept recommendation cannot contain missing or ambiguous requirements',
        path: ['recommendation']
      });
    }
    if (review.recommendation === 'revise' && !hasGap) {
      context.addIssue({
        code: 'custom',
        message: 'A revise recommendation must identify a missing or ambiguous requirement',
        path: ['recommendation']
      });
    }
  });

export type SemanticPlanReview = z.infer<typeof semanticPlanReviewSchema>;

export interface SemanticPlanReviewRequest {
  readonly attempt: number;
  readonly source: PlanningSource;
  readonly repository: RepositoryGraph;
  readonly specification: TaskSpecification;
}

export interface SemanticPlanReviewer {
  review(request: SemanticPlanReviewRequest): Promise<unknown>;
}

export class SemanticPlanReviewError extends Error {
  readonly issues: readonly z.core.$ZodIssue[];

  constructor(issues: readonly z.core.$ZodIssue[]) {
    super('Semantic plan reviewer returned an invalid structured review');
    this.name = 'SemanticPlanReviewError';
    this.issues = issues;
  }
}

export const parseSemanticPlanReview = (
  candidate: unknown,
  taskIds: ReadonlySet<string>
): SemanticPlanReview => {
  let value = candidate;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
    try {
      value = JSON.parse(fenced?.[1] ?? trimmed);
    } catch {
      throw new SemanticPlanReviewError([
        {
          code: 'custom',
          message: 'Semantic plan review must be one JSON object',
          path: []
        }
      ]);
    }
  }

  const parsed = semanticPlanReviewSchema.safeParse(value);
  if (!parsed.success) {
    throw new SemanticPlanReviewError(parsed.error.issues);
  }

  const unknownTaskIssues: z.core.$ZodIssue[] = [];
  for (const [requirementIndex, requirement] of parsed.data.requirements.entries()) {
    for (const [taskIndex, taskId] of requirement.taskIds.entries()) {
      if (!taskIds.has(taskId)) {
        unknownTaskIssues.push({
          code: 'custom',
          message: `Semantic review references unknown task: ${taskId}`,
          path: ['requirements', requirementIndex, 'taskIds', taskIndex]
        });
      }
    }
  }
  if (unknownTaskIssues.length > 0) {
    throw new SemanticPlanReviewError(unknownTaskIssues);
  }
  return parsed.data;
};
