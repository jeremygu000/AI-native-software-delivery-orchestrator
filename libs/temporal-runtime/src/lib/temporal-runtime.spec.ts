import { Client } from '@temporalio/client';
import { Context } from '@temporalio/activity';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  forgeRunWorkflow,
  ForgeRunInputSchema,
  integrationWakeSignal,
  type BlockedIntegrationContinuationActivities,
  type ForgeActivities,
  type ReevaluateRunInput,
  ReevaluateRunResultSchema,
  type ExecuteBuilderInput,
  ExecuteBuilderResultSchema,
  type EvaluateBuilderOutputInput,
  EvaluateBuilderOutputResultSchema,
  type AdmitRepairInput,
  AdmitRepairResultSchema,
  type ExecuteRepairInput,
  ExecuteRepairResultSchema,
  type IntegrateAcceptedOutputInput,
  IntegrateAcceptedOutputResultSchema,
  type FinalizeRunStateInput,
  FinalizeRunStateResultSchema,
  ForgeRunResultSchema,
  repairWakeSignal
} from '../index.js';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(moduleDirectory, '../../../..');
const WORKFLOWS_PATH = resolve(
  PROJECT_ROOT,
  'libs/temporal-runtime/dist/lib/workflows/forge-run.js'
);

const createDeferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolveDeferred) => {
    resolvePromise = resolveDeferred;
  });
  return { promise, resolve: resolvePromise };
};

