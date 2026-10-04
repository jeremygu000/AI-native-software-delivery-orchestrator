import type { PlanArtifact } from '@ai-native-software-delivery-orchestrator/planning';
import type { ForgeRunReadModel } from '@ai-native-software-delivery-orchestrator/orchestration-runtime';

export const integrationTaskIds = (artifact: PlanArtifact): readonly string[] =>
  artifact.decision.specification.tasks
    .filter((task) => {
      const impact = artifact.decision.impacts.find((row) => row.taskId === task.id);
      return (
        task.expectedWrites.length > 0 ||
        (impact?.filesWritten.length ?? 0) > 0 ||
        (impact?.projectsWritten.length ?? 0) > 0 ||
        (impact?.symbolsWritten.length ?? 0) > 0
      );
    })
    .map((task) => task.id);

export const renderPlanSummary = (artifact: PlanArtifact): string => {
  const decision = artifact.decision;
  const projects = new Set(
    decision.impacts.flatMap((impact) => [...impact.projectsRead, ...impact.projectsWritten])
  );
  const files = new Set(decision.impacts.flatMap((impact) => impact.filesWritten));
  return `\nPlan ready\nArtifact: ${artifact.artifactId} / revision ${artifact.revision}\nTasks: ${decision.specification.tasks.length}\nMaximum concurrency: ${decision.schedule.maxConcurrency}\nSemantic review: ${decision.semanticReview.recommendation}\nImpact: ${projects.size} packages, ${files.size} predicted written files\nHard conflicts: ${decision.hardConflicts.length}; risk conflicts: ${decision.riskConflicts.length}\n${decision.specification.tasks.map((task, i) => `${i + 1}. ${task.title}`).join('\n')}\n`;
};

export const renderPlanDetails = (artifact: PlanArtifact): string =>
  `${renderPlanSummary(artifact)}\n${artifact.decision.specification.tasks.map((task) => `${task.id}: ${task.title}\nGoal: ${task.goal}\nDepends on: ${task.dependencies.join(', ') || 'none'}\nExpected writes: ${task.expectedWrites.map((write) => `${write.type}:${write.value}`).join(', ') || 'none'}\nVerification: ${task.verification.map((rule) => (rule.type === 'package-script' ? `${rule.packageName}: ${rule.script}` : rule.command)).join(', ') || 'none'}`).join('\n\n')}\n\nRequirements coverage\n${artifact.decision.semanticReview.requirements.map((requirement) => `${requirement.status}: ${requirement.requirement} [${requirement.taskIds.join(', ')}]\n${requirement.detail}`).join('\n')}\nSemantic review: ${artifact.decision.semanticReview.summary}\nConflicts: ${JSON.stringify([...artifact.decision.hardConflicts, ...artifact.decision.riskConflicts])}\n`;

export const renderRunProgress = (run: ForgeRunReadModel): string =>
  `\nRun ${run.runId}: ${run.state}\n${run.tasks
    .map((task) => {
      const mark =
        task.state === 'COMPLETED'
          ? '✓'
          : ['FAILED', 'BLOCKED', 'CANCELLED'].includes(task.state)
            ? '!'
            : task.state === 'PENDING' || task.state === 'READY'
              ? ' '
              : '●';
      const attempt = task.attempts.at(-1);
      return `[${mark}] ${task.title}: ${task.state}\n    ${attempt === undefined ? '' : `${attempt.kind}: ${attempt.state}; `}verification: ${task.verification.at(-1)?.status ?? 'not recorded'}; review: ${task.reviews.at(-1)?.recommendation ?? 'not recorded'}${task.currentBlockingReason === undefined ? '' : `; blocked: ${task.currentBlockingReason.type}`}`;
    })
    .join('\n')}\n`;

export const renderRunCompletion = (run: ForgeRunReadModel): string => {
  const completed = run.tasks.filter((task) => task.state === 'COMPLETED').length;
  const verified = run.tasks.filter((task) => task.verification.at(-1)?.status === 'passed').length;
  const reviewed = run.tasks.filter(
    (task) => task.reviews.at(-1)?.recommendation === 'accept'
  ).length;
  const integrated = new Set(
    run.timeline
      .filter((event) => event.type === 'workspace-integrated')
      .map((event) => event.correlation.taskId)
  ).size;
  return `${renderRunProgress(run)}\nRun outcome: ${run.state}\nCompleted: ${completed}/${run.tasks.length}\nLatest verification passed: ${verified}/${run.tasks.length}\nLatest reviews accepted: ${reviewed}/${run.tasks.length}\nDurable integration events: ${integrated}\nActive/stale leases: ${run.leases.filter((lease) => lease.state !== 'RELEASED').length}\n`;
};
