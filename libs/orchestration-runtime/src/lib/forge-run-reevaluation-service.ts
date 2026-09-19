import {
  ForgeRunProgressionService,
  type ForgeRunAuthorization
} from './forge-run-progression-service.js';

export type { ForgeRunAuthorization };

export class ForgeRunReevaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForgeRunReevaluationError';
  }
}

export class ForgeRunReevaluationService {
  readonly #progression: ForgeRunProgressionService;

  constructor(options: { readonly progression: ForgeRunProgressionService }) {
    this.#progression = options.progression;
  }

  async recoverAuthorizations(runId: string): Promise<readonly ForgeRunAuthorization[]> {
    try {
      return await this.#progression.reevaluate(runId);
    } catch (error) {
      if (error instanceof Error && error.name === 'ForgeRunProgressionError') {
        throw new ForgeRunReevaluationError(error.message);
      }
      throw error;
    }
  }
}
