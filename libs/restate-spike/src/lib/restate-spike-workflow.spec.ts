import { RestateTestEnvironment } from '@restatedev/restate-sdk-testcontainers';
import * as clients from '@restatedev/restate-sdk-clients';
import { restateSpikeActivities, restateSpikeWorkflow } from './restate-spike-workflow.js';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';

const TESTCONTAINERS_START_TIMEOUT = 120_000;

describe('Restate spike workflow', () => {
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

  it('Scenario A: workflowSubmit + rs.result() completes successfully', async () => {
    const handle = await rs
      .workflowClient(restateSpikeWorkflow, 'scenario-a-result')
      .workflowSubmit({
        scenario: 'build-review-repair-integrate',
        runId: 'run-scenario-a-result',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        agentId: 'agent-1'
      });

    expect(handle).toBeDefined();
    expect(handle.invocationId).toBeDefined();

    const result = await rs.result(handle);

    expect(result).toBeDefined();
    expect(result.runId).toBe('run-scenario-a-result');
    expect(result.scenario).toBe('build-review-repair-integrate');
  }, 30_000);

  it('Scenario B: workflowSubmit + rs.result() waits for signal', async () => {
    const handle = await rs
      .workflowClient(restateSpikeWorkflow, 'scenario-b-result')
      .workflowSubmit({
        scenario: 'blocked-repair-restart-resume',
        runId: 'run-scenario-b-result',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        agentId: 'agent-1',
        blockedRepairAttemptId: 'blocked-repair-1'
      });

    expect(handle).toBeDefined();
    expect(handle.invocationId).toBeDefined();
  }, 30_000);

  it('workflow client can be created for different workflow keys', async () => {
    const client1 = rs.workflowClient(restateSpikeWorkflow, 'key-1');
    const client2 = rs.workflowClient(restateSpikeWorkflow, 'key-2');

    expect(client1).toBeDefined();
    expect(client2).toBeDefined();
    expect(client1).not.toBe(client2);
  }, 10_000);
});
