import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';

import type {
  AgentRunner,
  TaskVerifier,
  RepositoryGraph
} from '@ai-native-software-delivery-orchestrator/domain';
import { analyzeRepository } from '@ai-native-software-delivery-orchestrator/repository-analysis';
import {
  ConflictSeverity,
  OrchestrationRunState,
  TaskState,
  taskLeasePlanFromPredictedImpact
} from '@ai-native-software-delivery-orchestrator/domain';
import {
  FakeAgentRunner,
  FakeTaskVerifier,
  OrchestrationRuntime
} from '@ai-native-software-delivery-orchestrator/orchestration-runtime';
import { DrizzleSqliteOrchestrationPersistence } from '@ai-native-software-delivery-orchestrator/persistence';
import { InMemoryWriteGuard } from '@ai-native-software-delivery-orchestrator/runtime-guard';
import { DeterministicScheduler } from '@ai-native-software-delivery-orchestrator/scheduler';
import { GitWorkspaceManager } from '@ai-native-software-delivery-orchestrator/workspace-git';
import {
  AgentToolRuntime,
  PiAgentRunner,
  PiCodingAgentGateway,
  type PiSessionGateway
} from '@ai-native-software-delivery-orchestrator/agent-runtime';

import { LocalPlanStore } from './local-plan.js';
import {
  LocalTaskCompletionPipeline,
  PiOutputReviewer,
  RepositoryTaskVerifier,
  type OutputReviewer
} from './task-completion.js';

