import { Client } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

import { runTemporalSpikeWorkflow, repairWakeSignal } from './temporal-spike-workflow.js';
import { createTemporalSpikeHarness } from './shared-harness.js';
import { assertDurableExecutionSpikeOutcome } from '@ai-native-software-delivery-orchestrator/orchestration-runtime';

const environments: { readonly environment: TestWorkflowEnvironment; readonly worker: Worker }[] =
  [];

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

describe('Temporal spike workflow - Scenario A (build-review-repair-integrate)', () => {
  let environment: TestWorkflowEnvironment;
  let worker: Worker;
  let client: Client;

  beforeEach(async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
    worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'temporal-spike-test-scenario-a',
      workflowsPath: fileURLToPath(new URL('./temporal-spike-workflow.ts', import.meta.url))
    });
    environments.push({ environment, worker });
    client = new Client({ connection: environment.client.connection });
  });

  it('executes Scenario A and outcome passes assertDurableExecutionSpikeOutcome', async () => {
    const harness = createTemporalSpikeHarness({
      runId: 'run-temporal-a-1',
      scenario: 'build-review-repair-integrate'
    });
    const harnessOutcome = await harness.runBuildReviewRepairIntegrate();

    const result = await worker.runUntil(
      client.workflow.execute(runTemporalSpikeWorkflow, {
        taskQueue: 'temporal-spike-test-scenario-a',
        workflowId: 'forge-run:temporal-a-1',
        args: [
          {
            runId: 'run-temporal-a-1',
            scenario: 'build-review-repair-integrate',
            taskId: 'task-1',
            attemptId: 'attempt-1',
            agentId: 'agent-1',
            harnessOutcome
          }
        ]
      })
    );

    expect(result).toBeDefined();
    expect(result.builderAttempt).toBeDefined();
    expect(result.builderAttempt.state).toBe('COMPLETED');
    expect(result.repairs).toHaveLength(1);
    expect(result.verifications).toHaveLength(1);
    expect(result.reviews).toHaveLength(1);
    expect(result.integration.status).toBe('integrated');

    assertDurableExecutionSpikeOutcome({
      outcome: result,
      scenario: 'build-review-repair-integrate'
    });
  }, 15_000);

  it('proves builderAttempt is COMPLETED and repairs exist', async () => {
    const harness = createTemporalSpikeHarness({
      runId: 'run-temporal-a-builder',
      scenario: 'build-review-repair-integrate'
    });
    const harnessOutcome = await harness.runBuildReviewRepairIntegrate();

    const result = await worker.runUntil(
      client.workflow.execute(runTemporalSpikeWorkflow, {
        taskQueue: 'temporal-spike-test-scenario-a',
        workflowId: 'forge-run:temporal-a-builder',
        args: [
          {
            runId: 'run-temporal-a-builder',
            scenario: 'build-review-repair-integrate',
            taskId: 'task-builder',
            attemptId: 'attempt-builder',
            agentId: 'agent-builder',
            harnessOutcome
          }
        ]
      })
    );

    expect(result.builderAttempt.state).toBe('COMPLETED');
    expect(result.repairs[0].state).toBe('COMPLETED');
    expect(result.repairs[0].repairIteration).toBe(1);

    assertDurableExecutionSpikeOutcome({
      outcome: result,
      scenario: 'build-review-repair-integrate'
    });
  }, 15_000);
});

