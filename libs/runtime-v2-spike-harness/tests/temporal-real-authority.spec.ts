import { Client } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

import {
  runTemporalSpikeWorkflow,
  createTemporalSpikeActivities,
  repairWakeSignal
} from '@ai-native-software-delivery-orchestrator/temporal-spike';
import {
  createSqliteSpikeFixture,
  createForgeScenarioService,
  collectDurableExecutionOutcomeFromSqlite,
  type SqliteSpikeFixture
} from '../src/index.js';
import { assertDurableExecutionSpikeOutcome } from '@ai-native-software-delivery-orchestrator/orchestration-runtime';

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
  let taskId: string;
  let attemptId: string;
  let agentId: string;

  beforeEach(async () => {
    runId = `run-temporal-real-a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    taskId = 'task-1';
    attemptId = 'attempt-1';
    agentId = 'agent-1';
    fixture = createSqliteSpikeFixture();

    environment = await TestWorkflowEnvironment.createTimeSkipping();
    const workflowPath = resolve(
      PROJECT_ROOT,
      'libs/temporal-spike/dist/lib/temporal-spike-workflow.js'
    );

    const serviceImpl = createForgeScenarioService({
      fixture,
      runId,
      taskId,
      attemptId,
      agentId
    });

    worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: `temporal-spike-real-a-${runId}`,
      workflowsPath: workflowPath,
      activities: createTemporalSpikeActivities(serviceImpl)
    });
    environments.push({ environment, worker });
    client = new Client({ connection: environment.client.connection });
  });

  it('executes Scenario A with real Temporal worker and real Forge service', async () => {
    const result = await worker.runUntil(
      client.workflow.execute(runTemporalSpikeWorkflow, {
        taskQueue: worker.options.taskQueue,
        workflowId: `forge-run:temporal-real-a-${runId}`,
        args: [
          {
            runId,
            scenario: 'build-review-repair-integrate',
            taskId,
            attemptId,
            agentId
          }
        ]
      })
    );

    expect(result.runId).toBe(runId);
    expect(result.scenario).toBe('build-review-repair-integrate');

    const outcome = await collectDurableExecutionOutcomeFromSqlite(runId, fixture);
    expect(outcome.builderAttempt.state).toBe('COMPLETED');
    expect(outcome.repairs.length).toBeGreaterThan(0);
    expect(outcome.verifications.length).toBeGreaterThan(0);
    expect(outcome.reviews.length).toBeGreaterThan(0);
    expect(outcome.integration.status).toBe('integrated');
    expect(outcome.dispatchCount).toBeGreaterThanOrEqual(0);

    assertDurableExecutionSpikeOutcome({
      outcome,
      scenario: 'build-review-repair-integrate'
    });
  }, 15_000);
});

describe('Temporal spike - Scenario B real authority (SQLite)', () => {
  let environment: TestWorkflowEnvironment;
  let worker: Worker;
  let client: Client;
  let fixture: SqliteSpikeFixture;
  let serviceImpl: ReturnType<typeof createForgeScenarioService>;
  let runId: string;
  let taskId: string;
  let attemptId: string;
  let agentId: string;

  beforeEach(async () => {
    runId = `run-temporal-real-b-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    taskId = 'task-1';
    attemptId = 'attempt-1';
    agentId = 'agent-1';

    environment = await TestWorkflowEnvironment.createTimeSkipping();
    const workflowPath = resolve(
      PROJECT_ROOT,
      'libs/temporal-spike/dist/lib/temporal-spike-workflow.js'
    );

    fixture = createSqliteSpikeFixture();

    serviceImpl = createForgeScenarioService({
      fixture,
      runId,
      taskId,
      attemptId,
      agentId
    });

    worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: `temporal-spike-real-b-${runId}`,
      workflowsPath: workflowPath,
      activities: createTemporalSpikeActivities(serviceImpl)
    });
    environments.push({ environment, worker });
    client = new Client({ connection: environment.client.connection });
  });

  it('executes Scenario B with blocked-repair-restart-resume and signal', async () => {
    const blockedRepairAttemptId = `repair-blocked-${runId}`;
    const blockerLeaseId = `lease-${blockedRepairAttemptId}`;
    const builderAttemptId = `builder-${runId}`;

    await serviceImpl.setupBlockedRepair({
      runId,
      repairAttemptId: blockedRepairAttemptId,
      blockerLeaseId,
      builderAttemptId
    });

    const handle = await client.workflow.start(runTemporalSpikeWorkflow, {
      taskQueue: worker.options.taskQueue,
      workflowId: `forge-run:temporal-real-b-${runId}`,
      args: [
        {
          runId,
          scenario: 'blocked-repair-restart-resume' as const,
          blockedRepairAttemptId
        }
      ]
    });

    await environment.sleep(100);

    const leases = await fixture.persistence.recoverLeases(runId);
    const activeLease = leases.find((l) => l.lease.state === 'ACTIVE');
    if (activeLease) {
      await fixture.persistence.persistLease({
        runId,
        lease: {
          ...activeLease.lease,
          state: 'RELEASED' as const,
          version: activeLease.lease.version + 1
        }
      });
    }

    await handle.signal(repairWakeSignal, {
      repairAttemptId: blockedRepairAttemptId
    });

    const result = await worker.runUntil(handle.result());

    expect(result.runId).toBe(runId);
    expect(result.scenario).toBe('blocked-repair-restart-resume');

    const outcome = await collectDurableExecutionOutcomeFromSqlite(runId, fixture);
    expect(outcome.repairs.length).toBeGreaterThan(0);
    expect(outcome.verifications.length).toBeGreaterThan(0);
    expect(outcome.reviews.length).toBeGreaterThan(0);
    expect(outcome.blockedResume).toBeDefined();
    expect(outcome.dispatchCount).toBeGreaterThanOrEqual(1);

    assertDurableExecutionSpikeOutcome({
      outcome,
      scenario: 'blocked-repair-restart-resume'
    });
  }, 15_000);
});

