import type {
  TaskVerificationEvidence,
  WriteLease,
  TaskCodeReview,
  TaskCodeReviewSubject,
  PersistedTaskRepairAttempt,
  PersistedAgentExecutionAttempt
} from '@ai-native-software-delivery-orchestrator/domain';

import type {
  DurableExecutionSpikeDriver,
  DurableExecutionSpikeOutcome
} from './durable-execution-spike-contract.js';
import { assertDurableExecutionSpikeOutcome } from './durable-execution-spike-contract.js';

export interface RestateSpikeDriverOptions {
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly agentId: string;
  readonly blockedRepairAttemptId?: string;
  readonly scenario: 'build-review-repair-integrate' | 'blocked-repair-restart-resume';
  readonly recoverAttempts: (runId: string) => Promise<readonly PersistedAgentExecutionAttempt[]>;
  readonly recoverRepairs: (runId: string) => Promise<readonly PersistedTaskRepairAttempt[]>;
  readonly recoverVerifications: (runId: string) => Promise<readonly TaskVerificationEvidence[]>;
  readonly recoverReviews: (
    runId: string
  ) => Promise<readonly { review: TaskCodeReview; subject: TaskCodeReviewSubject }[]>;
  readonly recoverLeases: (runId: string) => Promise<readonly WriteLease[]>;
  readonly dispatchCount: number;
  readonly blockedResume?: DurableExecutionSpikeOutcome['blockedResume'];
}

export const createRestateSpikeDriver = (
  options: RestateSpikeDriverOptions
): DurableExecutionSpikeDriver => {
  return {
    runBuildReviewRepairIntegrate: async (): Promise<DurableExecutionSpikeOutcome> => {
      const [attempts, repairs, verifications, reviews, leases] = await Promise.all([
        options.recoverAttempts(options.runId),
        options.recoverRepairs(options.runId),
        options.recoverVerifications(options.runId),
        options.recoverReviews(options.runId),
        options.recoverLeases(options.runId)
      ]);

      const builderAttempt = attempts.find((a) => a.attempt.state === 'COMPLETED');
      if (builderAttempt === undefined) {
        throw new Error('Builder attempt not found or not completed');
      }

      const outcome: DurableExecutionSpikeOutcome = {
        builderAttempt: builderAttempt.attempt,
        repairs: repairs.map((r) => r.attempt),
        verifications,
        reviews,
        leases,
        integration: { status: 'integrated' },
        dispatchCount: options.dispatchCount
      };

      assertDurableExecutionSpikeOutcome({
        outcome,
        scenario: 'build-review-repair-integrate'
      });

      return outcome;
    },

    runBlockedRepairRestartResume: async (): Promise<DurableExecutionSpikeOutcome> => {
      const [attempts, repairs, verifications, reviews, leases] = await Promise.all([
        options.recoverAttempts(options.runId),
        options.recoverRepairs(options.runId),
        options.recoverVerifications(options.runId),
        options.recoverReviews(options.runId),
        options.recoverLeases(options.runId)
      ]);

      const builderAttempt = attempts.find((a) => a.attempt.state === 'COMPLETED');
      if (builderAttempt === undefined) {
        throw new Error('Builder attempt not found or not completed');
      }

      const outcome: DurableExecutionSpikeOutcome = {
        builderAttempt: builderAttempt.attempt,
        repairs: repairs.map((r) => r.attempt),
        verifications,
        reviews,
        leases,
        blockedResume: options.blockedResume,
        integration: { status: 'integrated' },
        dispatchCount: options.dispatchCount
      };

      assertDurableExecutionSpikeOutcome({
        outcome,
        scenario: 'blocked-repair-restart-resume'
      });

      return outcome;
    }
  };
};
