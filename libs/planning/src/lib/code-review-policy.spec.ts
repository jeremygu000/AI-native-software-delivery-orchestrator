import { describe, expect, it } from 'vitest';

import { codeReviewPolicyFingerprint } from './code-review-policy.js';

const policy = {
  version: 1,
  reviewer: {
    implementation: 'pi-task-code-reviewer',
    provider: 'pi',
    model: 'model-a',
    toolProfile: 'workspace-read-only-v1' as const,
    outputSchemaVersion: 1,
    promptVersion: 'v1'
  }
};

describe('CodeReviewPolicy', () => {
  it('fingerprints only semantic reviewer decision policy fields canonically', () => {
    expect(codeReviewPolicyFingerprint(policy)).toBe(
      codeReviewPolicyFingerprint({
        reviewer: {
          promptVersion: 'v1',
          model: 'model-a',
          provider: 'pi',
          outputSchemaVersion: 1,
          implementation: 'pi-task-code-reviewer',
          toolProfile: 'workspace-read-only-v1'
        },
        version: 1
      })
    );
    expect(
      codeReviewPolicyFingerprint({ ...policy, reviewer: { ...policy.reviewer, model: 'model-b' } })
    ).not.toBe(codeReviewPolicyFingerprint(policy));
  });
});
