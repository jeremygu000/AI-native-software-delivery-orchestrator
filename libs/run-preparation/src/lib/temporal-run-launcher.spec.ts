import { DrizzleSqliteOrchestrationPersistence } from '@ai-native-software-delivery-orchestrator/persistence';
import type { StartRuntimeRunRequest } from '@ai-native-software-delivery-orchestrator/orchestration-runtime';
import { describe, expect, it } from 'vitest';

import { TemporalRunLauncher } from './temporal-run-launcher.js';

const request = (): StartRuntimeRunRequest => ({
  run: {
    id: 'run-1',
    repositoryId: 'repository-1',
    state: 'ACTIVE',
    createdAt: '2026-09-20T00:00:00.000Z',
    authority: {
      artifactId: 'artifact-1',
      artifactRevision: 1,
      approvalId: 'approval-1',
      planFingerprint: `sha256:${'1'.repeat(64)}`,
      approvalFingerprint: `sha256:${'2'.repeat(64)}`,
      claimFingerprint: `sha256:${'3'.repeat(64)}`,
      executionFingerprint: `sha256:${'4'.repeat(64)}`,
      repositoryRoot: '/repository',
      baseCommit: '5'.repeat(40),
      workingTreeFingerprint: `sha256:${'6'.repeat(64)}`,
      repositoryFactsFingerprint: `sha256:${'7'.repeat(64)}`,
      sharedResourcePolicyFingerprint: `sha256:${'8'.repeat(64)}`,
      verificationPolicyFingerprint: `sha256:${'9'.repeat(64)}`,
      codeReviewPolicyFingerprint: `sha256:${'a'.repeat(64)}`
    }
  },
  tasks: [
    {
      id: 'task-a',
      title: 'Task A',
      goal: 'Complete Task A',
      dependencies: [],
      expectedReads: [],
      expectedWrites: [],
      sharedResources: [],
      verification: []
    }
  ],
  taskBindings: [
    {
      taskId: 'task-a',
      agentId: 'agent-a',
      leasePlan: {
        taskId: 'task-a',
        predictedResources: [{ type: 'project', projectId: 'project-a' }],
        source: 'manual'
      },
      workspace: {
        id: 'workspace-a',
        runId: 'run-1',
        taskId: 'task-a',
        integrationRepositoryPath: '/integration',
        workspacePath: '/workspace-a',
        branchName: 'forge/run-1/task-a',
        baseRef: 'main',
        integrationRef: 'main'
      }
    }
  ],
  hardConflicts: [],
  riskConflicts: [],
  scheduleOptions: { maxConcurrency: 1 }
});

describe('TemporalRunLauncher', () => {
  it('initializes durable authority once and starts the stable workflow', async () => {
    const persistence = new DrizzleSqliteOrchestrationPersistence(':memory:');
    const starts: string[] = [];
    const launcher = new TemporalRunLauncher({
      persistence,
      workflow: {
        async start(runId) {
          starts.push(runId);
          return { workflowId: `forge-run:${runId}`, workflowRunId: 'temporal-run-1' };
        }
      }
    });

    await expect(launcher.startOrResumeRun(request())).resolves.toEqual({
      runId: 'run-1',
      workflowId: 'forge-run:run-1',
      workflowRunId: 'temporal-run-1'
    });
    await launcher.startOrResumeRun(request());

    expect(starts).toEqual(['run-1', 'run-1']);
    expect((await persistence.recoverRun('run-1'))?.decisions).toHaveLength(1);
    persistence.close();
  });

  it('rejects a reused run ID with changed durable authority', async () => {
    const persistence = new DrizzleSqliteOrchestrationPersistence(':memory:');
    const launcher = new TemporalRunLauncher({
      persistence,
      workflow: {
        async start(runId) {
          return { workflowId: `forge-run:${runId}`, workflowRunId: 'temporal-run-1' };
        }
      }
    });
    await launcher.startOrResumeRun(request());
    const initial = request();
    const changed: StartRuntimeRunRequest = {
      ...initial,
      tasks: [{ ...initial.tasks[0], goal: 'Changed task authority' }]
    };

    await expect(launcher.startOrResumeRun(changed)).rejects.toThrow(
      'Temporal launch authority mismatch: run-1'
    );
    persistence.close();
  });
});
