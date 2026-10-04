import type { InteractiveTerminal } from '../interactive-terminal.js';
import { ModelSelectionCancelled } from '../model-selection.js';
import type { CodingPresentationEvent, CodingStage } from '../interactive-presentation.js';

export type TuiRequest = {
  id: number;
  kind: 'choice' | 'input' | 'task';
  title: string;
  options: readonly string[];
  initial: string;
};
export interface TuiState {
  readonly request?: TuiRequest;
  readonly events: readonly CodingPresentationEvent[];
  readonly notices: readonly string[];
  readonly error?: string;
  readonly finished: boolean;
}

/** UI adapter for the accepted interactive operations; no application calls live here. */
export class CodingTuiController {
  #state: TuiState = { events: [], notices: [], finished: false };
  #listeners = new Set<() => void>();
  #sequence = 0;
  #pending?: {
    resolve: (value: string | number) => void;
    reject: (error: Error) => void;
    cleanup: () => void;
  };
  readonly terminal: InteractiveTerminal = {
    isInteractive: true,
    choose: async (title, options) => Number(await this.#ask('choice', title, options)),
    prompt: async (title, initial, signal) =>
      String(await this.#ask('input', title, [], initial, signal)),
    multiline: async (title, signal) => String(await this.#ask('task', title, [], '', signal)),
    write: (message) =>
      this.#update({ notices: [...this.#state.notices.slice(-19), message.trim()] })
  };
  readonly snapshot = () => this.#state;
  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  readonly present = (event: CodingPresentationEvent) => {
    const events =
      event.type === 'stage'
        ? this.#state.events.filter(
            (previous) => previous.type !== 'stage' || previous.stage !== event.stage
          )
        : this.#state.events.filter((previous) => previous.type !== event.type);
    this.#update({ events: [...events, event] });
  };
  submit(value: string | number): void {
    const request = this.#state.request;
    if (request === undefined || this.#pending === undefined) {
      return;
    }
    if (
      request.kind === 'choice' &&
      (typeof value !== 'number' ||
        !Number.isInteger(value) ||
        request.options[value] === undefined)
    ) {
      return;
    }
    if (request.kind !== 'choice' && typeof value !== 'string') {
      return;
    }
    const pending = this.#pending;
    this.#pending = undefined;
    pending.cleanup();
    this.#update({ request: undefined });
    pending.resolve(value);
  }
  cancel(): void {
    const pending = this.#pending;
    this.#pending = undefined;
    pending?.cleanup();
    this.#update({ request: undefined });
    pending?.reject(new ModelSelectionCancelled('Interactive coding cancelled.'));
    process.emit('SIGINT');
  }
  finish(error?: string): void {
    this.#update({ finished: true, error });
  }
  #update(change: Partial<TuiState>): void {
    this.#state = { ...this.#state, ...change };
    for (const listener of this.#listeners) {
      listener();
    }
  }
  #ask(
    kind: TuiRequest['kind'],
    title: string,
    options: readonly string[],
    initial = '',
    signal?: AbortSignal
  ): Promise<string | number> {
    return new Promise((resolve, reject) => {
      const abort = () => {
        const pending = this.#pending;
        this.#pending = undefined;
        pending?.cleanup();
        this.#update({ request: undefined });
        reject(new ModelSelectionCancelled('Interactive coding cancelled.'));
      };
      this.#pending = {
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener('abort', abort)
      };
      this.#update({ request: { id: ++this.#sequence, kind, title, options, initial } });
      if (signal?.aborted) {
        abort();
      } else {
        signal?.addEventListener('abort', abort, { once: true });
      }
    });
  }
}

export const stageLabels: Record<CodingStage, string> = {
  repository: 'Validating repository',
  analysis: 'Analysing repository',
  planning: 'Creating model plan',
  'semantic-review': 'Independent semantic review',
  readiness: 'Worker deployment and task queue',
  approval: 'Exact plan approval',
  binding: 'Repository authority binding',
  metadata: 'Preparing run metadata',
  workspace: 'Preparing isolated workspace',
  authority: 'Establishing execution authority',
  launch: 'Starting Temporal workflow'
};
