import type {
  ConflictAnalyzer,
  ExecutionPlan,
  HardTaskConflict,
  PredictedTaskImpact,
  RepositoryGraph,
  RiskTaskConflict,
  ScheduleOptions,
  Scheduler,
  TaskContract,
  TaskImpactAnalyzer,
  TaskSpecification
} from '@ai-native-software-delivery-orchestrator/domain';
import {
  SchedulerInputError,
  scheduleOptionsSchema,
  taskSpecificationSchema
} from '@ai-native-software-delivery-orchestrator/domain';
import {
  type TaskGraphIssue,
  validateTaskGraph
} from '@ai-native-software-delivery-orchestrator/dag';
import { TaskImpactAnalysisError } from '@ai-native-software-delivery-orchestrator/task-impact';
import { z } from 'zod';

export const planningSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user-request'), content: z.string().trim().min(1) }),
  z.object({
    type: z.literal('markdown-spec'),
    content: z.string().trim().min(1),
    path: z.string().trim().min(1).optional()
  })
]);

export const autonomousPlanOptionsSchema = z.object({
  maxAttempts: z.int().positive().default(3),
  schedule: scheduleOptionsSchema
});

export type PlanningSource = z.infer<typeof planningSourceSchema>;
export type AutonomousPlanOptions = z.input<typeof autonomousPlanOptionsSchema>;

export type PlanningDiagnostic =
  | {
      readonly code: 'INVALID_PLANNER_OUTPUT';
      readonly detail: string;
    }
  | {
      readonly code: 'INVALID_TASK_CONTRACT';
      readonly detail: string;
      readonly path: readonly (string | number)[];
    }
  | {
      readonly code: 'INVALID_TASK_GRAPH';
      readonly detail: string;
      readonly issue: TaskGraphIssue;
    }
  | {
      readonly code: 'UNRESOLVED_SELECTOR';
      readonly detail: string;
      readonly taskId: string;
    }
  | {
      readonly code: 'UNKNOWN_SHARED_RESOURCE';
      readonly detail: string;
      readonly taskId: string;
      readonly resourceIds: readonly string[];
    }
  | {
      readonly code: 'INVALID_VERIFICATION';
      readonly detail: string;
      readonly taskId: string;
    }
  | {
      readonly code: 'UNSCHEDULABLE_PLAN';
      readonly detail: string;
    };

export interface PlannerProposalRequest {
  readonly attempt: number;
  readonly source: PlanningSource;
  readonly repository: RepositoryGraph;
  readonly sharedResourceIds: readonly string[];
  readonly previousDiagnostics: readonly PlanningDiagnostic[];
}

export interface PlannerAgent {
  propose(request: PlannerProposalRequest): Promise<unknown>;
}

export interface AutonomousPlanRequest {
  readonly source: PlanningSource;
  readonly repository: RepositoryGraph;
  readonly sharedResourceIds?: readonly string[];
  readonly options: AutonomousPlanOptions;
}

/**
 * A deterministically analyzed and schedulable proposal that is not yet runnable.
 *
 * Runtime binding must still assign run and agent identities, workspaces, lease plans, command
 * policy, and other execution metadata before this proposal can become a runtime start request.
 */
export interface PreparedOrchestrationPlan {
  readonly attempts: number;
  readonly specification: TaskSpecification;
  readonly impacts: readonly PredictedTaskImpact[];
  readonly hardConflicts: readonly HardTaskConflict[];
  readonly riskConflicts: readonly RiskTaskConflict[];
  readonly executionPlan: ExecutionPlan;
  readonly schedule: ScheduleOptions;
}

export class AutonomousPlanningError extends Error {
  readonly attempts: number;
  readonly diagnostics: readonly PlanningDiagnostic[];

  constructor(attempts: number, diagnostics: readonly PlanningDiagnostic[]) {
    super(`Planner did not produce a runnable task specification after ${attempts} attempt(s)`);
    this.name = 'AutonomousPlanningError';
    this.attempts = attempts;
    this.diagnostics = diagnostics;
  }
}

