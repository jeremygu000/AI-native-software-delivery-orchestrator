import * as restate from '@restatedev/restate-sdk';

import {
  ForgeRunInputSchema,
  ForgeRunResultSchema,
  RepairWakeSignalSchema
} from '@ai-native-software-delivery-orchestrator/forge-runtime-contracts';
import type {
  ForgeActivities,
  ForgeRunInput,
  ForgeRunResult,
  RepairWakeSignal
} from '@ai-native-software-delivery-orchestrator/forge-runtime-contracts';

const wakeKey = (repairAttemptId: string, generation: number): string =>
  `repairWake:${repairAttemptId}:${generation}`;

const currentRepairStateKey = 'forge.currentBlockedRepairAttemptId';
const wakeGenerationStateKey = 'forge.repairWakeGeneration';

const armRepairWake = async (
  ctx: restate.WorkflowContext,
  repairAttemptId: string
): Promise<number> => {
  const generation = ((await ctx.get<number>(wakeGenerationStateKey)) ?? 0) + 1;
  ctx.set(currentRepairStateKey, repairAttemptId);
  ctx.set(wakeGenerationStateKey, generation);
  return generation;
};

/**
 * Creates the Restate adapter for the provider-neutral Forge activity port.
 * Restate journals coordination only; every durable authority decision remains
 * in the injected Forge activities and their SQLite-backed services.
 */
export const createRestateForgeRunService = (activities: ForgeActivities) =>
  restate.workflow({
    name: 'forge-run',
    handlers: {
      run: async (ctx: restate.WorkflowContext, input: ForgeRunInput): Promise<ForgeRunResult> => {
        const { runId } = ForgeRunInputSchema.parse(input);
        const authorizedTasks = [
          ...(await ctx.run('reevaluateRun', () => activities.reevaluateRun({ runId })))
            .authorizedTasks
        ];
        const seenTaskIds = new Set(authorizedTasks.map((task) => task.taskId));

        while (authorizedTasks.length > 0) {
          const task = authorizedTasks.shift();
          if (task === undefined) {
            continue;
          }

          const builderResult = await ctx.run('executeBuilder', () =>
            activities.executeBuilder({
              runId,
              taskId: task.taskId,
              attemptId: task.attemptId
            })
          );

          const reevaluation = await ctx.run('reevaluateRunAfterBuilder', () =>
            activities.reevaluateRun({ runId })
          );
          for (const nextTask of reevaluation.authorizedTasks) {
            if (!seenTaskIds.has(nextTask.taskId)) {
              seenTaskIds.add(nextTask.taskId);
              authorizedTasks.push(nextTask);
            }
          }

          const evaluation = await ctx.run('evaluateBuilderOutput', () =>
            activities.evaluateBuilderOutput({
              runId,
              taskId: task.taskId,
              workspaceId: builderResult.workspaceId,
              builderAttemptId: builderResult.attemptId,
              impactId: builderResult.impactId
            })
          );

          let recommendation = evaluation.recommendation;
          let reviewId = evaluation.reviewId;
          let subjectRef = evaluation.subjectRef;
          let repairFailed = false;

          while (recommendation === 'repair') {
            const admittedRepair = await ctx.run('admitRepair', () =>
              activities.admitRepair({ runId, taskId: task.taskId, reviewId, subjectRef })
            );
            // Arm before Forge can durably report BLOCKED. A wake received
            // between that durable transition and this activity response is
            // still only a hint, but must remain available to reauthorize.
            let wakeGeneration = await armRepairWake(ctx, admittedRepair.repairAttemptId);
            let repairResult = await ctx.run('executeRepair', () =>
              activities.executeRepair({
                runId,
                taskId: task.taskId,
                workspaceId: builderResult.workspaceId,
                builderAttemptId: builderResult.attemptId,
                impactId: builderResult.impactId,
                reviewId,
                repairAttemptId: admittedRepair.repairAttemptId
              })
            );

            while (repairResult.state === 'blocked') {
              const repairAttemptId = repairResult.repairAttemptId;
              await ctx.promise<RepairWakeSignal>(wakeKey(repairAttemptId, wakeGeneration)).get();

              // Arm the successor before reauthorization. If the current
              // blocker releases while Forge returns `ignored`, its one wake
              // is buffered for the next validation attempt.
              wakeGeneration = await armRepairWake(ctx, repairAttemptId);

              const resumeResult = await ctx.run('resumeBlockedRepair', () =>
                activities.resumeBlockedRepair({ runId, repairAttemptId })
              );
              if (resumeResult.status === 'ignored') {
                continue;
              }
              if (resumeResult.status !== 'resumed') {
                repairFailed = true;
                break;
              }
              repairResult = await ctx.run('executeResumedRepair', () =>
                activities.executeRepair({
                  runId,
                  taskId: task.taskId,
                  workspaceId: builderResult.workspaceId,
                  builderAttemptId: builderResult.attemptId,
                  impactId: builderResult.impactId,
                  reviewId,
                  repairAttemptId
                })
              );
            }
            ctx.clear(currentRepairStateKey);
            ctx.clear(wakeGenerationStateKey);

            if (
              repairFailed ||
              repairResult.state !== 'completed' ||
              repairResult.recommendation === undefined ||
              repairResult.subjectRef === undefined
            ) {
              repairFailed = true;
              break;
            }

            recommendation = repairResult.recommendation;
            subjectRef = repairResult.subjectRef;
            if (repairResult.reviewId !== undefined) {
              reviewId = repairResult.reviewId;
            } else if (recommendation === 'repair') {
              repairFailed = true;
              break;
            }
          }

          if (repairFailed || recommendation !== 'accept') {
            continue;
          }

          const integrationResult = await ctx.run('integrateAcceptedOutput', () =>
            activities.integrateAcceptedOutput({
              runId,
              taskId: task.taskId,
              workspaceId: builderResult.workspaceId,
              subjectRef
            })
          );

          if (integrationResult.status === 'blocked') {
            continue;
          }

          const postIntegrationReevaluation = await ctx.run('reevaluateRunAfterIntegration', () =>
            activities.reevaluateRun({ runId })
          );
          for (const nextTask of postIntegrationReevaluation.authorizedTasks) {
            if (!seenTaskIds.has(nextTask.taskId)) {
              seenTaskIds.add(nextTask.taskId);
              authorizedTasks.push(nextTask);
            }
          }
        }

        return ForgeRunResultSchema.parse(
          await ctx.run('finalizeRunState', () => activities.finalizeRunState({ runId }))
        );
      },

      sendRepairWake: async (
        ctx: restate.WorkflowSharedContext,
        signal: RepairWakeSignal
      ): Promise<void> => {
        const { repairAttemptId } = RepairWakeSignalSchema.parse(signal);
        const currentRepairAttemptId = await ctx.get<string>(currentRepairStateKey);
        if (currentRepairAttemptId !== repairAttemptId) {
          return;
        }
        const generation = await ctx.get<number>(wakeGenerationStateKey);
        if (generation === null) {
          return;
        }
        await ctx.promise<RepairWakeSignal>(wakeKey(repairAttemptId, generation)).resolve({
          repairAttemptId
        });
      }
    }
  });

export type RestateForgeRunService = ReturnType<typeof createRestateForgeRunService>;
