import { Client } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

import { createTemporalSpikeActivities } from './temporal-spike-activities.js';
import { runTemporalSpikeWorkflow } from './temporal-spike-workflow.js';

const environments: { readonly environment: TestWorkflowEnvironment; readonly worker: Worker }[] =
  [];

afterEach(async () => {
  await Promise.all(
    environments.splice(0).map(async ({ environment, worker }) => {
      if (worker.getState() !== 'STOPPED') {
        worker.shutdown();
      }
      await environment.teardown();
    })
  );
});

describe('Temporal spike workflow', () => {
  it('executes deterministic workflow control flow through narrow activity boundaries', async () => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'temporal-spike-test',
      workflowsPath: fileURLToPath(new URL('./temporal-spike-workflow.ts', import.meta.url)),
      activities: createTemporalSpikeActivities({
        executeBuilder: async () => ({
          builderAttemptId: 'builder-1',
          workspaceId: 'workspace-1',
          impactPrediction: []
        }),
        evaluateBuilderOutput: async () => ({
          verificationEvidenceId: 'verification-1',
          reviewSubjectRef: {
            builderAttemptId: 'builder-1',
            outputAttemptId: 'output-1',
            workspaceId: 'workspace-1'
          },
          recommendation: 'accept' as const
        }),
        executeRepair: async () => ({
          repairAttemptId: 'repair-1',
          verificationEvidenceId: 'repair-verification-1',
          reviewSubjectRef: {
            builderAttemptId: 'builder-1',
            outputAttemptId: 'output-1',
            workspaceId: 'workspace-1'
          },
          recommendation: 'accept' as const
        }),
        integrateAcceptedOutput: async () => ({ integrationStatus: 'integrated' as const }),
        runBuildReviewRepairIntegrate: async () => ({
          builderAttemptId: 'builder-1',
          finalRepairAttemptId: 'repair-1',
          verificationEvidenceId: 'verification-1',
          reviewSubjectRef: {
            builderAttemptId: 'builder-1',
            outputAttemptId: 'output-1',
            workspaceId: 'workspace-1'
          }
        }),
        executeBlockedRepairResume: async () => ({
          repairAttemptId: 'repair-1',
          verificationEvidenceId: 'verification-1'
        })
      })
    });
    environments.push({ environment, worker });
    const client = new Client({ connection: environment.client.connection });
    const result = await worker.runUntil(
      client.workflow.execute(runTemporalSpikeWorkflow, {
        taskQueue: 'temporal-spike-test',
        workflowId: 'forge-run:run-1',
        args: [
          {
            runId: 'run-1',
            scenario: 'build-review-repair-integrate',
            taskId: 'task-1',
            attemptId: 'attempt-1',
            agentId: 'agent-1'
          }
        ]
      })
    );
    expect(result.runId).toBe('run-1');
    expect(result.scenario).toBe('build-review-repair-integrate');
    expect(result.builderAttemptId).toBe('builder-1');
  }, 15_000);

  it('calls executeBlockedRepairResume for blocked-repair-restart-resume scenario', async () => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    let resumeActivityCalled = false;
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'temporal-spike-test-blocked',
      workflowsPath: fileURLToPath(new URL('./temporal-spike-workflow.ts', import.meta.url)),
      activities: createTemporalSpikeActivities({
        executeBuilder: async () => ({
          builderAttemptId: 'builder-1',
          workspaceId: 'workspace-1',
          impactPrediction: []
        }),
        evaluateBuilderOutput: async () => ({
          verificationEvidenceId: 'verification-1',
          reviewSubjectRef: {
            builderAttemptId: 'builder-1',
            outputAttemptId: 'output-1',
            workspaceId: 'workspace-1'
          },
          recommendation: 'accept' as const
        }),
        executeRepair: async () => ({
          repairAttemptId: 'repair-1',
          verificationEvidenceId: 'repair-verification-1',
          reviewSubjectRef: {
            builderAttemptId: 'builder-1',
            outputAttemptId: 'output-1',
            workspaceId: 'workspace-1'
          },
          recommendation: 'accept' as const
        }),
        integrateAcceptedOutput: async () => ({ integrationStatus: 'integrated' as const }),
        runBuildReviewRepairIntegrate: async () => ({
          builderAttemptId: 'builder-1',
          finalRepairAttemptId: 'repair-1',
          verificationEvidenceId: 'verification-1',
          reviewSubjectRef: {
            builderAttemptId: 'builder-1',
            outputAttemptId: 'output-1',
            workspaceId: 'workspace-1'
          }
        }),
        executeBlockedRepairResume: async (request) => {
          resumeActivityCalled = true;
          return {
            repairAttemptId: request.repairAttemptId,
            verificationEvidenceId: 'resume-verification-1'
          };
        }
      })
    });
    environments.push({ environment, worker });
    const client = new Client({ connection: environment.client.connection });
    const result = await worker.runUntil(
      client.workflow.execute(runTemporalSpikeWorkflow, {
        taskQueue: 'temporal-spike-test-blocked',
        workflowId: 'forge-run:run-blocked',
        args: [
          {
            runId: 'run-blocked',
            scenario: 'blocked-repair-restart-resume',
            blockedRepairAttemptId: 'blocked-repair-1'
          }
        ]
      })
    );
    expect(result.runId).toBe('run-blocked');
    expect(result.scenario).toBe('blocked-repair-restart-resume');
    expect(result.repairAttemptId).toBe('blocked-repair-1');
    expect(resumeActivityCalled).toBe(true);
  }, 15_000);
});
