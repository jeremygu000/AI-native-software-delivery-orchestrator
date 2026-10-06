import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';

import type { AgentRunner, TaskVerifier } from '@ai-native-software-delivery-orchestrator/domain';
import { taskLeasePlanFromPredictedImpact } from '@ai-native-software-delivery-orchestrator/domain';
import {
  FakeAgentRunner,
  FakeTaskVerifier,
  OrchestrationRuntime
} from '@ai-native-software-delivery-orchestrator/orchestration-runtime';
import { DrizzleSqliteOrchestrationPersistence } from '@ai-native-software-delivery-orchestrator/persistence';
import { InMemoryWriteGuard } from '@ai-native-software-delivery-orchestrator/runtime-guard';
import { DeterministicScheduler } from '@ai-native-software-delivery-orchestrator/scheduler';
import { GitWorkspaceManager } from '@ai-native-software-delivery-orchestrator/workspace-git';

import { LocalPlanStore } from './local-plan.js';

export async function runLocalPlan(
  store: LocalPlanStore,
  planId: string,
  options: {
    readonly agentRunner?: AgentRunner;
    readonly verifier?: TaskVerifier;
  } = {}
) {
  const pending = await store.load(planId);
  const branch = await promisify(execFile)('git', ['symbolic-ref', '--short', 'HEAD'], {
    cwd: pending.repository
  });
  const plan = await store.beginRun(planId);
  const directory = join(store.directory, 'runs', plan.runId);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'run.json'),
    JSON.stringify(
      { id: plan.runId, planId, execution: 'controlled', verification: 'fake' },
      null,
      2
    )
  );
  const persistence = new DrizzleSqliteOrchestrationPersistence(join(directory, 'state.sqlite'));
  try {
    const runtime = new OrchestrationRuntime({
      scheduler: new DeterministicScheduler(),
      persistence,
      workspaceManager: new GitWorkspaceManager(),
      writeGuard: new InMemoryWriteGuard(),
      agentRunner: options.agentRunner ?? new FakeAgentRunner(),
      verifier: options.verifier ?? new FakeTaskVerifier()
    });
    const recovered = await runtime.startRun({
      run: {
        id: plan.runId,
        repositoryId: plan.repository,
        state: 'ACTIVE',
        createdAt: new Date().toISOString()
      },
      tasks: plan.tasks,
      hardConflicts: plan.conflicts.filter((conflict) => conflict.severity === 'hard'),
      riskConflicts: plan.conflicts.filter((conflict) => conflict.severity !== 'hard'),
      scheduleOptions: plan.schedule,
      taskBindings: plan.tasks.map((task, index) => {
        const impact = plan.impacts.find((candidate) => candidate.taskId === task.id)!;
        return {
          taskId: task.id,
          agentId: `local-agent-${index + 1}`,
          impact: { predicted: impact },
          leasePlan: taskLeasePlanFromPredictedImpact(impact),
          workspace: {
            id: `workspace-${index + 1}`,
            runId: plan.runId,
            taskId: task.id,
            integrationRepositoryPath: plan.repository,
            workspacePath: join(directory, `task-${index + 1}`),
            branchName: `forge/${plan.runId}/task-${index + 1}`,
            baseRef: plan.repositoryCommit,
            integrationRef: branch.stdout.trim()
          }
        };
      })
    });
    return {
      runId: plan.runId,
      planId,
      execution: 'controlled',
      verification: 'fake',
      taskStates: recovered.snapshot.taskStates,
      directory
    };
  } finally {
    persistence.close();
  }
}
