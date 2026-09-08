import { condition, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';

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

export interface TemporalSpikeWorkflowRequest {
  readonly runId: string;
  readonly scenario: 'build-review-repair-integrate' | 'blocked-repair-restart-resume';
  readonly blockedRepairAttemptId?: string;
  readonly taskId?: string;
  readonly attemptId?: string;
  readonly agentId?: string;
  readonly verificationPolicyFingerprint?: string;
}

export const runTemporalSpikeWorkflow = async (
  request: TemporalSpikeWorkflowRequest
): Promise<{ readonly runId: string; readonly scenario: string }> => {
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

    let finalReviewSubjectRef = evaluationResult.reviewSubjectRef;

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
        finalReviewSubjectRef = repairResult.reviewSubjectRef;
      } else if (repairResult.recommendation === 'repair') {
        throw new Error('Repair loop not yet implemented: maxRepairs exceeded or subsequent repair rejected');
      } else {
        throw new Error(`Repair resulted in ${repairResult.recommendation} - cannot integrate`);
      }
    }

    await activities.integrateAcceptedOutput({
      runId: request.runId,
      taskId: request.taskId,
      workspaceId: builderResult.workspaceId,
      reviewSubjectRef: finalReviewSubjectRef
    });

    return { runId: request.runId, scenario: request.scenario };
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

    const resumeResult = await activities.executeBlockedRepairResume({
      runId: request.runId,
      repairAttemptId: request.blockedRepairAttemptId,
      leaseState: wakeSignal!.leaseState
    });

    if (resumeResult.state === 'unknown') {
      throw new Error(
        `Blocked repair resume returned unknown state for repair ${request.blockedRepairAttemptId}`
      );
    }

    return { runId: request.runId, scenario: request.scenario };
  }

  throw new Error(`Unknown scenario: ${String(request.scenario)}`);
};
