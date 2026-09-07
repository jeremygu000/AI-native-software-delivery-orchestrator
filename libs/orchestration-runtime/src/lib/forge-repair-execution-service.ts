import type {
  AgentExecutionAttempt,
  TaskCodeReview,
  TaskCodeReviewSubject,
  TaskContract,
  TaskImpact,
  TaskRepairAttempt,
  TaskVerificationEvidence,
  WriteLease,
  RepairRuntimeFeedback
} from '@ai-native-software-delivery-orchestrator/domain';
import type { RepositoryGraph } from '@ai-native-software-delivery-orchestrator/domain';

import { RepairExecutionCoordinator } from './repair-execution-coordinator.js';
import { TaskRepairCoordinator } from './task-repair-coordinator.js';

export class ForgeRepairExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForgeRepairExecutionError';
  }
}

export type RepairExecutionOutcome =
  | {
      readonly state: 'completed';
      readonly attempt: TaskRepairAttempt;
      readonly reviewSubject: TaskCodeReviewSubject;
      readonly review: TaskCodeReview;
      readonly verification: TaskVerificationEvidence;
      readonly recommendation: 'accept' | 'repair' | 'reject';
    }
  | {
      readonly state: 'blocked';
      readonly attempt: TaskRepairAttempt;
      readonly blockerLeaseId: string;
    }
  | {
      readonly state: 'unknown';
      readonly attempt: TaskRepairAttempt;
      readonly detail: string;
    };

export class ForgeRepairExecutionService {
  readonly #repairs: TaskRepairCoordinator;
  readonly #execution: RepairExecutionCoordinator;

  constructor(options: {
    readonly repairCoordinator: TaskRepairCoordinator;
    readonly executionCoordinator: RepairExecutionCoordinator;
  }) {
    this.#repairs = options.repairCoordinator;
    this.#execution = options.executionCoordinator;
  }

  async execute(request: {
    readonly runId: string;
    readonly task: TaskContract;
    readonly agentId: string;
    readonly builderAttempt: AgentExecutionAttempt;
    readonly workspace: import('@ai-native-software-delivery-orchestrator/domain').TaskWorkspace;
    readonly impact: TaskImpact;
    readonly reviewIteration: number;
    readonly review: TaskCodeReview;
    readonly subject: TaskCodeReviewSubject;
    readonly verificationPolicyFingerprint: string;
    readonly repository: Pick<RepositoryGraph, 'files' | 'symbols'>;
    readonly maxRepairs: number;
    readonly leases?: readonly WriteLease[];
    readonly feedback?: RepairRuntimeFeedback;
  }): Promise<RepairExecutionOutcome> {
    const repair = await this.#repairs.prepare({
      runId: request.runId,
      taskId: request.task.id,
      agentId: request.agentId,
      workspaceId: request.workspace.id,
      reviewIteration: request.reviewIteration,
      review: request.review,
      subject: request.subject
    });

    let result: Awaited<ReturnType<RepairExecutionCoordinator['execute']>> | undefined;
    try {
      result = await this.#execution.execute({
        repair,
        builderAttempt: request.builderAttempt,
        task: request.task,
        workspace: request.workspace,
        impact: request.impact,
        leases: request.leases ?? [],
        verificationPolicyFingerprint: request.verificationPolicyFingerprint,
        repository: request.repository,
        reviewIteration: request.reviewIteration,
        feedback: request.feedback
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Repair blocked by lease:')) {
        const leaseId = error.message.replace('Repair blocked by lease: ', '');
        return {
          state: 'blocked',
          attempt: repair,
          blockerLeaseId: leaseId
        };
      }
      if (error instanceof Error && error.message.startsWith('Repair outcome is unknown:')) {
        const detail = error.message.replace('Repair outcome is unknown: ', '');
        return {
          state: 'unknown',
          attempt: repair,
          detail
        };
      }
      throw error;
    }

    return {
      state: 'completed',
      attempt: result.attempt,
      reviewSubject: result.reviewSubject,
      review: result.review,
      verification: result.verification,
      recommendation: result.review.recommendation
    };
  }
}
