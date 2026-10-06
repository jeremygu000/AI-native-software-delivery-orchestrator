import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TaskView } from '../run-view-schema.js';
import { TaskDetails } from './app.js';

const task: TaskView = {
  id: 'task-a',
  title: 'Inspect A',
  goal: 'Implement the approved task',
  state: 'PENDING',
  plannedFiles: ['file-a'],
  actualFiles: []
};

describe('read-only web task details', () => {
  it('keeps absent execution evidence absent instead of displaying successful checks', () => {
    const markup = renderToStaticMarkup(createElement(TaskDetails, { task }));
    expect(markup).toContain('PENDING');
    expect(markup).toContain('Not recorded');
    expect(markup).toContain('No integrated commit recorded');
    expect(markup).not.toContain('passed');
    expect(markup).not.toContain('button');
  });
  it('renders the full recorded error, checks, review, paths and diff as escaped selectable text', () => {
    const failure = '<script>failed</script>\n' + 'long diagnostic '.repeat(100);
    const observed: TaskView = {
      ...task,
      state: 'FAILED',
      stage: 'REVIEWING',
      description: 'Preserve the approved behavior',
      actualFiles: ['src/a.ts'],
      failure,
      verification: { status: 'failed', detail: 'Repository check output' },
      review: {
        recommendation: 'reject',
        summary: 'Review findings',
        findings: [{ path: 'src/a.ts', detail: 'Missing behavior' }]
      },
      worktree: '/worktree/a',
      integratedCommit: 'recorded-commit',
      diff: '+const actual = "<tag>";'
    };
    const markup = renderToStaticMarkup(createElement(TaskDetails, { task: observed }));
    for (const text of [
      'REVIEWING',
      'Repository check output',
      'Review findings',
      'Missing behavior',
      '/worktree/a',
      'recorded-commit',
      'long diagnostic '.repeat(100)
    ]) {
      expect(markup).toContain(text);
    }
    expect(markup).toContain('&lt;script&gt;failed&lt;/script&gt;');
    expect(markup).not.toContain('<script>');
    expect(observed.failure).toBe(failure);
  });
});
