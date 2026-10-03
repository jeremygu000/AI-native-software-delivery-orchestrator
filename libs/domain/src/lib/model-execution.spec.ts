import { describe, expect, it } from 'vitest';
import {
  createModelExecutionTarget,
  resolvedModelExecutionTargetSchema
} from './model-execution.js';

const profile = {
  version: 1,
  providerId: 'openai-codex',
  providerKind: 'subscription',
  modelId: 'gpt-5.4',
  reasoningConfig: { effort: 'high' },
  toolCapabilities: { functionCalling: true, textOnly: true },
  contextLimits: { inputTokens: 200000, outputTokens: 4096 },
  adapterVersion: 'v1',
  transport: 'openai-codex-responses'
} as const;
describe('Credential-free execution target', () => {
  it('canonicalizes semantic inputs and detects policy/transport/capability drift', () => {
    const target = createModelExecutionTarget(profile);
    expect(resolvedModelExecutionTargetSchema.parse(target)).toEqual(target);
    expect(createModelExecutionTarget({ ...profile, providerId: ' openai-codex ' })).toEqual(
      target
    );
    for (const changed of [
      { ...profile, reasoningConfig: { effort: 'low' as const } },
      { ...profile, contextLimits: { inputTokens: 200000, outputTokens: 2048 } },
      { ...profile, toolCapabilities: { functionCalling: false, textOnly: true as const } },
      { ...profile, transport: 'openai-responses' }
    ]) {
      expect(createModelExecutionTarget(changed).executionProfileFingerprint).not.toBe(
        target.executionProfileFingerprint
      );
    }
    expect(() => resolvedModelExecutionTargetSchema.parse({ ...target, modelId: 'other' })).toThrow(
      'fingerprint differs'
    );
    expect(() =>
      resolvedModelExecutionTargetSchema.parse({ ...target, apiKey: 'not-allowed' })
    ).toThrow();
    expect(() =>
      createModelExecutionTarget({
        ...profile,
        contextLimits: { inputTokens: 0, outputTokens: 4096 }
      })
    ).toThrow();
  });
});
