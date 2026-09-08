import * as restate from '@restatedev/restate-sdk';

import type { RestateSpikeActivity } from './restate-spike-activities.js';

export interface RepairWakeSignal {
  readonly repairAttemptId: string;
}

export interface RestateSpikeWorkflowRequest {
  readonly runId: string;
  readonly scenario: 'build-review-repair-integrate' | 'blocked-repair-restart-resume';
  readonly blockedRepairAttemptId?: string;
  readonly taskId?: string;
  readonly attemptId?: string;
  readonly agentId?: string;
  readonly verificationPolicyFingerprint?: string;
}

export const createRestateSpikeWorkflow = (activities: RestateSpikeActivity) => {
  return restate.workflow({
    name: 'spike-workflow',
    handlers: {
      run: async (
        ctx: restate.WorkflowContext,
        request: RestateSpikeWorkflowRequest
      ): Promise<{ readonly runId: string; readonly scenario: string }> => {
        if (request.scenario === 'build-review-repair-integrate') {
          if (!request.taskId || !request.attemptId || !request.agentId) {
            throw new Error(
              'taskId, attemptId, and agentId are required for build-review-repair-integrate scenario'
            );
          }

          const builderResult = await ctx.run('executeBuilder', () =>
            activities.executeBuilder({
              runId: request.runId,
              taskId: request.taskId!,
              attemptId: request.attemptId!,
              agentId: request.agentId!
            })
          );

          const evaluationResult = await ctx.run('evaluateBuilderOutput', () =>
            activities.evaluateBuilderOutput({
              runId: request.runId,
              builderAttemptId: builderResult.builderAttemptId,
              workspaceId: builderResult.workspaceId,
              verificationPolicyFingerprint: request.verificationPolicyFingerprint ?? 'default'
            })
          );

          let finalReviewSubjectRef = evaluationResult.reviewSubjectRef;

          if (evaluationResult.recommendation === 'repair') {
            if (evaluationResult.repairAttemptId === undefined) {
              throw new Error('Forge must provide repairAttemptId for repair recommendation');
            }
            const repairResult = await ctx.run('executeRepair', () =>
              activities.executeRepair({
                runId: request.runId,
                repairAttemptId: evaluationResult.repairAttemptId!,
                builderAttemptId: builderResult.builderAttemptId,
                workspaceId: builderResult.workspaceId,
                reviewSubjectRef: evaluationResult.reviewSubjectRef,
                maxRepairs: 3
              })
            );

            if (repairResult.recommendation === 'accept') {
              finalReviewSubjectRef = repairResult.reviewSubjectRef;
            } else if (repairResult.recommendation === 'repair') {
              throw new Error(
                'Repair loop not yet implemented: maxRepairs exceeded or subsequent repair rejected'
              );
            } else {
              throw new Error(
                `Repair resulted in ${repairResult.recommendation} - cannot integrate`
              );
            }
          }

          await ctx.run('integrateAcceptedOutput', () =>
            activities.integrateAcceptedOutput({
              runId: request.runId,
              taskId: request.taskId!,
              workspaceId: builderResult.workspaceId,
              reviewSubjectRef: finalReviewSubjectRef
            })
          );

          return { runId: request.runId, scenario: request.scenario };
        }

        if (request.scenario === 'blocked-repair-restart-resume') {
          if (request.blockedRepairAttemptId === undefined) {
            throw new Error(
              'blockedRepairAttemptId is required for blocked-repair-restart-resume scenario'
            );
          }

          const wakeSignal = await ctx.promise<RepairWakeSignal>('repairWake').get();

          if (wakeSignal.repairAttemptId !== request.blockedRepairAttemptId) {
            throw new Error(
              `Wake signal repairAttemptId ${wakeSignal.repairAttemptId} does not match expected ${request.blockedRepairAttemptId}`
            );
          }

          const resumeResult = await ctx.run('executeBlockedRepairResume', () =>
            activities.executeBlockedRepairResume({
              runId: request.runId,
              repairAttemptId: request.blockedRepairAttemptId!
            })
          );

          if (resumeResult.state === 'unknown') {
            throw new Error(
              `Blocked repair resume returned unknown state for repair ${request.blockedRepairAttemptId}`
            );
          }

          return { runId: request.runId, scenario: request.scenario };
        }

        throw new Error(`Unknown scenario: ${String(request.scenario)}`);
      },

      sendWake: async (
        ctx: restate.WorkflowSharedContext,
        request: RepairWakeSignal
      ): Promise<void> => {
        await ctx.promise<RepairWakeSignal>('repairWake').resolve(request);
      }
    }
  });
};

export const restateSpikeWorkflow = createRestateSpikeWorkflow({
  executeBuilder: () => {
    throw new Error('placeholder - must be injected');
  },
  evaluateBuilderOutput: () => {
    throw new Error('placeholder - must be injected');
  },
  executeRepair: () => {
    throw new Error('placeholder - must be injected');
  },
  integrateAcceptedOutput: () => {
    throw new Error('placeholder - must be injected');
  },
  executeBlockedRepairResume: () => {
    throw new Error('placeholder - must be injected');
  }
});

export type RestateSpikeWorkflow = ReturnType<typeof createRestateSpikeWorkflow>;
