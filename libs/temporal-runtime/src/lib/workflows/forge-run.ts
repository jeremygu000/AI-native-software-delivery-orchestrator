import { proxyActivities } from '@temporalio/workflow';
import type { ForgeActivities } from '../activities/forge-activities.js';
import {
  ForgeRunInputSchema,
  ForgeRunResultSchema,
  type ForgeRunInput,
  type ForgeRunResult
} from '../contracts.js';

const {
  reevaluateRun,
  executeBuilder,
  evaluateBuilderOutput,
  admitRepair,
  executeRepair,
  integrateAcceptedOutput,
  finalizeRunState
} = proxyActivities<ForgeActivities>({
  startToCloseTimeout: '5 minutes'
});

/**
 * Scenario A Forge run workflow.
 *
 * Topology:
 *   reevaluateRun
 *     → for each authorized task start:
 *         executeBuilder
 *         → reevaluateRun
 *         → evaluateBuilderOutput
 *             → [repair path] admitRepair → executeRepair
 *         → integrateAcceptedOutput (if accept)
 *   finalizeRunState
 */
export async function forgeRunWorkflow(input: ForgeRunInput): Promise<ForgeRunResult> {
  const { runId } = ForgeRunInputSchema.parse(input);

  // Step 1: ask the scheduler which tasks are authorized to start
  const initialReevaluation = await reevaluateRun({ runId });
  const authorizedTasks = [...initialReevaluation.authorizedTasks];
  const seenTaskIds = new Set(authorizedTasks.map((task) => task.taskId));

  // Step 2: process each task start authorized by Forge
  while (authorizedTasks.length > 0) {
    const task = authorizedTasks.shift();
    if (task === undefined) {
      continue;
    }

    // Step 3: run the builder agent
    const builderResult = await executeBuilder({
      runId,
      taskId: task.taskId,
      bindingId: task.bindingId,
      attemptId: task.attemptId
    });

    // Step 4: advance Forge task state after the builder run
    const reevaluation = await reevaluateRun({ runId });
    for (const nextTask of reevaluation.authorizedTasks) {
      if (seenTaskIds.has(nextTask.taskId)) {
        continue;
      }
      seenTaskIds.add(nextTask.taskId);
      authorizedTasks.push(nextTask);
    }

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

      const repairResult = await executeRepair({
        runId,
        taskId: task.taskId,
        workspaceId: builderResult.workspaceId,
        builderAttemptId: builderResult.attemptId,
        impactId: builderResult.impactId,
        reviewId: currentReviewId,
        repairAttemptId: admittedRepair.repairAttemptId
      });

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
    await integrateAcceptedOutput({
      runId,
      taskId: task.taskId,
      workspaceId: builderResult.workspaceId,
      subjectRef: finalSubjectRef
    });
  }

  // Step 8: finalize the run state
  const finalState = await finalizeRunState({ runId });

  const finalResult = ForgeRunResultSchema.parse({
    runId,
    status: finalState.status
  });
  return finalResult;
}
