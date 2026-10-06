// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunView } from '../run-view-schema.js';

vi.mock('@xyflow/react', () => ({
  ReactFlow: (props: {
    nodes: { id: string; data: { label: ReactNode } }[];
    edges: { id: string; label: string }[];
    onNodeClick: (event: unknown, node: { id: string }) => void;
    nodesDraggable: boolean;
    nodesConnectable: boolean;
    deleteKeyCode: null;
    children: ReactNode;
  }) =>
    createElement(
      'section',
      {
        'data-testid': 'graph',
        'data-draggable': String(props.nodesDraggable),
        'data-connectable': String(props.nodesConnectable),
        'data-delete': String(props.deleteKeyCode)
      },
      ...props.nodes.map((node) =>
        createElement(
          'button',
          { key: node.id, 'data-node': node.id, onClick: () => props.onNodeClick(undefined, node) },
          node.data.label
        )
      ),
      ...props.edges.map((edge) =>
        createElement('span', { key: edge.id, 'data-edge': edge.id }, edge.label)
      ),
      props.children
    ),
  Background: () => null,
  Controls: () => null,
  MiniMap: (props: { nodeColor: (node: { id: string }) => string }) =>
    createElement(
      'span',
      { 'data-testid': 'minimap' },
      props.nodeColor({ id: 'A' }),
      props.nodeColor({ id: 'missing' })
    )
}));

// No #root exists on module load: the test owns the React lifecycle.
import { App } from './app.js';

const view: RunView = {
  planId: 'plan-a',
  approved: true,
  repository: '/repo',
  repositoryCommit: 'base',
  runId: 'run-a',
  state: 'COMPLETED',
  stateSource: 'task-events',
  recordedRunState: 'ACTIVE',
  execution: 'live',
  verificationMode: 'repository',
  reviewMode: 'live-pi',
  warnings: ['Stored status has not been finalized'],
  finalRepository: { status: 'failed', head: 'final', clean: false, detail: 'Final checks failed' },
  tasks: [
    {
      id: 'A',
      title: 'Task A',
      goal: 'Implement A',
      state: 'VERIFYING',
      stage: 'REVIEWING',
      plannedFiles: ['a'],
      actualFiles: ['src/a.ts'],
      failure: 'Long failure',
      worktree: '/worktree/a',
      diff: '+actual',
      verification: { status: 'passed' },
      review: { recommendation: 'accept', summary: 'Reviewed', findings: [] }
    },
    {
      id: 'B',
      title: 'Task B',
      goal: 'Implement B',
      state: 'NOT_RECORDED',
      plannedFiles: [],
      actualFiles: []
    }
  ],
  edges: [
    { id: 'dependency', source: 'A', target: 'B', kind: 'dependency', label: 'depends on' },
    { id: 'conflict', source: 'A', target: 'B', kind: 'conflict', label: 'soft conflict' }
  ]
};
let root: Root | undefined;
let host: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  host?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const mount = async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(App)));
};
const click = async (text: string) => {
  const button = [...host.querySelectorAll('button')].find(
    (element) => element.textContent === text
  );
  expect(button, text).toBeDefined();
  await act(async () => button!.click());
};
const select = async (index: number, value: string) => {
  const element = host.querySelectorAll('select')[index];
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
};
const response = (value: unknown, ok = true) => ({ ok, json: async () => value });

describe('read-only inspector interactions', () => {
  it('refreshes, filters, navigates, helps and copies recorded facts using only GET requests', async () => {
    const fetcher = vi.fn(async (url: string, _options: { signal: AbortSignal; cache: string }) =>
      response(url === '/api/plans' ? [{ id: 'plan-a', approved: true, runId: 'run-a' }] : view)
    );
    vi.stubGlobal('fetch', fetcher);
    const writeText = vi.fn(async () => undefined);
    vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(writeText);
    await mount();
    expect(host.textContent).toContain('Choose a saved plan');
    await select(0, 'plan-a');
    expect(host.textContent).toContain('recorded task events');
    expect(host.textContent).toContain('separately recorded run status: ACTIVE');
    expect(host.textContent).toContain('Final checks failed');
    expect(host.querySelector('[data-testid="graph"]')?.getAttribute('data-draggable')).toBe(
      'false'
    );
    expect(host.querySelector('[data-testid="graph"]')?.getAttribute('data-connectable')).toBe(
      'false'
    );
    expect(host.querySelector('[data-testid="graph"]')?.getAttribute('data-delete')).toBe('null');
    await click('Copy run metadata');
    expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining('Final checks failed'));
    await act(async () => host.querySelector<HTMLButtonElement>('[data-node="A"]')!.click());
    expect(host.textContent).toContain('Long failure');
    await click('Copy task details / IDs');
    expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining('+actual'));
    await select(1, 'A');
    expect(host.querySelectorAll('[data-node]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-edge]')).toHaveLength(0);
    await click('? Task B');
    expect(host.textContent).toContain('No integrated commit recorded');
    await click('Help · ? / F1');
    expect(host.querySelector('[aria-label="Inspector help"]')).not.toBeNull();
    await click('Close help');
    await act(async () =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F1', bubbles: true }))
    );
    expect(host.querySelector('[aria-label="Inspector help"]')).not.toBeNull();
    await act(async () =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    );
    expect(host.querySelector('[aria-label="Inspector help"]')).toBeNull();
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await click('Refresh');
    for (const [, options] of fetcher.mock.calls) {
      expect(options).toMatchObject({ cache: 'no-store', signal: expect.any(AbortSignal) });
      expect(options).not.toHaveProperty('method');
    }
  });
  it('retains explicitly stale observations on refresh failure and does not accept a different plan identity', async () => {
    let fail = false;
    let wrong = false;
    const fetcher = vi.fn(async (url: string) => {
      if (url === '/api/plans') {
        return response([{ id: 'plan-a', approved: true }]);
      }
      return fail ? response({}, false) : response({ ...view, planId: wrong ? 'other' : 'plan-a' });
    });
    vi.stubGlobal('fetch', fetcher);
    await mount();
    await select(0, 'plan-a');
    fail = true;
    await click('Refresh');
    expect(host.textContent).toContain('Last observed facts remain visible');
    expect(host.textContent).toContain('run-a');
    fail = false;
    wrong = true;
    await click('Refresh');
    expect(host.textContent).not.toContain('run other');
    expect(host.textContent).toContain('run-a');
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Unavailable'));
    await click('Copy run metadata');
    expect(host.textContent).toContain('Clipboard unavailable; select and copy');
  });
  it('aborts obsolete plan requests and never paints their late response over a newly selected plan', async () => {
    const { promise: pending, resolve: release } =
      Promise.withResolvers<ReturnType<typeof response>>();
    let oldSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options: { signal: AbortSignal }) => {
        if (url === '/api/plans') {
          return response([
            { id: 'plan-a', approved: true },
            { id: 'plan-b', approved: false }
          ]);
        }
        if (url.endsWith('plan-a')) {
          oldSignal = options.signal;
          return pending;
        }
        return response({
          ...view,
          planId: 'plan-b',
          runId: undefined,
          stateSource: 'plan',
          recordedRunState: undefined,
          finalRepository: undefined
        });
      })
    );
    await mount();
    await select(0, 'plan-a');
    await select(0, 'plan-b');
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => release(response(view)));
    expect(host.querySelector('.summary')?.textContent).toContain('plan-b');
    expect(host.querySelector('.summary')?.textContent).not.toContain('run-a');
    expect(host.textContent).toContain('saved plan');
  });
});
