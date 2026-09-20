import { DrizzleSqliteOrchestrationPersistence } from '@ai-native-software-delivery-orchestrator/persistence';
import type { StartRuntimeRunRequest } from '@ai-native-software-delivery-orchestrator/orchestration-runtime';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { TemporalRunLauncher } from './temporal-run-launcher.js';

const request = (runId = 'run-1'): StartRuntimeRunRequest => ({
  run: {
    id: runId,
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
        runId,
        taskId: 'task-a',
        integrationRepositoryPath: '/integration',
        workspacePath: '/workspace-a',
        branchName: `forge/${runId}/task-a`,
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
  it('initializes durable authority exactly once across recovery and concurrent connections', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'forge-temporal-launcher-'));
    const databasePath = join(directory, 'run.sqlite');
    const firstPersistence = new DrizzleSqliteOrchestrationPersistence(databasePath);
    const secondPersistence = new DrizzleSqliteOrchestrationPersistence(databasePath);
    const starts: string[] = [];
    const workflow = {
      async start(runId: string) {
        starts.push(runId);
        return { workflowId: `forge-run:${runId}`, workflowRunId: `temporal-run-${starts.length}` };
      }
    };
    try {
      const initial = request('recovered-run');
      await firstPersistence.createRun({
        run: initial.run,
        tasks: initial.tasks,
        taskBindings: initial.taskBindings.map((binding) => ({
          ...binding,
          runId: initial.run.id
        })),
        hardConflicts: [],
        riskConflicts: [],
        scheduleOptions: { maxConcurrency: 1 }
      });

      const firstLauncher = new TemporalRunLauncher({ persistence: firstPersistence, workflow });
      const secondLauncher = new TemporalRunLauncher({ persistence: secondPersistence, workflow });
      await Promise.all([
        firstLauncher.startOrResumeRun(request()),
        secondLauncher.startOrResumeRun(request())
      ]);
      const beforeRelaunch = await firstPersistence.recoverRun('run-1');
      const initialAttempt = beforeRelaunch?.attempts[0]?.attempt;
      if (beforeRelaunch === undefined || initialAttempt === undefined) {
        throw new Error('Initial launch did not persist an attempt');
      }
      await firstPersistence.persistAttempt({
        runId: 'run-1',
        attempt: {
          ...initialAttempt,
          state: 'STARTING',
          revision: initialAttempt.revision + 1,
          startedAt: new Date('2026-09-20T00:00:01.000Z')
        }
      });
      await firstLauncher.startOrResumeRun(request());
      const afterRelaunch = await firstPersistence.recoverRun('run-1');
      expect(afterRelaunch?.decisions).toHaveLength(beforeRelaunch.decisions.length);
      expect(
        afterRelaunch?.events.filter(({ event }) => event.type === 'run-started')
      ).toHaveLength(1);
      expect(afterRelaunch?.attempts).toMatchObject([
        { attempt: { state: 'STARTING', revision: 2 } }
      ]);

      await Promise.all([
        firstLauncher.startOrResumeRun(initial),
        secondLauncher.startOrResumeRun(initial)
      ]);

      await expect(firstPersistence.recoverRun('run-1')).resolves.toMatchObject({
        decisions: [expect.anything()],
        events: [{ event: { type: 'run-started' } }],
        attempts: [{ attempt: { id: 'launch:run-1:1', state: 'STARTING' } }]
      });
      await expect(firstPersistence.recoverRun('recovered-run')).resolves.toMatchObject({
        decisions: [expect.anything()],
        events: [{ event: { type: 'run-started' } }],
        attempts: [{ attempt: { id: 'launch:recovered-run:1', state: 'PREPARING' } }]
      });
      expect(starts).toHaveLength(5);
    } finally {
      firstPersistence.close();
      secondPersistence.close();
      rmSync(directory, { recursive: true, force: true });
    }
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
