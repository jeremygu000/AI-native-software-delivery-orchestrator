import { describe, expect, it } from 'vitest';

import { parseTaskCodeReview, TaskCodeReviewError } from './task-code-review.js';

const accepted = {
  recommendation: 'accept',
  summary: 'Implementation matches the task contract.',
  findings: []
} as const;

describe('TaskCodeReview', () => {
  it('accepts an evidence-free acceptance and structured repair findings', () => {
    expect(parseTaskCodeReview(JSON.stringify(accepted))).toEqual(accepted);
    expect(
      parseTaskCodeReview({
        recommendation: 'repair',
        summary: 'One defect requires repair.',
        findings: [
          {
            id: 'finding-1',
            severity: 'high',
            fileIds: ['core:value.txt'],
            symbolIds: [],
            description: 'The value is not validated.',
            requirementReference: 'Validate user input.'
          }
        ]
      })
    ).toMatchObject({ recommendation: 'repair', findings: [{ id: 'finding-1' }] });
  });

  it('fails closed for malformed review structure and inconsistent recommendations', () => {
    expect(() => parseTaskCodeReview('not JSON')).toThrow(TaskCodeReviewError);
    expect(() =>
      parseTaskCodeReview({
        ...accepted,
        findings: [
          {
            id: 'finding-1',
            severity: 'low',
            fileIds: ['core:value.txt'],
            symbolIds: [],
            description: 'Unexpected finding.'
          }
        ]
      })
    ).toThrow(TaskCodeReviewError);
    expect(() =>
      parseTaskCodeReview({
        recommendation: 'repair',
        summary: 'Missing a finding.',
        findings: []
      })
    ).toThrow(TaskCodeReviewError);
    expect(() =>
      parseTaskCodeReview({
        recommendation: 'repair',
        summary: 'Duplicate findings.',
        findings: [
          {
            id: 'finding-1',
            severity: 'low',
            fileIds: ['core:value.txt'],
            symbolIds: [],
            description: 'First.'
          },
          {
            id: 'finding-1',
            severity: 'low',
            fileIds: ['core:other.txt'],
            symbolIds: [],
            description: 'Second.'
          }
        ]
      })
    ).toThrow(TaskCodeReviewError);
  });
});
