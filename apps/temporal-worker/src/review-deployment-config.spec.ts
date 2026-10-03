import type { PiSessionModel } from '@ai-native-software-delivery-orchestrator/agent-runtime';
import { describe, expect, it } from 'vitest';

import { codeReviewPolicyFingerprint } from '@ai-native-software-delivery-orchestrator/planning';

import {
  assertWorkerReviewPolicyMatchesAuthority,
  resolveWorkerReviewDeploymentConfig
} from './review-deployment-config.js';

const model: PiSessionModel = {
  provider: 'provider-a',
  id: 'model-a',
  name: 'Model A',
  api: 'openai-completions',
  baseUrl: 'https://example.test/v1',
  reasoning: false,
  input: ['text'],
  contextWindow: 1,
  maxTokens: 1,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
};

describe('resolveWorkerReviewDeploymentConfig', () => {
  it.each(['github-copilot', 'openai-codex'])(
    'pins %s subscription profile independently of API credentials',
    (provider) => {
      const result = resolveWorkerReviewDeploymentConfig({
        FORGE_WORKER_REVIEW_PROVIDER: provider,
        FORGE_WORKER_REVIEW_MODEL: 'gpt-5.4',
        FORGE_SUBSCRIPTION_AUTH_DIRECTORY: '/private/host-only-auth'
      });
      expect(result.execution?.target.providerId).toBe(provider);
      expect(result.policy.reviewer.model.executionTarget).toEqual(result.execution?.target);
      expect(JSON.stringify(result.policy)).not.toContain('/private/host-only-auth');
      const changed = resolveWorkerReviewDeploymentConfig({
        FORGE_WORKER_REVIEW_PROVIDER: provider,
        FORGE_WORKER_REVIEW_MODEL: 'gpt-5.4',
        FORGE_SUBSCRIPTION_AUTH_DIRECTORY: '/private/host-only-auth',
        FORGE_MODEL_REASONING_EFFORT: 'low'
      });
      expect(codeReviewPolicyFingerprint(result.policy)).not.toBe(
        codeReviewPolicyFingerprint(changed.policy)
      );
    }
  );
  it('fails closed for missing or blank deployment identity', () => {
    expect(() => resolveWorkerReviewDeploymentConfig({}, () => model)).toThrow(
      'Worker requires FORGE_WORKER_REVIEW_PROVIDER and FORGE_WORKER_REVIEW_MODEL'
    );
    expect(() =>
      resolveWorkerReviewDeploymentConfig(
        { FORGE_WORKER_REVIEW_PROVIDER: ' ', FORGE_WORKER_REVIEW_MODEL: 'model-a' },
        () => model
      )
    ).toThrow();
  });

  it('canonicalizes and resolves the configured identity before worker construction', () => {
    const result = resolveWorkerReviewDeploymentConfig(
      {
        FORGE_WORKER_REVIEW_PROVIDER: ' provider-a ',
        FORGE_WORKER_REVIEW_MODEL: ' model-a '
      },
      () => model
    );

    expect(result.policy.reviewer.model).toEqual({ provider: 'provider-a', id: 'model-a' });
    expect(codeReviewPolicyFingerprint(result.policy)).toMatch(/^sha256:/);
  });

  it('surfaces model resolution failures before the worker starts', () => {
    expect(() =>
      resolveWorkerReviewDeploymentConfig(
        { FORGE_WORKER_REVIEW_PROVIDER: 'provider-a', FORGE_WORKER_REVIEW_MODEL: 'missing' },
        () => {
          throw new Error('Approved code review model is unavailable: provider-a/missing');
        }
      )
    ).toThrow('Approved code review model is unavailable: provider-a/missing');
  });

  it('rejects a run bound with a different canonical review policy', () => {
    expect(() => assertWorkerReviewPolicyMatchesAuthority('sha256:worker', 'sha256:run')).toThrow(
      'Worker review policy does not match durable run authority'
    );
  });
});
