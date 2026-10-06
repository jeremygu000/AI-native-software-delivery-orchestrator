import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ObservableTuiController, TuiScreen, startObservableTui } from './observable-tui.js';

const clipboard = vi.hoisted(() => ({ fail: false, text: '', error: false }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: () => {
    const child = new EventEmitter();
    const input = new EventEmitter();
    Object.assign(input, {
      end: (text: string) => {
        clipboard.text = text;
        queueMicrotask(() =>
          clipboard.error
            ? child.emit('error', new Error('Clipboard not installed'))
            : child.emit('close', clipboard.fail ? 1 : 0)
        );
      }
    });
    return Object.assign(child, { stdin: input });
  }
}));

describe('explicit diagnostic copy', () => {
  it('requires a real terminal instead of altering redirected output', async () => {
    await expect(startObservableTui()).rejects.toThrow('requires an interactive terminal');
  });
  it.each(['success', 'exit-error', 'missing-command'])(
    'copies complete text or saves the same text for clipboard outcome %s',
    async (outcome) => {
      const directory = await mkdtemp(join(tmpdir(), 'forge-copy-'));
      try {
        clipboard.fail = outcome === 'exit-error';
        clipboard.error = outcome === 'missing-command';
        const controller = new ObservableTuiController({ directory, repository: '/repository' });
        controller.state.screen = TuiScreen.Result;
        controller.state.error = 'First line\nLong error without truncation\nLast line';
        await controller.key('y');
        expect(clipboard.text).toContain(controller.state.error);
        expect(clipboard.text).not.toContain('\x1b');
        if (outcome !== 'success') {
          const files = await readdir(join(directory, 'diagnostics'));
          expect(files).toHaveLength(1);
          expect(await readFile(join(directory, 'diagnostics', files[0]), 'utf8')).toBe(
            clipboard.text
          );
          expect(controller.state.message).toContain('diagnostics saved');
        } else {
          expect(controller.state.message).toContain('clipboard');
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
});
