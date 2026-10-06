import { describe, expect, it } from 'vitest';
import {
  ObservableTuiController,
  renderObservableTui,
  observableDiagnosticText
} from './observable-tui.js';
import { runMetadataText, taskDetailsText, taskPositions, taskTone } from './presentation.js';
import type { RunView } from './run-view-schema.js';

const view: RunView = {
  planId: 'plan',
  approved: false,
  repository: '/repo',
  repositoryCommit: 'base',
  runId: 'run',
  state: 'COMPLETED',
  stateSource: 'task-events',
  recordedRunState: 'ACTIVE',
  warnings: ['Final facts are independent'],
  finalRepository: { status: 'failed', clean: false, head: 'final', detail: 'Final check failed' },
  tasks: ['A', 'B', 'C'].map((id) => ({
    id,
    title: `Task ${id}`,
    goal: `Implement ${id}`,
    state: id === 'C' ? 'PENDING' : 'COMPLETED',
    plannedFiles: ['file-id'],
    actualFiles: []
  })),
  edges: [
    { id: 'ac', source: 'A', target: 'C', kind: 'dependency', label: 'requires A' },
    { id: 'bc', source: 'B', target: 'C', kind: 'dependency', label: 'requires B' }
  ]
};
describe('shared product presentation', () => {
  it('positions independent tasks together and their dependent in the next column without changing facts', () => {
    const positions = taskPositions(view);
    expect(positions.get('A')?.x).toBe(positions.get('B')?.x);
    expect(positions.get('C')?.x).toBeGreaterThan(positions.get('A')!.x);
    expect(runMetadataText(view)).toContain('recorded task events');
    expect(runMetadataText(view)).toContain('Separately recorded run status: ACTIVE');
    expect(runMetadataText(view)).toContain('failed (separate observation) · clean: false');
    expect(taskDetailsText(view.tasks[2])).toContain('Not recorded');
    expect(['COMPLETED', 'RUNNING', 'FAILED', 'PENDING', 'NOT_RECORDED'].map(taskTone)).toEqual([
      'complete',
      'active',
      'failed',
      'pending',
      'unknown'
    ]);
  });
  it('navigates tasks and help without changing approval or executing operations, even while busy', async () => {
    const controller = new ObservableTuiController({ directory: '/unused', repository: '/repo' });
    controller.state.view = structuredClone(view);
    controller.state.screen = 'running';
    controller.state.busy = true;
    await controller.key('tab');
    await controller.key('down');
    await controller.key('return');
    expect(controller.state.panel).toBe('detail');
    expect(controller.state.selectedTask).toBe(1);
    await controller.key('?');
    await controller.key('a');
    expect(controller.state.view.approved).toBe(false);
    expect(renderObservableTui(controller.state, 40, 24)).toContain('HELP');
    await controller.key('escape');
    expect(controller.state.help).toBe(false);
    expect(controller.state.screen).toBe('running');
    expect(observableDiagnosticText(controller.state)).toContain('Task C');
  });
  it('keeps full evidence copy available in help and clamps task navigation without invoking commands', async () => {
    let copied = '';
    const controller = new ObservableTuiController({
      directory: '/unused',
      repository: '/repo',
      copy: async (text) => {
        copied = text;
        return 'Copied';
      }
    });
    controller.state.view = view;
    controller.state.screen = 'running';
    controller.state.busy = true;
    await controller.key('tab');
    await controller.key('up');
    expect(controller.state.selectedTask).toBe(0);
    for (let index = 0; index < 6; index += 1) {
      await controller.key('down');
    }
    expect(controller.state.selectedTask).toBe(2);
    await controller.key('tab');
    await controller.key('tab');
    expect(controller.state.panel).toBe('overview');
    await controller.key('f1');
    await controller.key('l');
    await controller.key('y', '', true);
    expect(copied).toContain('Final check failed');
    expect(copied).toContain('Task C');
    expect(copied).not.toContain('\u001b');
    expect(controller.state.help).toBe(true);
    expect(controller.state.busy).toBe(true);
    await controller.key('return');
    expect(controller.state.help).toBe(false);
  });
  it('ignores absent dependency endpoints and keeps a cyclic observation bounded without changing it', () => {
    const observed = {
      ...view,
      edges: [
        ...view.edges,
        {
          id: 'missing',
          source: 'missing',
          target: 'C',
          kind: 'dependency' as const,
          label: 'missing'
        },
        { id: 'cycle', source: 'C', target: 'A', kind: 'dependency' as const, label: 'cycle' }
      ]
    };
    const original = structuredClone(observed);
    const positions = taskPositions(observed);
    expect(positions.size).toBe(3);
    expect([...positions.values()].every((position) => Number.isFinite(position.x))).toBe(true);
    expect(observed).toEqual(original);
    expect(taskTone('READY')).toBe('pending');
    expect(taskTone('CANCELLED')).toBe('failed');
    expect(
      runMetadataText({ ...view, stateSource: 'run-record', finalRepository: undefined })
    ).toContain('recorded run status');
    expect(runMetadataText({ ...view, stateSource: 'plan', finalRepository: undefined })).toContain(
      'saved plan'
    );
  });
  it.each([
    [40, 24],
    [60, 24],
    [100, 36]
  ])('fits %i×%i without dropping full copyable error details', (width, height) => {
    const controller = new ObservableTuiController({
      directory: '/unused',
      repository: '/仓库/👩‍💻'
    });
    controller.state.view = view;
    controller.state.screen = 'result';
    controller.state.error = 'Long error '.repeat(80);
    const rendered = renderObservableTui(controller.state, width, height);
    expect(rendered.split('\n').length).toBeLessThanOrEqual(height);
    expect(rendered).toContain('FORGE');
    expect(rendered).toContain('Help');
    expect(observableDiagnosticText(controller.state)).toContain(controller.state.error);
    controller.state.scroll = 10000;
    expect(renderObservableTui(controller.state, width, height)).toContain('COMPLETED');
  });
});
