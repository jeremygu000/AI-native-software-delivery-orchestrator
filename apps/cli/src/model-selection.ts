import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import {
  forgeModelProfiles,
  inspectForgeModelAuthentication,
  loginModelSubscription,
  resolveForgeModelSelection,
  type ForgeModelSelection
} from '@ai-native-software-delivery-orchestrator/agent-runtime';

export class ModelSelectionError extends Error {}

export class ModelSelectionCancelled extends ModelSelectionError {
  constructor() {
    super('Model selection cancelled.');
  }
}

export interface ModelSelectionTerminal {
  readonly isInteractive: boolean;
  choose(this: void, message: string, options: readonly string[]): Promise<number>;
  write(this: void, message: string): void;
}

type TerminalInput = Readable & {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
};
type TerminalOutput = Writable & { readonly isTTY?: boolean };

export const createModelSelectionTerminal = (
  input: TerminalInput = process.stdin,
  output: TerminalOutput = process.stderr
): ModelSelectionTerminal => ({
  isInteractive: input.isTTY === true && output.isTTY === true,
  write: (message) => {
    output.write(message);
  },
  choose: async (message, options) => {
    if (input.isTTY !== true || output.isTTY !== true || input.setRawMode === undefined) {
      throw new ModelSelectionError('Model selection requires an interactive terminal.');
    }
    const wasRaw = input.isRaw === true;
    const wasFlowing = input.readableFlowing === true;
    emitKeypressEvents(input);
    return new Promise<number>((resolve, reject) => {
      let selected = 0;
      let rendered = false;
      const render = () => {
        if (rendered) {
          output.write(`\u001b[${options.length + 1}A\u001b[J`);
        }
        output.write(
          `${message}\n${options.map((option, index) => `${index === selected ? '❯' : ' '} ${option}`).join('\n')}\n`
        );
        rendered = true;
      };
      const finish = (value?: number) => {
        input.removeListener('keypress', onKey);
        input.removeListener('end', onEnd);
        input.removeListener('close', onEnd);
        process.removeListener('SIGINT', onEnd);
        input.setRawMode?.(wasRaw);
        if (!wasFlowing) {
          input.pause();
        }
        output.write('\u001b[?25h');
        if (value === undefined) {
          reject(new ModelSelectionCancelled());
        } else {
          resolve(value);
        }
      };
      const onEnd = () => finish();
      const onKey = (_text: string, key: { name?: string; ctrl?: boolean }) => {
        if ((key.ctrl === true && key.name === 'c') || key.name === 'escape') {
          finish();
        } else if (key.name === 'return') {
          finish(selected);
        } else if (key.name === 'up' || key.name === 'down') {
          selected = (selected + (key.name === 'up' ? -1 : 1) + options.length) % options.length;
          render();
        }
      };
      input.on('keypress', onKey);
      input.once('end', onEnd);
      input.once('close', onEnd);
      process.once('SIGINT', onEnd);
      input.setRawMode?.(true);
      input.resume();
      output.write('\u001b[?25l');
      render();
    });
  }
});

export const listForgeModels = async (environment: NodeJS.ProcessEnv): Promise<string> => {
  const rows = await Promise.all(
    forgeModelProfiles.map(async (profile) => {
      const status = await inspectForgeModelAuthentication(profile.provider, environment);
      return `${profile.displayName.padEnd(18)} ${status.padEnd(16)} ${profile.model.padEnd(18)} ${profile.reasoningEffort}`;
    })
  );
  return `Provider           Auth status      Default model      Reasoning\n${rows.join('\n')}\n\nReady means Forge configuration exists; no remote authentication or inference is checked.\n`;
};

