import { proxyActivities } from '@temporalio/workflow';
import type { ForgeActivities } from '../activities/forge-activities.js';
import type { ForgeRunInput, ForgeRunResult } from '../contracts.js';

const {
  reevaluateRun,
  executeBuilder,
  evaluateBuilderOutput,
  executeRepair,
  integrateAcceptedOutput,
} = proxyActivities<ForgeActivities>({
  startToCloseTimeout: '5 minutes',
});

/**
 * Scenario A Forge run workflow.
 *
 * Topology:
 *   reevaluateRun
 *     → for each ready task:
 *         executeBuilder
 *         → evaluateBuilderOutput
 *             → [repair path] executeRepair
 *         → integrateAcceptedOutput (if accept)
 */
export async function forgeRunWorkflow(input: ForgeRunInput): Promise<ForgeRunResult> {
  const { runId } = input;

  // Step 1: ask the scheduler which tasks are ready
  const { taskDecisions } = await reevaluateRun({ runId });

  // Step 2: process each task the scheduler declared ready
  for (const decision of taskDecisions) {
    if (
      decision.action !== 'ready' ||
      decision.bindingId === undefined ||
      decision.attemptId === undefined
    ) {
      continue;
    }

    // Step 3: run the builder agent
    const builderResult = await executeBuilder({
      runId,
      taskId: decision.taskId,
      bindingId: decision.bindingId,
      attemptId: decision.attemptId,
    });

    // Step 4: evaluate the builder output
    const evalResult = await evaluateBuilderOutput({
      runId,
      taskId: decision.taskId,
      workspaceId: builderResult.workspaceId,
      builderAttemptId: builderResult.attemptId,
      impactId: builderResult.impactId,
    });

    // Reject: no integration for this task
    if (evalResult.recommendation === 'reject') {
      continue;
    }

    let finalSubjectRef = evalResult.subjectRef;

    // Step 5 (optional): repair path
    if (evalResult.recommendation === 'repair' && evalResult.repairAttemptId !== undefined) {
      const repairResult = await executeRepair({
        runId,
        taskId: decision.taskId,
        workspaceId: builderResult.workspaceId,
        builderAttemptId: builderResult.attemptId,
        impactId: builderResult.impactId,
        reviewId: evalResult.reviewId,
        repairAttemptId: evalResult.repairAttemptId,
      });

      // Repair did not complete or post-repair recommendation is reject — skip integration
      if (repairResult.state !== 'completed' || repairResult.recommendation === 'reject') {
        continue;
      }

      if (repairResult.subjectRef !== undefined) {
        finalSubjectRef = repairResult.subjectRef;
      }
    }

    // Step 6: integrate the accepted output
    await integrateAcceptedOutput({
      runId,
      taskId: decision.taskId,
      workspaceId: builderResult.workspaceId,
      subjectRef: finalSubjectRef,
    });
  }

  return { runId, status: 'completed' };
}
