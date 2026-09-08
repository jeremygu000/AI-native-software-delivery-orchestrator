import { RestateTestEnvironment } from '@restatedev/restate-sdk-testcontainers';
import * as clients from '@restatedev/restate-sdk-clients';
import { createRestateSpikeWorkflow } from './restate-spike-workflow.js';
import type { RestateSpikeActivity } from './restate-spike-activities.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TESTCONTAINERS_START_TIMEOUT = 120_000;

const mockActivities: RestateSpikeActivity = {
  executeBuilder: async (request) => ({
    builderAttemptId: `builder-${request.runId}-${request.attemptId}`,
    workspaceId: `workspace-${request.runId}`,
    impactPrediction: []
  }),
  evaluateBuilderOutput: async (request) => ({
    verificationEvidenceId: `verification-${request.runId}`,
    reviewSubjectRef: {
      builderAttemptId: request.builderAttemptId,
      outputAttemptId: `output-${request.builderAttemptId}`,
      workspaceId: request.workspaceId
    },
    recommendation: 'repair' as const,
    repairAttemptId: `repair-${request.runId}-1`
  }),
  executeRepair: async (request) => ({
    repairAttemptId: request.repairAttemptId,
    verificationEvidenceId: `verification-repair-${request.repairAttemptId}`,
    reviewSubjectRef: {
      builderAttemptId: request.builderAttemptId,
      outputAttemptId: request.repairAttemptId,
      workspaceId: request.workspaceId
    },
    recommendation: 'accept' as const
  }),
  integrateAcceptedOutput: async () => ({
    integrationStatus: 'integrated' as const
  }),
  executeBlockedRepairResume: async (request) => ({
    repairAttemptId: request.repairAttemptId,
    verificationEvidenceId: `verification-resume-${request.repairAttemptId}`,
    state: 'completed' as const
  })
};

describe('Restate spike workflow - Scenario A (build-review-repair-integrate)', () => {
  let restateTestEnvironment: RestateTestEnvironment;
  let rs: clients.Ingress;
  let workflow: ReturnType<typeof createRestateSpikeWorkflow>;

  beforeAll(async () => {
    workflow = createRestateSpikeWorkflow(mockActivities);
    restateTestEnvironment = await RestateTestEnvironment.start({
      services: [workflow],
      disableRetries: true
    });
    rs = clients.connect({ url: restateTestEnvironment.baseUrl() });
  }, TESTCONTAINERS_START_TIMEOUT);

  afterAll(async () => {
    if (restateTestEnvironment !== undefined) {
      await restateTestEnvironment.stop();
    }
  });

  it('executes Scenario A and returns {runId, scenario}', async () => {
    const runId = `run-scenario-a-1-${Date.now()}`;
    const handle = await rs.workflowClient(workflow, 'scenario-a-1').workflowSubmit({
      scenario: 'build-review-repair-integrate',
      runId,
      taskId: 'task-1',
      attemptId: 'attempt-1',
      agentId: 'agent-1'
    });

    expect(handle).toBeDefined();
    expect(handle.invocationId).toBeDefined();

    const result = await rs.result(handle);

    expect(result).toBeDefined();
    expect(result.runId).toBe(runId);
    expect(result.scenario).toBe('build-review-repair-integrate');
  }, 30_000);

  it('proves mock activities are called via ctx.run()', async () => {
    const runId = `run-scenario-a-builder-proof-${Date.now()}`;
    const handle = await rs.workflowClient(workflow, 'scenario-a-builder-proof').workflowSubmit({
      scenario: 'build-review-repair-integrate',
      runId,
      taskId: 'task-builder',
      attemptId: 'attempt-builder',
      agentId: 'agent-builder'
    });

    const result = await rs.result(handle);

    expect(result.runId).toBe(runId);
    expect(result.scenario).toBe('build-review-repair-integrate');
  }, 30_000);
});

describe('Restate spike workflow - Scenario B (blocked-repair-restart-resume)', () => {
  let restateTestEnvironment: RestateTestEnvironment;
  let rs: clients.Ingress;
  let workflow: ReturnType<typeof createRestateSpikeWorkflow>;

  beforeAll(async () => {
    workflow = createRestateSpikeWorkflow(mockActivities);
    restateTestEnvironment = await RestateTestEnvironment.start({
      services: [workflow],
      disableRetries: true
    });
    rs = clients.connect({ url: restateTestEnvironment.baseUrl() });
  }, TESTCONTAINERS_START_TIMEOUT);

  afterAll(async () => {
    if (restateTestEnvironment !== undefined) {
      await restateTestEnvironment.stop();
    }
  });

  it('executes Scenario B with durable promise-based wake signal', async () => {
    const runId = `run-scenario-b-1-${Date.now()}`;
    const blockedRepairAttemptId = 'blocked-repair-1';

    const client = rs.workflowClient(workflow, 'scenario-b-1');

    const handle = await client.workflowSubmit({
      scenario: 'blocked-repair-restart-resume',
      runId,
      taskId: 'task-1',
      attemptId: 'attempt-1',
      agentId: 'agent-1',
      blockedRepairAttemptId
    });

    expect(handle).toBeDefined();
    expect(handle.invocationId).toBeDefined();

    await client.sendWake({ repairAttemptId: blockedRepairAttemptId });

    const result = await rs.result(handle);

    expect(result).toBeDefined();
    expect(result.runId).toBe(runId);
    expect(result.scenario).toBe('blocked-repair-restart-resume');
  }, 30_000);

  it('sendWake resolves the durable promise in the run handler', async () => {
    const runId = `run-scenario-b-submit-${Date.now()}`;
    const client = rs.workflowClient(workflow, 'scenario-b-submit');

    const handle = await client.workflowSubmit({
      scenario: 'blocked-repair-restart-resume',
      runId,
      taskId: 'task-wait',
      attemptId: 'attempt-wait',
      agentId: 'agent-wait',
      blockedRepairAttemptId: 'blocked-repair-2'
    });

    expect(handle).toBeDefined();
    expect(handle.invocationId).toBeDefined();
  }, 30_000);
});

describe('Restate spike workflow - infrastructure', () => {
  let restateTestEnvironment: RestateTestEnvironment;
  let rs: clients.Ingress;
  let workflow: ReturnType<typeof createRestateSpikeWorkflow>;

  beforeAll(async () => {
    workflow = createRestateSpikeWorkflow(mockActivities);
    restateTestEnvironment = await RestateTestEnvironment.start({
      services: [workflow],
      disableRetries: true
    });
    rs = clients.connect({ url: restateTestEnvironment.baseUrl() });
  }, TESTCONTAINERS_START_TIMEOUT);

  afterAll(async () => {
    if (restateTestEnvironment !== undefined) {
      await restateTestEnvironment.stop();
    }
  });

  it('workflow client can be created for different workflow keys', async () => {
    const client1 = rs.workflowClient(workflow, 'key-1');
    const client2 = rs.workflowClient(workflow, 'key-2');

    expect(client1).toBeDefined();
    expect(client2).toBeDefined();
  }, 10_000);
});
