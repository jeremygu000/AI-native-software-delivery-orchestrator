import { z } from 'zod';

import {
  canonicalPlanJson,
  fingerprintPlanValue,
  parsePlanArtifact,
  type PlanArtifact
} from './plan-artifact.js';

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const recordIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);

export const planApprovalSchema = z.object({
  schemaVersion: z.literal(1),
  approvalId: recordIdSchema,
  artifactId: recordIdSchema,
  artifactRevision: z.int().positive(),
  planFingerprint: digestSchema,
  approvedBy: z.string().trim().min(1),
  approvedAt: z.iso.datetime({ offset: true }),
  approvalFingerprint: digestSchema
});

export type PlanApproval = z.infer<typeof planApprovalSchema>;

export const planApprovalClaimSchema = z.object({
  schemaVersion: z.literal(1),
  approvalId: recordIdSchema,
  artifactId: recordIdSchema,
  artifactRevision: z.int().positive(),
  planFingerprint: digestSchema,
  runId: recordIdSchema,
  claimedAt: z.iso.datetime({ offset: true }),
  claimFingerprint: digestSchema
});

export type PlanApprovalClaim = z.infer<typeof planApprovalClaimSchema>;

export interface PlanApprovalStore {
  save(approval: PlanApproval): Promise<void>;
  load(approvalId: string): Promise<PlanApproval | undefined>;
  claim(claim: PlanApprovalClaim): Promise<PlanApprovalClaim>;
  loadClaim(approvalId: string): Promise<PlanApprovalClaim | undefined>;
}

export type PlanApprovalMismatch =
  | 'artifact-id'
  | 'artifact-revision'
  | 'plan-fingerprint'
  | 'approval-before-artifact';

export class PlanApprovalIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanApprovalIntegrityError';
  }
}

const withoutApprovalFingerprint = (approval: Omit<PlanApproval, 'approvalFingerprint'>) =>
  approval;
const withoutClaimFingerprint = (claim: Omit<PlanApprovalClaim, 'claimFingerprint'>) => claim;

export const createPlanApproval = (request: {
  readonly approvalId: string;
  readonly artifact: PlanArtifact;
  readonly approvedBy: string;
  readonly approvedAt: string;
}): PlanApproval => {
  const artifact = parsePlanArtifact(request.artifact);
  const payload = {
    schemaVersion: 1 as const,
    approvalId: request.approvalId,
    artifactId: artifact.artifactId,
    artifactRevision: artifact.revision,
    planFingerprint: artifact.planFingerprint,
    approvedBy: request.approvedBy,
    approvedAt: request.approvedAt
  };
  const approval = planApprovalSchema.parse({
    ...payload,
    approvalFingerprint: fingerprintPlanValue(withoutApprovalFingerprint(payload))
  });
  const mismatches = planApprovalMismatches(approval, artifact);
  if (mismatches.length > 0) {
    throw new PlanApprovalIntegrityError(`Invalid plan approval: ${mismatches.join(', ')}`);
  }
  return approval;
};

export const parsePlanApproval = (candidate: unknown): PlanApproval => {
  const approval = planApprovalSchema.parse(candidate);
  const { approvalFingerprint, ...payload } = approval;
  if (approvalFingerprint !== fingerprintPlanValue(withoutApprovalFingerprint(payload))) {
    throw new PlanApprovalIntegrityError('Approval fingerprint does not match its content');
  }
  return approval;
};

export const createPlanApprovalClaim = (request: {
  readonly approval: PlanApproval;
  readonly runId: string;
  readonly claimedAt: string;
}): PlanApprovalClaim => {
  const approval = parsePlanApproval(request.approval);
  const payload = {
    schemaVersion: 1 as const,
    approvalId: approval.approvalId,
    artifactId: approval.artifactId,
    artifactRevision: approval.artifactRevision,
    planFingerprint: approval.planFingerprint,
    runId: request.runId,
    claimedAt: request.claimedAt
  };
  return planApprovalClaimSchema.parse({
    ...payload,
    claimFingerprint: fingerprintPlanValue(withoutClaimFingerprint(payload))
  });
};

export const parsePlanApprovalClaim = (candidate: unknown): PlanApprovalClaim => {
  const claim = planApprovalClaimSchema.parse(candidate);
  const { claimFingerprint, ...payload } = claim;
  if (claimFingerprint !== fingerprintPlanValue(withoutClaimFingerprint(payload))) {
    throw new PlanApprovalIntegrityError('Approval claim fingerprint does not match its content');
  }
  return claim;
};

export const planApprovalMismatches = (
  approval: PlanApproval,
  artifact: PlanArtifact
): readonly PlanApprovalMismatch[] => {
  const mismatches: PlanApprovalMismatch[] = [];
  if (approval.artifactId !== artifact.artifactId) {
    mismatches.push('artifact-id');
  }
  if (approval.artifactRevision !== artifact.revision) {
    mismatches.push('artifact-revision');
  }
  if (approval.planFingerprint !== artifact.planFingerprint) {
    mismatches.push('plan-fingerprint');
  }
  if (Date.parse(approval.approvedAt) < Date.parse(artifact.createdAt)) {
    mismatches.push('approval-before-artifact');
  }
  return mismatches;
};

export const areEquivalentApprovalClaims = (
  left: PlanApprovalClaim,
  right: PlanApprovalClaim
): boolean =>
  canonicalPlanJson({
    approvalId: left.approvalId,
    artifactId: left.artifactId,
    artifactRevision: left.artifactRevision,
    planFingerprint: left.planFingerprint,
    runId: left.runId
  }) ===
  canonicalPlanJson({
    approvalId: right.approvalId,
    artifactId: right.artifactId,
    artifactRevision: right.artifactRevision,
    planFingerprint: right.planFingerprint,
    runId: right.runId
  });
