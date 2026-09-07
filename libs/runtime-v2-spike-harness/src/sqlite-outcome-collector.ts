import type {
  PersistedAgentExecutionAttempt,
  PersistedTaskCodeReview,
  PersistedTaskRepairAttempt,
  PersistedWriteLease,
  RecoveredRun,
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

  const recovered = await persistence.recoverRun(runId);
  if (!recovered) {
    throw new Error(`Run not found: ${runId}`);
  }

  const reviews = await persistence.recoverReviews(runId);
  const verifications = await persistence.recoverVerificationEvidence(runId);
  const repairAttempts = await persistence.recoverRepairAttempts(runId);
  const dispatches = await persistence.recoverDispatches(runId);

  const builderAttempt = findBuilderAttempt(recovered);
  const repairs = repairAttempts.map((r: PersistedTaskRepairAttempt) => r.attempt);

  const integration = { status: 'integrated' as const };

  let blockedResume: DurableExecutionSpikeOutcome['blockedResume'] | undefined;
  const blockedRepair = repairs.find((r) => r.state === 'BLOCKED');
  if (blockedRepair && blockedRepair.blocker?.type === 'lease') {
    const blockerLease = recovered.leases.find(
      (p: PersistedWriteLease) => p.lease.id === blockedRepair.blocker!.leaseId
    );
    if (blockerLease && (blockerLease.lease.state === 'RELEASED' || blockerLease.lease.state === 'STALE')) {
      blockedResume = {
        blockerLeaseId: blockerLease.lease.id,
        blockedRevision: blockedRepair.revision,
        resumedRevision: blockedRepair.revision + 1,
        repairAttemptId: blockedRepair.id,
        releaseState: blockerLease.lease.state
      };
    }
  }

  const dispatchCount = dispatches.length;

  return {
    builderAttempt: builderAttempt as DurableExecutionSpikeOutcome['builderAttempt'],
    repairs: repairs as DurableExecutionSpikeOutcome['repairs'],
    verifications: verifications as DurableExecutionSpikeOutcome['verifications'],
    reviews: normalizeReviews(reviews),
    leases: recovered.leases.map((p: PersistedWriteLease) => p.lease) as DurableExecutionSpikeOutcome['leases'],
    integration,
    blockedResume,
    dispatchCount
  };
};

function findBuilderAttempt(recovered: RecoveredRun) {
  const builderAttempt = recovered.attempts.find(
    (a: PersistedAgentExecutionAttempt) => a.attempt.state === 'COMPLETED'
  );
  if (!builderAttempt) {
    throw new Error(`No builder attempt found`);
  }
  return builderAttempt.attempt;
}

function normalizeReviews(
  reviews: readonly PersistedTaskCodeReview[]
): DurableExecutionSpikeOutcome['reviews'] {
  return reviews.map((r: PersistedTaskCodeReview) => ({
    review: r.review as TaskCodeReview,
    subject: r.subject as TaskCodeReviewSubject
  }));
}
