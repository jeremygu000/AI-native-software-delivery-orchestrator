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

  it('rejects blank and non-production model identities before any smoke effect', () => {
    const authorized = {
      FORGE_M312_EXTERNAL_SMOKE: '1',
      FORGE_M312_CREDENTIALS_CONFIRMED: '1',
      FORGE_M312_CODING_AGENT_CONFIRMED: '1',
      FORGE_M312_REVIEW_PROVIDER: 'openai'
    };
    expect(() =>
      resolveM312ExternalSmokeConfig({ ...authorized, FORGE_M312_REVIEW_MODEL: ' ' })
    ).toThrow('FORGE_M312_REVIEW_MODEL');
    expect(() =>
      resolveM312ExternalSmokeConfig({
        ...authorized,
        FORGE_M312_REVIEW_MODEL: 'claude-sonnet'
      })
    ).toThrow('only supports');
  });

  it('returns the fixed production model identity for every external role', () => {
    expect(
      resolveM312ExternalSmokeConfig({
        FORGE_M312_EXTERNAL_SMOKE: '1',
        FORGE_M312_CREDENTIALS_CONFIRMED: '1',
        FORGE_M312_CODING_AGENT_CONFIRMED: '1',
        FORGE_M312_REVIEW_PROVIDER: 'openai',
        FORGE_M312_REVIEW_MODEL: 'gpt-4.1'
      })
    ).toEqual({ provider: 'openai', model: 'gpt-4.1' });
  });
});
