import { describe, expect, it } from 'vitest';

import {
  parseSemanticPlanReview,
  SemanticPlanReviewError,
  semanticPlanReviewSchema
} from './semantic-plan-review.js';

const acceptedReview = {
  recommendation: 'accept' as const,
  summary: 'The plan covers the request.',
  requirements: [
    {
      requirement: 'Add login.',
      status: 'covered' as const,
      taskIds: ['task-b', 'task-a', 'task-a'],
      detail: 'The authentication tasks implement and verify login.'
    }
  ]
};

describe('SemanticPlanReview', () => {
  it('parses fenced JSON and canonicalizes requirement task IDs', () => {
    const review = parseSemanticPlanReview(
      `\`\`\`json\n${JSON.stringify(acceptedReview)}\n\`\`\``,
      new Set(['task-a', 'task-b'])
    );

    expect(review.requirements[0].taskIds).toEqual(['task-a', 'task-b']);
  });

  it('requires recommendation and requirement statuses to agree', () => {
    expect(
      semanticPlanReviewSchema.safeParse({
        ...acceptedReview,
        recommendation: 'accept',
        requirements: [
          {
            requirement: 'Add logout.',
            status: 'missing',
            taskIds: [],
            detail: 'No task implements logout.'
          }
        ]
      }).success
    ).toBe(false);
    expect(
      semanticPlanReviewSchema.safeParse({ ...acceptedReview, recommendation: 'revise' }).success
    ).toBe(false);
  });

  it('requires covered requirements to cite at least one task', () => {
    expect(
      semanticPlanReviewSchema.safeParse({
        ...acceptedReview,
        requirements: [{ ...acceptedReview.requirements[0], taskIds: [] }]
      }).success
    ).toBe(false);
  });

  it('rejects duplicate requirements and unknown task citations', () => {
    expect(
      semanticPlanReviewSchema.safeParse({
        ...acceptedReview,
        requirements: [
          acceptedReview.requirements[0],
          { ...acceptedReview.requirements[0], requirement: ' add LOGIN. ' }
        ]
      }).success
    ).toBe(false);

    expect(() =>
      parseSemanticPlanReview(
        {
          ...acceptedReview,
          requirements: [{ ...acceptedReview.requirements[0], taskIds: ['missing-task'] }]
        },
        new Set(['task-a'])
      )
    ).toThrow(SemanticPlanReviewError);
  });

  it('fails closed for non-object and malformed review values', () => {
    expect(() => parseSemanticPlanReview('not JSON', new Set())).toThrow(SemanticPlanReviewError);
    expect(() => parseSemanticPlanReview([], new Set())).toThrow(SemanticPlanReviewError);
  });
});