describe('Temporal spike workflow - Scenario B (blocked-repair-restart-resume)', () => {
  let environment: TestWorkflowEnvironment;
  let worker: Worker;
  let client: Client;

  beforeEach(async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
    worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'temporal-spike-test-scenario-b',
      workflowsPath: fileURLToPath(new URL('./temporal-spike-workflow.ts', import.meta.url))
    });
    environments.push({ environment, worker });
    client = new Client({ connection: environment.client.connection });
  });

  it('waits for repairWake signal and outcome passes assertDurableExecutionSpikeOutcome', async () => {
    const harness = createTemporalSpikeHarness({
      runId: 'run-temporal-b-1',
      scenario: 'blocked-repair-restart-resume',
      blockedRepairAttemptId: 'blocked-repair-1'
    });
    const harnessOutcome = await harness.runBlockedRepairRestartResume();

    const handle = await client.workflow.start(runTemporalSpikeWorkflow, {
      taskQueue: 'temporal-spike-test-scenario-b',
      workflowId: 'forge-run:temporal-b-1',
      args: [
        {
          runId: 'run-temporal-b-1',
          scenario: 'blocked-repair-restart-resume',
          blockedRepairAttemptId: 'blocked-repair-1',
          harnessOutcome
        }
      ]
    });

    await environment.sleep(100);

    await handle.signal(repairWakeSignal, {
      repairAttemptId: 'blocked-repair-1',
      leaseState: 'RELEASED'
    });

    const result = await worker.runUntil(handle.result());

    expect(result).toBeDefined();
    expect(result.builderAttempt).toBeDefined();
    expect(result.blockedResume).toBeDefined();
    expect(result.blockedResume?.repairAttemptId).toBe(result.repairs[0].id);
    expect(result.blockedResume?.releaseState).toBe('RELEASED');

    assertDurableExecutionSpikeOutcome({
      outcome: result,
      scenario: 'blocked-repair-restart-resume'
    });
  }, 15_000);

  it('ignores unrelated wake signals and continues waiting', async () => {
    const harness = createTemporalSpikeHarness({
      runId: 'run-temporal-b-unrelated',
      scenario: 'blocked-repair-restart-resume',
      blockedRepairAttemptId: 'blocked-repair-1'
    });
    const harnessOutcome = await harness.runBlockedRepairRestartResume();

    const handle = await client.workflow.start(runTemporalSpikeWorkflow, {
      taskQueue: 'temporal-spike-test-scenario-b',
      workflowId: 'forge-run:temporal-b-unrelated',
      args: [
        {
          runId: 'run-temporal-b-unrelated',
          scenario: 'blocked-repair-restart-resume',
          blockedRepairAttemptId: 'blocked-repair-1',
          harnessOutcome
        }
      ]
    });

    await environment.sleep(100);

    await handle.signal(repairWakeSignal, {
      repairAttemptId: 'other-repair-id',
      leaseState: 'RELEASED'
    });

    await environment.sleep(100);

    await handle.signal(repairWakeSignal, {
      repairAttemptId: 'blocked-repair-1',
      leaseState: 'RELEASED'
    });

    const result = await worker.runUntil(handle.result());

    expect(result.blockedResume).toBeDefined();
    expect(result.blockedResume?.repairAttemptId).toBe(result.repairs[0].id);
  }, 15_000);

  it('STALE leaseState also triggers resume', async () => {
    const harness = createTemporalSpikeHarness({
      runId: 'run-temporal-b-stale',
      scenario: 'blocked-repair-restart-resume',
      blockedRepairAttemptId: 'blocked-repair-1'
    });
    const harnessOutcome = await harness.runBlockedRepairRestartResume();

    const handle = await client.workflow.start(runTemporalSpikeWorkflow, {
      taskQueue: 'temporal-spike-test-scenario-b',
      workflowId: 'forge-run:temporal-b-stale',
      args: [
        {
          runId: 'run-temporal-b-stale',
          scenario: 'blocked-repair-restart-resume',
          blockedRepairAttemptId: 'blocked-repair-1',
          harnessOutcome
        }
      ]
    });

    await environment.sleep(100);

    await handle.signal(repairWakeSignal, {
      repairAttemptId: 'blocked-repair-1',
      leaseState: 'STALE'
    });

    const result = await worker.runUntil(handle.result());

    expect(result.blockedResume?.releaseState).toBe('RELEASED');
  }, 15_000);
});

describe('Temporal spike workflow - infrastructure', () => {
  let environment: TestWorkflowEnvironment;
  let worker: Worker;
  let client: Client;

  beforeEach(async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
    worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'temporal-spike-test-infra',
      workflowsPath: fileURLToPath(new URL('./temporal-spike-workflow.ts', import.meta.url))
    });
    environments.push({ environment, worker });
    client = new Client({ connection: environment.client.connection });
  });

  it('workflow can be created and executed with different parameters', async () => {
    const harness = createTemporalSpikeHarness({
      runId: 'run-temporal-infra',
      scenario: 'build-review-repair-integrate'
    });
    const harnessOutcome = await harness.runBuildReviewRepairIntegrate();

    const result = await worker.runUntil(
      client.workflow.execute(runTemporalSpikeWorkflow, {
        taskQueue: 'temporal-spike-test-infra',
        workflowId: 'forge-run:temporal-infra',
        args: [
          {
            runId: 'run-temporal-infra',
            scenario: 'build-review-repair-integrate',
            taskId: 'task-infra',
            attemptId: 'attempt-infra',
            agentId: 'agent-infra',
            harnessOutcome
          }
        ]
      })
    );

    expect(result).toBeDefined();
    expect(result.builderAttempt).toBeDefined();
  }, 15_000);
});
