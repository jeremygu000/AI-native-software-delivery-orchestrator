import * as restate from '@restatedev/restate-sdk';
import type {
  DurableExecutionSpikeDriver,
  DurableExecutionSpikeOutcome
} from '@ai-native-software-delivery-orchestrator/orchestration-runtime';

export interface RepairWakeSignal {
  readonly repairAttemptId: string;
  readonly leaseState: 'RELEASED' | 'STALE';
}

const harnessRegistry: { current: DurableExecutionSpikeDriver | undefined } = {
  current: undefined
};

export const setSpikeHarness = (harness: DurableExecutionSpikeDriver): void => {
  harnessRegistry.current = harness;
};

export const getSpikeHarness = (): DurableExecutionSpikeDriver => {
  if (harnessRegistry.current === undefined) {
    throw new Error('Spike harness not set - call setSpikeHarness before running workflow');
  }
  return harnessRegistry.current;
};

export const createRestateSpikeWorkflow = () => {
  return restate.workflow({
    name: 'spike-workflow',
    handlers: {
      run: async (
        _ctx: restate.WorkflowContext,
        request: {
          readonly scenario: 'build-review-repair-integrate' | 'blocked-repair-restart-resume';
          readonly runId: string;
          readonly taskId: string;
          readonly attemptId: string;
          readonly agentId: string;
          readonly blockedRepairAttemptId?: string;
        }
      ): Promise<DurableExecutionSpikeOutcome> => {
        const harness = getSpikeHarness();

        if (request.scenario === 'build-review-repair-integrate') {
          return harness.runBuildReviewRepairIntegrate();
        } else {
          if (request.blockedRepairAttemptId === undefined) {
            throw new Error('blockedRepairAttemptId is required for Scenario B');
          }

          return harness.runBlockedRepairRestartResume();
        }
      }
    }
  });
};

export const restateSpikeWorkflow = createRestateSpikeWorkflow();

export type RestateSpikeWorkflow = ReturnType<typeof createRestateSpikeWorkflow>;
