import type { OrchestrationPersistence } from '@ai-native-software-delivery-orchestrator/domain';
import { DeterministicScheduler } from '@ai-native-software-delivery-orchestrator/scheduler';

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
    const replayed = await this.#persistence.replayRun(runId, new DeterministicScheduler());
    const latestDecision = replayed.at(-1);
    if (latestDecision === undefined) {
      return [];
    }
    return latestDecision.decision.taskDecisions
      .filter((taskDecision) => taskDecision.action === 'start')
      .map((taskDecision) => ({
        taskId: taskDecision.taskId,
        attemptId: recoveredRun.attempts.find((attempt) => attempt.attempt.taskId === taskDecision.taskId)?.attempt.id ?? `${runId}:${taskDecision.taskId}:preparing`
      }))
      .filter((authorization) => authorization.attemptId.length > 0);
  }
}