interface AutonomousPlanPhaseDependencies {
  readonly planner: PlannerAgent;
  readonly impactAnalyzer: TaskImpactAnalyzer;
  readonly conflictAnalyzer: ConflictAnalyzer;
  readonly scheduler: Scheduler;
}

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const stripJsonFence = (value: string): string => {
  const trimmed = value.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match?.[1] ?? trimmed;
};

const parsePlannerOutput = (
  proposal: unknown
): {
  readonly specification?: TaskSpecification;
  readonly diagnostics: readonly PlanningDiagnostic[];
} => {
  let candidate = proposal;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(stripJsonFence(candidate));
    } catch {
      return {
        diagnostics: [
          {
            code: 'INVALID_PLANNER_OUTPUT',
            detail: 'Planner output must be one JSON object containing a tasks array.'
          }
        ]
      };
    }
  }

  const parsed = taskSpecificationSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      diagnostics: parsed.error.issues.map((issue) => ({
        code: 'INVALID_TASK_CONTRACT' as const,
        detail: issue.message,
        path: issue.path.map((part) => String(part))
      }))
    };
  }
  return { specification: parsed.data, diagnostics: [] };
};

const graphDiagnostics = (tasks: readonly TaskContract[]): readonly PlanningDiagnostic[] =>
  validateTaskGraph(tasks).issues.map((issue) => ({
    code: 'INVALID_TASK_GRAPH' as const,
    detail: `Invalid task graph: ${JSON.stringify(issue)}`,
    issue
  }));

const verificationDiagnostics = (
  tasks: readonly TaskContract[],
  repository: RepositoryGraph
): readonly PlanningDiagnostic[] => {
  const diagnostics: PlanningDiagnostic[] = [];
  for (const task of [...tasks].toSorted((left, right) => compareStrings(left.id, right.id))) {
    if (!task.verification.some((verification) => verification.type === 'package-script')) {
      diagnostics.push({
        code: 'INVALID_VERIFICATION',
        detail: 'Autonomous tasks must define at least one package-script verification rule.',
        taskId: task.id
      });
    }
    for (const verification of task.verification) {
      if (verification.type === 'command') {
        diagnostics.push({
          code: 'INVALID_VERIFICATION',
          detail:
            'Autonomous planning cannot use free-form command verification; use a repository package script.',
          taskId: task.id
        });
        continue;
      }
      const projects = [...repository.projects.values()].filter(
        (project) =>
          project.id === verification.packageName || project.name === verification.packageName
      );
      if (projects.length !== 1) {
        diagnostics.push({
          code: 'INVALID_VERIFICATION',
          detail: `Package ${verification.packageName} matched ${projects.length} repository projects.`,
          taskId: task.id
        });
        continue;
      }
      if (projects[0].scripts[verification.script] === undefined) {
        diagnostics.push({
          code: 'INVALID_VERIFICATION',
          detail: `Package ${verification.packageName} does not define script ${verification.script}.`,
          taskId: task.id
        });
      }
    }
  }
  return diagnostics;
};

export class AutonomousPlanPhase {
  readonly #planner: PlannerAgent;
  readonly #impactAnalyzer: TaskImpactAnalyzer;
  readonly #conflictAnalyzer: ConflictAnalyzer;
  readonly #scheduler: Scheduler;

  constructor(dependencies: AutonomousPlanPhaseDependencies) {
    this.#planner = dependencies.planner;
    this.#impactAnalyzer = dependencies.impactAnalyzer;
    this.#conflictAnalyzer = dependencies.conflictAnalyzer;
    this.#scheduler = dependencies.scheduler;
  }

