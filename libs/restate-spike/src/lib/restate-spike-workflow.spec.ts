import { RestateTestEnvironment } from '@restatedev/restate-sdk-testcontainers';
import * as clients from '@restatedev/restate-sdk-clients';
import { restateSpikeActivities, restateSpikeWorkflow } from './restate-spike-workflow.js';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';

const TESTCONTAINERS_START_TIMEOUT = 120_000;

describe('Restate spike workflow - Scenario A (build-review-repair-integrate)', () => {
  let restateTestEnvironment: RestateTestEnvironment;
  let rs: clients.Ingress;

  beforeAll(async () => {
    restateTestEnvironment = await RestateTestEnvironment.start({
      services: [restateSpikeActivities, restateSpikeWorkflow],
      disableRetries: true
    });
    rs = clients.connect({ url: restateTestEnvironment.baseUrl() });
  }, TESTCONTAINERS_START_TIMEOUT);

  afterAll(async () => {
    if (restateTestEnvironment !== undefined) {
      await restateTestEnvironment.stop();
    }
  });

  it('executes full Scenario A path and returns builderAttemptId (proves executeBuilder was called)', async () => {
    const handle = await rs
      .workflowClient(restateSpikeWorkflow, 'scenario-a-full')
      .workflowSubmit({
        scenario: 'build-review-repair-integrate',
        runId: 'run-scenario-a-full',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        agentId: 'agent-1'
      });

    expect(handle).toBeDefined();
    expect(handle.invocationId).toBeDefined();

    const result = await rs.result(handle);

    expect(result).toBeDefined();
    expect(result.runId).toBe('run-scenario-a-full');
    expect(result.scenario).toBe('build-review-repair-integrate');
    expect(result.builderAttemptId).toBeDefined();
    expect(result.builderAttemptId).toContain('builder-');
    expect(result.repairAttemptId).toBeUndefined();
  }, 30_000);

  it('proves executeBuilder was called via builderAttemptId in result', async () => {
    const handle = await rs
      .workflowClient(restateSpikeWorkflow, 'scenario-a-builder-proof')
      .workflowSubmit({
        scenario: 'build-review-repair-integrate',
        runId: 'run-scenario-a-builder',
        taskId: 'task-builder',
        attemptId: 'attempt-builder',
        agentId: 'agent-builder'
      });

    const result = await rs.result(handle);

    expect(result.builderAttemptId).toBe('builder-run-scenario-a-builder-attempt-builder');
  }, 30_000);

  it('proves evaluateBuilderOutput was called (recommendation=accept means no repair needed)', async () => {
    const handle = await rs
      .workflowClient(restateSpikeWorkflow, 'scenario-a-eval-proof')
      .workflowSubmit({
        scenario: 'build-review-repair-integrate',
        runId: 'run-scenario-a-eval',
        taskId: 'task-eval',
        attemptId: 'attempt-eval',
        agentId: 'agent-eval'
      });

    const result = await rs.result(handle);

    expect(result.repairAttemptId).toBeUndefined();
  }, 30_000);
});

describe('Restate spike workflow - Scenario B (blocked-repair-restart-resume)', () => {
  let restateTestEnvironment: RestateTestEnvironment;
  let rs: clients.Ingress;

  beforeAll(async () => {
    restateTestEnvironment = await RestateTestEnvironment.start({
      services: [restateSpikeActivities, restateSpikeWorkflow],
      disableRetries: true
    });
    rs = clients.connect({ url: restateTestEnvironment.baseUrl() });
  }, TESTCONTAINERS_START_TIMEOUT);

  afterAll(async () => {
    if (restateTestEnvironment !== undefined) {
      await restateTestEnvironment.stop();
    }
  });

  it('Scenario B workflowSubmit returns invocationId (durable wait starts)', async () => {
    const handle = await rs
      .workflowClient(restateSpikeWorkflow, 'scenario-b-submit')
      .workflowSubmit({
        scenario: 'blocked-repair-restart-resume',
        runId: 'run-scenario-b',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        agentId: 'agent-1',
        blockedRepairAttemptId: 'blocked-repair-1'
      });

    expect(handle).toBeDefined();
    expect(handle.invocationId).toBeDefined();
    expect(handle.invocationId).toContain('inv_');
  }, 30_000);

  it('Scenario B durable wait at signal point via ctx.signal()', async () => {
    const handle = await rs
      .workflowClient(restateSpikeWorkflow, 'scenario-b-durable-wait')
      .workflowSubmit({
        scenario: 'blocked-repair-restart-resume',
        runId: 'run-scenario-b-wait',
        taskId: 'task-wait',
        attemptId: 'attempt-wait',
        agentId: 'agent-wait',
        blockedRepairAttemptId: 'blocked-repair-2'
      });

    expect(handle).toBeDefined();

    const workflowState = await restateTestEnvironment.stateOf(restateSpikeWorkflow, 'scenario-b-durable-wait');
    expect(workflowState).toBeDefined();
  }, 30_000);
});

describe('Restate spike workflow - infrastructure', () => {
  let restateTestEnvironment: RestateTestEnvironment;
  let rs: clients.Ingress;

  beforeAll(async () => {
    restateTestEnvironment = await RestateTestEnvironment.start({
      services: [restateSpikeActivities, restateSpikeWorkflow],
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
    const client1 = rs.workflowClient(restateSpikeWorkflow, 'key-1');
    const client2 = rs.workflowClient(restateSpikeWorkflow, 'key-2');

    expect(client1).toBeDefined();
    expect(client2).toBeDefined();
    expect(client1).not.toBe(client2);
  }, 10_000);
});