describe('Temporal spike - Scenario B worker restart (SQLite + Local)', () => {
  it('survives worker shutdown and resume on new worker', async () => {
    const environment = await TestWorkflowEnvironment.createLocal();
    const workflowPath = resolve(
      PROJECT_ROOT,
      'libs/temporal-spike/dist/lib/temporal-spike-workflow.js'
    );
    const runId = `run-worker-restart-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const taskId = 'task-1';
    const attemptId = 'attempt-1';
    const agentId = 'agent-1';
    const taskQueue = `temporal-spike-worker-restart-${runId}`;
    const blockedRepairAttemptId = `repair-blocked-${runId}`;
    const blockerLeaseId = `lease-${blockedRepairAttemptId}`;

    const fixture = createSqliteSpikeFixture();
    const serviceImpl = createForgeScenarioService({
      fixture,
      runId,
      taskId,
      attemptId,
      agentId
    });

    await serviceImpl.setupBlockedRepair({
      runId,
      repairAttemptId: blockedRepairAttemptId,
      blockerLeaseId,
      builderAttemptId: `builder-${runId}`
    });

    const workerA = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: workflowPath,
      activities: createTemporalSpikeActivities(serviceImpl)
    });

    const workerARun = workerA.run();

    const clientA = new Client({ connection: environment.nativeConnection });

    const handle = await clientA.workflow.start(runTemporalSpikeWorkflow, {
      taskQueue,
      workflowId: `forge-run:worker-restart-${runId}`,
      args: [
        {
          runId,
          scenario: 'blocked-repair-restart-resume' as const,
          blockedRepairAttemptId
        }
      ]
    });

    await environment.sleep(500);

    await workerA.shutdown();
    await workerARun;

    await fixture.persistence.persistLease({
      runId,
      lease: {
        id: blockerLeaseId,
        runId,
        agentId: `lease-agent-${blockerLeaseId}`,
        taskId,
        resource: { type: 'project' as const, projectId: 'test-project' },
        mode: 'exclusive' as const,
        version: 2,
        state: 'RELEASED' as const,
        acquiredAt: new Date(),
        lastHeartbeatAt: new Date()
      }
    });

    await handle.signal(repairWakeSignal, {
      repairAttemptId: `wrong-repair-${runId}`
    });

    await environment.sleep(200);

    await handle.signal(repairWakeSignal, {
      repairAttemptId: blockedRepairAttemptId
    });

    const workerB = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: workflowPath,
      activities: createTemporalSpikeActivities(serviceImpl)
    });

    const result = await workerB.runUntil(handle.result());

    expect(result.runId).toBe(runId);
    expect(result.scenario).toBe('blocked-repair-restart-resume');

    const outcome = await collectDurableExecutionOutcomeFromSqlite(runId, fixture);
    expect(outcome.repairs.length).toBeGreaterThan(0);
    expect(outcome.verifications.length).toBeGreaterThan(0);
    expect(outcome.reviews.length).toBeGreaterThan(0);
    expect(outcome.blockedResume).toBeDefined();
    expect(outcome.dispatchCount).toBeGreaterThanOrEqual(1);

    assertDurableExecutionSpikeOutcome({
      outcome,
      scenario: 'blocked-repair-restart-resume'
    });

    await environment.teardown();
  }, 30_000);
});
