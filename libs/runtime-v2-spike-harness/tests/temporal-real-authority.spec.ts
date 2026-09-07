import { Client } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

import {
  runTemporalSpikeWorkflow,
  createTemporalSpikeActivities
} from '@ai-native-software-delivery-orchestrator/temporal-spike';
import { createSqliteSpikeFixture, type SqliteSpikeFixture } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');

const environments: {
  readonly environment: TestWorkflowEnvironment;
  readonly worker: Worker;
  readonly fixture: SqliteSpikeFixture;
}[] = [];

afterEach(async () => {
  await Promise.all(
    environments.splice(0).map(async ({ environment, worker }) => {
      try {
        if (worker.getState() !== 'STOPPED') {
          worker.shutdown();
        }
        await environment.teardown();
      } catch {
        // Ignore cleanup errors
      }
    })
  );
});

describe('Temporal spike - Scenario A real authority (SQLite)', () => {
  let environment: TestWorkflowEnvironment;
  let worker: Worker;
  let client: Client;
  let fixture: SqliteSpikeFixture;
  let runId: string;

  beforeEach(async () => {
    runId = `run-temporal-real-a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    fixture = createSqliteSpikeFixture();

    environment = await TestWorkflowEnvironment.createTimeSkipping();
    const workflowPath = resolve(PROJECT_ROOT, 'libs/temporal-spike/dist/lib/temporal-spike-workflow.js');

    const service = createTemporalSpikeActivities({
      executeBuilder: async () => ({
        builderAttemptId: `builder-${runId}`,
        workspaceId: `workspace-${runId}`,
        impactPrediction: []
      }),
      evaluateBuilderOutput: async () => ({
        verificationEvidenceId: `verification-${runId}`,
        reviewSubjectRef: {
          builderAttemptId: `builder-${runId}`,
          outputAttemptId: `output-${runId}`,
          workspaceId: `workspace-${runId}`
        },
        recommendation: 'accept' as const
      }),
      executeRepair: async () => ({
        repairAttemptId: `repair-${runId}`,
        verificationEvidenceId: `verification-repair-${runId}`,
        reviewSubjectRef: {
          builderAttemptId: `builder-${runId}`,
          outputAttemptId: `output-${runId}`,
          workspaceId: `workspace-${runId}`
        },
        recommendation: 'accept' as const
      }),
      integrateAcceptedOutput: async () => ({
        integrationStatus: 'integrated' as const
      }),
      executeBlockedRepairResume: async () => ({
        repairAttemptId: `repair-${runId}`,
        verificationEvidenceId: `verification-${runId}`,
        state: 'completed' as const
      })
    });

    worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: `temporal-spike-real-a-${runId}`,
      workflowsPath: workflowPath,
      activities: service
    });
    environments.push({ environment, worker });
    client = new Client({ connection: environment.client.connection });
  });

  it('executes Scenario A with real Temporal worker and custom activities', async () => {
    const result = await worker.runUntil(
      client.workflow.execute(runTemporalSpikeWorkflow, {
        taskQueue: worker.options.taskQueue,
        workflowId: `forge-run:temporal-real-a-${runId}`,
        args: [
          {
            runId,
            scenario: 'build-review-repair-integrate',
            taskId: 'task-1',
            attemptId: 'attempt-1',
            agentId: 'agent-1'
          }
        ]
      })
    );

    expect(result.runId).toBe(runId);
    expect(result.scenario).toBe('build-review-repair-integrate');
  }, 15_000);
});
