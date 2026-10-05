import { createCliRenderer, createHostClipboard } from '@opentui/core';
import type { HostClipboardService } from '@opentui/core';
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
  let hostClipboard: HostClipboardService | undefined;
  const copyText = async (value: string): Promise<boolean> => {
    try {
      if (renderer.copyToClipboardOSC52(value)) {
        return true;
      }
      hostClipboard ??= createHostClipboard();
      return (await hostClipboard.writeText(value)).status === 'written';
    } catch {
      return false;
    }
  };
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
      <ForgeTui
        controller={controller}
        environment={dependencies.environment}
        exit={exit}
        selectedText={() => renderer.getSelection()?.getSelectedText() ?? ''}
        copyText={copyText}
      />
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
    try {
      await hostClipboard?.dispose();
    } finally {
      renderer.destroy();
    }
  }
}
