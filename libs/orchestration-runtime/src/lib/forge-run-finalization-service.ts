import { ForgeRunProgressionService } from './forge-run-progression-service.js';

export class ForgeRunFinalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForgeRunFinalizationError';
  }
}

/**
 * Finalizes a run from the authoritative scheduler progression snapshot.
 */
export class ForgeRunFinalizationService {
  readonly #progression: ForgeRunProgressionService;

  constructor(options: { readonly progression: ForgeRunProgressionService }) {
    this.#progression = options.progression;
  }

  async finalize(runId: string): Promise<'completed' | 'failed'> {
    try {
      return await this.#progression.finalize(runId);
    } catch (error) {
      if (error instanceof Error && error.name === 'ForgeRunProgressionError') {
        throw new ForgeRunFinalizationError(error.message);
      }
      throw error;
    }
  }
}
