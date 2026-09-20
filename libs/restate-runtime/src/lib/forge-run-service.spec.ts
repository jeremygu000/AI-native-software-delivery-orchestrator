import { RestateTestEnvironment } from '@restatedev/restate-sdk-testcontainers';
import * as clients from '@restatedev/restate-sdk-clients';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ForgeActivities } from '@ai-native-software-delivery-orchestrator/forge-runtime-contracts';

import { createRestateForgeRunService } from './forge-run-service.js';

const TESTCONTAINERS_START_TIMEOUT = 120_000;

describe('Restate Forge run service', () => {
  let environment: RestateTestEnvironment;
  let ingress: clients.Ingress;
  let service: ReturnType<typeof createRestateForgeRunService>;
  const calls: string[] = [];
  let repairExecutions = 0;
  let resumeAttempts = 0;
  let firstRepairEntered = false;
  let reblockedRepairEntered = false;
  let ignoredResumeEntered = false;
  let releaseFirstRepair: (() => void) | undefined;
  let releaseReblockedRepair: (() => void) | undefined;
  let releaseIgnoredResume: (() => void) | undefined;

  const activities: ForgeActivities = {
    reevaluateRun: async ({ runId }) => {
      calls.push('reevaluate');
      return {
        runId,
        authorizedTasks:
          calls.filter((call) => call === 'reevaluate').length === 1
            ? [{ taskId: 'task-1', attemptId: 'builder-1' }]
            : []
      };
    },
    executeBuilder: async ({ runId, taskId, attemptId }) => {
      calls.push('builder');
      return { runId, taskId, workspaceId: 'workspace-1', attemptId, impactId: 'impact-1' };
    },
    evaluateBuilderOutput: async ({ runId, taskId, workspaceId, builderAttemptId }) => {
      calls.push('evaluate');
      return {
        runId,
        taskId,
        recommendation: 'repair',
        verificationId: 'verification-builder-1',
        subjectRef: {
          builderAttemptId,
          outputAttemptId: builderAttemptId,
          workspaceId
        },
        reviewId: 'review-builder-1'
      };
    },
    admitRepair: async ({ runId, taskId }) => {
      calls.push('admit');
      return { runId, taskId, repairAttemptId: 'repair-1' };
    },
    executeRepair: async ({ runId, taskId, repairAttemptId }) => {
      repairExecutions += 1;
      calls.push(`repair:${repairAttemptId}`);
      if (repairExecutions === 1) {
        firstRepairEntered = true;
        await new Promise<void>((resolve) => {
          releaseFirstRepair = resolve;
        });
        return {
          runId,
          taskId,
          state: 'blocked',
          repairAttemptId,
          blockerLeaseId: 'lease-1'
        };
      }
      if (repairExecutions === 2) {
        reblockedRepairEntered = true;
        await new Promise<void>((resolve) => {
          releaseReblockedRepair = resolve;
        });
        return {
          runId,
          taskId,
          state: 'blocked',
          repairAttemptId,
          blockerLeaseId: 'lease-2'
        };
      }
      return {
        runId,
        taskId,
        state: 'completed',
        repairAttemptId,
        recommendation: 'accept',
        verificationId: 'verification-repair-1',
        subjectRef: {
          builderAttemptId: 'builder-1',
          outputAttemptId: repairAttemptId,
          workspaceId: 'workspace-1'
        },
        reviewId: 'review-repair-1'
      };
    },
    resumeBlockedRepair: async ({ runId, repairAttemptId }) => {
      resumeAttempts += 1;
      calls.push(`resume:${repairAttemptId}`);
      if (resumeAttempts === 1) {
        ignoredResumeEntered = true;
        await new Promise<void>((resolve) => {
          releaseIgnoredResume = resolve;
        });
      }
      return {
        runId,
        repairAttemptId,
        status: resumeAttempts === 1 ? 'ignored' : 'resumed',
        taskId: 'task-1'
      };
    },
    integrateAcceptedOutput: async ({ runId, taskId }) => {
      calls.push('integrate');
      return { runId, taskId, status: 'integrated' };
    },
    finalizeRunState: async ({ runId }) => {
      calls.push('finalize');
      return { runId, status: 'completed' };
    }
  };

  beforeAll(async () => {
    service = createRestateForgeRunService(activities);
    environment = await RestateTestEnvironment.start({
      services: [service],
      disableRetries: true
    });
    ingress = clients.connect({ url: environment.baseUrl() });
  }, TESTCONTAINERS_START_TIMEOUT);

  afterAll(async () => {
    await environment.stop();
  });

  it('buffers single matching wakes across blocked, ignored, and reblocked repair responses', async () => {
    calls.length = 0;
    repairExecutions = 0;
    resumeAttempts = 0;
    firstRepairEntered = false;
    reblockedRepairEntered = false;
    ignoredResumeEntered = false;
    releaseFirstRepair = undefined;
    releaseReblockedRepair = undefined;
    releaseIgnoredResume = undefined;
    const client = ingress.workflowClient(service, 'forge-run-service-test');
    const handle = await client.workflowSubmit({ runId: 'run-1' });

    await expect.poll(() => firstRepairEntered).toBe(true);
    await client.sendRepairWake({ repairAttemptId: 'other-repair' });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(resumeAttempts).toBe(0);

    // This is the only matching wake while Forge has already reached its
    // BLOCKED transition but executeRepair has not returned to Restate.
    await client.sendRepairWake({ repairAttemptId: 'repair-1' });
    releaseFirstRepair?.();
    await expect.poll(() => ignoredResumeEntered).toBe(true);

    // This is the only next wake. It arrives while Forge is still deciding
    // that the first resume is ignored, so it must be held for generation 2.
    await client.sendRepairWake({ repairAttemptId: 'repair-1' });
    releaseIgnoredResume?.();

    await expect.poll(() => reblockedRepairEntered).toBe(true);

    // A successful resume keeps the same repair armed while it runs again.
    // This single wake must survive the second durable BLOCKED response.
    await client.sendRepairWake({ repairAttemptId: 'repair-1' });
    releaseReblockedRepair?.();

    const result = await ingress.result(handle);
    expect(result).toEqual({ runId: 'run-1', status: 'completed' });
    expect(calls).toEqual([
      'reevaluate',
      'builder',
      'reevaluate',
      'evaluate',
      'admit',
      'repair:repair-1',
      'resume:repair-1',
      'resume:repair-1',
      'repair:repair-1',
      'resume:repair-1',
      'repair:repair-1',
      'integrate',
      'reevaluate',
      'finalize'
    ]);
  }, 30_000);
});