export async function runLocalPlan(
  store: LocalPlanStore,
  planId: string,
  options: {
    readonly agentRunner?: AgentRunner;
    readonly executionMode?: 'controlled' | 'live';
    readonly liveGateway?: PiSessionGateway;
    readonly verifier?: TaskVerifier;
    readonly verificationMode?: 'fake' | 'repository' | 'custom';
    readonly completion?: {
      readonly graph?: RepositoryGraph;
      readonly reviewer?: OutputReviewer;
    };
  } = {}
) {
  const pending = await store.load(planId);
  const execution = options.executionMode ?? 'controlled';
  if (
    execution === 'live' &&
    (options.verificationMode !== 'repository' || options.completion === undefined)
  ) {
    throw new Error('Live execution requires repository verification and output review.');
  }
  if (execution === 'live' && options.agentRunner !== undefined) {
    throw new Error('Live execution uses the Pi writer, not an injected controlled agent.');
  }
  if (options.verifier !== undefined && options.verificationMode === undefined) {
    throw new Error('An injected verifier requires an explicit verificationMode.');
  }
  if (options.verificationMode === 'custom' && options.verifier === undefined) {
    throw new Error('Custom verification requires an injected verifier.');
  }
  if (options.verificationMode === 'repository' && options.completion === undefined) {
    throw new Error('Repository verification requires the completion pipeline.');
  }
  const graph =
    options.completion === undefined
      ? undefined
      : (options.completion.graph ?? (await analyzeRepository(pending.repository)).graph);
  const verification = options.verificationMode ?? 'fake';
  const branch = await promisify(execFile)('git', ['symbolic-ref', '--short', 'HEAD'], {
    cwd: pending.repository
  });
  const plan = await store.beginRun(planId);
  const directory = join(store.directory, 'runs', plan.runId);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'run.json'),
    JSON.stringify(
      {
        id: plan.runId,
        planId,
        execution,
        verification,
        completion: options.completion === undefined ? 'legacy' : 'reviewed',
        review:
          options.completion === undefined
            ? 'none'
            : options.completion.reviewer === undefined
              ? 'live-pi'
              : 'custom'
      },
      null,
      2
    )
  );
  const persistence = new DrizzleSqliteOrchestrationPersistence(join(directory, 'state.sqlite'));
  try {
    const writeGuard = new InMemoryWriteGuard();
    const agentRunner =
      execution === 'live' && graph !== undefined
        ? new PiAgentRunner({
            gateway: options.liveGateway ?? new PiCodingAgentGateway(),
            createTools: (request) => {
              const fileFor = (path: string) =>
                [...graph.files.values()].find((file) => file.path === path);
              const projectFor = (path: string) => {
                const project = [...graph.projects.values()]
                  .filter(
                    (candidate) =>
                      candidate.root === '.' ||
                      path === candidate.root ||
                      path.startsWith(`${candidate.root}/`)
                  )
                  .toSorted((a, b) => b.root.length - a.root.length)[0];
                if (project === undefined) {
                  throw new Error(`No repository project for workspace path: ${path}`);
                }
                return project;
              };
              return new AgentToolRuntime({
                runId: request.runId,
                taskId: request.taskId,
                attemptId: request.attempt.id,
                agentId: request.attempt.agentId,
                workspacePath: request.workspace.workspacePath,
                persistence,
                writeGuard,
                resolveFileId: (path) => fileFor(path)?.id ?? `${projectFor(path).id}:${path}`,
                resolveResource: (path) => {
                  const file = fileFor(path);
                  return file === undefined
                    ? { type: 'project', projectId: projectFor(path).id }
                    : { type: 'file', projectId: file.projectId, fileId: file.id };
                }
              });
            }
          })
        : (options.agentRunner ?? new FakeAgentRunner());
    const verifier =
      options.verifier ??
      (verification === 'repository' && graph !== undefined
        ? new RepositoryTaskVerifier(graph)
        : new FakeTaskVerifier());
    const runtime = new OrchestrationRuntime({
      scheduler: new DeterministicScheduler(),
      persistence,
      workspaceManager: (() => {
        const manager = new GitWorkspaceManager();
        return {
          create: async (request: Parameters<typeof manager.create>[0]) => {
            const task = plan.tasks.find((candidate) => candidate.id === request.taskId)!;
            if (task.dependencies.length === 0) {
              return manager.create(request);
            }
            const head = await promisify(execFile)('git', ['rev-parse', request.integrationRef], {
              cwd: request.integrationRepositoryPath
            });
            return manager.create({ ...request, baseRef: head.stdout.trim() });
          },
          commit: (request: Parameters<typeof manager.commit>[0]) => manager.commit(request),
          integrate: (workspace: Parameters<typeof manager.integrate>[0]) =>
            manager.integrate(workspace),
          resumeIntegration: (workspace: Parameters<typeof manager.resumeIntegration>[0]) =>
            manager.resumeIntegration(workspace),
          abortIntegration: (workspace: Parameters<typeof manager.abortIntegration>[0]) =>
            manager.abortIntegration(workspace),
          dispose: (request: Parameters<typeof manager.dispose>[0]) => manager.dispose(request)
        };
      })(),
      writeGuard,
      agentRunner,
      verifier,
      completionGate:
        options.completion !== undefined && graph !== undefined
          ? new LocalTaskCompletionPipeline({
              graph,
              impacts: plan.impacts,
              verifier,
              reviewer: options.completion.reviewer ?? new PiOutputReviewer(),
              evidenceDirectory: join(directory, 'completion')
            })
          : undefined
    });
    const recovered = await runtime.startRun({
      run: {
        id: plan.runId,
        repositoryId: plan.repository,
        state: OrchestrationRunState.ACTIVE,
        createdAt: new Date().toISOString()
      },
      tasks: plan.tasks,
      hardConflicts: plan.conflicts.filter(
        (conflict) => conflict.severity === ConflictSeverity.hard
      ),
      riskConflicts: plan.conflicts.filter(
        (conflict) => conflict.severity !== ConflictSeverity.hard
      ),
      scheduleOptions: plan.schedule,
      taskBindings: plan.tasks.map((task, index) => {
        const impact = plan.impacts.find((candidate) => candidate.taskId === task.id)!;
        return {
          taskId: task.id,
          agentId: `local-agent-${index + 1}`,
          impact: { predicted: impact },
          leasePlan: taskLeasePlanFromPredictedImpact({
            ...impact,
            projectsWritten: impact.explicitProjectsWritten
          }),
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
    let finalRepository;
    if (
      execution === 'live' &&
      graph !== undefined &&
      recovered.snapshot.taskStates.every((task) => task.state === TaskState.COMPLETED)
    ) {
      const lastWorkspace = recovered.workspaces.at(-1)?.workspace;
      if (lastWorkspace === undefined) {
        throw new Error('Completed live run has no recorded workspace.');
      }
      const firstTask = plan.tasks[0];
      if (firstTask === undefined) {
        throw new Error('Completed live run has no planned task.');
      }
      const finalVerification = await new RepositoryTaskVerifier(graph).verify({
        runId: plan.runId,
        task: {
          ...firstTask,
          verification: [
            ...new Map(
              plan.tasks
                .flatMap((task) => task.verification)
                .map((rule) => [JSON.stringify(rule), rule])
            ).values()
          ]
        },
        workspace: { ...lastWorkspace, workspacePath: plan.repository }
      });
      const head = await promisify(execFile)('git', ['rev-parse', 'HEAD'], {
        cwd: plan.repository
      });
      const status = await promisify(execFile)('git', ['status', '--porcelain'], {
        cwd: plan.repository
      });
      finalRepository = {
        ...finalVerification,
        head: head.stdout.trim(),
        clean: status.stdout.trim() === ''
      };
      if (!finalRepository.clean) {
        finalRepository = {
          ...finalRepository,
          status: 'failed' as const,
          detail: 'Final integration repository has uncommitted changes.'
        };
      }
      const metadataPath = join(directory, 'run.json');
      await writeFile(
        metadataPath,
        JSON.stringify(
          {
            id: plan.runId,
            planId,
            execution,
            verification,
            completion: 'reviewed',
            review: options.completion?.reviewer === undefined ? 'live-pi' : 'custom',
            finalRepository
          },
          null,
          2
        )
      );
    }
    return {
      runId: plan.runId,
      planId,
      execution,
      verification,
      completion: options.completion === undefined ? 'legacy' : 'reviewed',
      taskStates: recovered.snapshot.taskStates,
      directory,
      finalRepository
    };
  } finally {
    persistence.close();
  }
}
