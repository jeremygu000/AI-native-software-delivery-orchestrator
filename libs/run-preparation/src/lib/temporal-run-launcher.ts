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

type TemporalLaunchPersistence = OrchestrationPersistence &
  TaskCodeReviewStore & {
    ensureInitialDispatch: NonNullable<OrchestrationPersistence['ensureInitialDispatch']>;
    requiresGlobalRunBinding?(): boolean;
    createBoundRun?(request: Parameters<OrchestrationPersistence['createRun']>[0]): Promise<void>;
    createGlobalBoundRun?(
      request: Parameters<OrchestrationPersistence['createRun']>[0]
    ): Promise<void>;
    assertGlobalRunBinding?(
      runId: string,
      repositoryId: string,
      mode?: 'legacy' | 'global'
    ): Promise<void>;
  };

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
  launchFingerprint({
    run: request.run,
    tasks: request.tasks.toSorted((left, right) => left.id.localeCompare(right.id)),
    taskBindings: bindings(request).toSorted((left, right) =>
      left.taskId.localeCompare(right.taskId)
    ),
    hardConflicts: request.hardConflicts,
    riskConflicts: request.riskConflicts,
    scheduleOptions: request.scheduleOptions
  });

const launchFingerprint = (value: unknown): string =>
  fingerprintPlanValue(
    JSON.parse(
      JSON.stringify(value, (_key, item: unknown) =>
        item instanceof Set
          ? [...item].toSorted((left, right) => String(left).localeCompare(String(right)))
          : item
      )
    )
  );

const initialAttemptId = (runId: string, ordinal: number): string => `launch:${runId}:${ordinal}`;

/**
 * Initializes Forge authority before asking Temporal to coordinate a run. The
 * workflow receives only the durable run ID; the configured persistence remains the authority.
 */
export class TemporalRunLauncher {
  readonly #persistence: TemporalLaunchPersistence;
  readonly #workflow: TemporalWorkflowStarter;
  readonly #mode: 'legacy' | 'global';

  constructor(options: {
    readonly persistence: TemporalLaunchPersistence;
    readonly workflow: TemporalWorkflowStarter;
    readonly mode?: 'legacy' | 'global';
  }) {
    this.#persistence = options.persistence;
    this.#workflow = options.workflow;
    this.#mode = options.mode ?? 'legacy';
  }

  async startOrResumeRun(request: StartRuntimeRunRequest): Promise<TemporalRunLaunchResult> {
    await this.prepareRun(request);
    const workflow = await this.#workflow.start(request.run.id);
    return { runId: request.run.id, ...workflow };
  }

  /** Persist approved initial dispatch only; privileged setup/handoff occurs before workflow launch. */
  async prepareRun(
    request: StartRuntimeRunRequest
  ): Promise<{ readonly runId: string; readonly status: 'prepared' }> {
    const requiresBinding = this.#persistence.requiresGlobalRunBinding?.() === true;
    if (
      requiresBinding &&
      (this.#persistence.createBoundRun === undefined ||
        this.#persistence.assertGlobalRunBinding === undefined)
    ) {
      throw new Error('Global run launch requires atomic run/scope binding');
    }
    let existing = await this.#persistence.recoverRun(request.run.id);
    if (existing === undefined) {
      try {
        const creation = {
          run: request.run,
          tasks: request.tasks,
          taskBindings: bindings(request),
          hardConflicts: request.hardConflicts,
          riskConflicts: request.riskConflicts,
          scheduleOptions: request.scheduleOptions
        };
        if (!requiresBinding) {
          await this.#persistence.createRun(creation);
        } else if (
          this.#mode === 'global' &&
          this.#persistence.createGlobalBoundRun !== undefined
        ) {
          await this.#persistence.createGlobalBoundRun(creation);
        } else if (this.#mode === 'legacy' && this.#persistence.createBoundRun !== undefined) {
          await this.#persistence.createBoundRun(creation);
        } else {
          throw new Error('Global run launch requires atomic run/scope binding');
        }
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
      const persistedFingerprint = launchFingerprint({
        run: recovered.run,
        tasks: recovered.tasks.toSorted((left, right) => left.id.localeCompare(right.id)),
        taskBindings: persistedBindings.toSorted((left, right) =>
          left.taskId.localeCompare(right.taskId)
        ),
        hardConflicts: recovered.hardConflicts,
        riskConflicts: recovered.riskConflicts,
        scheduleOptions: recovered.scheduleOptions
      });
      if (persistedFingerprint !== requestFingerprint(request)) {
        throw new Error(`Temporal launch authority mismatch: ${request.run.id}`);
      }
    }
    if (requiresBinding) {
      if (this.#persistence.assertGlobalRunBinding === undefined) {
        throw new Error('Global run launch requires atomic run/scope binding');
      }
      await this.#persistence.assertGlobalRunBinding(
        request.run.id,
        request.run.repositoryId,
        this.#mode
      );
    }
    // This fresh authority check also rejects malformed initial evidence.
    await new ForgeRunProgressionService({
      persistence: this.#persistence,
      now: () => new Date(request.run.createdAt),
      createAttemptId: (() => {
        let ordinal = 0;
        return () => initialAttemptId(request.run.id, ++ordinal);
      })()
    }).ensureInitialRunStarted(request.run.id);
    return { runId: request.run.id, status: 'prepared' };
  }
}
