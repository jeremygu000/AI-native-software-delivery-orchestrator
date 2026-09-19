import type {
  OrchestrationPersistence,
  OrchestrationRunState
} from '@ai-native-software-delivery-orchestrator/domain';

export class ForgeRunFinalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForgeRunFinalizationError';
  }
}

/**
 * Finalizes a run using persisted runtime state, matching the orchestration runtime's
 * fail-closed terminal semantics.
 */
export class ForgeRunFinalizationService {
  readonly #persistence: OrchestrationPersistence;

  constructor(options: { readonly persistence: OrchestrationPersistence }) {
    this.#persistence = options.persistence;
  }

  async finalize(runId: string): Promise<'completed' | 'failed'> {
    const recovered = await this.#persistence.recoverRun(runId);
    if (recovered === undefined) {
      throw new ForgeRunFinalizationError(`Missing durable finalization authority: ${runId}`);
    }
    const authoritativeTaskStates = recovered.tasks.map((task) => {
      const attempt = [...recovered.attempts].reverse().find((entry) => entry.attempt.taskId === task.id)?.attempt;
      return attempt?.state ?? 'PENDING';
    });
    const hasFailedTask = authoritativeTaskStates.some((taskState) => taskState === 'FAILED');
    const isCompletedRun = authoritativeTaskStates.every((taskState) => taskState === 'COMPLETED' || taskState === 'CANCELLED');
    if (!hasFailedTask && !isCompletedRun) {
      throw new ForgeRunFinalizationError(`Run is not terminal: ${runId}`);
    }
    const state: OrchestrationRunState = hasFailedTask ? 'FAILED' : 'COMPLETED';
    await this.#persistence.updateRunState(runId, state);
    return state === 'COMPLETED' ? 'completed' : 'failed';
  }
}
