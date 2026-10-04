import { createInterface } from 'node:readline/promises';
import {
  createModelSelectionTerminal,
  ModelSelectionCancelled,
  type ModelSelectionTerminal
} from './model-selection.js';

export interface InteractiveTerminal extends ModelSelectionTerminal {
  prompt(this: void, message: string, defaultValue?: string, signal?: AbortSignal): Promise<string>;
  multiline(this: void, message: string, signal?: AbortSignal): Promise<string>;
}

export const createInteractiveTerminal = (
  input: Parameters<typeof createModelSelectionTerminal>[0] = process.stdin,
  output: Parameters<typeof createModelSelectionTerminal>[1] = process.stderr
): InteractiveTerminal => {
  const menu = createModelSelectionTerminal(input, output);
  const read = async (
    message: string,
    multiple: boolean,
    defaultValue?: string,
    signal?: AbortSignal
  ) => {
    if (!menu.isInteractive) {
      throw new ModelSelectionCancelled();
    }
    const wasRaw = input.isRaw === true;
    const wasFlowing = input.readableFlowing === true;
    const terminal = createInterface({ input, output });
    const controller = new AbortController();
    const cancel = () => {
      controller.abort();
      terminal.close();
    };
    const onKey = (_text: string, key: { name?: string }) => {
      if (key.name === 'escape') {
        cancel();
      }
    };
    input.on('keypress', onKey);
    process.once('SIGINT', cancel);
    terminal.on('SIGINT', cancel);
    terminal.on('close', cancel);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted === true) {
      cancel();
    }
    try {
      if (!multiple) {
        const result = await terminal.question(
          `${message}${defaultValue === undefined ? '' : ` [${defaultValue}]`}: `,
          { signal: controller.signal }
        );
        return result.trim() === '' ? (defaultValue ?? '') : result;
      }
      menu.write(`${message}\nEnter multiple lines; a line containing only . finishes the task.\n`);
      const lines: string[] = [];
      const iterator = terminal[Symbol.asyncIterator]();
      terminal.setPrompt('> ');
      terminal.prompt();
      for await (const line of iterator) {
        if (controller.signal.aborted) {
          throw new ModelSelectionCancelled();
        }
        if (line === '.') {
          return lines.join('\n');
        }
        lines.push(line);
        terminal.prompt();
      }
      throw new ModelSelectionCancelled();
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ModelSelectionCancelled();
      }
      throw error;
    } finally {
      terminal.removeListener('SIGINT', cancel);
      terminal.removeListener('close', cancel);
      terminal.close();
      process.removeListener('SIGINT', cancel);
      input.removeListener('keypress', onKey);
      input.setRawMode?.(wasRaw);
      signal?.removeEventListener('abort', cancel);
      if (wasFlowing) {
        input.resume();
      } else {
        input.pause();
      }
    }
  };
  return {
    ...menu,
    prompt: (message, value, signal) => read(message, false, value, signal),
    multiline: (message, signal) => read(message, true, undefined, signal)
  };
};
