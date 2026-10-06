import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ObservableTuiController, startObservableTui } from './observable-tui.js';

describe('terminal presentation lifecycle', () => {
  it('rejects non-interactive streams before entering full-screen mode', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    try {
      await expect(startObservableTui()).rejects.toThrow('requires an interactive terminal');
    } finally {
      if (descriptor) {
        Object.defineProperty(process.stdin, 'isTTY', descriptor);
      } else {
        Reflect.deleteProperty(process.stdin, 'isTTY');
      }
    }
  });

  it('restores raw mode, screen and listeners on an idle quit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'forge-tui-'));
    const original = Object.getOwnPropertyDescriptors(process.stdin);
    const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const raw = vi.fn();
    Object.defineProperties(process.stdin, {
      isTTY: { configurable: true, value: true },
      isRaw: { configurable: true, value: false },
      setRawMode: { configurable: true, value: raw }
    });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const resume = vi.spyOn(process.stdin, 'resume').mockReturnValue(process.stdin);
    const pause = vi.spyOn(process.stdin, 'pause').mockReturnValue(process.stdin);
    const keyListeners = process.stdin.listenerCount('keypress');
    const resizeListeners = process.stdout.listenerCount('resize');
    try {
      const running = startObservableTui(directory, '/repo');
      await vi.waitFor(() => expect(write).toHaveBeenCalledWith(expect.stringContaining('FORGE')));
      process.stdout.emit('resize');
      process.stdin.emit('keypress', '', {});
      process.stdin.emit('keypress', 'q', { name: 'q' });
      await expect(running).resolves.toBe(true);
      expect(raw.mock.calls).toEqual([[true], [false]]);
      expect(write).toHaveBeenLastCalledWith('\x1b[?25h\x1b[?1049l');
      expect(process.stdin.listenerCount('keypress')).toBe(keyListeners);
      expect(process.stdout.listenerCount('resize')).toBe(resizeListeners);
      expect(resume).toHaveBeenCalled();
      expect(pause).toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      for (const key of ['isTTY', 'isRaw', 'setRawMode']) {
        const descriptor = original[key];
        if (descriptor) {
          Object.defineProperty(process.stdin, key, descriptor);
        } else {
          Reflect.deleteProperty(process.stdin, key);
        }
      }
      if (stdoutTTY) {
        Object.defineProperty(process.stdout, 'isTTY', stdoutTTY);
      } else {
        Reflect.deleteProperty(process.stdout, 'isTTY');
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('ignores a second planning submission while the current operation is busy', async () => {
    const controller = new ObservableTuiController({ directory: '/unused', repository: '/repo' });
    controller.state.screen = 'request';
    controller.state.busy = true;
    controller.state.input = 'Original request';
    await controller.key('s', '', true);
    await controller.key('return');
    expect(controller.state.input).toBe('Original request');
    expect(controller.state.planId).toBeUndefined();
  });
});
