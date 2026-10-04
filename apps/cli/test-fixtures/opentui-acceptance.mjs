import assert from 'node:assert/strict';
import { testRender } from '@opentui/react/test-utils';
import { jsx } from '@opentui/react/jsx-runtime';
import { ForgeTui } from '../src/tui/app.tsx';
import { CodingTuiController } from '../src/tui/controller.ts';

const controller = new CodingTuiController();
const ui = await testRender(jsx(ForgeTui, { controller, environment: {}, exit() {} }), {
  width: 110,
  height: 38,
  kittyKeyboard: true
});
try {
  const choice = controller.terminal.choose('Exact approval', [
    'Review details',
    'Approve and run',
    'Cancel'
  ]);
  await ui.waitForFrame((frame) => frame.includes('Exact approval'));
  ui.mockInput.pressArrow('down');
  await ui.flush();
  ui.mockInput.pressEnter();
  assert.equal(await choice, 1);
  const task = controller.terminal.multiline('Multiline task');
  await ui.waitForFrame((frame) => frame.includes('Multiline task'));
  await ui.mockInput.typeText('First line');
  ui.mockInput.pressEnter();
  await ui.mockInput.typeText('Second line');
  await ui.flush();
  assert.equal(controller.snapshot().request?.kind, 'task');
  ui.mockInput.pressEnter({ ctrl: true });
  assert.equal(await task, 'First line\nSecond line');
  const input = controller.terminal.prompt('Repository path', '/initial');
  await ui.waitForFrame((frame) => frame.includes('Repository path'));
  ui.mockInput.pressKey('a', { ctrl: true });
  await ui.mockInput.typeText('/repo');
  await ui.flush();
  ui.mockInput.pressEnter();
  assert.ok((await input).includes('/repo'));
  controller.present({ type: 'stage', stage: 'authority', state: 'active' });
  controller.present({
    type: 'model',
    provider: 'openai-codex',
    model: 'gpt-6.1-sol',
    reasoning: 'medium'
  });
  controller.present({
    type: 'run',
    status: {
      runId: 'actual-run',
      state: 'FAILED',
      createdAt: '',
      correlation: { runId: 'actual-run' },
      tasks: [],
      leases: [],
      timeline: []
    }
  });
  controller.finish('Safe error: inspect durable status');
  const frame = await ui.waitForFrame((value) => value.includes('Safe error'));
  assert.ok(frame.includes('FAILED'));
  assert.ok(frame.includes('gpt-6.1-sol'));
  assert.ok(!frame.includes('Run completed successfully'));
  for (const outcome of ['COMPLETED', 'CANCELLED']) {
    controller.present({
      type: 'run',
      status: {
        runId: 'actual-run',
        state: outcome,
        createdAt: '',
        correlation: { runId: 'actual-run' },
        tasks: [],
        leases: [],
        timeline: []
      }
    });
    await ui.waitForFrame((value) => value.includes(`Run outcome: ${outcome}`));
  }
  console.log(
    'OpenTUI native rendering, choices, multiline submission and failed durable state passed'
  );
} finally {
  ui.renderer.destroy();
}
