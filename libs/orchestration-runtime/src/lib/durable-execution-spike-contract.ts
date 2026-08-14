import type {
  AgentExecutionAttempt,
  PersistedTaskConflict,
  TaskCodeReview,
  TaskCodeReviewSubject,
  TaskRepairAttempt,
  TaskVerificationEvidence,
  WriteLease
} from '@ai-native-software-delivery-orchestrator/domain';

/**
 * Candidate durable-execution substrates trigger scenarios only. The common authority harness verifies these
 * normalized results against Forge evidence and deliberately excludes framework history or API types.
 */
export interface DurableExecutionSpikeDriver {
  runBuildReviewRepairIntegrate(): Promise<DurableExecutionSpikeOutcome>;
  runBlockedRepairRestartResume(): Promise<DurableExecutionSpikeOutcome>;
}

export interface DurableExecutionSpikeOutcome {
  readonly builderAttempt: AgentExecutionAttempt;
  readonly repairs: readonly TaskRepairAttempt[];
  readonly verifications: readonly TaskVerificationEvidence[];
  readonly reviews: readonly {
    readonly review: TaskCodeReview;
    readonly subject: TaskCodeReviewSubject;
  }[];
  readonly leases: readonly WriteLease[];
  readonly runtimeConflicts: readonly PersistedTaskConflict[];
  readonly blockedResume?: {
    readonly blockerLeaseId: string;
    readonly blockedRevision: number;
    readonly resumedRevision: number;
    readonly repairAttemptId: string;
    readonly releaseState: 'RELEASED' | 'STALE';
  };
  readonly integration: { readonly status: 'integrated' | 'blocked' };
  readonly dispatchCount: number;
}

export class DurableExecutionSpikeAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DurableExecutionSpikeAuthorityError';
  }
}

export const assertDurableExecutionSpikeOutcome = (request: {
  readonly outcome: DurableExecutionSpikeOutcome;
  readonly expectBlockedResume: boolean;
}): void => {
  if (request.outcome.builderAttempt.state !== 'COMPLETED') {
    throw new DurableExecutionSpikeAuthorityError('Builder attempt must complete');
  }
  if (request.outcome.verifications.length === 0 || request.outcome.reviews.length === 0) {
    throw new DurableExecutionSpikeAuthorityError(
      'Spike must persist verification and review evidence'
    );
  }
  if (request.outcome.integration.status !== 'integrated') {
    throw new DurableExecutionSpikeAuthorityError(
      'Spike must integrate the accepted current output'
    );
  }
  const finalReview = request.outcome.reviews.at(-1)!;
  if (finalReview.review.recommendation !== 'accept') {
    throw new DurableExecutionSpikeAuthorityError('Final review must accept the integrated output');
  }
  if (request.expectBlockedResume) {
    const repair = request.outcome.repairs.at(-1);
    const resume = request.outcome.blockedResume;
    if (
      repair === undefined ||
      repair.repairIteration !== 1 ||
      request.outcome.dispatchCount !== 1 ||
      resume === undefined ||
      resume.repairAttemptId !== repair.id ||
      resume.resumedRevision !== resume.blockedRevision + 1 ||
      !request.outcome.leases.some(
        (lease) => lease.id === resume.blockerLeaseId && lease.state === resume.releaseState
      )
    ) {
      throw new DurableExecutionSpikeAuthorityError(
        'Blocked resume must retain durable blocker evidence, preserve repair iteration, and dispatch exactly once'
      );
    }
    const finalVerification = request.outcome.verifications.at(-1)!;
    if (
      finalVerification.attemptId !== repair.id ||
      finalReview.subject.outputAttemptId !== repair.id
    ) {
      throw new DurableExecutionSpikeAuthorityError(
        'Final verification and review must bind the resumed repair output'
      );
    }
  }
};
