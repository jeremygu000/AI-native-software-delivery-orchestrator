import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createInteractiveTerminal } from './interactive-terminal.js';
import { ModelSelectionCancelled } from './model-selection.js';

const fixture = () => {
  const input = Object.assign(new PassThrough(), { isTTY: true });
  const output = Object.assign(new PassThrough(), { isTTY: true });
  output.resume();
  return { input, terminal: createInteractiveTerminal(input, output) };
};
describe('Interactive text terminal lifecycle', () => {
  it('returns the repository default and restores paused input/listeners', async () => {
    const { input, terminal } = fixture();
    input.pause();
    const listeners = input.listenerCount('keypress');
    const answer = terminal.prompt('Repository', '/repo');
    input.write('\n');
    await expect(answer).resolves.toBe('/repo');
    expect(input.readableFlowing).toBe(false);
    expect(input.listenerCount('keypress')).toBe(listeners);
  });
  it('collects multiline text without the terminator', async () => {
    const { input, terminal } = fixture();
    const answer = terminal.multiline('Task');
    input.write('first\n');
    await vi.waitFor(() => expect(input.listenerCount('data')).toBeGreaterThan(0));
    await new Promise<void>((resolve) => setImmediate(resolve));
    input.write('second\n');
    await new Promise<void>((resolve) => setImmediate(resolve));
    input.write('.\n');
    await expect(answer).resolves.toBe('first\nsecond');
  });
  it('retains all lines from a single multiline paste', async () => {
    const { input, terminal } = fixture();
    const answer = terminal.multiline('Task');
    input.write('first\nsecond\n.\n');
    await expect(answer).resolves.toBe('first\nsecond');
  });
  it('cancels a pending question using the session abort signal and cleans listeners', async () => {
    const { input, terminal } = fixture();
    const signal = new AbortController();
    const answer = terminal.prompt('Repository', undefined, signal.signal);
    signal.abort();
    await expect(answer).rejects.toBeInstanceOf(ModelSelectionCancelled);
    expect(input.listenerCount('keypress')).toBe(0);
    expect(input.readableFlowing).toBe(false);
  });
  it('does not leave a pending prompt on end-of-input', async () => {
    const { input, terminal } = fixture();
    const answer = terminal.prompt('Repository');
    input.end();
    await expect(answer).rejects.toBeInstanceOf(ModelSelectionCancelled);
  });
  it('preserves input which was already flowing', async () => {
    const { input, terminal } = fixture();
    input.resume();
    const answer = terminal.prompt('Repository');
    input.write('/repo\n');
    await expect(answer).resolves.toBe('/repo');
    expect(input.readableFlowing).toBe(true);
    input.pause();
  });
});
