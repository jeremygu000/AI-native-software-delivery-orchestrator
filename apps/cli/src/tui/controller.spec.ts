import { describe, expect, it, vi } from 'vitest';
import { CodingTuiController } from './controller.js';

describe('OpenTUI semantic adapter', () => {
  it('keeps multiline text intact and requires a valid explicit choice', async () => {
    const controller = new CodingTuiController();
    const changed = vi.fn();
    const unsubscribe = controller.subscribe(changed);
    const choice = controller.terminal.choose('Approve exact plan?', [
      'Review',
      'Approve',
      'Cancel'
    ]);
    controller.submit(99);
    expect(controller.snapshot().request?.kind).toBe('choice');
    controller.submit(1);
    await expect(choice).resolves.toBe(1);
    const task = controller.terminal.multiline('Task');
    controller.submit('First line\nSecond line\nThird line');
    await expect(task).resolves.toBe('First line\nSecond line\nThird line');
    expect(controller.snapshot().request).toBeUndefined();
    expect(changed).toHaveBeenCalled();
    unsubscribe();
  });

  it('reflects observed status only and bounds notices without launching operations', () => {
    const controller = new CodingTuiController();
    controller.present({ type: 'stage', stage: 'planning', state: 'active' });
    controller.present({ type: 'stage', stage: 'planning', state: 'complete' });
    controller.present({
      type: 'model',
      provider: 'openai-codex',
      model: 'gpt-6.1-sol',
      reasoning: 'medium'
    });
    for (let index = 0; index < 25; index += 1) {
      controller.terminal.write(`Notice ${index}`);
    }
    expect(controller.snapshot().events.filter((event) => event.type === 'stage')).toEqual([
      { type: 'stage', stage: 'planning', state: 'complete' }
    ]);
    expect(controller.snapshot().notices).toHaveLength(20);
    controller.finish('Safe deployment failure');
    expect(controller.snapshot()).toMatchObject({
      finished: true,
      error: 'Safe deployment failure'
    });
  });

  it('aborts a pending input without recursively emitting SIGINT', async () => {
    const controller = new CodingTuiController();
    const signal = new AbortController();
    const emit = vi.spyOn(process, 'emit');
    const input = controller.terminal.prompt('Repository', '/repo', signal.signal);
    signal.abort();
    await expect(input).rejects.toThrow('Interactive coding cancelled');
    expect(emit).not.toHaveBeenCalledWith('SIGINT');
    expect(controller.snapshot().request).toBeUndefined();
    emit.mockRestore();
  });
});
