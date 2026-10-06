import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import {
  agentExecutionAttemptSchema,
  taskWorkspaceSchema,
  taskStateSchema,
  schedulerEventSchema,
  TaskState,
  OrchestrationRunState
} from '@ai-native-software-delivery-orchestrator/domain';
import { LocalPlanStore } from './local-plan.js';
import { CompletionStage, CompletionScope, CompletionOutcome } from './completion-values.js';
import type { RunView, TaskView } from './run-view-schema.js';

const rowSchema = z.object({ payload: z.string() });
const evidenceSchema = z.object({
  stage: z.enum(CompletionStage).optional(),
  scope: z.enum(CompletionScope).optional(),
  completion: z.enum(CompletionOutcome).optional(),
  detail: z.string().optional(),
  outside: z.array(z.string()).optional(),
  diff: z.object({ paths: z.array(z.string()), patch: z.string() }).optional(),
  verification: z.object({ status: z.string(), detail: z.string().optional() }).optional(),
  review: z
    .object({
      recommendation: z.string(),
      summary: z.string(),
      findings: z.array(z.object({ path: z.string(), detail: z.string() }))
    })
    .optional()
});

async function optionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/** Maps existing local facts. Never creates a database, runs a scheduler or changes a plan. */
export async function readRunView(store: LocalPlanStore, planId: string): Promise<RunView> {
  const plan = await store.load(planId);
  const view: RunView = {
    planId: plan.id,
    approved: plan.approved,
    repository: plan.repository,
    repositoryCommit: plan.repositoryCommit,
    ...(plan.runId === undefined ? {} : { runId: plan.runId }),
    state: plan.runId === undefined ? (plan.approved ? 'APPROVED' : 'PLANNED') : 'NOT_RECORDED',
    stateSource: 'plan',
    tasks: plan.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      goal: task.goal,
      description: task.description,
      state: 'NOT_RECORDED',
      plannedFiles: [
        ...(plan.impacts.find((impact) => impact.taskId === task.id)?.filesWritten ?? [])
      ],
      actualFiles: []
    })),
    edges: [
      ...plan.tasks.flatMap((task) =>
        task.dependencies.map((dependency) => ({
          id: `dependency:${dependency}:${task.id}`,
          source: dependency,
          target: task.id,
          kind: 'dependency' as const,
          label: 'depends on'
        }))
      ),
      ...plan.conflicts
        .filter((conflict) => conflict.severity !== 'none')
        .map((conflict, index) => ({
          id: `conflict:${index}`,
          source: conflict.taskA,
          target: conflict.taskB,
          kind: 'conflict' as const,
          label: `${conflict.severity}: ${conflict.recommendedAction}`
        }))
    ],
    warnings: []
  };
  if (plan.runId === undefined) {
    return view;
  }
  const directory = join(store.directory, 'runs', plan.runId);
  const evidenceFiles: { task: TaskView; filename: string }[] = [];
  const metadata = await optionalFile(join(directory, 'run.json'));
  if (metadata !== undefined) {
    const parsed = z
      .object({ execution: z.string(), verification: z.string(), review: z.string().optional() })
      .parse(JSON.parse(metadata));
    view.execution = parsed.execution;
    view.verificationMode = parsed.verification;
    view.reviewMode = parsed.review;
  }
  let db: Database.Database;
  try {
    db = new Database(join(directory, 'state.sqlite'), { readonly: true, fileMustExist: true });
  } catch {
    view.warnings.push('Run database is not available yet. No runtime state is inferred.');
    return view;
  }
  try {
    db.pragma('query_only = ON');
    db.transaction(() => {
      const run = z
        .object({ state: z.enum(['ACTIVE', 'COMPLETED', 'FAILED', 'CANCELLED']) })
        .parse(db.prepare('SELECT state FROM orchestration_runs WHERE id = ?').get(plan.runId));
      view.state = run.state;
      view.recordedRunState = run.state;
      view.stateSource = 'run-record';
      const transitions = z
        .array(z.object({ task_id: z.string(), to_state: taskStateSchema, sequence: z.number() }))
        .parse(
          db
            .prepare(
              'SELECT task_id, to_state, sequence FROM task_transitions WHERE run_id = ? ORDER BY sequence, ordinal'
            )
            .all(plan.runId)
        );
      for (const task of view.tasks) {
        task.state =
          transitions.findLast((row) => row.task_id === task.id)?.to_state ?? 'NOT_RECORDED';
      }
      for (const row of z
        .array(z.object({ sequence: z.number(), payload: z.string() }))
        .parse(
          db
            .prepare(
              'SELECT sequence, event_json AS payload FROM scheduler_events WHERE run_id = ? ORDER BY sequence'
            )
            .all(plan.runId)
        )) {
        const event = schedulerEventSchema.parse(JSON.parse(row.payload));
        if ('state' in event) {
          const task = view.tasks.find((item) => item.id === event.taskId);
          const laterTransition = transitions.some(
            (transition) =>
              transition.task_id === event.taskId && transition.sequence > row.sequence
          );
          if (task && !laterTransition) {
            task.state = event.state;
          }
        }
      }
      // The legacy run row may remain ACTIVE. Label an aggregate of recorded task events explicitly.
      if (
        run.state === OrchestrationRunState.ACTIVE &&
        view.tasks.length > 0 &&
        view.tasks.every((task) =>
          [TaskState.COMPLETED, TaskState.FAILED, TaskState.CANCELLED].some(
            (state) => state === task.state
          )
        )
      ) {
        view.state = view.tasks.every((task) => task.state === TaskState.COMPLETED)
          ? OrchestrationRunState.COMPLETED
          : view.tasks.some((task) => task.state === TaskState.FAILED)
            ? OrchestrationRunState.FAILED
            : OrchestrationRunState.CANCELLED;
        view.stateSource = 'task-events';
      }
      for (const row of db
        .prepare('SELECT attempt_json AS payload FROM agent_execution_attempts WHERE run_id = ?')
        .all(plan.runId)) {
        const attempt = agentExecutionAttemptSchema.parse(
          JSON.parse(rowSchema.parse(row).payload, (key, value: unknown) =>
            ['startedAt', 'completedAt'].includes(key) && typeof value === 'string'
              ? new Date(value)
              : value
          )
        );
        const task = view.tasks.find((item) => item.id === attempt.taskId);
        if (task && attempt.failure) {
          task.failure = attempt.failure.detail;
        }
      }
      for (const row of db
        .prepare('SELECT workspace_json AS payload FROM task_workspaces WHERE run_id = ?')
        .all(plan.runId)) {
        const workspace = taskWorkspaceSchema.parse(JSON.parse(rowSchema.parse(row).payload));
        const task = view.tasks.find((item) => item.id === workspace.taskId);
        if (!task) {
          continue;
        }
        task.worktree = workspace.workspacePath;
        if (workspace.phase === 'INTEGRATED') {
          task.integratedCommit = workspace.integrationCommit;
        }
        const filename = join(directory, 'completion', `${workspace.id}.jsonl`);
        // Read completion evidence after the short database transaction; it is a separate observation.
        evidenceFiles.push({ task, filename });
      }
    })();
  } catch {
    view.warnings.push(
      'Recorded run data could not be decoded. Missing facts are not reported as success.'
    );
  } finally {
    db.close();
  }
  for (const { task, filename } of evidenceFiles) {
    const text = await optionalFile(filename);
    if (text === undefined) {
      continue;
    }
    for (const line of text.split('\n').filter(Boolean)) {
      try {
        const evidence = evidenceSchema.parse(JSON.parse(line));
        if (evidence.diff) {
          task.actualFiles = evidence.diff.paths;
          task.diff = evidence.diff.patch;
        }
        if (evidence.stage) {
          task.stage = evidence.stage;
        }
        if (evidence.verification) {
          task.verification = evidence.verification;
        }
        if (evidence.review) {
          task.review = evidence.review;
        }
        if (evidence.detail) {
          task.failure = evidence.detail;
        }
        if (evidence.outside?.length) {
          task.failure = `Outside planned scope: ${evidence.outside.join(', ')}`;
        }
      } catch {
        view.warnings.push(`Incomplete or invalid completion evidence for ${task.id}.`);
      }
    }
  }
  return view;
}

export async function listLocalPlans(
  store: LocalPlanStore
): Promise<{ id: string; approved: boolean; runId?: string }[]> {
  let entries: string[];
  try {
    entries = await readdir(join(store.directory, 'plans'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const plans = [];
  for (const entry of entries.filter((name) => /^[a-f0-9-]{36}\.json$/.test(name)).toSorted()) {
    try {
      const plan = await store.load(entry.slice(0, -5));
      plans.push({ id: plan.id, approved: plan.approved, runId: plan.runId });
    } catch {
      /* An unreadable plan is not offered as executable. */
    }
  }
  return plans;
}
