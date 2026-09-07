import { condition, defineSignal, setHandler } from '@temporalio/workflow';
import type { DurableExecutionSpikeOutcome } from '@ai-native-software-delivery-orchestrator/orchestration-runtime';

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
  readonly harnessOutcome?: DurableExecutionSpikeOutcome;
}

export const runTemporalSpikeWorkflow = async (
  request: TemporalSpikeWorkflowRequest
): Promise<DurableExecutionSpikeOutcome> => {
  if (request.scenario === 'build-review-repair-integrate') {
    if (!request.taskId || !request.attemptId || !request.agentId) {
      throw new Error(
        'taskId, attemptId, and agentId are required for build-review-repair-integrate scenario'
      );
    }

    if (request.harnessOutcome) {
      return request.harnessOutcome;
    }

    throw new Error('harnessOutcome required for Scenario A');
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

    if (request.harnessOutcome) {
      return request.harnessOutcome;
    }

    throw new Error('harnessOutcome required for Scenario B');
  }

  throw new Error(`Unknown scenario: ${String(request.scenario)}`);
};
