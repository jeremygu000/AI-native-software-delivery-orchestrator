import { describe, expect, it } from 'vitest';

import { codeReviewPolicyFingerprint, createCodeReviewPolicy } from './code-review-policy.js';

const policy = {
  version: 1,
  reviewer: {
    implementation: 'pi-task-code-reviewer',
    agentBackend: 'pi',
    model: { provider: 'provider-a', id: 'model-a' },
    toolProfile: 'workspace-read-only-v1' as const,
    outputSchemaVersion: 1,
    promptVersion: 'v1'
  }
} as const;

describe('CodeReviewPolicy', () => {
  it('canonicalizes the selected deployment identity', () => {
    expect(createCodeReviewPolicy({ provider: ' provider-a ', model: ' model-a ' })).toMatchObject({
      reviewer: { model: { provider: 'provider-a', id: 'model-a' } }
    });
    expect(() => createCodeReviewPolicy({ provider: ' ', model: 'model-a' })).toThrow();
    expect(() => createCodeReviewPolicy({ provider: 'provider-a', model: ' ' })).toThrow();
  });

  it('fingerprints only semantic reviewer decision policy fields canonically', () => {
    expect(codeReviewPolicyFingerprint(policy)).toBe(
      codeReviewPolicyFingerprint({
        reviewer: {
          promptVersion: 'v1',
          model: { provider: 'provider-a', id: 'model-a' },
          agentBackend: 'pi',
          outputSchemaVersion: 1,
          implementation: 'pi-task-code-reviewer',
          toolProfile: 'workspace-read-only-v1'
        },
        version: 1
      })
    );
    expect(
      codeReviewPolicyFingerprint({
        ...policy,
        reviewer: { ...policy.reviewer, model: { provider: 'provider-a', id: 'model-b' } }
      })
    ).not.toBe(codeReviewPolicyFingerprint(policy));
  });
});
