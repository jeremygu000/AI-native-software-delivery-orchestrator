import { describe, expect, it } from 'vitest';

import { agentCommandPolicySchema } from './command-policy.js';

describe('AgentCommandPolicy', () => {
  it('accepts fixed command definitions and an explicit environment', () => {
    expect(
      agentCommandPolicySchema.safeParse({
        commands: [
          {
            id: 'check-types',
            executable: 'pnpm',
            args: ['typecheck'],
            timeoutMs: 30_000,
            maxOutputBytes: 10_000
          }
        ],
        environment: { CI: '1' }
      }).success
    ).toBe(true);
  });

  it('rejects a shell-like executable', () => {
    expect(
      agentCommandPolicySchema.safeParse({
        commands: [{ id: 'run', executable: 'bash -c', args: [], timeoutMs: 1, maxOutputBytes: 1 }],
        environment: {}
      }).success
    ).toBe(false);
  });

  it('rejects duplicate command IDs', () => {
    expect(
      agentCommandPolicySchema.safeParse({
        commands: [
          { id: 'run', executable: 'node', args: [], timeoutMs: 1, maxOutputBytes: 1 },
          { id: 'run', executable: 'pnpm', args: [], timeoutMs: 1, maxOutputBytes: 1 }
        ],
        environment: {}
      }).success
    ).toBe(false);
  });

  it('rejects a timeout below the policy minimum', () => {
    expect(
      agentCommandPolicySchema.safeParse({
        commands: [{ id: 'run', executable: 'node', args: [], timeoutMs: 0, maxOutputBytes: 1 }],
        environment: {}
      }).success
    ).toBe(false);
  });

  it('rejects a timeout above the policy maximum', () => {
    expect(
      agentCommandPolicySchema.safeParse({
        commands: [
          {
            id: 'check-types',
            executable: 'pnpm',
            args: ['typecheck'],
            timeoutMs: 600_001,
            maxOutputBytes: 1
          }
        ],
        environment: {}
      }).success
    ).toBe(false);
  });

  it('rejects an output limit below the policy minimum', () => {
    expect(
      agentCommandPolicySchema.safeParse({
        commands: [{ id: 'run', executable: 'node', args: [], timeoutMs: 1, maxOutputBytes: 0 }],
        environment: {}
      }).success
    ).toBe(false);
  });

  it('rejects an output limit above the policy maximum', () => {
    expect(
      agentCommandPolicySchema.safeParse({
        commands: [
          {
            id: 'check-types',
            executable: 'pnpm',
            args: ['typecheck'],
            timeoutMs: 1,
            maxOutputBytes: 1_048_577
          }
        ],
        environment: {}
      }).success
    ).toBe(false);
  });

  it('rejects a PATH override', () => {
    expect(
      agentCommandPolicySchema.safeParse({
        commands: [
          {
            id: 'check-types',
            executable: 'pnpm',
            args: ['typecheck'],
            timeoutMs: 1,
            maxOutputBytes: 1
          }
        ],
        environment: { PATH: '/override' }
      }).success
    ).toBe(false);
  });

  it('rejects an invalid environment name', () => {
    expect(
      agentCommandPolicySchema.safeParse({
        commands: [
          {
            id: 'check-types',
            executable: 'pnpm',
            args: ['typecheck'],
            timeoutMs: 1,
            maxOutputBytes: 1
          }
        ],
        environment: { '1INVALID': 'value' }
      }).success
    ).toBe(false);
  });

  it('rejects a NUL environment value', () => {
    expect(
      agentCommandPolicySchema.safeParse({
        commands: [{ id: 'run', executable: 'node', args: [], timeoutMs: 1, maxOutputBytes: 1 }],
        environment: { NUL: 'before\0after' }
      }).success
    ).toBe(false);
  });

  it('rejects a newline environment value', () => {
    expect(
      agentCommandPolicySchema.safeParse({
        commands: [{ id: 'run', executable: 'node', args: [], timeoutMs: 1, maxOutputBytes: 1 }],
        environment: { NEWLINE: 'before\nafter' }
      }).success
    ).toBe(false);
  });
});
