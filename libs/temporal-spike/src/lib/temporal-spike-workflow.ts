import { condition, defineSignal, setHandler, proxyActivities } from '@temporalio/workflow';

import type { TemporalSpikeActivity } from './temporal-spike-activities.js';

const activities = proxyActivities<TemporalSpikeActivity>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 1 }
});

export interface RepairWakeSignal {
  readonly repairAttemptId: string;
  readonly leaseState: 'RELEASED' | 'STALE';
}

export const repairWakeSignal = defineSignal<[RepairWakeSignal]>('repairWake');

export interface ScenarioABuildReviewRepairIntegrateRequest {
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly agentId: string;
  readonly verificationPolicyFingerprint?: string;
}

export interface ScenarioBBlockedRepairRestartResumeRequest {
  readonly runId: string;
  readonly blockedRepairAttemptId: string;
}

export type TemporalSpikeWorkflowRequest =
  | ScenarioABuildReviewRepairIntegrateRequest
  | ScenarioBBlockedRepairRestartResumeRequest;

/**
 * M2 control flow only. Forge authority evidence remains in the authority store, never workflow history.
 *
 * Temporal is wake-only. Forge CAS authority is exercised inside executeBlockedRepairResume Activity.
 *
 * Scenario A (build-review-repair-integrate) using four narrow activities:
 *   -> ExecuteBuilder Activity (Seam 1)
 *   -> EvaluateBuilderOutput Activity (Seam 2)
 *   -> if recommendation == repair -> ExecuteRepair Activity (Seam 3)
 *   -> if final recommendation == accept -> IntegrateAcceptedOutput Activity (Seam 4)
 *
 * Each activity call is a durable continuation boundary. Workflow state is minimal:
 * only runId and scenario discriminator in history.
 *
 * Scenario B (blocked-repair-restart-resume):
 *   -> durable wait for 'repairWake' signal (wake-only, not authorization)
 *   -> ExecuteBlockedRepairResume Activity (Forge CAS authority inside)
 */
export const runTemporalSpikeWorkflow = async (request: {
  readonly runId: string;
  readonly scenario: 'build-review-repair-integrate' | 'blocked-repair-restart-resume';
  readonly blockedRepairAttemptId?: string;
  readonly taskId?: string;
  readonly attemptId?: string;
  readonly agentId?: string;
  readonly verificationPolicyFingerprint?: string;
}): Promise<{
  readonly runId: string;
  readonly scenario: string;
  readonly builderAttemptId?: string;
  readonly repairAttemptId?: string;
}> => {
  if (request.scenario === 'build-review-repair-integrate') {
    if (!request.taskId || !request.attemptId || !request.agentId) {
      throw new Error(
        'taskId, attemptId, and agentId are required for build-review-repair-integrate scenario'
      );
    }

    const builderResult = await activities.executeBuilder({
      runId: request.runId,
      taskId: request.taskId,
      attemptId: request.attemptId,
      agentId: request.agentId
    });

    const evaluationResult = await activities.evaluateBuilderOutput({
      runId: request.runId,
      builderAttemptId: builderResult.builderAttemptId,
      workspaceId: builderResult.workspaceId,
      verificationPolicyFingerprint: request.verificationPolicyFingerprint ?? 'default'
    });

    if (evaluationResult.recommendation === 'repair') {
      if (evaluationResult.repairAttemptId === undefined) {
        throw new Error('Forge must provide repairAttemptId for repair recommendation');
      }
      const repairResult = await activities.executeRepair({
        runId: request.runId,
        repairAttemptId: evaluationResult.repairAttemptId,
        builderAttemptId: builderResult.builderAttemptId,
        workspaceId: builderResult.workspaceId,
        reviewSubjectRef: evaluationResult.reviewSubjectRef,
        maxRepairs: 3
      });

      if (repairResult.recommendation === 'accept') {
        await activities.integrateAcceptedOutput({
          runId: request.runId,
          taskId: request.taskId,
          workspaceId: builderResult.workspaceId,
          reviewSubjectRef: repairResult.reviewSubjectRef
        });
        return {
          runId: request.runId,
          scenario: request.scenario,
          builderAttemptId: builderResult.builderAttemptId,
          repairAttemptId: repairResult.repairAttemptId
        };
      }

      throw new Error('Multi-repair not yet supported');
    }

    await activities.integrateAcceptedOutput({
      runId: request.runId,
      taskId: request.taskId,
      workspaceId: builderResult.workspaceId,
      reviewSubjectRef: evaluationResult.reviewSubjectRef
    });

    return {
      runId: request.runId,
      scenario: request.scenario,
      builderAttemptId: builderResult.builderAttemptId
    };
  }

  if (request.scenario === 'blocked-repair-restart-resume') {
    if (request.blockedRepairAttemptId === undefined) {
      throw new Error(
        'blockedRepairAttemptId is required for blocked-repair-restart-resume scenario'
      );
    }

    let wakeSignal: RepairWakeSignal | undefined;

    setHandler(repairWakeSignal, (signal: RepairWakeSignal) => {
      wakeSignal = signal;
    });

    await condition(
      () =>
        wakeSignal !== undefined &&
        wakeSignal.repairAttemptId === request.blockedRepairAttemptId &&
        (wakeSignal.leaseState === 'RELEASED' || wakeSignal.leaseState === 'STALE')
    );

    const result = await activities.executeBlockedRepairResume({
      runId: request.runId,
      repairAttemptId: request.blockedRepairAttemptId,
      leaseState: wakeSignal!.leaseState
    });
    return {
      runId: request.runId,
      scenario: request.scenario,
      repairAttemptId: result.repairAttemptId
    };
  }

  throw new Error(`Unknown scenario: ${String(request.scenario)}`);
};
