import { describe, expect, it } from 'vitest';

import { resolveM312ExternalSmokeConfig } from './m3.12-external-smoke-config.js';

describe('resolveM312ExternalSmokeConfig', () => {
  it('fails closed until external execution, credential confirmation, and review identity are explicit', () => {
    expect(() => resolveM312ExternalSmokeConfig({})).toThrow('FORGE_M312_EXTERNAL_SMOKE=1');
    expect(() => resolveM312ExternalSmokeConfig({ FORGE_M312_EXTERNAL_SMOKE: '1' })).toThrow(
      'FORGE_M312_CREDENTIALS_CONFIRMED=1'
    );
    expect(() =>
      resolveM312ExternalSmokeConfig({
        FORGE_M312_EXTERNAL_SMOKE: '1',
        FORGE_M312_CREDENTIALS_CONFIRMED: '1'
      })
    ).toThrow('FORGE_M312_CODING_AGENT_CONFIRMED=1');
    expect(() =>
      resolveM312ExternalSmokeConfig({
        FORGE_M312_EXTERNAL_SMOKE: '1',
        FORGE_M312_CREDENTIALS_CONFIRMED: '1',
        FORGE_M312_CODING_AGENT_CONFIRMED: '1'
      })
    ).toThrow('FORGE_M312_REVIEW_PROVIDER');
  });

  it('returns only explicit nonblank provider and model configuration', () => {
    expect(
      resolveM312ExternalSmokeConfig({
        FORGE_M312_EXTERNAL_SMOKE: '1',
        FORGE_M312_CREDENTIALS_CONFIRMED: '1',
        FORGE_M312_CODING_AGENT_CONFIRMED: '1',
        FORGE_M312_REVIEW_PROVIDER: 'anthropic',
        FORGE_M312_REVIEW_MODEL: 'claude-sonnet'
      })
    ).toEqual({ reviewProvider: 'anthropic', reviewModel: 'claude-sonnet' });
  });
});
