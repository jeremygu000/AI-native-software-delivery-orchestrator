import type {
  OrchestrationPersistence,
  PersistedTaskExecutionBinding,
  TaskCodeReviewStore
} from '@ai-native-software-delivery-orchestrator/domain';
import {
  type StartRuntimeRunRequest,
  ForgeRunProgressionService
} from '@ai-native-software-delivery-orchestrator/orchestration-runtime';
import { fingerprintPlanValue } from '@ai-native-software-delivery-orchestrator/planning';

export interface TemporalWorkflowStarter {
  start(runId: string): Promise<{ readonly workflowId: string; readonly workflowRunId: string }>;
}

export interface TemporalRunLaunchResult {
  readonly runId: string;
  readonly workflowId: string;
  readonly workflowRunId: string;
}

type TemporalLaunchPersistence = OrchestrationPersistence & TaskCodeReviewStore;

const bindings = (request: StartRuntimeRunRequest): readonly PersistedTaskExecutionBinding[] =>
  request.taskBindings.map((binding) => ({
    runId: request.run.id,
    taskId: binding.taskId,
    agentId: binding.agentId,
    leasePlan: binding.leasePlan,
    impact: binding.impact,
    commandPolicy: binding.commandPolicy,
    trustedCommandPath: binding.trustedCommandPath,
    workspace: binding.workspace
  }));

const requestFingerprint = (request: StartRuntimeRunRequest): string =>
  fingerprintPlanValue({
    run: request.run,
    tasks: request.tasks,
    taskBindings: bindings(request),
    hardConflicts: request.hardConflicts,
    riskConflicts: request.riskConflicts,
    scheduleOptions: request.scheduleOptions
  });

const initialAttemptId = (runId: string, ordinal: number): string => `launch:${runId}:${ordinal}`;

const hasInitialRunStarted = (recovered: {
  readonly events: readonly {
    readonly sequence: number;
    readonly event: { readonly type: string };
  }[];
  readonly decisions: readonly unknown[];
}): boolean => {
  const initialEvent = recovered.events.find((event) => event.sequence === 1);
  if (initialEvent === undefined) {
    if (recovered.events.length === 0 && recovered.decisions.length === 0) {
      return false;
    }
    throw new Error('Temporal launch authority history is missing sequence-one run-started');
  }
  if (initialEvent.event.type !== 'run-started') {
    throw new Error('Temporal launch authority history must begin with run-started');
  }
  return true;
};

/**
 * Initializes Forge authority before asking Temporal to coordinate a run. The
 * workflow receives only the durable run ID; SQLite remains the authority.
 */
export class TemporalRunLauncher {
  readonly #persistence: TemporalLaunchPersistence;
  readonly #workflow: TemporalWorkflowStarter;

  constructor(options: {
    readonly persistence: TemporalLaunchPersistence;
    readonly workflow: TemporalWorkflowStarter;
  }) {
    this.#persistence = options.persistence;
    this.#workflow = options.workflow;
  }

  async startOrResumeRun(request: StartRuntimeRunRequest): Promise<TemporalRunLaunchResult> {
    let existing = await this.#persistence.recoverRun(request.run.id);
    if (existing === undefined) {
      try {
        await this.#persistence.createRun({
          run: request.run,
          tasks: request.tasks,
          taskBindings: bindings(request),
          hardConflicts: request.hardConflicts,
          riskConflicts: request.riskConflicts,
          scheduleOptions: request.scheduleOptions
        });
      } catch (error) {
        existing = await this.#persistence.recoverRun(request.run.id);
        if (existing === undefined) {
          throw error;
        }
      }
    }
    const recovered = existing ?? (await this.#persistence.recoverRun(request.run.id));
    if (recovered === undefined) {
      throw new Error(`Temporal launch authority is unavailable: ${request.run.id}`);
    }
    if (existing !== undefined) {
      const persistedBindings = await this.#persistence.recoverTaskBindings(request.run.id);
      const persistedFingerprint = fingerprintPlanValue({
        run: recovered.run,
        tasks: recovered.tasks,
        taskBindings: persistedBindings,
        hardConflicts: recovered.hardConflicts,
        riskConflicts: recovered.riskConflicts,
        scheduleOptions: recovered.scheduleOptions
      });
      if (persistedFingerprint !== requestFingerprint(request)) {
        throw new Error(`Temporal launch authority mismatch: ${request.run.id}`);
      }
    }
    if (!hasInitialRunStarted(recovered)) {
      // Concurrent sequence-one writes have deterministic authority evidence.
      await new ForgeRunProgressionService({
        persistence: this.#persistence,
        now: () => new Date(request.run.createdAt),
        createAttemptId: (() => {
          let ordinal = 0;
          return () => initialAttemptId(request.run.id, ++ordinal);
        })()
      }).advance(request.run.id, { type: 'run-started' });
    }
    const workflow = await this.#workflow.start(request.run.id);
    return { runId: request.run.id, ...workflow };
  }
}
