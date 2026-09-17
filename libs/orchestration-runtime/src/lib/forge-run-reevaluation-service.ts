import type { OrchestrationPersistence } from '@ai-native-software-delivery-orchestrator/domain';

export interface ForgeRunAuthorization {
  readonly taskId: string;
  readonly attemptId: string;
}

export class ForgeRunReevaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForgeRunReevaluationError';
  }
}

/**
 * Replays persisted dispatch authority without inventing new scheduler state.
 */
export class ForgeRunReevaluationService {
  readonly #persistence: OrchestrationPersistence;

  constructor(options: { readonly persistence: OrchestrationPersistence }) {
    this.#persistence = options.persistence;
  }

  async recoverAuthorizations(runId: string): Promise<readonly ForgeRunAuthorization[]> {
    const recoveredRun = await this.#persistence.recoverRun(runId);
    if (recoveredRun === undefined) {
      throw new ForgeRunReevaluationError(`Missing durable reevaluation authority: ${runId}`);
    }
    const dispatches = await this.#persistence.recoverDispatches(runId);
    const latestDispatch = dispatches.at(-1);
    if (latestDispatch === undefined) {
      return [];
    }
    return latestDispatch.attempts.map(({ attempt }) => ({
      taskId: attempt.taskId,
      attemptId: attempt.id
    }));
  }
}
