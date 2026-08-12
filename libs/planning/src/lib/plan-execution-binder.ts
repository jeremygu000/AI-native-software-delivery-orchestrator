import type {
  RepositoryContext,
  RepositoryGraph,
  RepositorySnapshotProvider
} from '@ai-native-software-delivery-orchestrator/domain';
import { z } from 'zod';

import {
  areEquivalentApprovalClaims,
  createPlanApprovalClaim,
  parsePlanApproval,
  parsePlanApprovalClaim,
  planApprovalClaimSchema,
  planApprovalMismatches,
  planApprovalSchema,
  type PlanApprovalStore,
  type PlanApprovalMismatch
} from './plan-approval.js';
import {
  assertStableRepositorySnapshot,
  fingerprintPlanValue,
  parsePlanArtifact,
  planArtifactSchema,
  type PlanArtifactStore,
  type RepositoryBindingMismatch,
  repositoryBindingMismatches
} from './plan-artifact.js';

const recordIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export interface RepositoryFactsProvider {
  analyze(repository: RepositoryContext): Promise<RepositoryGraph>;
}

export const planExecutionIntentSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: recordIdSchema,
    boundAt: z.iso.datetime({ offset: true }),
    artifact: planArtifactSchema,
    approval: planApprovalSchema,
    approvalClaim: planApprovalClaimSchema,
    executionFingerprint: digestSchema
  })
  .superRefine((intent, context) => {
    const approvalMismatches = planApprovalMismatches(intent.approval, intent.artifact);
    for (const mismatch of approvalMismatches) {
      context.addIssue({
        code: 'custom',
        message: `Execution approval mismatch: ${mismatch}`,
        path: ['approval']
      });
    }
    const expectedClaim = createPlanApprovalClaim({
      approval: intent.approval,
      runId: intent.runId,
      claimedAt: intent.approvalClaim.claimedAt
    });
    if (!areEquivalentApprovalClaims(expectedClaim, intent.approvalClaim)) {
      context.addIssue({
        code: 'custom',
        message: 'Execution approval claim does not match its approval and run',
        path: ['approvalClaim']
      });
    }
    if (intent.boundAt !== intent.approvalClaim.claimedAt) {
      context.addIssue({
        code: 'custom',
        message: 'Execution binding time must match approval claim time',
        path: ['boundAt']
      });
    }
  });

export type PlanExecutionIntent = z.infer<typeof planExecutionIntentSchema>;

export type PlanExecutionBindingMismatch =
  | RepositoryBindingMismatch
  | PlanApprovalMismatch
  | 'shared-resource-policy'
  | 'verification-policy';

export class PlanExecutionBindingError extends Error {
  readonly mismatches: readonly PlanExecutionBindingMismatch[];

  constructor(message: string, mismatches: readonly PlanExecutionBindingMismatch[] = []) {
    super(message);
    this.name = 'PlanExecutionBindingError';
    this.mismatches = mismatches;
  }
}

export interface BindPlanExecutionRequest {
  readonly artifactId: string;
  readonly artifactRevision: number;
  readonly approvalId: string;
  readonly runId: string;
  readonly repository: RepositoryContext;
  readonly sharedResourcePolicy: unknown;
  readonly verificationPolicy: unknown;
}

export class PlanExecutionBinder {
  readonly #artifactStore: PlanArtifactStore;
  readonly #approvalStore: PlanApprovalStore;
  readonly #snapshotProvider: RepositorySnapshotProvider;
  readonly #factsProvider: RepositoryFactsProvider;
  readonly #now: () => Date;

  constructor(options: {
    readonly artifactStore: PlanArtifactStore;
    readonly approvalStore: PlanApprovalStore;
    readonly snapshotProvider: RepositorySnapshotProvider;
    readonly factsProvider: RepositoryFactsProvider;
    readonly now?: () => Date;
  }) {
    this.#artifactStore = options.artifactStore;
    this.#approvalStore = options.approvalStore;
    this.#snapshotProvider = options.snapshotProvider;
    this.#factsProvider = options.factsProvider;
    this.#now = options.now ?? (() => new Date());
  }

  async bind(request: BindPlanExecutionRequest): Promise<PlanExecutionIntent> {
    const [artifactCandidate, approvalCandidate] = await Promise.all([
      this.#artifactStore.load(request.artifactId, request.artifactRevision),
      this.#approvalStore.load(request.approvalId)
    ]);
    if (artifactCandidate === undefined) {
      throw new PlanExecutionBindingError(
        `Plan artifact not found: ${request.artifactId} revision ${request.artifactRevision}`
      );
    }
    if (approvalCandidate === undefined) {
      throw new PlanExecutionBindingError(`Plan approval not found: ${request.approvalId}`);
    }
    const artifact = parsePlanArtifact(artifactCandidate);
    const approval = parsePlanApproval(approvalCandidate);
    const approvalMismatches = planApprovalMismatches(approval, artifact);
    if (approvalMismatches.length > 0) {
      throw new PlanExecutionBindingError(
        `Plan approval does not authorize the requested artifact: ${approvalMismatches.join(', ')}`,
        approvalMismatches
      );
    }

    const snapshotBefore = await this.#snapshotProvider.capture(request.repository);
    const graph = await this.#factsProvider.analyze(request.repository);
    const snapshot = assertStableRepositorySnapshot(
      snapshotBefore,
      await this.#snapshotProvider.capture(request.repository)
    );
    const mismatches: PlanExecutionBindingMismatch[] = [
      ...repositoryBindingMismatches(artifact, snapshot, graph)
    ];
    if (
      artifact.authority.sharedResourcePolicyFingerprint !==
      fingerprintPlanValue(request.sharedResourcePolicy)
    ) {
      mismatches.push('shared-resource-policy');
    }
    if (
      artifact.authority.verificationPolicyFingerprint !==
      fingerprintPlanValue(request.verificationPolicy)
    ) {
      mismatches.push('verification-policy');
    }
    if (mismatches.length > 0) {
      throw new PlanExecutionBindingError(
        `Plan execution binding rejected: ${mismatches.join(', ')}`,
        mismatches
      );
    }

    const requestedClaim = createPlanApprovalClaim({
      approval,
      runId: request.runId,
      claimedAt: this.#now().toISOString()
    });
    const approvalClaim = await this.#approvalStore.claim(requestedClaim);
    const payload = {
      schemaVersion: 1 as const,
      runId: request.runId,
      boundAt: approvalClaim.claimedAt,
      artifact,
      approval,
      approvalClaim
    };
    return planExecutionIntentSchema.parse({
      ...payload,
      executionFingerprint: fingerprintPlanValue(payload)
    });
  }
}

export const parsePlanExecutionIntent = (candidate: unknown): PlanExecutionIntent => {
  const intent = planExecutionIntentSchema.parse(candidate);
  parsePlanArtifact(intent.artifact);
  parsePlanApproval(intent.approval);
  parsePlanApprovalClaim(intent.approvalClaim);
  const { executionFingerprint, ...payload } = intent;
  if (executionFingerprint !== fingerprintPlanValue(payload)) {
    throw new PlanExecutionBindingError('Execution intent fingerprint does not match its content');
  }
  return intent;
};
