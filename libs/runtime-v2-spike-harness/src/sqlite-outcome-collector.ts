import type {
  PersistedAgentExecutionAttempt,
  PersistedTaskCodeReview,
  PersistedTaskRepairAttempt,
  PersistedWriteLease,
  TaskCodeReview,
  TaskCodeReviewSubject
} from '@ai-native-software-delivery-orchestrator/domain';
import type {
  DurableExecutionSpikeOutcome
} from '@ai-native-software-delivery-orchestrator/orchestration-runtime';
import { DrizzleSqliteOrchestrationPersistence } from '@ai-native-software-delivery-orchestrator/persistence';

export interface SqliteSpikeFixture {
  readonly persistence: DrizzleSqliteOrchestrationPersistence;
}

export const createSqliteSpikeFixture = (): SqliteSpikeFixture => {
  const persistence = new DrizzleSqliteOrchestrationPersistence(':memory:');
  return { persistence };
};

export const collectDurableExecutionOutcomeFromSqlite = async (
  runId: string,
  deps: SqliteSpikeFixture
): Promise<DurableExecutionSpikeOutcome> => {
  const { persistence } = deps;

  const attempts = await persistence.recoverAttempts(runId);
  if (attempts.length === 0) {
    throw new Error(`No attempts found for run: ${runId}`);
  }

  const reviews = await persistence.recoverReviews(runId);
  const verifications = await persistence.recoverVerificationEvidence(runId);
  const repairAttempts = await persistence.recoverRepairAttempts(runId);
  const leases = await persistence.recoverLeases(runId);
  const integrationStatus = await persistence.recoverIntegration(runId);
  const repairResumeDispatches = await persistence.recoverRepairResumeDispatches(runId);

  const builderAttempt = attempts.find(
    (a: PersistedAgentExecutionAttempt) => a.attempt.state === 'COMPLETED'
  );

  const repairs = repairAttempts.map((r: PersistedTaskRepairAttempt) => r.attempt);

  const integration = { status: integrationStatus ?? 'blocked' as const };

  let blockedResume: DurableExecutionSpikeOutcome['blockedResume'] | undefined;
  const blockedRepair = repairs.find((r) => r.state === 'BLOCKED');
  if (blockedRepair && blockedRepair.blocker?.type === 'lease') {
    const blockerLease = leases.find(
      (p: PersistedWriteLease) => p.lease.id === blockedRepair.blocker!.leaseId
    );
    if (blockerLease && (blockerLease.lease.state === 'RELEASED' || blockerLease.lease.state === 'STALE')) {
      const resumeDispatch = repairResumeDispatches.find(
        (d) => d.repairAttemptId === blockedRepair.id
      );
      blockedResume = {
        blockerLeaseId: blockerLease.lease.id,
        blockedRevision: blockedRepair.revision,
        resumedRevision: resumeDispatch?.repairRevision ?? blockedRepair.revision + 1,
        repairAttemptId: blockedRepair.id,
        releaseState: blockerLease.lease.state
      };
    }
  }

  const dispatchCount = repairResumeDispatches.length;

  if (!builderAttempt) {
    const completedRepair = repairs.find((r) => r.state === 'COMPLETED');
    if (!completedRepair) {
      throw new Error(`No COMPLETED builder attempt or repair attempt found for run: ${runId}`);
    }
    return {
      builderAttempt: { ...completedRepair, id: 'synthetic', state: 'COMPLETED' } as unknown as DurableExecutionSpikeOutcome['builderAttempt'],
      repairs: repairs as DurableExecutionSpikeOutcome['repairs'],
      verifications: verifications as DurableExecutionSpikeOutcome['verifications'],
      reviews: normalizeReviews(reviews),
      leases: leases.map((p: PersistedWriteLease) => p.lease) as DurableExecutionSpikeOutcome['leases'],
      integration,
      blockedResume,
      dispatchCount
    };
  }

  return {
    builderAttempt: builderAttempt.attempt as DurableExecutionSpikeOutcome['builderAttempt'],
    repairs: repairs as DurableExecutionSpikeOutcome['repairs'],
    verifications: verifications as DurableExecutionSpikeOutcome['verifications'],
    reviews: normalizeReviews(reviews),
    leases: leases.map((p: PersistedWriteLease) => p.lease) as DurableExecutionSpikeOutcome['leases'],
    integration,
    blockedResume,
    dispatchCount
  };
};

function normalizeReviews(
  reviews: readonly PersistedTaskCodeReview[]
): DurableExecutionSpikeOutcome['reviews'] {
  return reviews.map((r: PersistedTaskCodeReview) => ({
    review: r.review as TaskCodeReview,
    subject: r.subject as TaskCodeReviewSubject
  }));
}
