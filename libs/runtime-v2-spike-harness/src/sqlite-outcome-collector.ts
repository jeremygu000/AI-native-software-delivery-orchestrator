import type {
  PersistedAgentExecutionAttempt,
  PersistedTaskCodeReview,
  PersistedTaskRepairAttempt,
  PersistedWriteLease,
  TaskCodeReview,
  TaskCodeReviewSubject
} from '@ai-native-software-delivery-orchestrator/domain';
import type { DurableExecutionSpikeOutcome } from '@ai-native-software-delivery-orchestrator/orchestration-runtime';
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

  const reviews = await persistence.recoverReviews(runId);
  const verifications = await persistence.recoverVerificationEvidence(runId);
  const repairAttempts = await persistence.recoverRepairAttempts(runId);
  const repairHistory = await persistence.recoverRepairAttemptHistory(runId);
  const leases = await persistence.recoverLeases(runId);
  const integrationStatus = await persistence.recoverIntegration(runId);
  const repairResumeDispatches = await persistence.recoverRepairResumeDispatches(runId);

  const builderAttempt = attempts.find(
    (a: PersistedAgentExecutionAttempt) => a.attempt.state === 'COMPLETED'
  );

  const repairs = repairAttempts.map((r: PersistedTaskRepairAttempt) => r.attempt);

  const integration = {
    status: integrationStatus?.status ?? ('blocked' as const),
    outputAttemptId: integrationStatus?.outputAttemptId
  };

  let blockedResume: DurableExecutionSpikeOutcome['blockedResume'] | undefined;

  for (const dispatch of repairResumeDispatches) {
    const blockedSnapshot = repairHistory.find(
      (h) => h.attempt.id === dispatch.repairAttemptId && h.attempt.state === 'BLOCKED'
    );
    if (blockedSnapshot && blockedSnapshot.attempt.blocker?.type === 'lease') {
      const blockerLease = leases.find(
        (p: PersistedWriteLease) => p.lease.id === blockedSnapshot.attempt.blocker!.leaseId
      );
      if (
        blockerLease &&
        (blockerLease.lease.state === 'RELEASED' || blockerLease.lease.state === 'STALE')
      ) {
        blockedResume = {
          blockerLeaseId: blockerLease.lease.id,
          blockedRevision: blockedSnapshot.attempt.revision,
          resumedRevision: dispatch.repairRevision,
          repairAttemptId: dispatch.repairAttemptId,
          releaseState: blockerLease.lease.state
        };
        break;
      }
    }
  }

  const dispatchCount = repairResumeDispatches.length;

  if (!builderAttempt) {
    throw new Error(`No COMPLETED builder attempt found for run: ${runId}`);
  }

  return {
    builderAttempt: builderAttempt.attempt as DurableExecutionSpikeOutcome['builderAttempt'],
    repairs: repairs as DurableExecutionSpikeOutcome['repairs'],
    verifications: verifications as DurableExecutionSpikeOutcome['verifications'],
    reviews: normalizeReviews(reviews),
    leases: leases.map(
      (p: PersistedWriteLease) => p.lease
    ) as DurableExecutionSpikeOutcome['leases'],
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
