import { TaskState } from '@ai-native-software-delivery-orchestrator/domain';
import { RunEdgeKind, RunStateSource, type RunView, type TaskView } from './run-view-schema.js';

export const TaskTone = {
  Complete: 'complete',
  Active: 'active',
  Failed: 'failed',
  Pending: 'pending',
  Unknown: 'unknown'
} as const;
export type TaskTone = (typeof TaskTone)[keyof typeof TaskTone];
export const TuiPanel = { Overview: 'overview', Tasks: 'tasks', Detail: 'detail' } as const;
export type TuiPanel = (typeof TuiPanel)[keyof typeof TuiPanel];
export const TaskFilter = { All: 'all' } as const;

/** Presentation only: no task/run state is synthesized here. */
export const taskTone = (state: string): TaskTone =>
  state === TaskState.COMPLETED
    ? TaskTone.Complete
    : [TaskState.RUNNING, TaskState.VERIFYING, TaskState.INTEGRATING].some(
          (value) => value === state
        )
      ? TaskTone.Active
      : [TaskState.FAILED, TaskState.CANCELLED].some((value) => value === state)
        ? TaskTone.Failed
        : [TaskState.PENDING, TaskState.READY, TaskState.BLOCKED].some((value) => value === state)
          ? TaskTone.Pending
          : TaskTone.Unknown;

export const taskSymbol = (state: string) =>
  ({
    [TaskTone.Complete]: '✓',
    [TaskTone.Active]: '◐',
    [TaskTone.Failed]: '✗',
    [TaskTone.Pending]: '○',
    [TaskTone.Unknown]: '?'
  })[taskTone(state)];

export function taskDetailsText(task: TaskView): string {
  return [
    `${task.title} · ${task.state}`,
    `Task: ${task.id}`,
    task.goal,
    task.description,
    task.stage ? `Last completion observation: ${task.stage}` : undefined,
    `Planned file IDs:\n${task.plannedFiles.join('\n') || 'None recorded'}`,
    `Actual changed paths:\n${task.actualFiles.join('\n') || 'Not recorded'}`,
    `Verification:\n${task.verification ? JSON.stringify(task.verification, null, 2) : 'Not recorded'}`,
    `Output review:\n${task.review ? JSON.stringify(task.review, null, 2) : 'Not recorded'}`,
    task.failure ? `Failure:\n${task.failure}` : undefined,
    `Worktree: ${task.worktree ?? 'Not recorded'}`,
    `Integrated commit: ${task.integratedCommit ?? 'Not recorded'}`,
    `Actual diff:\n${task.diff ?? 'Not recorded'}`
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n\n');
}

export function runMetadataText(view: RunView): string {
  return [
    `Plan: ${view.planId} · ${view.approved ? 'APPROVED' : 'not approved'}`,
    `Repository: ${view.repository}`,
    `Planned HEAD: ${view.repositoryCommit}`,
    `Run: ${view.runId ?? 'not started'} · displayed state: ${view.state}`,
    `Status based on: ${view.stateSource === RunStateSource.TaskEvents ? 'recorded task events' : view.stateSource === RunStateSource.RunRecord ? 'recorded run status' : 'saved plan'}`,
    `Separately recorded run status: ${view.recordedRunState ?? 'not recorded'}`,
    `Execution: ${view.execution ?? 'not recorded'}`,
    `Verification mode: ${view.verificationMode ?? 'not recorded'} · review: ${view.reviewMode ?? 'not recorded'}`,
    view.finalRepository
      ? `Final repository checks: ${view.finalRepository.status} (separate observation) · clean: ${view.finalRepository.clean}\nFinal HEAD: ${view.finalRepository.head}${view.finalRepository.detail ? `\n${view.finalRepository.detail}` : ''}`
      : 'Final repository checks: not recorded',
    ...view.warnings.map((warning) => `Observation warning: ${warning}`)
  ].join('\n');
}

/** Dependency depth, not array order, defines the visual task columns. */
export function taskPositions(view: RunView): Map<string, { x: number; y: number }> {
  const depths = new Map(view.tasks.map((task) => [task.id, 0]));
  for (let pass = 0; pass < view.tasks.length; pass += 1) {
    let changed = false;
    for (const edge of view.edges.filter(
      (candidate) => candidate.kind === RunEdgeKind.Dependency
    )) {
      if (!depths.has(edge.source) || !depths.has(edge.target)) {
        continue;
      }
      const next = Math.min(view.tasks.length - 1, depths.get(edge.source)! + 1);
      if (next > depths.get(edge.target)!) {
        depths.set(edge.target, next);
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }
  const rows = new Map<number, number>();
  return new Map(
    view.tasks.map((task) => {
      const depth = depths.get(task.id)!;
      const row = rows.get(depth) ?? 0;
      rows.set(depth, row + 1);
      return [task.id, { x: depth * 320, y: row * 170 }];
    })
  );
}
