import { NativeConnection, Worker } from '@temporalio/worker';
import { Context, heartbeat } from '@temporalio/activity';
import {
  PostgresGlobalMutationAuthority,
  PostgresOrchestrationPersistence
} from '@ai-native-software-delivery-orchestrator/postgres-persistence';
import { ApprovedPiHostModelProxy } from '@ai-native-software-delivery-orchestrator/agent-runtime';
import { PostgresExecutionChildTools } from '../src/postgres-execution-child.ts';
import { createPostgresDockerChildRunner } from '../src/postgres-docker-child-runner.ts';

process.once('message', async (configuration) => {
  try {
    const authority = await PostgresGlobalMutationAuthority.connect(configuration.database);
    const persistence = await PostgresOrchestrationPersistence.connect(configuration.database);
    const heldPersistence = new Proxy(persistence, {
      get(target, key) {
        if (key === 'persistImpact') {
          return async (request) => {
            await target.persistImpact(request);
            process.send?.({
              type: 'callback-held',
              identity: 'fleet-loss-original-process',
              attempt: Context.current().info.attempt,
              pid: process.pid
            });
            await new Promise(() => {});
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    const tools = new PostgresExecutionChildTools({
      authority,
      persistence: heldPersistence,
      resolveResource: () => ({ type: 'project', projectId: 'project' }),
      resolveFileId: (path) => `project:${path}`
    });
    const runner = createPostgresDockerChildRunner({
      authority,
      tools,
      image: configuration.image,
      executable: '/usr/local/bin/node',
      args: ['/opt/forge/entrypoint.mjs'],
      modelProxy: new ApprovedPiHostModelProxy({
        model: {
          api: 'openai-completions',
          provider: 'openai',
          id: 'approved',
          name: 'Approved',
          baseUrl: 'http://host-only.invalid',
          reasoning: false,
          input: ['text'],
          contextWindow: 32768,
          maxTokens: 1024,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        },
        apiKey: 'fixture-host-only',
        complete: async (model) => ({
          role: 'assistant',
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: [
            {
              type: 'toolCall',
              id: 'loss-write',
              name: 'forge_write',
              arguments: { path: 'approved.txt', content: 'written-before-process-loss' }
            }
          ],
          stopReason: 'toolUse',
          timestamp: Date.now(),
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          }
        })
      })
    });
    const connection = await NativeConnection.connect({ address: configuration.address });
    const worker = await Worker.create({
      connection,
      identity: 'fleet-loss-original-process',
      taskQueue: configuration.taskQueue,
      workflowsPath: configuration.workflowsPath,
      maxCachedWorkflows: 0,
      activities: {
        executeBuilder: async (input) => {
          const timer = setInterval(() => heartbeat('live-host-callback'), 250);
          try {
            const recovered = await persistence.recoverRun(input.runId);
            const attempt = recovered.attempts.find(
              (item) => item.attempt.id === input.attemptId
            ).attempt;
            const parent = await authority.recoverExecutionParent(input.runId, input.attemptId);
            return await runner.run(parent.scopeId, parent.parentClaimId, {
              runId: input.runId,
              taskId: input.taskId,
              task: recovered.tasks.find((task) => task.id === input.taskId),
              attempt,
              workspace: recovered.workspaces.find((item) => item.workspace.taskId === input.taskId)
                ?.workspace,
              instructions: 'Write approved output',
              onStarted: async () => {}
            });
          } finally {
            clearInterval(timer);
          }
        }
      }
    });
    process.send?.({ type: 'ready' });
    await worker.run();
  } catch (error) {
    process.send?.({ type: 'failed', detail: String(error) });
    process.exitCode = 1;
  }
});
