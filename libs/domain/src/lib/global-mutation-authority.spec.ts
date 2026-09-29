import { describe, expect, it, vi } from 'vitest';

import {
  FencedMutationPort,
  type CurrentMutationTokenRequest
} from './global-mutation-authority.js';

const request: CurrentMutationTokenRequest = {
  scopeId: 'scope-1',
  claimId: 'claim-1',
  owner: {
    runId: 'run-1',
    taskId: 'task-1',
    attemptId: 'attempt-1',
    agentId: 'agent-1'
  },
  token: 1,
  resource: { type: 'file', projectId: 'catalog', fileId: 'product.ts' }
};

describe('FencedMutationPort', () => {
  it('does not enter the controlled side effect when authority rejects a stale token', async () => {
    const sideEffect = vi.fn(async () => 'mutated');
    const endFencedMutation = vi.fn(async () => undefined);
    const authority = {
      beginFencedMutation: vi.fn(async () => {
        throw new Error('stale token');
      }),
      endFencedMutation
    };

    await expect(new FencedMutationPort(authority).execute(request, sideEffect)).rejects.toThrow(
      'stale token'
    );
    expect(sideEffect).not.toHaveBeenCalled();
    expect(endFencedMutation).not.toHaveBeenCalled();
  });

  it('holds the exact permit until the callback settles', async () => {
    const permit = { id: 'permit-1', completionSecret: 'completion-secret-1' };
    const calls: string[] = [];
    const authority = {
      beginFencedMutation: vi.fn(async () => {
        calls.push('begin');
        return permit;
      }),
      endFencedMutation: vi.fn(async (released: typeof permit) => {
        expect(released).toBe(permit);
        calls.push('end');
      })
    };

    await expect(
      new FencedMutationPort(authority).execute(request, async () => {
        calls.push('callback');
        return 'written';
      })
    ).resolves.toBe('written');
    expect(calls).toEqual(['begin', 'callback', 'end']);
  });
});
