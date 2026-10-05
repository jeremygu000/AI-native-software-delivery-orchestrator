import assert from 'node:assert/strict';
import { testRender } from '@opentui/react/test-utils';
import { jsx } from '@opentui/react/jsx-runtime';
import { ForgeTui } from '../src/tui/app.tsx';
import { CodingTuiController } from '../src/tui/controller.ts';

const controller = new CodingTuiController();
const ui = await testRender(
  jsx(ForgeTui, {
    controller,
    environment: { TEMPORAL_TASK_QUEUE: 'forge-neon-comparison-deepseek-' + 'queue'.repeat(12) },
    exit() {}
  }),
  {
    width: 110,
    height: 38,
    kittyKeyboard: true
  }
);
try {
  const rootOptions = [
    'Start a coding task',
    'Resume a run',
    'View runs',
    'Configure model',
    'Check environment'
  ];
  const root = controller.terminal.choose('What do you want to do?', rootOptions);
  for (const [width, height] of [
    [110, 38],
    [60, 30],
    [40, 24]
  ]) {
    ui.resize(width, height);
    const frame = await ui.waitForFrame((value) => value.includes('Check environment'));
    const lines = frame.split('\n');
    assert.equal(
      new Set(rootOptions.map((option) => lines.findIndex((line) => line.includes(option)))).size,
      5,
      frame
    );
    for (const label of ['Provider', 'Model', 'Reasoning', 'Authority', 'Queue']) {
      assert.ok(frame.includes(label), frame);
    }
    assert.ok(frame.includes('Enter Confirm'), frame);
    assert.ok(!frame.includes('Durable state is authoritative'), frame);
    if (width === 110) {
      assert.ok(frame.includes('███████'), frame);
    }
    if (width === 40) {
      assert.ok(!frame.includes('queue'.repeat(12)), frame);
    }
  }
  ui.resize(110, 38);
  await ui.mockInput.typeText('?');
  const helpFrame = await ui.waitForFrame((value) =>
    value.includes('Help · full execution details')
  );
  assert.ok(helpFrame.includes('queue'.repeat(12)), helpFrame);
  ui.resize(40, 24);
  const narrowHelp = await ui.waitForFrame((value) => value.includes('Queue:'));
  assert.ok(
    narrowHelp
      .replace(/[│\s]/gu, '')
      .includes('forge-neon-comparison-deepseek-' + 'queue'.repeat(12)),
    narrowHelp
  );
  ui.mockInput.pressEnter();
  await ui.waitForFrame((value) => value.includes('What do you want to do?'));
  assert.equal(controller.snapshot().request?.kind, 'choice');
  ui.resize(30, 12);
  await ui.waitForFrame((value) => value.includes('columns and 24 rows'));
  ui.mockInput.pressEnter();
  await ui.flush();
  assert.equal(controller.snapshot().request?.kind, 'choice');
  ui.resize(110, 38);
  await ui.waitForFrame((value) => value.includes('Check environment'));
  ui.mockInput.pressEnter();
  assert.equal(await root, 0);
  const longProvider = 'provider-' + 'example'.repeat(8);
  const longModel = 'model-' + '模型'.repeat(20);
  controller.present({
    type: 'model',
    provider: longProvider,
    model: longModel,
    reasoning: 'high'
  });
  ui.resize(40, 24);
  const longProfile = await ui.waitForFrame((value) => value.includes('Reasoning high'));
  assert.ok(!longProfile.includes(longProvider), longProfile);
  assert.ok(!longProfile.includes(longModel), longProfile);
  assert.ok(longProfile.includes('Authority') && longProfile.includes('Queue'), longProfile);
  ui.resize(110, 38);
  await ui.mockInput.typeText('?');
  const profileHelp = await ui.waitForFrame((value) =>
    value.includes('Help · full execution details')
  );
  assert.ok(profileHelp.includes(longProvider), profileHelp);
  assert.ok(profileHelp.includes(longModel), profileHelp);
  ui.mockInput.pressEscape();
  await ui.waitForFrame((value) => !value.includes('Help · full execution details'));
  const longApproval =
    'Allow Forge to prepare isolated workspaces and modify/integrate these approved tasks?';
  const approval = controller.terminal.choose(longApproval, [
    'Approve and run',
    'Review details',
    'Cancel'
  ]);
  ui.resize(40, 24);
  const approvalFrame = await ui.waitForFrame((value) => value.includes('approved tasks?'));
  assert.ok(approvalFrame.includes('modify/integrate'), approvalFrame);
  assert.ok(approvalFrame.includes('Approve and run'), approvalFrame);
  ui.mockInput.pressEnter();
  assert.equal(await approval, 0);
  ui.resize(110, 38);
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
  await ui.mockInput.typeText('Second line?');
  ui.mockInput.pressKey('F1');
  await ui.waitForFrame((value) => value.includes('Help · full execution details'));
  ui.mockInput.pressEscape();
  await ui.waitForFrame((value) => value.includes('Multiline task'));
  ui.resize(30, 12);
  await ui.waitForFrame((value) => value.includes('columns and 24 rows'));
  ui.resize(60, 30);
  await ui.waitForFrame((value) => value.includes('Multiline task'));
  await ui.flush();
  assert.equal(controller.snapshot().request?.kind, 'task');
  ui.mockInput.pressEnter({ ctrl: true });
  assert.equal(await task, 'First line\nSecond line?');
  ui.resize(110, 38);
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
