import type { HardTaskConflict } from '@ai-native-software-delivery-orchestrator/domain';
import { describe, expect, it } from 'vitest';

import { runtimeScopeExpansionConflicts } from './runtime-scope-conflicts.js';

const bindings = [
  {
    taskId: 'task-c',
    leasePlan: {
      taskId: 'task-c',
      source: 'manual' as const,
      predictedResources: [{ type: 'project' as const, projectId: 'other' }]
    }
  },
  {
    taskId: 'task-b',
    leasePlan: {
      taskId: 'task-b',
      source: 'manual' as const,
      predictedResources: [{ type: 'project' as const, projectId: 'core' }]
    }
  }
] as const;

describe('runtimeScopeExpansionConflicts', () => {
  it('creates one sorted hard conflict for each newly overlapping task pair', () => {
    const conflicts = runtimeScopeExpansionConflicts({
      taskId: 'task-a',
      expandedResources: [
        { type: 'file', projectId: 'core', fileId: 'expanded.ts' },
        { type: 'file', projectId: 'other', fileId: 'other.ts' }
      ],
      bindings,
      existingHardConflicts: []
    });

    expect(conflicts).toMatchObject([
      {
        taskA: 'task-a',
        taskB: 'task-b',
        severity: 'hard',
        constraints: [{ type: 'runtime-scope-expansion', resourceIds: ['expanded.ts'] }]
      },
      {
        taskA: 'task-a',
        taskB: 'task-c',
        severity: 'hard',
        constraints: [{ type: 'runtime-scope-expansion', resourceIds: ['other.ts'] }]
      }
    ]);
  });

  it('does not recreate an existing runtime scope-expansion conflict', () => {
    const existing: HardTaskConflict = {
      taskA: 'task-a',
      taskB: 'task-b',
      score: 100,
      severity: 'hard',
      reasons: [],
      constraints: [
        {
          type: 'runtime-scope-expansion',
          detail: 'Already recorded.',
          resourceIds: ['expanded.ts']
        }
      ],
      recommendedAction: 'serialize'
    };

    expect(
      runtimeScopeExpansionConflicts({
        taskId: 'task-a',
        expandedResources: [{ type: 'file', projectId: 'core', fileId: 'expanded.ts' }],
        bindings,
        existingHardConflicts: [existing]
      })
    ).toEqual([]);
  });
});
