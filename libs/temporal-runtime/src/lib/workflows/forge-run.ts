import {
  CancellationScope,
  condition,
  defineSignal,
  isCancellation,
  proxyActivities,
  setHandler,
  sleep
} from '@temporalio/workflow';
import type { ForgeActivities } from '../activities/forge-activities.js';
import {
  ForgeRunInputSchema,
  ForgeRunResultSchema,
  IntegrationWakeSignalSchema,
  RepairWakeSignalSchema,
  type BlockedIntegrationContinuationActivities,
  type ExecuteBuilderResult,
  type ForgeRunInput,
  type ForgeRunResult,
  type IntegrationWakeSignal,
  type RepairWakeSignal
} from '@ai-native-software-delivery-orchestrator/forge-runtime-contracts';

const { reevaluateRun, integrateAcceptedOutput, resumeBlockedRepair } =
  proxyActivities<ForgeActivities>({
    startToCloseTimeout: '5 minutes'
  });

const { evaluateBuilderOutput } = proxyActivities<Pick<ForgeActivities, 'evaluateBuilderOutput'>>({
  startToCloseTimeout: '5 minutes',
  // Evaluation is replay-safe and its worker adapter heartbeats while an
  // external review is pending, allowing a replacement worker to recover it.
  heartbeatTimeout: '5 seconds'
});

const { resumeBlockedIntegration } = proxyActivities<BlockedIntegrationContinuationActivities>({
  startToCloseTimeout: '5 minutes'
});

// Once an external agent has established a session, SQLite records UNKNOWN on
// an ambiguous outcome and retains its lease. Replaying that activity would be
// state-invalid and could not safely repeat the external work.
const { executeBuilder, executeRepair } = proxyActivities<
  Pick<ForgeActivities, 'executeBuilder' | 'executeRepair'>
>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 1 }
});

// Repair admission failures are durable validation decisions, not transient work.
const { admitRepair } = proxyActivities<Required<Pick<ForgeActivities, 'admitRepair'>>>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 1 }
});

// A non-terminal run is a durable authority result, not transient activity
// work. Retrying cannot make an UNKNOWN execution or blocked integration safe.
const { finalizeRunState } = proxyActivities<Pick<ForgeActivities, 'finalizeRunState'>>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 1 }
});

const { finalizeRunCancellation } = proxyActivities<
  Required<Pick<ForgeActivities, 'finalizeRunCancellation'>>
>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 1 }
});

export const repairWakeSignal = defineSignal<[RepairWakeSignal]>('repairWake');
export const integrationWakeSignal = defineSignal<[IntegrationWakeSignal]>('integrationWake');

/**
 * Forge run workflow.
 *
 * Scenario A topology:
 *   reevaluateRun
 *     → for each authorized task start:
 *         executeBuilder
 *         → reevaluateRun
 *         → evaluateBuilderOutput
 *             → [repair path] admitRepair → executeRepair
 *         → integrateAcceptedOutput (if accept)
 *   finalizeRunState
 *
 * Scenario B topology:
 *   if executeRepair returns BLOCKED:
 *     await repairWakeSignal for the same repairAttemptId
 *     → resumeBlockedRepair
 *     → executeRepair with the same repairAttemptId
 */
export async function forgeRunWorkflow(input: ForgeRunInput): Promise<ForgeRunResult> {
  const { runId } = ForgeRunInputSchema.parse(input);

  const pendingWakeRepairIds = new Set<string>();
  const pendingIntegrationWakeKeys = new Set<string>();
  setHandler(repairWakeSignal, (signal: RepairWakeSignal) => {
    const parsed = RepairWakeSignalSchema.parse(signal);
    pendingWakeRepairIds.add(parsed.repairAttemptId);
  });
  setHandler(integrationWakeSignal, (signal: IntegrationWakeSignal) => {
    const parsed = IntegrationWakeSignalSchema.parse(signal);
    pendingIntegrationWakeKeys.add(integrationWakeKey(parsed));
  });

  try {
    return await executeForgeRun(runId, pendingWakeRepairIds, pendingIntegrationWakeKeys);
  } catch (error) {
    if (!isCancellation(error)) {
      throw error;
    }
    return CancellationScope.nonCancellable(async () => {
      let result = await finalizeRunCancellation({ runId });
      while (result.status === 'pending') {
        await sleep('5 seconds');
        result = await finalizeRunCancellation({ runId });
      }
      return ForgeRunResultSchema.parse(result);
    });
  }
}

