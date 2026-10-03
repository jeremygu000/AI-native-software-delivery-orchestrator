import { context, propagation, trace } from '@opentelemetry/api';
import { resolve } from 'node:path';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { Client, WorkflowFailedError } from '@temporalio/client';
import { OpenTelemetryPlugin } from '@temporalio/interceptors-opentelemetry-v2';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  BlockedIntegrationContinuationActivities,
  ForgeActivities
} from '@ai-native-software-delivery-orchestrator/temporal-runtime';
import {
  ForgeSafeSpanProcessor,
  traceForgeModelRequest,
  traceForgeOperation
} from './forge-telemetry.js';

const timestampMilliseconds = ([seconds, nanoseconds]: [number, number]): number =>
  seconds * 1_000 + Math.floor(nanoseconds / 1_000_000);

describe('Forge Temporal trace propagation', () => {
  afterEach(() => {
    trace.disable();
    context.disable();
    propagation.disable();
  });

  it('links run, task, activity, and safe model spans without content attributes', async () => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const exporter = new InMemorySpanExporter();
    const spanProcessor = new ForgeSafeSpanProcessor(new SimpleSpanProcessor(exporter));
    const resource = resourceFromAttributes({ 'service.name': 'forge-test' });
    const sdk = new NodeSDK({ resource, spanProcessors: [spanProcessor] });
    sdk.start();
    const plugin = new OpenTelemetryPlugin({ resource, spanProcessor });
    let reevaluations = 0;
    const activities: ForgeActivities = {
      async reevaluateRun({ runId }) {
        return {
          runId,
          authorizedTasks:
            reevaluations++ === 0 ? [{ taskId: 'task-1', attemptId: 'builder-1' }] : []
        };
      },
      async executeBuilder({ runId, taskId, attemptId }) {
        await traceForgeModelRequest(
          {
            provider: 'deepseek',
            model: 'deepseek-flash',
            reasoningEffort: 'high',
            role: 'builder',
            runId,
            taskId,
            attemptId
          },
          async () => undefined,
          context.active()
        );
        return {
          status: 'completed',
          runId,
          taskId,
          attemptId,
          workspaceId: 'workspace-1',
          impactId: 'impact-1'
        };
      },
      async evaluateBuilderOutput({ runId, taskId, builderAttemptId }) {
        await traceForgeOperation(
          'forge.verification',
          { runId, taskId, attemptId: builderAttemptId },
          async () => ({ status: 'passed' as const }),
          (result) => result.status
        );
        await traceForgeOperation(
          'forge.review',
          { runId, taskId, attemptId: builderAttemptId },
          async () => undefined
        );
        return {
          runId,
          taskId,
          recommendation: 'repair',
          verificationId: 'verification-1',
          reviewId: 'review-1',
          subjectRef: {
            builderAttemptId,
            outputAttemptId: builderAttemptId,
            workspaceId: 'workspace-1'
          }
        };
      },
      async admitRepair({ runId, taskId }) {
        return { runId, taskId, repairAttemptId: 'repair-1' };
      },
      async executeRepair({ runId, taskId, builderAttemptId, repairAttemptId }) {
        return traceForgeOperation(
          'forge.repair',
          { runId, taskId, attemptId: repairAttemptId },
          async () => {
            await traceForgeModelRequest(
              {
                provider: 'deepseek',
                model: 'deepseek-flash',
                reasoningEffort: 'high',
                role: 'repair',
                runId,
                taskId,
                attemptId: repairAttemptId
              },
              async () => undefined
            );
            return {
              runId,
              taskId,
              state: 'completed' as const,
              repairAttemptId,
              recommendation: 'accept' as const,
              reviewId: 'review-2',
              subjectRef: {
                builderAttemptId,
                outputAttemptId: repairAttemptId,
                workspaceId: 'workspace-1'
              }
            };
          },
          (result) => result.state
        );
      },
      async integrateAcceptedOutput({ runId, taskId, subjectRef }) {
        return traceForgeOperation(
          'forge.integration',
          { runId, taskId, attemptId: subjectRef.outputAttemptId },
          async () => ({ runId, taskId, status: 'integrated' as const }),
          (result) => result.status
        );
      },
      async finalizeRunState({ runId }) {
        return { runId, status: 'completed' };
      },
      async resumeBlockedRepair() {
        throw new Error('No blocked repair expected');
      }
    };
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      workflowsPath: resolve('libs/temporal-runtime/dist/lib/workflows/forge-run.js'),
      taskQueue: 'forge-telemetry-integration',
      activities,
      plugins: [plugin]
    });
    const client = new Client({ connection: environment.client.connection, plugins: [plugin] });
    const workerPromise = worker.run();
    try {
      const result = await client.workflow.execute('forgeRunWorkflow', {
        workflowId: 'forge-run:telemetry-test',
        taskQueue: 'forge-telemetry-integration',
        args: [{ runId: 'telemetry-test' }]
      });
      expect(result).toEqual({ runId: 'telemetry-test', status: 'completed' });
      await spanProcessor.forceFlush();
      const spans = exporter.getFinishedSpans();
      const run = spans.find((span) => span.name === 'forge.run');
      const task = spans.find((span) => span.name === 'forge.task');
      const model = spans.find((span) => span.name === 'forge.model.request');
      expect(run).toBeDefined();
      expect(task).toBeDefined();
      expect(task?.parentSpanContext?.spanId).toBe(run?.spanContext().spanId);
      expect(model?.spanContext().traceId).toBe(run?.spanContext().traceId);
      for (const name of [
        'forge.model.request',
        'forge.verification',
        'forge.review',
        'forge.repair',
        'forge.integration'
      ]) {
        expect(spans.some((span) => span.name === name)).toBe(true);
      }
      for (const span of spans) {
        expect(
          Object.keys(span.attributes).every((key) =>
            [
              'run_id',
              'task_id',
              'attempt_id',
              'provider',
              'model',
              'reasoning_effort',
              'role',
              'outcome'
            ].includes(key)
          ),
          `${span.name}: ${Object.keys(span.attributes).join(', ')}`
        ).toBe(true);
        expect(span.events).toEqual([]);
        expect(span.links).toEqual([]);
        expect(span.status.message).toBeUndefined();
      }
    } finally {
      worker.shutdown();
      await workerPromise;
      await sdk.shutdown();
      await environment.teardown();
    }
  });

  it.each(['completed', 'builder-failed'] as const)(
    'settles the deferred task span after the other task: %s',
    async (scenario) => {
      const environment = await TestWorkflowEnvironment.createTimeSkipping();
      const exporter = new InMemorySpanExporter();
      const spanProcessor = new ForgeSafeSpanProcessor(new SimpleSpanProcessor(exporter));
      const resource = resourceFromAttributes({ 'service.name': 'forge-test' });
      const sdk = new NodeSDK({ resource, spanProcessors: [spanProcessor] });
      sdk.start();
      const plugin = new OpenTelemetryPlugin({ resource, spanProcessor });
      const events: string[] = [];
      let reevaluations = 0;
      let taskAEndedDuringBuilderB = false;
      const activities: ForgeActivities & BlockedIntegrationContinuationActivities = {
        async reevaluateRun({ runId }) {
          const reevaluation = reevaluations++;
          return {
            runId,
            authorizedTasks:
              reevaluation === 0
                ? [{ taskId: 'task-a', attemptId: 'builder-a' }]
                : reevaluation === 2
                  ? [{ taskId: 'task-b', attemptId: 'builder-b' }]
                  : []
          };
        },
        async executeBuilder({ runId, taskId, attemptId }) {
          events.push(`builder:${taskId}`);
          if (taskId === 'task-b') {
            taskAEndedDuringBuilderB = exporter
              .getFinishedSpans()
              .some((span) => span.name === 'forge.task' && span.attributes.task_id === 'task-a');
            if (scenario === 'builder-failed') {
              throw new Error('Builder B failed');
            }
          }
          return {
            status: 'completed',
            runId,
            taskId,
            attemptId,
            workspaceId: `workspace-${taskId}`,
            impactId: `impact-${taskId}`
          };
        },
        async evaluateBuilderOutput({ runId, taskId, workspaceId, builderAttemptId }) {
          return {
            runId,
            taskId,
            recommendation: 'accept',
            verificationId: `verification-${taskId}`,
            reviewId: `review-${taskId}`,
            subjectRef: {
              builderAttemptId,
              outputAttemptId: builderAttemptId,
              workspaceId
            }
          };
        },
        async integrateAcceptedOutput({ runId, taskId, subjectRef }) {
          events.push(`integrate:${taskId}`);
          return traceForgeOperation(
            'forge.integration',
            { runId, taskId, attemptId: subjectRef.outputAttemptId },
            async () => ({
              runId,
              taskId,
              status: taskId === 'task-a' ? ('blocked' as const) : ('integrated' as const)
            }),
            (result) => result.status
          );
        },
        async resumeBlockedIntegration({ runId, taskId, subjectRef }) {
          events.push(`resume:${taskId}`);
          return traceForgeOperation(
            'forge.integration',
            { runId, taskId, attemptId: subjectRef.outputAttemptId },
            async () => ({ runId, taskId, status: 'integrated' as const }),
            (result) => result.status
          );
        },
        async finalizeRunState({ runId }) {
          return { runId, status: 'completed' };
        },
        async admitRepair() {
          throw new Error('No repair expected');
        },
        async executeRepair() {
          throw new Error('No repair expected');
        },
        async resumeBlockedRepair() {
          throw new Error('No blocked repair expected');
        }
      };
      const worker = await Worker.create({
        connection: environment.nativeConnection,
        workflowsPath: resolve('libs/temporal-runtime/dist/lib/workflows/forge-run.js'),
        taskQueue: 'forge-telemetry-deferred-integration',
        activities,
        plugins: [plugin]
      });
      const client = new Client({ connection: environment.client.connection, plugins: [plugin] });
      const workerPromise = worker.run();
      try {
        const execution = client.workflow.execute('forgeRunWorkflow', {
          workflowId: 'forge-run:telemetry-deferred-test',
          taskQueue: 'forge-telemetry-deferred-integration',
          args: [{ runId: 'telemetry-deferred-test' }]
        });
        if (scenario === 'builder-failed') {
          await expect(execution).rejects.toBeInstanceOf(WorkflowFailedError);
        } else {
          expect(await execution).toEqual({
            runId: 'telemetry-deferred-test',
            status: 'completed'
          });
        }
        expect(events).toEqual([
          'builder:task-a',
          'integrate:task-a',
          'builder:task-b',
          ...(scenario === 'completed' ? ['integrate:task-b', 'resume:task-a'] : [])
        ]);
        await spanProcessor.forceFlush();
        const spans = exporter.getFinishedSpans();
        const taskA = spans.find(
          (span) => span.name === 'forge.task' && span.attributes.task_id === 'task-a'
        );
        expect(taskA).toBeDefined();
        expect(taskAEndedDuringBuilderB).toBe(false);
        if (scenario === 'builder-failed') {
          expect(taskA?.attributes.outcome).toBe('error');
          return;
        }
        const resumedIntegration = spans.find(
          (span) =>
            span.name === 'forge.integration' &&
            span.attributes.task_id === 'task-a' &&
            span.attributes.outcome === 'integrated'
        );
        expect(resumedIntegration).toBeDefined();
        // Temporal inserts scheduling and execution spans before the operation.
        const ancestors = [];
        let parentId = resumedIntegration?.parentSpanContext?.spanId;
        while (parentId !== undefined) {
          const parent = spans.find((span) => span.spanContext().spanId === parentId);
          if (parent === undefined) {
            break;
          }
          ancestors.push(parent);
          parentId = parent.parentSpanContext?.spanId;
        }
        expect(ancestors.find((span) => span.name === 'forge.task')?.spanContext().spanId).toBe(
          taskA?.spanContext().spanId
        );
        expect(resumedIntegration?.spanContext().traceId).toBe(taskA?.spanContext().traceId);
        if (taskA === undefined || resumedIntegration === undefined) {
          throw new Error('Missing deferred task or resumed integration span');
        }
        // Workflow time has millisecond precision; host operation time has nanoseconds.
        expect(timestampMilliseconds(taskA.endTime)).toBeGreaterThanOrEqual(
          timestampMilliseconds(resumedIntegration.endTime)
        );
        expect(spans.indexOf(taskA)).toBeGreaterThan(spans.indexOf(resumedIntegration));
        expect(taskA.attributes.outcome).toBe('integrated');
      } finally {
        worker.shutdown();
        await workerPromise;
        await sdk.shutdown();
        await environment.teardown();
      }
    }
  );
});
