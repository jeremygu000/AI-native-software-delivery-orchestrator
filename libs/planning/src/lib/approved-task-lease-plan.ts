import {
  taskLeasePlanFromPredictedImpact,
  type PredictedTaskImpact,
  type TaskLeasePlan
} from '@ai-native-software-delivery-orchestrator/domain';
import type { PlanApproval } from './plan-approval.js';

/** Git integration rights are explicit human approval, never inferred from an accepted review. */
export function approvedTaskLeasePlan(
  impact: PredictedTaskImpact,
  approval: PlanApproval
): TaskLeasePlan {
  const plan = taskLeasePlanFromPredictedImpact(impact);
  return approval.repositoryIntegrationTasks?.includes(impact.taskId)
    ? { ...plan, predictedResources: [{ type: 'repository' }, ...plan.predictedResources] }
    : plan;
}