async function executeForgeRun(
  runId: string,
  pendingWakeRepairIds: Set<string>,
  pendingIntegrationWakeKeys: Set<string>
): Promise<ForgeRunResult> {
  // Step 1: ask the scheduler which tasks are authorized to start
  const initialReevaluation = await reevaluateRun({ runId });
  const authorizedTasks = [...initialReevaluation.authorizedTasks];
  const queuedAuthorizationKeys = new Set(authorizedTasks.map(authorizationKey));
  const completedAuthorizationKeys = new Set<string>();

  const enqueueAuthorizations = (
    authorizations: typeof initialReevaluation.authorizedTasks
  ): void => {
    for (const authorization of authorizations) {
      const key = authorizationKey(authorization);
      if (queuedAuthorizationKeys.has(key) || completedAuthorizationKeys.has(key)) {
        continue;
      }
      queuedAuthorizationKeys.add(key);
      authorizedTasks.push(authorization);
    }
  };

  // Step 2: process each snapshot of task starts authorized by Forge.
  while (authorizedTasks.length > 0) {
    const builderWave = authorizedTasks.splice(0);
    for (const task of builderWave) {
      queuedAuthorizationKeys.delete(authorizationKey(task));
    }
    const builderResults = await Promise.all(
      builderWave.map((task) =>
        executeBuilder({
          runId,
          taskId: task.taskId,
          attemptId: task.attemptId
        })
      )
    );
    let blockedBuilder = false;

    for (const [index, builderResult] of builderResults.entries()) {
      const task = builderWave[index];
      if (task === undefined) {
        continue;
      }

      if (!isCompletedBuilderResult(builderResult)) {
        // The composition has already durably recorded the lease-blocked state.
        blockedBuilder = true;
        continue;
      }
      completedAuthorizationKeys.add(authorizationKey(task));

      // Step 4: advance Forge task state after the builder run.
      // New authorizations wait for the next builder wave.
      const reevaluation = await reevaluateRun({ runId });
      enqueueAuthorizations(reevaluation.authorizedTasks);

      // Step 5: evaluate the builder output
      const evalResult = await evaluateBuilderOutput({
        runId,
        taskId: task.taskId,
        workspaceId: builderResult.workspaceId,
        builderAttemptId: builderResult.attemptId,
        impactId: builderResult.impactId
      });

      // Reject: no integration for this task
      if (evalResult.recommendation === 'reject') {
        continue;
      }

      let finalSubjectRef = evalResult.subjectRef;
      let recommendation: 'accept' | 'repair' | 'reject' = evalResult.recommendation;
      let currentReviewId = evalResult.reviewId;
      let repairFailed = false;

      // Step 6 (optional): repair admission + execution loop.
      while (recommendation === 'repair') {
        const admittedRepair = await admitRepair({
          runId,
          taskId: task.taskId,
          reviewId: currentReviewId,
          subjectRef: finalSubjectRef
        });

        let repairResult = await executeRepair({
          runId,
          taskId: task.taskId,
          workspaceId: builderResult.workspaceId,
          builderAttemptId: builderResult.attemptId,
          impactId: builderResult.impactId,
          reviewId: currentReviewId,
          repairAttemptId: admittedRepair.repairAttemptId
        });

        // Scenario B: a repair may BLOCK on a lease, wait for a wake signal
        // scoped to the same repairAttemptId, then resume and re-execute. This
        // is a loop because the same repairAttemptId can block again after a
        // resume, and an early wake (blocker lease still ACTIVE) must not
        // permanently fail the repair — the wake is a hint, not authority.
        while (repairResult.state === 'blocked') {
          const blockedRepairAttemptId = repairResult.repairAttemptId;
          await condition(() => pendingWakeRepairIds.has(blockedRepairAttemptId));
          pendingWakeRepairIds.delete(blockedRepairAttemptId);
          const resumeResult = await resumeBlockedRepair({
            runId,
            repairAttemptId: blockedRepairAttemptId
          });
          if (resumeResult.status === 'ignored') {
            // Early wake or stale blocker: keep waiting for the next matching
            // wake instead of abandoning the continuation.
            continue;
          }
          if (resumeResult.status !== 'resumed') {
            repairFailed = true;
            break;
          }
          repairResult = await executeRepair({
            runId,
            taskId: task.taskId,
            workspaceId: builderResult.workspaceId,
            builderAttemptId: builderResult.attemptId,
            impactId: builderResult.impactId,
            reviewId: currentReviewId,
            repairAttemptId: blockedRepairAttemptId
          });
        }

        if (repairFailed) {
          break;
        }

        if (repairResult.state !== 'completed' || repairResult.subjectRef === undefined) {
          repairFailed = true;
          break;
        }

        if (repairResult.recommendation === undefined) {
          repairFailed = true;
          break;
        }

        finalSubjectRef = repairResult.subjectRef;

        if (repairResult.reviewId !== undefined) {
          currentReviewId = repairResult.reviewId;
        } else if (repairResult.recommendation === 'repair') {
          repairFailed = true;
          break;
        }

        recommendation = repairResult.recommendation;
      }

      if (repairFailed) {
        continue;
      }

      if (recommendation !== 'accept') {
        continue;
      }

      // Step 7: integrate the accepted output
      let integrationResult = await integrateAcceptedOutput({
        runId,
        taskId: task.taskId,
        workspaceId: builderResult.workspaceId,
        subjectRef: finalSubjectRef
      });

      const integrationWake = {
        taskId: task.taskId,
        workspaceId: builderResult.workspaceId,
        subjectRef: finalSubjectRef
      };
      const wakeKey = integrationWakeKey(integrationWake);
      while (integrationResult.status === 'blocked') {
        await condition(() => pendingIntegrationWakeKeys.has(wakeKey));
        pendingIntegrationWakeKeys.delete(wakeKey);
        const resumed = await resumeBlockedIntegration({ runId, ...integrationWake });
        if (resumed.status === 'integrated') {
          integrationResult = {
            runId: resumed.runId,
            taskId: resumed.taskId,
            status: 'integrated'
          };
        }
      }

      const postIntegrationReevaluation = await reevaluateRun({ runId });
      enqueueAuthorizations(postIntegrationReevaluation.authorizedTasks);
    }

    if (blockedBuilder) {
      // Another builder in this wave may have released the exact blocker and
      // reauthorized the original PREPARING attempt.
      const postWaveReevaluation = await reevaluateRun({ runId });
      enqueueAuthorizations(postWaveReevaluation.authorizedTasks);
    }
  }

  // Step 8: finalize the run state
  const finalState = await finalizeRunState({ runId });

  const finalResult = ForgeRunResultSchema.parse({
    runId,
    status: finalState.status
  });
  return finalResult;
}

const integrationWakeKey = (signal: IntegrationWakeSignal): string =>
  [
    signal.taskId,
    signal.workspaceId,
    signal.subjectRef.builderAttemptId,
    signal.subjectRef.outputAttemptId,
    signal.subjectRef.workspaceId
  ].join('\0');

type CompletedBuilderResult = Extract<ExecuteBuilderResult, { status: 'completed' }>;

const isCompletedBuilderResult = (result: ExecuteBuilderResult): result is CompletedBuilderResult =>
  result.status === 'completed';

const authorizationKey = (authorization: { taskId: string; attemptId: string }): string =>
  [authorization.taskId, authorization.attemptId].join('\0');
