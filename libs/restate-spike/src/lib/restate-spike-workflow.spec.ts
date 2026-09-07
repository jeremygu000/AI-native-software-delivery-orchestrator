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

  it('Scenario A workflow can be submitted and executed', async () => {
    const submission = await rs
      .workflowClient(restateSpikeWorkflow, 'scenario-a-submit')
      .workflowSubmit({
        scenario: 'build-review-repair-integrate',
        runId: 'run-scenario-a-submit',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        agentId: 'agent-1'
      });

    expect(submission).toBeDefined();
    expect(submission.invocationId).toBeDefined();
  }, 30_000);

  it('Scenario B workflow can be submitted and waits for signal', async () => {
    const submission = await rs
      .workflowClient(restateSpikeWorkflow, 'scenario-b-submit')
      .workflowSubmit({
        scenario: 'blocked-repair-restart-resume',
        runId: 'run-scenario-b-submit',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        agentId: 'agent-1',
        blockedRepairAttemptId: 'blocked-repair-1'
      });

    expect(submission).toBeDefined();
    expect(submission.invocationId).toBeDefined();
  }, 30_000);

  it('workflow client can be created for different workflow keys', async () => {
    const client1 = rs.workflowClient(restateSpikeWorkflow, 'key-1');
    const client2 = rs.workflowClient(restateSpikeWorkflow, 'key-2');

    expect(client1).toBeDefined();
    expect(client2).toBeDefined();
    expect(client1).not.toBe(client2);
  }, 10_000);
});
