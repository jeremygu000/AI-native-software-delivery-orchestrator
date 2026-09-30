import { z } from 'zod';

import { fingerprintPlanValue, parsePlanArtifact, type PlanArtifact } from './plan-artifact.js';
import { parsePlanApproval, planApprovalMismatches, type PlanApproval } from './plan-approval.js';

const recordId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/** A separate approval decision; the execution approval alone cannot authorize Git setup. */
export const workspaceSetupApprovalSchema = z.strictObject({
  schemaVersion: z.literal(1),
  setupApprovalId: recordId,
  executionApprovalId: recordId,
  executionApprovalFingerprint: digest,
  artifactId: recordId,
  artifactRevision: z.int().positive(),
  planFingerprint: digest,
  taskId: z.string().trim().min(1),
  repositoryId: digest,
  repositoryRoot: z.string().trim().min(1),
  baseCommit: z.string().regex(/^[0-9a-f]{40,64}$/),
  resource: z.strictObject({ type: z.literal('repository') }),
  operation: z.literal('git-worktree-create'),
  approvedBy: z.string().trim().min(1),
  approvedAt: z.iso.datetime({ offset: true }),
  setupApprovalFingerprint: digest
});

export type WorkspaceSetupApproval = z.infer<typeof workspaceSetupApprovalSchema>;

export class WorkspaceSetupApprovalIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceSetupApprovalIntegrityError';
  }
}

export const parseWorkspaceSetupApproval = (candidate: unknown): WorkspaceSetupApproval => {
  const approval = workspaceSetupApprovalSchema.parse(candidate);
  const { setupApprovalFingerprint, ...payload } = approval;
  if (setupApprovalFingerprint !== fingerprintPlanValue(payload)) {
    throw new WorkspaceSetupApprovalIntegrityError('Git setup approval fingerprint does not match');
  }
  if (approval.setupApprovalId === approval.executionApprovalId) {
    throw new WorkspaceSetupApprovalIntegrityError(
      'Git setup requires a distinct approval identity'
    );
  }
  return approval;
};

export const assertWorkspaceSetupApproval = (request: {
  readonly setupApproval: WorkspaceSetupApproval;
  readonly artifact: PlanArtifact;
  readonly executionApproval: PlanApproval;
}): WorkspaceSetupApproval => {
  const setup = parseWorkspaceSetupApproval(request.setupApproval);
  const artifact = parsePlanArtifact(request.artifact);
  const execution = parsePlanApproval(request.executionApproval);
  if (
    planApprovalMismatches(execution, artifact).length !== 0 ||
    setup.artifactId !== artifact.artifactId ||
    setup.artifactRevision !== artifact.revision ||
    setup.planFingerprint !== artifact.planFingerprint ||
    setup.executionApprovalId !== execution.approvalId ||
    setup.executionApprovalFingerprint !== execution.approvalFingerprint ||
    setup.repositoryId !== artifact.repository.repositoryId ||
    setup.repositoryRoot !== artifact.repository.repositoryRoot ||
    setup.baseCommit !== artifact.repository.baseCommit ||
    !artifact.decision.specification.tasks.some((task) => task.id === setup.taskId) ||
    Date.parse(setup.approvedAt) < Date.parse(execution.approvedAt)
  ) {
    throw new WorkspaceSetupApprovalIntegrityError(
      'Git setup approval does not match approved execution and repository'
    );
  }
  return setup;
};

export const createWorkspaceSetupApproval = (request: {
  readonly setupApprovalId: string;
  readonly artifact: PlanArtifact;
  readonly executionApproval: PlanApproval;
  readonly taskId: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
}): WorkspaceSetupApproval => {
  const artifact = parsePlanArtifact(request.artifact);
  const execution = parsePlanApproval(request.executionApproval);
  const payload = {
    schemaVersion: 1 as const,
    setupApprovalId: request.setupApprovalId,
    executionApprovalId: execution.approvalId,
    executionApprovalFingerprint: execution.approvalFingerprint,
    artifactId: artifact.artifactId,
    artifactRevision: artifact.revision,
    planFingerprint: artifact.planFingerprint,
    taskId: request.taskId,
    repositoryId: artifact.repository.repositoryId,
    repositoryRoot: artifact.repository.repositoryRoot,
    baseCommit: artifact.repository.baseCommit,
    resource: { type: 'repository' as const },
    operation: 'git-worktree-create' as const,
    approvedBy: request.approvedBy,
    approvedAt: request.approvedAt
  };
  return assertWorkspaceSetupApproval({
    setupApproval: workspaceSetupApprovalSchema.parse({
      ...payload,
      setupApprovalFingerprint: fingerprintPlanValue(payload)
    }),
    artifact,
    executionApproval: execution
  });
};
