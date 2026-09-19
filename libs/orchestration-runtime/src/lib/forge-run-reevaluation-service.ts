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
    const currentTaskDecisions = latestDispatch.reevaluation.decision.decision.taskDecisions.filter((taskDecision) => taskDecision.action === 'start');
    if (currentTaskDecisions.length === 0) {
      return [];
    }
    return currentTaskDecisions.flatMap((taskDecision) => {
      const attempt = [...recoveredRun.attempts].reverse().find((entry) => entry.attempt.taskId === taskDecision.taskId)?.attempt;
      if (attempt === undefined || attempt.state !== 'PREPARING') {
        throw new ForgeRunReevaluationError(`Missing durable PREPARING attempt authority: ${runId}/${taskDecision.taskId}`);
      }
      return [{ taskId: taskDecision.taskId, attemptId: attempt.id }];
    });
  }
}
