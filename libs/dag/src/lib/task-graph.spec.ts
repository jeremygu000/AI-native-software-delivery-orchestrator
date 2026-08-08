import type { TaskContract } from '@apra-amcos-admin-coding-orchestrator/domain';
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
    expect(validateTaskGraph([task('T1', ['T1'])]).issues).toContainEqual({
      type: 'self-dependency',
      taskId: 'T1'
    });
  });

  it('detects cycles and includes a closed path', () => {
    const result = validateTaskGraph([task('T1', ['T3']), task('T2', ['T1']), task('T3', ['T2'])]);

    expect(result.issues).toContainEqual({
      type: 'cycle',
      taskIds: ['T1', 'T3', 'T2', 'T1']
    });
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
