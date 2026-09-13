import * as clients from '@restatedev/restate-sdk-clients';
import { RestateTestEnvironment } from '@restatedev/restate-sdk-testcontainers';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createRestateSpikeWorkflow,
  createRestateSpikeActivities
} from '@ai-native-software-delivery-orchestrator/restate-spike';
import {
  createSqliteSpikeFixture,
  createForgeScenarioService,
  collectDurableExecutionOutcomeFromSqlite,
  type SqliteSpikeFixture
} from '../src/index.js';
import { assertDurableExecutionSpikeOutcome } from '@ai-native-software-delivery-orchestrator/orchestration-runtime';

const TESTCONTAINERS_START_TIMEOUT = 120_000;

const environments: RestateTestEnvironment[] = [];

afterEach(async () => {
  for (const env of environments.splice(0)) {
    try {
      await env.stop();
    } catch {
      // Ignore cleanup errors
    }
  }
});

describe('Restate spike - Scenario A real authority (SQLite)', () => {
  let environment: RestateTestEnvironment;
  let rs: clients.Ingress;
  let fixture: SqliteSpikeFixture;
  let runId: string;
  let taskId: string;
  let attemptId: string;
  let agentId: string;
  let workflow: ReturnType<typeof createRestateSpikeWorkflow>;

  beforeAll(async () => {
    runId = `run-restate-real-a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    taskId = 'task-1';
    attemptId = 'attempt-1';
    agentId = 'agent-1';
    fixture = createSqliteSpikeFixture();

    const serviceImpl = createForgeScenarioService({
      fixture,
      runId,
      taskId,
      attemptId,
      agentId
    });

    const activities = createRestateSpikeActivities(serviceImpl);
    workflow = createRestateSpikeWorkflow(activities);

    environment = await RestateTestEnvironment.start({
      services: [workflow],
      disableRetries: true
    });
    environments.push(environment);

    rs = clients.connect({ url: environment.baseUrl() });
  }, TESTCONTAINERS_START_TIMEOUT);

  it('executes Scenario A with real Restate executor and real Forge service', async () => {
    const handle = await rs.workflowClient(workflow, `real-a-${runId}`).workflowSubmit({
      scenario: 'build-review-repair-integrate',
      runId,
      taskId,
      attemptId,
      agentId
    });

    const result = await rs.result(handle);

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
  }, 30_000);
});

describe('Restate spike - Scenario B real authority (SQLite)', () => {
  let environment: RestateTestEnvironment;
  let rs: clients.Ingress;
  let fixture: SqliteSpikeFixture;
  let serviceImpl: ReturnType<typeof createForgeScenarioService>;
  let runId: string;
  let taskId: string;
  let attemptId: string;
  let agentId: string;
  let workflow: ReturnType<typeof createRestateSpikeWorkflow>;

  beforeAll(async () => {
    runId = `run-restate-real-b-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    taskId = 'task-1';
    attemptId = 'attempt-1';
    agentId = 'agent-1';

    fixture = createSqliteSpikeFixture();

    serviceImpl = createForgeScenarioService({
      fixture,
      runId,
      taskId,
      attemptId,
      agentId
    });

    const activities = createRestateSpikeActivities(serviceImpl);
    workflow = createRestateSpikeWorkflow(activities);

    environment = await RestateTestEnvironment.start({
      services: [workflow],
      disableRetries: true
    });
    environments.push(environment);

    rs = clients.connect({ url: environment.baseUrl() });
  }, TESTCONTAINERS_START_TIMEOUT);

  it('executes Scenario B with blocked-repair-restart-resume and durable promise', async () => {
    const blockedRepairAttemptId = `repair-blocked-${runId}`;
    const blockerLeaseId = `lease-${blockedRepairAttemptId}`;
    const builderAttemptId = `builder-${runId}`;

    await serviceImpl.setupBlockedRepair({
      runId,
      repairAttemptId: blockedRepairAttemptId,
      blockerLeaseId,
      builderAttemptId
    });

    const client = rs.workflowClient(workflow, `real-b-${runId}`);

    const handle = await client.workflowSubmit({
      scenario: 'blocked-repair-restart-resume',
      runId,
      taskId,
      attemptId,
      agentId,
      blockedRepairAttemptId
    });

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

    await client.sendWake({ repairAttemptId: blockedRepairAttemptId });

    const result = await rs.result(handle);

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
  }, 30_000);

  it('wrong wake for R2 does not consume R1 promise — R1 resumes after correct wake', async () => {
    const negRunId = `run-restate-real-b-wrong-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const negFixture = createSqliteSpikeFixture();
    const negService = createForgeScenarioService({
      fixture: negFixture,
      runId: negRunId,
      taskId,
      attemptId,
      agentId
    });
    const negActivities = createRestateSpikeActivities(negService);
    const negWorkflow = createRestateSpikeWorkflow(negActivities);

    const negEnv = await RestateTestEnvironment.start({
      services: [negWorkflow],
      disableRetries: true
    });
    environments.push(negEnv);
    const negRs = clients.connect({ url: negEnv.baseUrl() });

    const r1RepairId = `repair-r1-${negRunId}`;
    const r1LeaseId = `lease-${r1RepairId}`;
    const r2RepairId = `repair-r2-${negRunId}`;

    await negService.setupBlockedRepair({
      runId: negRunId,
      repairAttemptId: r1RepairId,
      blockerLeaseId: r1LeaseId,
      builderAttemptId: `builder-r1-${negRunId}`
    });

    const client = negRs.workflowClient(negWorkflow, `wrong-wake-${negRunId}`);

    const r1Handle = await client.workflowSubmit({
      scenario: 'blocked-repair-restart-resume',
      runId: negRunId,
      taskId,
      attemptId,
      agentId,
      blockedRepairAttemptId: r1RepairId
    });

    await new Promise((resolve) => setTimeout(resolve, 500));

    const r1Leases = await negFixture.persistence.recoverLeases(negRunId);
    const r1ActiveLease = r1Leases.find(
      (l) => l.lease.id === r1LeaseId && l.lease.state === 'ACTIVE'
    );
    if (r1ActiveLease) {
      await negFixture.persistence.persistLease({
        runId: negRunId,
        lease: {
          ...r1ActiveLease.lease,
          state: 'RELEASED' as const,
          version: r1ActiveLease.lease.version + 1
        }
      });
    }

    await client.sendWake({ repairAttemptId: r2RepairId });

    await new Promise((resolve) => setTimeout(resolve, 500));

    const dispatchesAfterWrongWake =
      await negFixture.persistence.recoverRepairResumeDispatches(negRunId);
    expect(dispatchesAfterWrongWake.filter((d) => d.repairAttemptId === r1RepairId)).toHaveLength(
      0
    );

    const r1Repairs = await negFixture.persistence.recoverRepairAttempts(negRunId);
    const r1Repair = r1Repairs.find((r) => r.attempt.id === r1RepairId);
    expect(r1Repair?.attempt.state).toBe('BLOCKED');

    await client.sendWake({ repairAttemptId: r1RepairId });

    const r1Result = await negRs.result(r1Handle);

    expect(r1Result.runId).toBe(negRunId);
    expect(r1Result.scenario).toBe('blocked-repair-restart-resume');

    const outcome = await collectDurableExecutionOutcomeFromSqlite(negRunId, negFixture);
    expect(outcome.blockedResume).toBeDefined();
    expect(outcome.blockedResume?.repairAttemptId).toBe(r1RepairId);

    assertDurableExecutionSpikeOutcome({
      outcome,
      scenario: 'blocked-repair-restart-resume'
    });
  }, 60_000);

  it('rejects resume when blocker lease is still ACTIVE but unrelated lease is RELEASED', async () => {
    const negRunId = `run-restate-real-b-neg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const negFixture = createSqliteSpikeFixture();
    const negService = createForgeScenarioService({
      fixture: negFixture,
      runId: negRunId,
      taskId,
      attemptId,
      agentId
    });
    const negActivities = createRestateSpikeActivities(negService);
    const negWorkflow = createRestateSpikeWorkflow(negActivities);

    const negEnv = await RestateTestEnvironment.start({
      services: [negWorkflow],
      disableRetries: true
    });
    environments.push(negEnv);
    const negRs = clients.connect({ url: negEnv.baseUrl() });

    const blockedRepairAttemptId = `repair-blocked-neg-${negRunId}`;
    const blockerLeaseId = `lease-${blockedRepairAttemptId}`;
    const builderAttemptId = `builder-neg-${negRunId}`;
    const unrelatedLeaseId = `lease-unrelated-${negRunId}`;

    await negService.setupBlockedRepair({
      runId: negRunId,
      repairAttemptId: blockedRepairAttemptId,
      blockerLeaseId,
      builderAttemptId
    });

    await negFixture.persistence.persistLease({
      runId: negRunId,
      lease: {
        id: unrelatedLeaseId,
        runId: negRunId,
        agentId: 'unrelated-agent',
        taskId,
        resource: { type: 'project' as const, projectId: 'other-project' },
        mode: 'exclusive' as const,
        version: 1,
        state: 'RELEASED' as const,
        acquiredAt: new Date(),
        lastHeartbeatAt: new Date()
      }
    });

    const client = negRs.workflowClient(negWorkflow, `real-b-neg-${negRunId}`);

    const handle = await client.workflowSubmit({
      scenario: 'blocked-repair-restart-resume',
      runId: negRunId,
      taskId,
      attemptId,
      agentId,
      blockedRepairAttemptId
    });

    await client.sendWake({ repairAttemptId: blockedRepairAttemptId });

    await new Promise((resolve) => setTimeout(resolve, 1000));

    const dispatches = await negFixture.persistence.recoverRepairResumeDispatches(negRunId);
    expect(dispatches.filter((d) => d.repairAttemptId === blockedRepairAttemptId)).toHaveLength(0);

    const repairs = await negFixture.persistence.recoverRepairAttempts(negRunId);
    const blockedRepair = repairs.find((r) => r.attempt.id === blockedRepairAttemptId);
    expect(blockedRepair?.attempt.state).toBe('BLOCKED');
  }, 30_000);
});