  async create(request: AutonomousPlanRequest): Promise<PreparedOrchestrationPlan> {
    const source = planningSourceSchema.parse(request.source);
    const options = autonomousPlanOptionsSchema.parse(request.options);
    const sharedResourceIds = [...new Set(request.sharedResourceIds ?? [])].toSorted(
      compareStrings
    );
    let previousDiagnostics: readonly PlanningDiagnostic[] = [];

    for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
      const proposal = await this.#planner.propose({
        attempt,
        source,
        repository: request.repository,
        sharedResourceIds,
        previousDiagnostics
      });
      const parsed = parsePlannerOutput(proposal);
      if (parsed.specification === undefined) {
        previousDiagnostics = parsed.diagnostics;
        continue;
      }

      const taskGraphDiagnostics = graphDiagnostics(parsed.specification.tasks);
      if (taskGraphDiagnostics.length > 0) {
        previousDiagnostics = taskGraphDiagnostics;
        continue;
      }

      const taskVerificationDiagnostics = verificationDiagnostics(
        parsed.specification.tasks,
        request.repository
      );
      if (taskVerificationDiagnostics.length > 0) {
        previousDiagnostics = taskVerificationDiagnostics;
        continue;
      }

      const analyzed = await this.#analyze(parsed.specification.tasks, request.repository);
      if (analyzed.diagnostics.length > 0) {
        previousDiagnostics = analyzed.diagnostics;
        continue;
      }

      const conflicts = this.#compare(analyzed.impacts, request.repository);
      try {
        const executionPlan = this.#scheduler.createInitialPlan(
          parsed.specification.tasks,
          conflicts.hard,
          conflicts.risk,
          options.schedule
        );
        return {
          attempts: attempt,
          specification: parsed.specification,
          impacts: analyzed.impacts,
          hardConflicts: conflicts.hard,
          riskConflicts: conflicts.risk,
          executionPlan,
          schedule: options.schedule
        };
      } catch (error) {
        if (!(error instanceof SchedulerInputError)) {
          throw error;
        }
        previousDiagnostics = [
          {
            code: 'UNSCHEDULABLE_PLAN',
            detail: error.message
          }
        ];
      }
    }

    throw new AutonomousPlanningError(options.maxAttempts, previousDiagnostics);
  }

  async #analyze(
    tasks: readonly TaskContract[],
    repository: RepositoryGraph
  ): Promise<{
    readonly impacts: readonly PredictedTaskImpact[];
    readonly diagnostics: readonly PlanningDiagnostic[];
  }> {
    const impacts: PredictedTaskImpact[] = [];
    const diagnostics: PlanningDiagnostic[] = [];
    for (const task of [...tasks].toSorted((left, right) => compareStrings(left.id, right.id))) {
      try {
        const impact = await this.#impactAnalyzer.analyze(task, repository);
        impacts.push(impact);
        for (const signal of impact.riskSignals) {
          if (signal.type === 'ambiguous-selector') {
            diagnostics.push({
              code: 'UNRESOLVED_SELECTOR',
              detail: signal.detail,
              taskId: task.id
            });
          }
        }
      } catch (error) {
        if (error instanceof TaskImpactAnalysisError) {
          diagnostics.push({
            code: 'UNKNOWN_SHARED_RESOURCE',
            detail: error.message,
            taskId: task.id,
            resourceIds: error.resourceIds
          });
          continue;
        }
        throw error;
      }
    }
    return {
      impacts,
      diagnostics: diagnostics.toSorted(
        (left, right) =>
          compareStrings(
            'taskId' in left ? left.taskId : '',
            'taskId' in right ? right.taskId : ''
          ) ||
          compareStrings(left.code, right.code) ||
          compareStrings(left.detail, right.detail)
      )
    };
  }

  #compare(
    impacts: readonly PredictedTaskImpact[],
    repository: RepositoryGraph
  ): { readonly hard: readonly HardTaskConflict[]; readonly risk: readonly RiskTaskConflict[] } {
    const hard: HardTaskConflict[] = [];
    const risk: RiskTaskConflict[] = [];
    for (let firstIndex = 0; firstIndex < impacts.length; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < impacts.length; secondIndex += 1) {
        const conflict = this.#conflictAnalyzer.compare(
          impacts[firstIndex],
          impacts[secondIndex],
          repository
        );
        if (conflict.severity === 'hard') {
          hard.push(conflict);
        } else {
          risk.push(conflict);
        }
      }
    }
    return { hard, risk };
  }
}
