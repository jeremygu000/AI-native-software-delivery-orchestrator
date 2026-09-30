import { describe, expect, it } from 'vitest';

import { approvalTestArtifact } from './plan-artifact.fixture.js';
import { createPlanApproval } from './plan-approval.js';
import { fingerprintPlanValue } from './plan-artifact.js';
import {
  assertWorkspaceSetupApproval,
  createWorkspaceSetupApproval,
  parseWorkspaceSetupApproval
} from './workspace-setup-approval.js';

const fixture = () => {
  const artifact = approvalTestArtifact();
  const executionApproval = createPlanApproval({
    approvalId: 'execution-approval-1',
    artifact,
    approvedBy: 'execution-reviewer',
    approvedAt: '2026-08-13T01:00:00.000Z'
  });
  const setupApproval = createWorkspaceSetupApproval({
    setupApprovalId: 'git-setup-approval-1',
    executionApproval,
    artifact,
    taskId: 'task-a',
    approvedBy: 'git-reviewer',
    approvedAt: '2026-08-13T02:00:00.000Z'
  });
  return { artifact, executionApproval, setupApproval };
};

describe('WorkspaceSetupApproval', () => {
  it('records a separate repository-only Git setup decision bound to the approved execution', () => {
    const { artifact, executionApproval, setupApproval } = fixture();
    expect(setupApproval).toMatchObject({
      setupApprovalId: 'git-setup-approval-1',
      executionApprovalId: executionApproval.approvalId,
      resource: { type: 'repository' },
      operation: 'git-worktree-create',
      taskId: 'task-a',
      baseCommit: artifact.repository.baseCommit
    });
    expect(assertWorkspaceSetupApproval({ setupApproval, artifact, executionApproval })).toEqual(
      setupApproval
    );
  });

  it('rejects tampered decisions, reused execution approval identity, and self-declared extra authority', () => {
    const { artifact, executionApproval, setupApproval } = fixture();
    expect(() => parseWorkspaceSetupApproval({ ...setupApproval, approvedBy: 'attacker' })).toThrow(
      'fingerprint does not match'
    );
    expect(() =>
      parseWorkspaceSetupApproval({
        ...setupApproval,
        resource: { type: 'project', value: 'core' }
      })
    ).toThrow();
    expect(() => parseWorkspaceSetupApproval({ ...setupApproval, canRunCommands: true })).toThrow();
    const { setupApprovalFingerprint: _digest, ...payload } = setupApproval;
    expect(() =>
      parseWorkspaceSetupApproval({
        ...payload,
        setupApprovalId: executionApproval.approvalId,
        setupApprovalFingerprint: fingerprintPlanValue({
          ...payload,
          setupApprovalId: executionApproval.approvalId
        })
      })
    ).toThrow('distinct approval identity');
    expect(() =>
      createWorkspaceSetupApproval({
        setupApprovalId: 'new-setup',
        artifact,
        executionApproval,
        taskId: 'unknown-task',
        approvedBy: 'git-reviewer',
        approvedAt: '2026-08-13T02:00:00.000Z'
      })
    ).toThrow('does not match approved execution');
  });

  it('rejects a valid-looking setup decision for a different task, base commit, or execution approval', () => {
    const { artifact, executionApproval, setupApproval } = fixture();
    const { setupApprovalFingerprint: _digest, ...payload } = setupApproval;
    const rehash = (change: Partial<typeof payload>) => {
      const changed = { ...payload, ...change };
      return { ...changed, setupApprovalFingerprint: fingerprintPlanValue(changed) };
    };
    expect(() =>
      assertWorkspaceSetupApproval({
        artifact,
        executionApproval,
        setupApproval: parseWorkspaceSetupApproval(rehash({ taskId: 'other-task' }))
      })
    ).toThrow('does not match approved execution');
    expect(() =>
      assertWorkspaceSetupApproval({
        artifact,
        executionApproval,
        setupApproval: parseWorkspaceSetupApproval(rehash({ baseCommit: 'a'.repeat(40) }))
      })
    ).toThrow('does not match approved execution');
    expect(() =>
      assertWorkspaceSetupApproval({
        artifact,
        executionApproval,
        setupApproval: parseWorkspaceSetupApproval(rehash({ executionApprovalId: 'different' }))
      })
    ).toThrow('does not match approved execution');
    expect(() =>
      createWorkspaceSetupApproval({
        setupApprovalId: 'too-early',
        artifact,
        executionApproval,
        taskId: 'task-a',
        approvedBy: 'git-reviewer',
        approvedAt: '2026-08-13T00:00:00.000Z'
      })
    ).toThrow('does not match approved execution');
  });
});
