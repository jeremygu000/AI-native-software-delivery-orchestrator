import { describe, expect, it } from 'vitest';

import { agentExecutionAttemptSchema } from './agent-execution.js';

const base = {
  id: 'attempt-1',
  runId: 'run-1',
  taskId: 'task-1',
  agentId: 'agent-1',
  workspaceId: 'workspace-1',
  leasePlanFingerprint: 'lease-plan-1',
  commandPolicyFingerprint: 'command-policy-1',
  revision: 1
};

describe('agent execution attempt contract', () => {
  it('enforces state-specific evidence invariants', () => {
    expect(agentExecutionAttemptSchema.safeParse({ ...base, state: 'PREPARING' }).success).toBe(
      true
    );
    expect(
      agentExecutionAttemptSchema.safeParse({
        ...base,
        state: 'RUNNING',
        startedAt: new Date('2026-08-13T00:00:00.000Z')
      }).success
    ).toBe(true);
    expect(
      agentExecutionAttemptSchema.safeParse({
        ...base,
        state: 'COMPLETED',
        startedAt: new Date('2026-08-13T00:00:00.000Z'),
        completedAt: new Date('2026-08-13T00:01:00.000Z')
      }).success
    ).toBe(true);
    expect(agentExecutionAttemptSchema.safeParse({ ...base, state: 'COMPLETED' }).success).toBe(
      false
    );
    expect(
      agentExecutionAttemptSchema.safeParse({
        ...base,
        state: 'FAILED',
        completedAt: new Date('2026-08-13T00:01:00.000Z')
      }).success
    ).toBe(false);
    expect(
      agentExecutionAttemptSchema.safeParse({
        ...base,
        state: 'UNKNOWN',
        completedAt: new Date('2026-08-13T00:01:00.000Z'),
        failure: { type: 'unknown-outcome', detail: 'Session state cannot be inspected.' }
      }).success
    ).toBe(true);
  });
});
