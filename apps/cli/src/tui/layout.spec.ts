import { expect, it } from 'vitest';
import { codingLayout, wrapPrompt } from './layout.js';
import type { TuiRequest } from './controller.js';

const request: TuiRequest = {
  id: 1,
  kind: 'choice',
  title: 'What do you want to do?',
  initial: '',
  options: [
    'Start a coding task',
    'Resume a run',
    'View runs',
    'Configure model',
    'Check environment'
  ]
};

it.for([
  [110, 38],
  [80, 24],
  [40, 24]
])('allocates separate regions within %s', ([width, height]) => {
  const layout = codingLayout(width, height, request);
  expect(layout.tooSmall).toBe(false);
  expect(layout.header + layout.body + layout.menu + layout.footer + layout.padding * 2 + 3).toBe(
    height
  );
  expect(layout.optionRows).toBe(5);
  expect(layout.body).toBeGreaterThanOrEqual(3);
  expect(layout.banner).toBe(height >= 36);
});

it('uses additional height for evidence and a bounded task editor', () => {
  const task = { ...request, kind: 'task' as const };
  expect(codingLayout(110, 60, task).editorRows).toBe(7);
  expect(codingLayout(110, 60, task).banner).toBe(false);
  expect(codingLayout(110, 60, task).body).toBeGreaterThan(codingLayout(110, 38, task).body);
});

it('retains the entire authorization question when wrapping narrow prompts', () => {
  const question =
    'Allow Forge to prepare isolated workspaces and modify/integrate these approved tasks?';
  const layout = codingLayout(40, 24, {
    ...request,
    title: question,
    options: ['Approve and run', 'Review details', 'Cancel']
  });
  expect(layout.tooSmall).toBe(false);
  expect(layout.titleLines.join(' ')).toBe(question);
  expect(layout.titleLines.every((line) => line.length <= layout.columns)).toBe(true);
  expect(wrapPrompt('abcdefghijklmnop', 5)).toEqual(['abcde', 'fghij', 'klmno', 'p']);
});

it('requires resizing rather than squeezing hidden prompts into tiny terminals', () => {
  expect(codingLayout(39, 40, request).tooSmall).toBe(true);
  expect(codingLayout(80, 23, request).tooSmall).toBe(true);
});