describe('temporal-runtime Scenario A workflow', () => {
  it('reconciles external cancellation through the non-cancellable finalizer', async () => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const calls: string[] = [];
    const reevaluationStarted = createDeferred();
    const activities: ForgeActivities = {
      async reevaluateRun(_input: ReevaluateRunInput) {
        calls.push('reevaluateRun');
        reevaluationStarted.resolve();
        Context.current().heartbeat();
        await Context.current().cancelled;
        throw new Error('activity cancellation should interrupt the workflow');
      },
      async executeBuilder(_input: ExecuteBuilderInput) {
        throw new Error('executeBuilder should not be called');
      },
      async evaluateBuilderOutput(_input: EvaluateBuilderOutputInput) {
        throw new Error('evaluateBuilderOutput should not be called');
      },
      async admitRepair(_input: AdmitRepairInput) {
        throw new Error('admitRepair should not be called');
      },
      async executeRepair(_input: ExecuteRepairInput) {
        throw new Error('executeRepair should not be called');
      },
      async integrateAcceptedOutput(_input: IntegrateAcceptedOutputInput) {
        throw new Error('integrateAcceptedOutput should not be called');
      },
      async finalizeRunState(_input: FinalizeRunStateInput) {
        calls.push('finalizeRunState');
        throw new Error('finalizeRunState should not be called');
      },
      async finalizeRunCancellation() {
        calls.push('finalizeRunCancellation');
        return { runId: 'run-cancelled', status: 'cancelled' };
      }
    };

    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'temporal-runtime-test-cancellation',
      workflowsPath: WORKFLOWS_PATH,
      activities
    });
    const client = new Client({ connection: environment.client.connection });
    const workerPromise = worker.run();
    try {
      const handle = await client.workflow.start(forgeRunWorkflow, {
        taskQueue: 'temporal-runtime-test-cancellation',
        args: [{ runId: 'run-cancelled' }],
        workflowId: 'forge-run:run-cancelled'
      });
      await reevaluationStarted.promise;
      await handle.cancel();

      await expect(handle.result()).resolves.toEqual({
        runId: 'run-cancelled',
        status: 'cancelled'
      });
      expect(calls).toEqual(['reevaluateRun', 'finalizeRunCancellation']);
    } finally {
      worker.shutdown();
      await workerPromise;
      await environment.teardown();
    }
  });

  it('re-drives cancellation reconciliation until durable cleanup completes', async () => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const calls: string[] = [];
    const reevaluationStarted = createDeferred();
    const pendingFinalizerCalled = createDeferred();

    const activities: ForgeActivities = {
      async reevaluateRun(_input: ReevaluateRunInput) {
        reevaluationStarted.resolve();
        Context.current().heartbeat();
        await Context.current().cancelled;
        throw new Error('activity cancellation should interrupt the workflow');
      },
      async executeBuilder(_input: ExecuteBuilderInput) {
        throw new Error('executeBuilder should not be called');
      },
      async evaluateBuilderOutput(_input: EvaluateBuilderOutputInput) {
        throw new Error('evaluateBuilderOutput should not be called');
      },
      async admitRepair(_input: AdmitRepairInput) {
        throw new Error('admitRepair should not be called');
      },
      async executeRepair(_input: ExecuteRepairInput) {
        throw new Error('executeRepair should not be called');
      },
      async integrateAcceptedOutput(_input: IntegrateAcceptedOutputInput) {
        throw new Error('integrateAcceptedOutput should not be called');
      },
      async finalizeRunState(_input: FinalizeRunStateInput) {
        throw new Error('finalizeRunState should not be called');
      },
      async finalizeRunCancellation() {
        calls.push('finalizeRunCancellation');
        if (calls.length === 1) {
          pendingFinalizerCalled.resolve();
          return { runId: 'run-cancelled', status: 'pending' };
        }
        return { runId: 'run-cancelled', status: 'cancelled' };
      }
    };

    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'temporal-runtime-test-cancellation-rejected',
      workflowsPath: WORKFLOWS_PATH,
      activities
    });
    const client = new Client({ connection: environment.client.connection });
    const workerPromise = worker.run();
    try {
      const handle = await client.workflow.start(forgeRunWorkflow, {
        taskQueue: 'temporal-runtime-test-cancellation-rejected',
        args: [{ runId: 'run-cancelled' }],
        workflowId: 'forge-run:run-cancellation-rejected'
      });
      await reevaluationStarted.promise;
      await handle.cancel();
      await pendingFinalizerCalled.promise;
      await environment.sleep(5_000);

      await expect(handle.result()).resolves.toEqual({
        runId: 'run-cancelled',
        status: 'cancelled'
      });
      expect(calls).toEqual(['finalizeRunCancellation', 'finalizeRunCancellation']);
    } finally {
      worker.shutdown();
      await workerPromise;
      await environment.teardown();
    }
  }, 15_000);

  it('returns completed when no tasks are ready', async () => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const calls: string[] = [];

    const activities: ForgeActivities = {
      async reevaluateRun(_input: ReevaluateRunInput) {
        calls.push('reevaluateRun');
        return ReevaluateRunResultSchema.parse({ runId: 'run-1', authorizedTasks: [] });
      },
      async executeBuilder(_input: ExecuteBuilderInput) {
        calls.push('executeBuilder');
        throw new Error('executeBuilder should not be called');
      },
      async evaluateBuilderOutput(_input: EvaluateBuilderOutputInput) {
        calls.push('evaluateBuilderOutput');
        throw new Error('evaluateBuilderOutput should not be called');
      },
      async admitRepair(_input: AdmitRepairInput) {
        calls.push('admitRepair');
        throw new Error('admitRepair should not be called');
      },
      async executeRepair(_input: ExecuteRepairInput) {
        calls.push('executeRepair');
        throw new Error('executeRepair should not be called');
      },
      async integrateAcceptedOutput(_input: IntegrateAcceptedOutputInput) {
        calls.push('integrateAcceptedOutput');
        return IntegrateAcceptedOutputResultSchema.parse({
          runId: 'run-5',
          taskId: 'task-5',
          status: 'integrated'
        });
      },
      async finalizeRunState(_input: FinalizeRunStateInput) {
        calls.push('finalizeRunState');
        return FinalizeRunStateResultSchema.parse({ runId: 'run-1', status: 'completed' });
      }
    };

    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'temporal-runtime-test-scenario-a-empty',
      workflowsPath: WORKFLOWS_PATH,
      activities
    });

    const runId = `run-empty-${Date.now()}`;
    const client = new Client({ connection: environment.client.connection });

    const workerPromise = worker.run();
    try {
      const handle = await client.workflow.start(forgeRunWorkflow, {
        taskQueue: 'temporal-runtime-test-scenario-a-empty',
        args: [{ runId }],
        workflowId: `workflow-${runId}`
      });

      const result = await handle.result();
      expect(result).toEqual({ runId, status: 'completed' });
      expect(calls).toEqual(['reevaluateRun', 'finalizeRunState']);
    } finally {
      worker.shutdown();
      await workerPromise;
      await environment.teardown();
    }
  });

  it('executes builder, evaluates, and integrates accepted output', async () => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const calls: string[] = [];

    const activities: ForgeActivities = {
      async reevaluateRun(_input: ReevaluateRunInput) {
        calls.push('reevaluateRun');
        return ReevaluateRunResultSchema.parse({
          runId: 'run-2',
          authorizedTasks: [{ taskId: 'task-1', attemptId: 'attempt-1' }]
        });
      },
      async executeBuilder(input: ExecuteBuilderInput) {
        calls.push(`executeBuilder:${input.taskId}`);
        return ExecuteBuilderResultSchema.parse({
          status: 'completed',
          runId: input.runId,
          taskId: input.taskId,
          workspaceId: 'workspace-1',
          attemptId: 'builder-attempt-1',
          impactId: 'impact-1'
        });
      },
      async evaluateBuilderOutput(input: EvaluateBuilderOutputInput) {
        calls.push(`evaluateBuilderOutput:${input.taskId}`);
        return EvaluateBuilderOutputResultSchema.parse({
          runId: input.runId,
          taskId: input.taskId,
          recommendation: 'accept',
          verificationId: 'verification-1',
          subjectRef: {
            builderAttemptId: 'builder-attempt-1',
            outputAttemptId: 'output-attempt-1',
            workspaceId: 'workspace-1'
          },
          reviewId: 'review-1'
        });
      },
      async admitRepair(_input: AdmitRepairInput) {
        calls.push('admitRepair');
        throw new Error('admitRepair should not be called');
      },
      async executeRepair(_input: ExecuteRepairInput) {
        calls.push('executeRepair');
        throw new Error('executeRepair should not be called');
      },
      async integrateAcceptedOutput(input: IntegrateAcceptedOutputInput) {
        calls.push(`integrateAcceptedOutput:${input.taskId}`);
        return IntegrateAcceptedOutputResultSchema.parse({
          runId: input.runId,
          taskId: input.taskId,
          status: 'integrated'
        });
      },
      async finalizeRunState(_input: FinalizeRunStateInput) {
        calls.push('finalizeRunState');
        return FinalizeRunStateResultSchema.parse({ runId: 'run-2', status: 'completed' });
      }
    };

    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'temporal-runtime-test-scenario-a-accept',
      workflowsPath: WORKFLOWS_PATH,
      activities
    });

    const runId = `run-accept-${Date.now()}`;
    const client = new Client({ connection: environment.client.connection });

    const workerPromise = worker.run();
    try {
      const handle = await client.workflow.start(forgeRunWorkflow, {
        taskQueue: 'temporal-runtime-test-scenario-a-accept',
        args: [{ runId }],
        workflowId: `workflow-${runId}`
      });

      const result = await handle.result();
      expect(result).toEqual({ runId, status: 'completed' });
      expect(calls).toEqual([
        'reevaluateRun',
        'executeBuilder:task-1',
        'reevaluateRun',
        'evaluateBuilderOutput:task-1',
        'integrateAcceptedOutput:task-1',
        'reevaluateRun',
        'finalizeRunState'
      ]);
    } finally {
      worker.shutdown();
      await workerPromise;
      await environment.teardown();
    }
  });

  it('starts an independent authorized builder wave before either builder completes', async () => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const calls: string[] = [];
    const bothBuildersStarted = createDeferred();
    const releaseBuilders = createDeferred();
    let builderStarts = 0;

    const activities: ForgeActivities = {
      async reevaluateRun(input: ReevaluateRunInput) {
        calls.push('reevaluateRun');
        return ReevaluateRunResultSchema.parse({
          runId: input.runId,
          authorizedTasks:
            calls.filter((call) => call === 'reevaluateRun').length === 1
              ? [
                  { taskId: 'task-a', attemptId: 'attempt-a' },
                  { taskId: 'task-b', attemptId: 'attempt-b' }
                ]
              : []
        });
      },
      async executeBuilder(input: ExecuteBuilderInput) {
        calls.push(`executeBuilder:${input.taskId}`);
        builderStarts += 1;
        if (builderStarts === 2) {
          bothBuildersStarted.resolve();
        }
        await releaseBuilders.promise;
        return ExecuteBuilderResultSchema.parse({
          status: 'completed',
          runId: input.runId,
          taskId: input.taskId,
          workspaceId: `workspace-${input.taskId}`,
          attemptId: input.attemptId,
          impactId: `impact-${input.taskId}`
        });
      },
      async evaluateBuilderOutput(input: EvaluateBuilderOutputInput) {
        calls.push(`evaluateBuilderOutput:${input.taskId}`);
        return EvaluateBuilderOutputResultSchema.parse({
          runId: input.runId,
          taskId: input.taskId,
          recommendation: 'accept',
          verificationId: `verification-${input.taskId}`,
          subjectRef: {
            builderAttemptId: input.builderAttemptId,
            outputAttemptId: `output-${input.taskId}`,
            workspaceId: input.workspaceId
          },
          reviewId: `review-${input.taskId}`
        });
      },
      async admitRepair() {
        throw new Error('admitRepair should not be called');
      },
      async executeRepair() {
        throw new Error('executeRepair should not be called');
      },
      async integrateAcceptedOutput(input: IntegrateAcceptedOutputInput) {
        calls.push(`integrateAcceptedOutput:${input.taskId}`);
        return IntegrateAcceptedOutputResultSchema.parse({
          runId: input.runId,
          taskId: input.taskId,
          status: 'integrated'
        });
      },
      async finalizeRunState(input: FinalizeRunStateInput) {
        calls.push('finalizeRunState');
        return FinalizeRunStateResultSchema.parse({ runId: input.runId, status: 'completed' });
      }
    };

    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'temporal-runtime-test-concurrent-builder-wave',
      workflowsPath: WORKFLOWS_PATH,
      activities
    });
    const runId = `run-concurrent-${Date.now()}`;
    const client = new Client({ connection: environment.client.connection });
    const workerPromise = worker.run();
    try {
      const handle = await client.workflow.start(forgeRunWorkflow, {
        taskQueue: 'temporal-runtime-test-concurrent-builder-wave',
        args: [{ runId }],
        workflowId: `workflow-${runId}`
      });

      await bothBuildersStarted.promise;
      expect(calls).toEqual([
        'reevaluateRun',
        expect.stringMatching(/^executeBuilder:task-[ab]$/),
        expect.stringMatching(/^executeBuilder:task-[ab]$/)
      ]);
      expect(new Set(calls.slice(1))).toEqual(
        new Set(['executeBuilder:task-a', 'executeBuilder:task-b'])
      );

      releaseBuilders.resolve();
      await expect(handle.result()).resolves.toEqual({ runId, status: 'completed' });
      expect(calls.filter((call) => call.startsWith('evaluateBuilderOutput:'))).toHaveLength(2);
      expect(calls.filter((call) => call.startsWith('integrateAcceptedOutput:'))).toHaveLength(2);
      expect(calls).toContain('finalizeRunState');
    } finally {
      worker.shutdown();
      await workerPromise;
      await environment.teardown();
    }
  });

  it('retries a blocked builder authorization only after reevaluation returns the same attempt', async () => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const calls: string[] = [];
    const builderInputs: ExecuteBuilderInput[] = [];
    let builderAttempts = 0;
    let reevaluationCount = 0;

    const activities: ForgeActivities = {
      async reevaluateRun(input: ReevaluateRunInput) {
        reevaluationCount += 1;
        calls.push(`reevaluateRun:${reevaluationCount}`);
        return ReevaluateRunResultSchema.parse({
          runId: input.runId,
          authorizedTasks:
            reevaluationCount <= 2 ? [{ taskId: 'task-blocked', attemptId: 'attempt-blocked' }] : []
        });
      },
      async executeBuilder(input: ExecuteBuilderInput) {
        builderInputs.push(input);
        builderAttempts += 1;
        calls.push(`executeBuilder:${builderAttempts}`);
        if (builderAttempts === 1) {
          return ExecuteBuilderResultSchema.parse({
            status: 'blocked',
            runId: input.runId,
            taskId: input.taskId,
            attemptId: input.attemptId,
            blockerLeaseId: 'lease-blocked'
          });
        }
        return ExecuteBuilderResultSchema.parse({
          status: 'completed',
          runId: input.runId,
          taskId: input.taskId,
          workspaceId: 'workspace-blocked',
          attemptId: input.attemptId,
          impactId: 'impact-blocked'
        });
      },
      async evaluateBuilderOutput(input: EvaluateBuilderOutputInput) {
        calls.push('evaluateBuilderOutput');
        return EvaluateBuilderOutputResultSchema.parse({
          runId: input.runId,
          taskId: input.taskId,
          recommendation: 'accept',
          verificationId: 'verification-blocked',
          subjectRef: {
            builderAttemptId: input.builderAttemptId,
            outputAttemptId: 'output-blocked',
            workspaceId: input.workspaceId
          },
          reviewId: 'review-blocked'
        });
      },
      async admitRepair() {
        calls.push('admitRepair');
        throw new Error('admitRepair should not be called');
      },
      async executeRepair() {
        throw new Error('executeRepair should not be called');
      },
      async integrateAcceptedOutput(input: IntegrateAcceptedOutputInput) {
        calls.push('integrateAcceptedOutput');
        return IntegrateAcceptedOutputResultSchema.parse({
          runId: input.runId,
          taskId: input.taskId,
          status: 'integrated'
        });
      },
      async finalizeRunState(input: FinalizeRunStateInput) {
        calls.push('finalizeRunState');
        return FinalizeRunStateResultSchema.parse({ runId: input.runId, status: 'completed' });
      }
    };

    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'temporal-runtime-test-blocked-builder',
      workflowsPath: WORKFLOWS_PATH,
      activities
    });
    const runId = `run-blocked-builder-${Date.now()}`;
    const client = new Client({ connection: environment.client.connection });
    const workerPromise = worker.run();
    try {
      const handle = await client.workflow.start(forgeRunWorkflow, {
        taskQueue: 'temporal-runtime-test-blocked-builder',
        args: [{ runId }],
        workflowId: `workflow-${runId}`
      });

      await expect(handle.result()).resolves.toEqual({ runId, status: 'completed' });
      expect(calls).toEqual([
        'reevaluateRun:1',
        'executeBuilder:1',
        'reevaluateRun:2',
        'executeBuilder:2',
        'reevaluateRun:3',
        'evaluateBuilderOutput',
        'integrateAcceptedOutput',
        'reevaluateRun:4',
        'finalizeRunState'
      ]);
      expect(builderInputs).toEqual([
        { runId, taskId: 'task-blocked', attemptId: 'attempt-blocked' },
        { runId, taskId: 'task-blocked', attemptId: 'attempt-blocked' }
      ]);
    } finally {
      worker.shutdown();
      await workerPromise;
      await environment.teardown();
    }
  });

  it('repairs and integrates repaired output when the evaluation requests repair', async () => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const calls: string[] = [];

    const activities: ForgeActivities = {
      async reevaluateRun(_input: ReevaluateRunInput) {
        calls.push('reevaluateRun');
        return ReevaluateRunResultSchema.parse({
          runId: 'run-3',
          authorizedTasks: [{ taskId: 'task-2', attemptId: 'attempt-2' }]
        });
      },
      async executeBuilder(input: ExecuteBuilderInput) {
        calls.push(`executeBuilder:${input.taskId}`);
        return ExecuteBuilderResultSchema.parse({
          status: 'completed',
          runId: input.runId,
          taskId: input.taskId,
          workspaceId: 'workspace-2',
          attemptId: 'builder-attempt-2',
          impactId: 'impact-2'
        });
      },
      async evaluateBuilderOutput(input: EvaluateBuilderOutputInput) {
        calls.push(`evaluateBuilderOutput:${input.taskId}`);
        return EvaluateBuilderOutputResultSchema.parse({
          runId: input.runId,
          taskId: input.taskId,
          recommendation: 'repair',
          verificationId: 'verification-2',
          subjectRef: {
            builderAttemptId: 'builder-attempt-2',
            outputAttemptId: 'output-attempt-2',
            workspaceId: 'workspace-2'
          },
          reviewId: 'review-2'
        });
      },
      async admitRepair(input: AdmitRepairInput) {
        calls.push(`admitRepair:${input.taskId}`);
        return AdmitRepairResultSchema.parse({
          runId: input.runId,
          taskId: input.taskId,
          repairAttemptId: 'repair-attempt-2'
        });
      },
      async executeRepair(input: ExecuteRepairInput) {
        calls.push(`executeRepair:${input.taskId}`);
        return ExecuteRepairResultSchema.parse({
          runId: input.runId,
          taskId: input.taskId,
          state: 'completed',
          repairAttemptId: input.repairAttemptId,
          recommendation: 'accept',
          verificationId: 'verification-3',
          subjectRef: {
            builderAttemptId: 'builder-attempt-2',
            outputAttemptId: 'repair-output-attempt-2',
            workspaceId: 'workspace-2'
          },
          reviewId: 'review-3'
        });
      },
      async integrateAcceptedOutput(input: IntegrateAcceptedOutputInput) {
        calls.push(`integrateAcceptedOutput:${input.taskId}`);
        return IntegrateAcceptedOutputResultSchema.parse({
          runId: input.runId,
          taskId: input.taskId,
          status: 'integrated'
        });
      },
      async finalizeRunState(_input: FinalizeRunStateInput) {
        calls.push('finalizeRunState');
        return FinalizeRunStateResultSchema.parse({ runId: 'run-3', status: 'completed' });
      }
    };

    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'temporal-runtime-test-scenario-a-repair',
      workflowsPath: WORKFLOWS_PATH,
      activities
    });

    const runId = `run-repair-${Date.now()}`;
    const client = new Client({ connection: environment.client.connection });

    const workerPromise = worker.run();
    try {
      const handle = await client.workflow.start(forgeRunWorkflow, {
        taskQueue: 'temporal-runtime-test-scenario-a-repair',
        args: [{ runId }],
        workflowId: `workflow-${runId}`
      });

      const result = await handle.result();
      expect(result).toEqual({ runId, status: 'completed' });
      expect(calls).toEqual([
        'reevaluateRun',
        'executeBuilder:task-2',
        'reevaluateRun',
        'evaluateBuilderOutput:task-2',
        'admitRepair:task-2',
        'executeRepair:task-2',
        'integrateAcceptedOutput:task-2',
        'reevaluateRun',
        'finalizeRunState'
      ]);
    } finally {
      worker.shutdown();
      await workerPromise;
      await environment.teardown();
    }
  });

  it('admits a second repair before integrating repaired output', async () => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const calls: string[] = [];
    let repairCallCount = 0;
    const admittedReviewIds: string[] = [];
    const repairReviewIds: string[] = [];

    const activities: ForgeActivities = {
      async reevaluateRun(_input: ReevaluateRunInput) {
        calls.push('reevaluateRun');
        return ReevaluateRunResultSchema.parse({
          runId: 'run-5',
          authorizedTasks: [{ taskId: 'task-5', attemptId: 'attempt-5' }]
        });
      },
      async executeBuilder(input: ExecuteBuilderInput) {
        calls.push(`executeBuilder:${input.taskId}`);
        return ExecuteBuilderResultSchema.parse({
          status: 'completed',
          runId: input.runId,
          taskId: input.taskId,
          workspaceId: 'workspace-5',
          attemptId: 'builder-attempt-5',
          impactId: 'impact-5'
        });
      },
      async evaluateBuilderOutput(input: EvaluateBuilderOutputInput) {
        calls.push(`evaluateBuilderOutput:${input.taskId}`);
        return EvaluateBuilderOutputResultSchema.parse({
          runId: input.runId,
          taskId: input.taskId,
          recommendation: 'repair',
          verificationId: 'verification-5',
          subjectRef: {
            builderAttemptId: 'builder-attempt-5',
            outputAttemptId: 'output-attempt-5',
            workspaceId: 'workspace-5'
          },
          reviewId: 'review-5'
        });
      },
      async admitRepair(input: AdmitRepairInput) {
        calls.push(`admitRepair:${input.taskId}`);
        admittedReviewIds.push(input.reviewId);
        return AdmitRepairResultSchema.parse({
          runId: input.runId,
          taskId: input.taskId,
          repairAttemptId: `repair-attempt-5${repairCallCount === 0 ? 'a' : 'b'}`
        });
      },
      async executeRepair(input: ExecuteRepairInput) {
        repairCallCount += 1;
        calls.push(`executeRepair:${input.taskId}:${input.repairAttemptId}`);
        repairReviewIds.push(input.reviewId);
        return ExecuteRepairResultSchema.parse({
          runId: input.runId,
          taskId: input.taskId,
          state: 'completed',
          repairAttemptId: input.repairAttemptId,
          recommendation: repairCallCount === 1 ? 'repair' : 'accept',
          verificationId: repairCallCount === 1 ? 'verification-5b' : 'verification-5c',
          subjectRef: {
            builderAttemptId: 'builder-attempt-5',
            outputAttemptId:
              repairCallCount === 1 ? 'repair-output-attempt-5' : 'repair-output-attempt-5b',
            workspaceId: 'workspace-5'
          },
          reviewId: repairCallCount === 1 ? 'review-5b' : 'review-5c'
        });
      },
      async integrateAcceptedOutput(_input: IntegrateAcceptedOutputInput) {
        calls.push('integrateAcceptedOutput');
        return IntegrateAcceptedOutputResultSchema.parse({
          runId: 'run-5',
          taskId: 'task-5',
          status: 'integrated'
        });
      },
      async finalizeRunState(_input: FinalizeRunStateInput) {
        calls.push('finalizeRunState');
        return FinalizeRunStateResultSchema.parse({ runId: 'run-5', status: 'completed' });
      }
    };

    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'temporal-runtime-test-scenario-a-repair-fail-closed',
      workflowsPath: WORKFLOWS_PATH,
      activities
    });

    const runId = `run-repair-fail-${Date.now()}`;
    const client = new Client({ connection: environment.client.connection });

    const workerPromise = worker.run();
    try {
      const handle = await client.workflow.start(forgeRunWorkflow, {
        taskQueue: 'temporal-runtime-test-scenario-a-repair-fail-closed',
        args: [{ runId }],
        workflowId: `workflow-${runId}`
      });

      const result = await handle.result();
      expect(result).toEqual({ runId, status: 'completed' });
      expect(calls).toEqual([
        'reevaluateRun',
        'executeBuilder:task-5',
        'reevaluateRun',
        'evaluateBuilderOutput:task-5',
        'admitRepair:task-5',
        'executeRepair:task-5:repair-attempt-5a',
        'admitRepair:task-5',
        'executeRepair:task-5:repair-attempt-5b',
        'integrateAcceptedOutput',
        'reevaluateRun',
        'finalizeRunState'
      ]);
      expect(admittedReviewIds).toEqual(['review-5', 'review-5b']);
      expect(repairReviewIds).toEqual(['review-5', 'review-5b']);
      expect(repairCallCount).toBe(2);
    } finally {
      worker.shutdown();
      await workerPromise;
      await environment.teardown();
    }
  });

  it('returns failed when Forge finalization fails', async () => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const calls: string[] = [];

    const activities: ForgeActivities = {
      async reevaluateRun(_input: ReevaluateRunInput) {
        calls.push('reevaluateRun');
        return ReevaluateRunResultSchema.parse({
          runId: 'run-6',
          authorizedTasks: []
        });
      },
      async executeBuilder(_input: ExecuteBuilderInput) {
        calls.push('executeBuilder');
        throw new Error('executeBuilder should not be called');
      },
      async evaluateBuilderOutput(_input: EvaluateBuilderOutputInput) {
        calls.push('evaluateBuilderOutput');
        throw new Error('evaluateBuilderOutput should not be called');
      },
      async admitRepair(_input: AdmitRepairInput) {
        calls.push('admitRepair');
        throw new Error('admitRepair should not be called');
      },
      async executeRepair(_input: ExecuteRepairInput) {
        calls.push('executeRepair');
        throw new Error('executeRepair should not be called');
      },
      async integrateAcceptedOutput(_input: IntegrateAcceptedOutputInput) {
        calls.push('integrateAcceptedOutput');
        throw new Error('integrateAcceptedOutput should not be called');
      },
      async finalizeRunState(_input: FinalizeRunStateInput) {
        calls.push('finalizeRunState');
        return FinalizeRunStateResultSchema.parse({ runId: 'run-6', status: 'failed' });
      }
    };

    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'temporal-runtime-test-scenario-a-finalize-failed',
      workflowsPath: WORKFLOWS_PATH,
      activities
    });

    const runId = `run-finalize-failed-${Date.now()}`;
    const client = new Client({ connection: environment.client.connection });

    const workerPromise = worker.run();
    try {
      const handle = await client.workflow.start(forgeRunWorkflow, {
        taskQueue: 'temporal-runtime-test-scenario-a-finalize-failed',
        args: [{ runId }],
        workflowId: `workflow-${runId}`
      });

      const result = await handle.result();
      expect(result).toEqual({ runId, status: 'failed' });
      expect(calls).toEqual(['reevaluateRun', 'finalizeRunState']);
    } finally {
      worker.shutdown();
      await workerPromise;
      await environment.teardown();
    }
  });

  it('waits for repairWake and resumes a blocked repair with the same repairAttemptId', async () => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const calls: string[] = [];
    let repairAttempts = 0;

    const activities: ForgeActivities = {
      async reevaluateRun(_input: ReevaluateRunInput) {
        calls.push('reevaluateRun');
        return ReevaluateRunResultSchema.parse({
          runId: 'run-blocked',
          authorizedTasks: [{ taskId: 'task-blocked', attemptId: 'attempt-blocked' }]
        });
      },
      async executeBuilder(input: ExecuteBuilderInput) {
        calls.push(`executeBuilder:${input.taskId}`);
        return ExecuteBuilderResultSchema.parse({
          status: 'completed',
          runId: input.runId,
          taskId: input.taskId,
          workspaceId: 'workspace-blocked',
          attemptId: 'builder-attempt-blocked',
          impactId: 'impact-blocked'
        });
      },
      async evaluateBuilderOutput(input: EvaluateBuilderOutputInput) {
        calls.push(`evaluateBuilderOutput:${input.taskId}`);
        return EvaluateBuilderOutputResultSchema.parse({
          runId: input.runId,
          taskId: input.taskId,
          recommendation: 'repair',
          verificationId: 'verification-blocked',
          subjectRef: {
            builderAttemptId: 'builder-attempt-blocked',
            outputAttemptId: 'output-attempt-blocked',
            workspaceId: 'workspace-blocked'
          },
          reviewId: 'review-blocked'
        });
      },
      async admitRepair(input: AdmitRepairInput) {
        calls.push(`admitRepair:${input.taskId}`);
        return AdmitRepairResultSchema.parse({
          runId: input.runId,
          taskId: input.taskId,
          repairAttemptId: 'repair-attempt-blocked'
        });
      },
      async executeRepair(input: ExecuteRepairInput) {
        repairAttempts += 1;
        calls.push(`executeRepair:${input.taskId}:${input.repairAttemptId}`);
        if (repairAttempts === 1) {
          return ExecuteRepairResultSchema.parse({
            runId: input.runId,
            taskId: input.taskId,
            state: 'blocked',
            repairAttemptId: input.repairAttemptId,
            blockerLeaseId: 'lease-blocked-1'
          });
        }
        return ExecuteRepairResultSchema.parse({
          runId: input.runId,
          taskId: input.taskId,
          state: 'completed',
          repairAttemptId: input.repairAttemptId,
          recommendation: 'accept',
          verificationId: 'verification-blocked-2',
          subjectRef: {
            builderAttemptId: 'builder-attempt-blocked',
            outputAttemptId: 'repair-output-blocked',
            workspaceId: 'workspace-blocked'
          },
          reviewId: 'review-blocked-2'
        });
      },
      async integrateAcceptedOutput(input: IntegrateAcceptedOutputInput) {
        calls.push(`integrateAcceptedOutput:${input.taskId}`);
        return IntegrateAcceptedOutputResultSchema.parse({
          runId: input.runId,
          taskId: input.taskId,
          status: 'integrated'
        });
      },
      async finalizeRunState(_input: FinalizeRunStateInput) {
        calls.push('finalizeRunState');
        return FinalizeRunStateResultSchema.parse({ runId: 'run-blocked', status: 'completed' });
      },
      async resumeBlockedRepair(input) {
        calls.push(`resumeBlockedRepair:${input.repairAttemptId}`);
        return {
          runId: input.runId,
          repairAttemptId: input.repairAttemptId,
          status: 'resumed',
          taskId: 'task-blocked'
        };
      }
    };

    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'temporal-runtime-test-scenario-b-blocked-repair',
      workflowsPath: WORKFLOWS_PATH,
      activities
    });

    const runId = `run-blocked-${Date.now()}`;
    const client = new Client({ connection: environment.client.connection });

    const workerPromise = worker.run();
    try {
      const handle = await client.workflow.start(forgeRunWorkflow, {
        taskQueue: 'temporal-runtime-test-scenario-b-blocked-repair',
        args: [{ runId }],
        workflowId: `workflow-${runId}`
      });

      await environment.sleep(200);
      await handle.signal(repairWakeSignal, { repairAttemptId: 'repair-attempt-blocked' });

      const result = await handle.result();
      expect(result).toEqual({ runId, status: 'completed' });
      expect(calls).toEqual([
        'reevaluateRun',
        'executeBuilder:task-blocked',
        'reevaluateRun',
        'evaluateBuilderOutput:task-blocked',
        'admitRepair:task-blocked',
        'executeRepair:task-blocked:repair-attempt-blocked',
        'resumeBlockedRepair:repair-attempt-blocked',
        'executeRepair:task-blocked:repair-attempt-blocked',
        'integrateAcceptedOutput:task-blocked',
        'reevaluateRun',
        'finalizeRunState'
      ]);
      expect(repairAttempts).toBe(2);
    } finally {
      worker.shutdown();
      await workerPromise;
      await environment.teardown();
    }
  });

  it('waits for an exact integration wake and resumes the blocked accepted output', async () => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const calls: string[] = [];
    const activities: ForgeActivities & BlockedIntegrationContinuationActivities = {
      async reevaluateRun(input) {
        calls.push('reevaluateRun');
        return ReevaluateRunResultSchema.parse({
          runId: input.runId,
          authorizedTasks:
            calls.filter((call) => call === 'reevaluateRun').length === 1
              ? [{ taskId: 'task-integration', attemptId: 'attempt-integration' }]
              : []
        });
      },
      async executeBuilder(input) {
        calls.push(`executeBuilder:${input.taskId}`);
        return ExecuteBuilderResultSchema.parse({
          status: 'completed',
          runId: input.runId,
          taskId: input.taskId,
          workspaceId: 'workspace-integration',
          attemptId: input.attemptId,
          impactId: 'impact-integration'
        });
      },
      async evaluateBuilderOutput(input) {
        calls.push(`evaluateBuilderOutput:${input.taskId}`);
        return EvaluateBuilderOutputResultSchema.parse({
          runId: input.runId,
          taskId: input.taskId,
          recommendation: 'accept',
          verificationId: 'verification-integration',
          subjectRef: {
            builderAttemptId: input.builderAttemptId,
            outputAttemptId: input.builderAttemptId,
            workspaceId: input.workspaceId
          },
          reviewId: 'review-integration'
        });
      },
      async admitRepair() {
        throw new Error('admitRepair should not be called');
      },
      async executeRepair() {
        throw new Error('executeRepair should not be called');
      },
      async integrateAcceptedOutput(input) {
        calls.push(`integrateAcceptedOutput:${input.taskId}`);
        return IntegrateAcceptedOutputResultSchema.parse({
          runId: input.runId,
          taskId: input.taskId,
          status: 'blocked'
        });
      },
      async resumeBlockedIntegration(input) {
        calls.push(`resumeBlockedIntegration:${input.taskId}:${input.workspaceId}`);
        return { runId: input.runId, taskId: input.taskId, status: 'integrated' as const };
      },
      async finalizeRunState(input) {
        calls.push('finalizeRunState');
        return FinalizeRunStateResultSchema.parse({ runId: input.runId, status: 'completed' });
      },
      async resumeBlockedRepair() {
        throw new Error('resumeBlockedRepair should not be called');
      }
    };
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'temporal-runtime-test-blocked-integration',
      workflowsPath: WORKFLOWS_PATH,
      activities
    });
    const runId = `run-integration-${Date.now()}`;
    const client = new Client({ connection: environment.client.connection });
    const workerPromise = worker.run();
    try {
      const handle = await client.workflow.start(forgeRunWorkflow, {
        taskQueue: 'temporal-runtime-test-blocked-integration',
        args: [{ runId }],
        workflowId: `workflow-${runId}`
      });
      await environment.sleep(200);
      expect(calls).toContain('integrateAcceptedOutput:task-integration');
      expect(calls).not.toContain('finalizeRunState');
      await handle.signal(integrationWakeSignal, {
        taskId: 'task-integration',
        workspaceId: 'workspace-integration',
        subjectRef: {
          builderAttemptId: 'attempt-integration',
          outputAttemptId: 'attempt-integration',
          workspaceId: 'workspace-integration'
        }
      });
      await expect(handle.result()).resolves.toEqual({ runId, status: 'completed' });
      expect(calls).toEqual([
        'reevaluateRun',
        'executeBuilder:task-integration',
        'reevaluateRun',
        'evaluateBuilderOutput:task-integration',
        'integrateAcceptedOutput:task-integration',
        'resumeBlockedIntegration:task-integration:workspace-integration',
        'reevaluateRun',
        'finalizeRunState'
      ]);
    } finally {
      worker.shutdown();
      await workerPromise;
      await environment.teardown();
    }
  });

  it('ignores mismatched wakes and remains blocked through a repeated integration block', async () => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const calls: string[] = [];
    let integrationAttempts = 0;
    const subject = {
      builderAttemptId: 'attempt-integration-repeat',
      outputAttemptId: 'attempt-integration-repeat',
      workspaceId: 'workspace-integration-repeat'
    };
    const activities: ForgeActivities & BlockedIntegrationContinuationActivities = {
      async reevaluateRun(input) {
        calls.push('reevaluateRun');
        return ReevaluateRunResultSchema.parse({
          runId: input.runId,
          authorizedTasks:
            calls.filter((call) => call === 'reevaluateRun').length === 1
              ? [{ taskId: 'task-integration-repeat', attemptId: subject.builderAttemptId }]
              : []
        });
      },
      async executeBuilder(input) {
        calls.push(`executeBuilder:${input.taskId}`);
        return ExecuteBuilderResultSchema.parse({
          status: 'completed',
          runId: input.runId,
          taskId: input.taskId,
          workspaceId: subject.workspaceId,
          attemptId: input.attemptId,
          impactId: 'impact-integration-repeat'
        });
      },
      async evaluateBuilderOutput(input) {
        calls.push(`evaluateBuilderOutput:${input.taskId}`);
        return EvaluateBuilderOutputResultSchema.parse({
          runId: input.runId,
          taskId: input.taskId,
          recommendation: 'accept',
          verificationId: 'verification-integration-repeat',
          subjectRef: subject,
          reviewId: 'review-integration-repeat'
        });
      },
      async admitRepair() {
        throw new Error('admitRepair should not be called');
      },
      async executeRepair() {
        throw new Error('executeRepair should not be called');
      },
      async integrateAcceptedOutput(input) {
        integrationAttempts += 1;
        calls.push(`integrateAcceptedOutput:${input.taskId}`);
        return IntegrateAcceptedOutputResultSchema.parse({
          runId: input.runId,
          taskId: input.taskId,
          status: 'blocked'
        });
      },
      async resumeBlockedIntegration(input) {
        integrationAttempts += 1;
        calls.push(`resumeBlockedIntegration:${input.taskId}:${input.workspaceId}`);
        return {
          runId: input.runId,
          taskId: input.taskId,
          status: integrationAttempts === 2 ? ('blocked' as const) : ('integrated' as const)
        };
      },
      async finalizeRunState(input) {
        calls.push('finalizeRunState');
        return FinalizeRunStateResultSchema.parse({ runId: input.runId, status: 'completed' });
      },
      async resumeBlockedRepair() {
        throw new Error('resumeBlockedRepair should not be called');
      }
    };
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'temporal-runtime-test-repeated-blocked-integration',
      workflowsPath: WORKFLOWS_PATH,
      activities
    });
    const runId = `run-integration-repeat-${Date.now()}`;
    const client = new Client({ connection: environment.client.connection });
    const workerPromise = worker.run();
    try {
      const handle = await client.workflow.start(forgeRunWorkflow, {
        taskQueue: 'temporal-runtime-test-repeated-blocked-integration',
        args: [{ runId }],
        workflowId: `workflow-${runId}`
      });
      await environment.sleep(200);
      await handle.signal(integrationWakeSignal, {
        taskId: 'wrong-task',
        workspaceId: subject.workspaceId,
        subjectRef: subject
      });
      await environment.sleep(100);
      expect(calls).not.toContain(`resumeBlockedIntegration:wrong-task:${subject.workspaceId}`);

      await handle.signal(integrationWakeSignal, {
        taskId: 'task-integration-repeat',
        workspaceId: subject.workspaceId,
        subjectRef: subject
      });
      await environment.sleep(100);
      expect(calls).toContain(
        `resumeBlockedIntegration:task-integration-repeat:${subject.workspaceId}`
      );
      expect(calls).not.toContain('finalizeRunState');

      await handle.signal(integrationWakeSignal, {
        taskId: 'task-integration-repeat',
        workspaceId: subject.workspaceId,
        subjectRef: subject
      });
      await expect(handle.result()).resolves.toEqual({ runId, status: 'completed' });
      expect(integrationAttempts).toBe(3);
      expect(calls.filter((call) => call.startsWith('resumeBlockedIntegration:'))).toHaveLength(2);
    } finally {
      worker.shutdown();
      await workerPromise;
      await environment.teardown();
    }
  });

  it('reevaluates after builder execution and discovers dependent tasks', async () => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const calls: string[] = [];

    const activities: ForgeActivities = {
      async reevaluateRun(_input: ReevaluateRunInput) {
        const reevaluateCount = calls.filter((call) => call === 'reevaluateRun').length;
        calls.push('reevaluateRun');
        if (reevaluateCount === 0) {
          return ReevaluateRunResultSchema.parse({
            runId: 'run-4',
            authorizedTasks: [{ taskId: 'task-a', attemptId: 'attempt-a' }]
          });
        }

        return ReevaluateRunResultSchema.parse({
          runId: 'run-4',
          authorizedTasks: [{ taskId: 'task-b', attemptId: 'attempt-b' }]
        });
      },
      async executeBuilder(input: ExecuteBuilderInput) {
        calls.push(`executeBuilder:${input.taskId}`);
        return ExecuteBuilderResultSchema.parse({
          status: 'completed',
          runId: input.runId,
          taskId: input.taskId,
          workspaceId: `workspace-${input.taskId}`,
          attemptId: `builder-${input.taskId}`,
          impactId: `impact-${input.taskId}`
        });
      },
      async evaluateBuilderOutput(input: EvaluateBuilderOutputInput) {
        calls.push(`evaluateBuilderOutput:${input.taskId}`);
        return EvaluateBuilderOutputResultSchema.parse({
          runId: input.runId,
          taskId: input.taskId,
          recommendation: 'accept',
          verificationId: `verification-${input.taskId}`,
          subjectRef: {
            builderAttemptId: `builder-${input.taskId}`,
            outputAttemptId: `output-${input.taskId}`,
            workspaceId: `workspace-${input.taskId}`
          },
          reviewId: `review-${input.taskId}`
        });
      },
      async admitRepair(_input: AdmitRepairInput) {
        calls.push('admitRepair');
        throw new Error('admitRepair should not be called');
      },
      async executeRepair(_input: ExecuteRepairInput) {
        calls.push('executeRepair');
        throw new Error('executeRepair should not be called');
      },
      async integrateAcceptedOutput(input: IntegrateAcceptedOutputInput) {
        calls.push(`integrateAcceptedOutput:${input.taskId}`);
        return IntegrateAcceptedOutputResultSchema.parse({
          runId: input.runId,
          taskId: input.taskId,
          status: 'integrated'
        });
      },
      async finalizeRunState(_input: FinalizeRunStateInput) {
        calls.push('finalizeRunState');
        return FinalizeRunStateResultSchema.parse({ runId: 'run-4', status: 'completed' });
      }
    };

    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'temporal-runtime-test-scenario-a-chain',
      workflowsPath: WORKFLOWS_PATH,
      activities
    });

    const runId = `run-chain-${Date.now()}`;
    const client = new Client({ connection: environment.client.connection });

    const workerPromise = worker.run();
    try {
      const handle = await client.workflow.start(forgeRunWorkflow, {
        taskQueue: 'temporal-runtime-test-scenario-a-chain',
        args: [{ runId }],
        workflowId: `workflow-${runId}`
      });

      const result = await handle.result();
      expect(result).toEqual({ runId, status: 'completed' });
      expect(calls).toEqual([
        'reevaluateRun',
        'executeBuilder:task-a',
        'reevaluateRun',
        'evaluateBuilderOutput:task-a',
        'integrateAcceptedOutput:task-a',
        'reevaluateRun',
        'executeBuilder:task-b',
        'reevaluateRun',
        'evaluateBuilderOutput:task-b',
        'integrateAcceptedOutput:task-b',
        'reevaluateRun',
        'finalizeRunState'
      ]);
    } finally {
      worker.shutdown();
      await workerPromise;
      await environment.teardown();
    }
  });
});

describe('temporal-runtime payload boundary', () => {
  it('ForgeRunInputSchema accepts only compact IDs', () => {
    const result = ForgeRunInputSchema.safeParse({ runId: 'run-123' });
    expect(result.success).toBe(true);
  });

  it('ForgeRunInputSchema rejects empty runId', () => {
    expect(ForgeRunInputSchema.safeParse({ runId: '' }).success).toBe(false);
  });

  it('ForgeRunInputSchema rejects missing runId', () => {
    expect(ForgeRunInputSchema.safeParse({}).success).toBe(false);
  });

  it('ForgeRunResultSchema accepts only compact status enum', () => {
    expect(ForgeRunResultSchema.safeParse({ runId: 'r1', status: 'completed' }).success).toBe(true);
    expect(ForgeRunResultSchema.safeParse({ runId: 'r1', status: 'failed' }).success).toBe(true);
    expect(ForgeRunResultSchema.safeParse({ runId: 'r1', status: 'unknown' }).success).toBe(false);
  });
});
