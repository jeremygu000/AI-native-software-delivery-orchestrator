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

export interface ForgeRepairExecutionResult {
  readonly attempt: TaskRepairAttempt;
  readonly reviewSubject: TaskCodeReviewSubject;
  readonly review: TaskCodeReview;
  readonly verification: TaskVerificationEvidence;
  readonly recommendation: 'accept' | 'repair' | 'reject';
}

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
  }): Promise<ForgeRepairExecutionResult> {
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
        return {
          attempt: repair,
          reviewSubject: request.subject,
          review: request.review,
          verification: result!.verification,
          recommendation: 'repair'
        };
      }
      throw error;
    }

    return {
      attempt: result.attempt,
      reviewSubject: result.reviewSubject,
      review: result.review,
      verification: result.verification,
      recommendation: result.review.recommendation
    };
  }
}