export const selectForgeModel = async (
  terminal: ModelSelectionTerminal,
  environment: NodeJS.ProcessEnv,
  constraint: {
    readonly provider?: string;
    readonly model?: string;
    readonly reasoningEffort?: string;
  } = {}
): Promise<ForgeModelSelection> => {
  if (!terminal.isInteractive) {
    throw new ModelSelectionError('Model selection requires an interactive terminal.');
  }
  const profiles = forgeModelProfiles.filter(
    (profile) =>
      (constraint.provider === undefined || constraint.provider === profile.provider) &&
      (constraint.model === undefined || constraint.model === profile.model) &&
      (constraint.reasoningEffort === undefined ||
        constraint.reasoningEffort === profile.reasoningEffort)
  );
  if (profiles.length === 0) {
    throw new ModelSelectionError('No validated execution profile matches the supplied flags.');
  }
  const statuses = await Promise.all(
    profiles.map((profile) => inspectForgeModelAuthentication(profile.provider, environment))
  );
  for (;;) {
    const index = await terminal.choose(
      'Select execution profile (↑/↓, Enter; Esc or Ctrl-C cancels)',
      profiles.map(
        (profile, i) =>
          `${profile.displayName} — ${profile.model} / ${profile.reasoningEffort} [${statuses[i]}]`
      )
    );
    const profile = profiles[index];
    if (profile === undefined) {
      throw new ModelSelectionError('Invalid execution profile selection.');
    }
    if (statuses[index] !== 'ready') {
      throw new ModelSelectionError(
        profile.authMode === 'subscription'
          ? `Forge credentials are not ready. Run: forge model login ${profile.provider}`
          : 'DeepSeek uses an API key. Configure FORGE_MODEL_API_KEY in the private environment.'
      );
    }
    const selection = {
      provider: profile.provider,
      model: profile.model,
      reasoningEffort: profile.reasoningEffort
    };
    const target = resolveForgeModelSelection(selection, environment);
    terminal.write(
      `\nExecution profile\nProvider: ${target.providerId}\nModel: ${target.modelId}\nReasoning effort: ${target.reasoningConfig.effort}\nTransport: ${target.providerKind} (${target.transport})\nAuthentication: ready\n\n`
    );
    const confirmation = await terminal.choose('Confirm execution profile', [
      'Continue',
      'Change selection'
    ]);
    if (confirmation === 0) {
      return selection;
    }
    if (confirmation !== 1) {
      throw new ModelSelectionError('Invalid execution profile confirmation.');
    }
  }
};

export const resolvePlanModelSelection = async (
  options: {
    readonly reviewProvider?: string;
    readonly reviewModel?: string;
    readonly reasoningEffort?: string;
  },
  terminal: ModelSelectionTerminal,
  environment: NodeJS.ProcessEnv
): Promise<{
  readonly reviewProvider: string;
  readonly reviewModel: string;
  readonly reasoningEffort?: string;
}> => {
  if (options.reviewProvider !== undefined && options.reviewModel !== undefined) {
    return {
      reviewProvider: options.reviewProvider,
      reviewModel: options.reviewModel,
      ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort })
    };
  }
  if (!terminal.isInteractive) {
    throw new ModelSelectionError(
      'Model provider/model are required in non-interactive mode. Pass --review-provider and --review-model explicitly.'
    );
  }
  const selected = await selectForgeModel(terminal, environment, {
    ...(options.reviewProvider === undefined ? {} : { provider: options.reviewProvider }),
    ...(options.reviewModel === undefined ? {} : { model: options.reviewModel }),
    ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort })
  });
  return {
    reviewProvider: selected.provider,
    reviewModel: selected.model,
    reasoningEffort: selected.reasoningEffort
  };
};

export const loginForgeModel = async (
  provider: string,
  terminal: ModelSelectionTerminal,
  environment: NodeJS.ProcessEnv,
  login: typeof loginModelSubscription = loginModelSubscription
): Promise<void> => {
  const profile = forgeModelProfiles.find((candidate) => candidate.provider === provider);
  if (profile === undefined) {
    throw new ModelSelectionError('Unsupported Forge model provider.');
  }
  if (profile.authMode === 'api-key') {
    terminal.write(
      'DeepSeek uses an API key. Configure FORGE_MODEL_API_KEY in the private environment.\n'
    );
    return;
  }
  if (!terminal.isInteractive) {
    throw new ModelSelectionError('Subscription login requires an interactive operator terminal.');
  }
  const directory = environment.FORGE_SUBSCRIPTION_AUTH_DIRECTORY;
  if (directory === undefined) {
    throw new ModelSelectionError(
      'Set FORGE_SUBSCRIPTION_AUTH_DIRECTORY to an absolute private host directory.'
    );
  }
  const controller = new AbortController();
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  const cancel = () => {
    controller.abort();
  };
  process.once('SIGINT', cancel);
  readline.on('SIGINT', cancel);
  try {
    await login(provider, directory, {
      onAuth: ({ url, instructions }) => terminal.write(`${url}\n${instructions ?? ''}\n`),
      onPrompt: ({ message }) => readline.question(`${message}: `, { signal: controller.signal }),
      onManualCodeInput: () =>
        readline.question('Authorization redirect URL: ', { signal: controller.signal }),
      signal: controller.signal
    });
    terminal.write('Subscription authorization saved in the private host store.\n');
  } catch {
    if (controller.signal.aborted) {
      throw new ModelSelectionCancelled();
    }
    throw new ModelSelectionError(
      'Subscription authorization failed; no provider diagnostic is printed.'
    );
  } finally {
    process.removeListener('SIGINT', cancel);
    readline.close();
  }
};
