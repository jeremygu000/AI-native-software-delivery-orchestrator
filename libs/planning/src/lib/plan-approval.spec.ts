import { describe, expect, it } from 'vitest';

import { approvalTestArtifact } from './plan-artifact.fixture.js';
import {
  createPlanApproval,
  createPlanApprovalClaim,
  parsePlanApproval,
  parsePlanApprovalClaim,
  planApprovalMismatches,
  PlanApprovalIntegrityError
} from './plan-approval.js';
import { fingerprintPlanValue } from './plan-artifact.js';

describe('PlanApproval', () => {
  it('creates an immutable approval for one exact artifact revision and fingerprint', () => {
    const artifact = approvalTestArtifact();
    const approval = createPlanApproval({
      approvalId: 'approval-1',
      artifact,
      approvedBy: 'reviewer@example.com',
      approvedAt: '2026-08-13T01:00:00.000Z'
    });

    expect(approval).toMatchObject({
      artifactId: artifact.artifactId,
      artifactRevision: artifact.revision,
      planFingerprint: artifact.planFingerprint,
      approvedBy: 'reviewer@example.com'
    });
    expect(parsePlanApproval(approval)).toEqual(approval);
    expect(planApprovalMismatches(approval, artifact)).toEqual([]);
  });

  it('detects approval and claim content tampering', () => {
    const approval = createPlanApproval({
      approvalId: 'approval-1',
      artifact: approvalTestArtifact(),
      approvedBy: 'reviewer@example.com',
      approvedAt: '2026-08-13T01:00:00.000Z'
    });
    const claim = createPlanApprovalClaim({
      approval,
      runId: 'run-1',
      claimedAt: '2026-08-13T02:00:00.000Z'
    });

    expect(() => parsePlanApproval({ ...approval, approvedBy: 'attacker' })).toThrow(
      PlanApprovalIntegrityError
    );
    expect(() => parsePlanApprovalClaim({ ...claim, runId: 'run-2' })).toThrow(
      PlanApprovalIntegrityError
    );
  });

  it('rejects approval timestamps before the artifact and reports exact artifact mismatches', () => {
    const artifact = approvalTestArtifact();
    expect(() =>
      createPlanApproval({
        approvalId: 'approval-1',
        artifact,
        approvedBy: 'reviewer@example.com',
        approvedAt: '2026-08-12T23:59:59.000Z'
      })
    ).toThrow('approval-before-artifact');

    const otherApproval = createPlanApproval({
      approvalId: 'approval-2',
      artifact: approvalTestArtifact('plan-2'),
      approvedBy: 'reviewer@example.com',
      approvedAt: '2026-08-13T01:00:00.000Z'
    });
    expect(planApprovalMismatches(otherApproval, artifact)).toEqual([
      'artifact-id',
      'plan-fingerprint'
    ]);
  });

  it('reports an artifact revision mismatch independently of the plan fingerprint', () => {
    const artifact = approvalTestArtifact();
    const approval = createPlanApproval({
      approvalId: 'approval-1',
      artifact,
      approvedBy: 'reviewer@example.com',
      approvedAt: '2026-08-13T01:00:00.000Z'
    });
    const { approvalFingerprint: _approvalFingerprint, ...payload } = approval;
    const differentRevision = parsePlanApproval({
      ...payload,
      artifactRevision: 2,
      approvalFingerprint: fingerprintPlanValue({ ...payload, artifactRevision: 2 })
    });

    expect(planApprovalMismatches(differentRevision, artifact)).toEqual(['artifact-revision']);
  });
});
