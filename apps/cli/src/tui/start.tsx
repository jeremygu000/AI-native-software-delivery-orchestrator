import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import {
  startInteractiveCoding,
  type InteractiveCodingDependencies
} from '../interactive-coding.js';
import { ModelSelectionError, ModelSelectionCancelled } from '../model-selection.js';
import { CodingTuiController } from './controller.js';
import { ForgeTui } from './app.js';

export async function startCodingTui(
  dependencies: Omit<InteractiveCodingDependencies, 'terminal' | 'present'>
): Promise<void> {
  const controller = new CodingTuiController();
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const root = createRoot(renderer);
  let close: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    close = resolve;
  });
  const exit = () => {
    close?.();
  };
  try {
    root.render(
      <ForgeTui controller={controller} environment={dependencies.environment} exit={exit} />
    );
    try {
      await startInteractiveCoding({
        ...dependencies,
        terminal: controller.terminal,
        present: controller.present
      });
      controller.finish();
    } catch (error) {
      controller.finish(
        error instanceof ModelSelectionError
          ? error.message
          : 'Forge stopped safely. Inspect durable status before recovery.'
      );
      process.exitCode = error instanceof ModelSelectionCancelled ? 130 : 1;
    }
    await closed;
  } finally {
    root.unmount();
    renderer.destroy();
  }
}
