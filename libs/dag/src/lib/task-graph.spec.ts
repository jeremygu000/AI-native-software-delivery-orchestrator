import type { TaskContract } from '@ai-native-software-delivery-orchestrator/domain';
import { describe, expect, it } from 'vitest';

import {
  getReadyTaskIds,
  InvalidTaskGraphError,
  topologicalSort,
  validateTaskGraph
} from './task-graph.js';

const task = (
  id: string,
  dependencies: readonly string[] = [],
  priority?: number
): TaskContract => ({
  id,
  title: id,
  goal: `Complete ${id}`,
  dependencies: [...dependencies],
  expectedReads: [],
  expectedWrites: [],
  sharedResources: [],
  verification: [],
  priority
});

describe('validateTaskGraph', () => {
  it('accepts a valid DAG', () => {
    expect(validateTaskGraph([task('T1'), task('T2', ['T1'])])).toEqual({
      valid: true,
      issues: []
    });
  });

  it('reports duplicate tasks and missing dependencies', () => {
    const result = validateTaskGraph([task('T1'), task('T1'), task('T2', ['missing'])]);

    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({ type: 'duplicate-task', taskId: 'T1' });
    expect(result.issues).toContainEqual({
      type: 'missing-dependency',
      taskId: 'T2',
      dependencyId: 'missing'
    });
  });

  it('detects self dependencies', () => {
    const issues = validateTaskGraph([task('T1', ['T1'])]).issues;

    expect(issues).toEqual([
      {
        type: 'self-dependency',
        taskId: 'T1'
      }
    ]);
  });

  it('detects duplicate dependencies when callers bypass schema validation', () => {
    expect(validateTaskGraph([task('T1'), task('T2', ['T1', 'T1'])]).issues).toContainEqual({
      type: 'duplicate-dependency',
      taskId: 'T2',
      dependencyId: 'T1'
    });
  });

  it('reports every independent cycle as a stable strongly connected component', () => {
    const result = validateTaskGraph([
      task('T1', ['T2']),
      task('T2', ['T1']),
      task('T3', ['T5']),
      task('T4', ['T3']),
      task('T5', ['T4'])
    ]);

    expect(result.issues).toEqual([
      { type: 'cycle', taskIds: ['T1', 'T2'] },
      { type: 'cycle', taskIds: ['T3', 'T4', 'T5'] }
    ]);
  });

  it('handles a valid dependency chain deeper than the JavaScript call stack', () => {
    const tasks = Array.from({ length: 20_000 }, (_, index) =>
      task(`T${index}`, index === 0 ? [] : [`T${index - 1}`])
    );

    expect(validateTaskGraph(tasks)).toEqual({ valid: true, issues: [] });
    const ordered = topologicalSort(tasks);
    expect(ordered).toHaveLength(20_000);
    expect(ordered[0]).toBe('T0');
    expect(ordered.at(-1)).toBe('T19999');
  }, 20_000);

  it('does not use locale-sensitive ordering for diagnostics', () => {
    const result = validateTaskGraph([task('ä', ['z']), task('z', ['ä'])]);

    expect(result.issues).toEqual([{ type: 'cycle', taskIds: ['z', 'ä'] }]);
  });

  it('reports a cycle component without duplicating its first task', () => {
    const result = validateTaskGraph([task('T1', ['T3']), task('T2', ['T1']), task('T3', ['T2'])]);

    expect(result.issues).toContainEqual({
      type: 'cycle',
      taskIds: ['T1', 'T2', 'T3']
    });
  });

  it('reports a self dependency only once', () => {
    expect(validateTaskGraph([task('T1', ['T1'])]).issues).toEqual([
      {
        type: 'self-dependency',
        taskId: 'T1'
      }
    ]);
  });
});

describe('topologicalSort', () => {
  it('orders dependencies before their consumers', () => {
    const tasks = [task('T3', ['T2']), task('T1'), task('T2', ['T1']), task('T4')];

    const ordered = topologicalSort(tasks);

    expect(ordered.indexOf('T1')).toBeLessThan(ordered.indexOf('T2'));
    expect(ordered.indexOf('T2')).toBeLessThan(ordered.indexOf('T3'));
  });

  it('uses priority and then ID for deterministic ready-task ordering', () => {
    expect(topologicalSort([task('T2'), task('T3', [], 10), task('T1')])).toEqual([
      'T3',
      'T1',
      'T2'
    ]);
  });

  it('uses code-unit ordering instead of the host locale', () => {
    expect(topologicalSort([task('ä'), task('z')])).toEqual(['z', 'ä']);
  });

  it('orders a broad ready set by priority through the deterministic queue', () => {
    const tasks = Array.from({ length: 50 }, (_, index) =>
      task(`T${index.toString().padStart(2, '0')}`, [], (index * 17) % 50)
    );
    const expected = tasks
      .toSorted((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
      .map(({ id }) => id);

    expect(topologicalSort(tasks)).toEqual(expected);
  });

  it('rejects an invalid graph', () => {
    expect(() => topologicalSort([task('T1', ['missing'])])).toThrow(InvalidTaskGraphError);
  });
});

describe('getReadyTaskIds', () => {
  const tasks = [task('T1'), task('T2', ['T1'], 10), task('T3', ['T1']), task('T4', ['T2', 'T3'])];

  it('returns only tasks whose dependencies are completed', () => {
    expect(getReadyTaskIds(tasks, new Set(['T1']))).toEqual(['T2', 'T3']);
  });

  it('excludes completed and otherwise unavailable tasks', () => {
    expect(getReadyTaskIds(tasks, new Set(['T1', 'T2']), new Set(['T3']))).toEqual([]);
  });
});
