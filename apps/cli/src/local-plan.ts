import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute, sep, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  predictedTaskImpactSchema,
  scheduleOptionsSchema,
  taskConflictSchema,
  taskSpecificationSchema
} from '@ai-native-software-delivery-orchestrator/domain';
import type { PreparedOrchestrationPlan } from '@ai-native-software-delivery-orchestrator/planning';
import { z } from 'zod';

const git = promisify(execFile);

export const localPlanSchema = z
  .object({
    id: z.uuid(),
    repository: z.string().min(1),
    repositoryCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
    tasks: taskSpecificationSchema.shape.tasks,
    impacts: z.array(predictedTaskImpactSchema),
    conflicts: z.array(taskConflictSchema),
    schedule: scheduleOptionsSchema,
    approved: z.boolean(),
    runId: z.uuid().optional()
  })
  .superRefine((plan, context) => {
    const specification = taskSpecificationSchema.safeParse({ tasks: plan.tasks });
    if (!specification.success) {
      context.addIssue({ code: 'custom', message: 'Plan tasks are invalid or duplicated' });
    }
    const ids = plan.tasks.map((task) => task.id);
    if (
      plan.impacts.length !== ids.length ||
      new Set(plan.impacts.map((impact) => impact.taskId)).size !== ids.length ||
      plan.impacts.some((impact) => !ids.includes(impact.taskId))
    ) {
      context.addIssue({ code: 'custom', message: 'Plan impacts must match its tasks' });
    }
  });

export type LocalPlan = z.infer<typeof localPlanSchema>;

const encode = (value: unknown): string =>
  JSON.stringify(
    value,
    (_key, item: unknown) => (item instanceof Set ? { $set: [...item] } : item),
    2
  );

const decode = (value: string): unknown =>
  JSON.parse(value, (_key, item: unknown) => {
    if (typeof item === 'object' && item !== null && '$set' in item && Array.isArray(item.$set)) {
      return new Set(item.$set);
    }
    return item;
  });

export async function inspectLocalRepository(
  path: string
): Promise<{ repository: string; repositoryCommit: string }> {
  const repository = await realpath(path);
  const top = await git('git', ['rev-parse', '--show-toplevel'], { cwd: repository });
  if ((await realpath(top.stdout.trim())) !== repository) {
    throw new Error('Use the repository root, not a subdirectory.');
  }
  const status = await git('git', ['status', '--porcelain'], { cwd: repository });
  if (status.stdout.length !== 0) {
    throw new Error(
      'Repository has uncommitted changes; commit or discard them before planning/running.'
    );
  }
  const head = await git('git', ['rev-parse', 'HEAD'], { cwd: repository });
  return { repository, repositoryCommit: head.stdout.trim() };
}

export class LocalPlanStore {
  constructor(readonly directory: string) {}

  #path(id: string): string {
    return join(this.directory, 'plans', `${z.uuid().parse(id)}.json`);
  }

  async save(
    repositoryPath: string,
    prepared: PreparedOrchestrationPlan,
    plannedCommit?: string
  ): Promise<LocalPlan> {
    const repository = await inspectLocalRepository(repositoryPath);
    if (plannedCommit !== undefined && repository.repositoryCommit !== plannedCommit) {
      throw new Error('Repository changed during planning. Create a new plan.');
    }
    const proposed = relative(repository.repository, resolve(this.directory));
    if (
      proposed === '' ||
      (proposed !== '..' && !proposed.startsWith(`..${sep}`) && !isAbsolute(proposed))
    ) {
      throw new Error('Keep Forge state outside the target repository.');
    }
    await mkdir(this.directory, { recursive: true });
    const statePath = await realpath(this.directory);
    const inside = relative(repository.repository, statePath);
    if (
      inside === '' ||
      (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))
    ) {
      throw new Error('Keep Forge state outside the target repository.');
    }
    const plan = localPlanSchema.parse({
      id: randomUUID(),
      ...repository,
      tasks: prepared.specification.tasks,
      impacts: prepared.impacts,
      conflicts: [...prepared.hardConflicts, ...prepared.riskConflicts],
      schedule: prepared.schedule,
      approved: false
    });
    await mkdir(join(this.directory, 'plans'), { recursive: true });
    await writeFile(this.#path(plan.id), encode(plan), { flag: 'wx' });
    return plan;
  }

  async load(id: string): Promise<LocalPlan> {
    const plan = localPlanSchema.parse(decode(await readFile(this.#path(id), 'utf8')));
    if (plan.id !== id) {
      throw new Error('Saved plan ID does not match its filename.');
    }
    return plan;
  }

  async approve(id: string): Promise<LocalPlan> {
    const plan = await this.load(id);
    if (plan.runId !== undefined) {
      throw new Error('This plan has already been run. Create a new plan to run again.');
    }
    const approved = { ...plan, approved: true };
    await writeFile(this.#path(id), encode(approved));
    return approved;
  }

  async beginRun(id: string): Promise<LocalPlan & { runId: string }> {
    const plan = await this.load(id);
    if (!plan.approved) {
      throw new Error('Plan is not approved. Inspect it and use forge approve <plan-id> --yes.');
    }
    if (plan.runId !== undefined) {
      throw new Error('This plan has already been run; resume/retry is not implemented in P1.2.');
    }
    const current = await inspectLocalRepository(plan.repository);
    if (current.repositoryCommit !== plan.repositoryCommit) {
      throw new Error('Repository changed since planning. Create and approve a new plan.');
    }
    const started = { ...plan, runId: randomUUID() };
    await writeFile(this.#path(id), encode(started));
    return started;
  }
}
