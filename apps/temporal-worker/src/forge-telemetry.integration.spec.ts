import { context } from '@opentelemetry/api';
import { resolve } from 'node:path';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { Client } from '@temporalio/client';
import { OpenTelemetryPlugin } from '@temporalio/interceptors-opentelemetry-v2';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { describe, expect, it } from 'vitest';
import type { ForgeActivities } from '@ai-native-software-delivery-orchestrator/temporal-runtime';
import {
  ForgeSafeSpanProcessor,
  traceForgeModelRequest,
  traceForgeOperation
} from './forge-telemetry.js';

describe('Forge Temporal trace propagation', () => {
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
});
