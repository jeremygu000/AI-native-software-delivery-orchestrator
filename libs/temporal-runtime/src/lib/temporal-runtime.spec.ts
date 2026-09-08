import { Client } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  forgeRunWorkflow,
  ForgeRunInputSchema,
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
} from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../../..');
const WORKFLOWS_PATH = resolve(
  PROJECT_ROOT,
  'libs/temporal-runtime/dist/lib/workflows/forge-run.js',
);

describe('temporal-runtime Scenario A workflow', () => {
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
        throw new Error('integrateAcceptedOutput should not be called');
      },
      async finalizeRunState(_input: FinalizeRunStateInput) {
        calls.push('finalizeRunState');
        return FinalizeRunStateResultSchema.parse({ runId: 'run-1', status: 'completed' });
      },
    };

    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'temporal-runtime-test-scenario-a-empty',
      workflowsPath: WORKFLOWS_PATH,
      activities,
    });

    const runId = `run-empty-${Date.now()}`;
    const client = new Client({ connection: environment.client.connection });

    const workerPromise = worker.run();
    try {
      const handle = await client.workflow.start(forgeRunWorkflow, {
        taskQueue: 'temporal-runtime-test-scenario-a-empty',
        args: [{ runId }],
        workflowId: `workflow-${runId}`,
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
          authorizedTasks: [{ taskId: 'task-1', bindingId: 'binding-1', attemptId: 'attempt-1' }],
        });
      },
      async executeBuilder(input: ExecuteBuilderInput) {
        calls.push(`executeBuilder:${input.taskId}`);
        return ExecuteBuilderResultSchema.parse({
          runId: input.runId,
          taskId: input.taskId,
          workspaceId: 'workspace-1',
          attemptId: 'builder-attempt-1',
          impactId: 'impact-1',
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
            workspaceId: 'workspace-1',
          },
          reviewId: 'review-1',
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
          status: 'integrated',
        });
      },
      async finalizeRunState(_input: FinalizeRunStateInput) {
        calls.push('finalizeRunState');
        return FinalizeRunStateResultSchema.parse({ runId: 'run-2', status: 'completed' });
      },
    };

    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'temporal-runtime-test-scenario-a-accept',
      workflowsPath: WORKFLOWS_PATH,
      activities,
    });

    const runId = `run-accept-${Date.now()}`;
    const client = new Client({ connection: environment.client.connection });

    const workerPromise = worker.run();
    try {
      const handle = await client.workflow.start(forgeRunWorkflow, {
        taskQueue: 'temporal-runtime-test-scenario-a-accept',
        args: [{ runId }],
        workflowId: `workflow-${runId}`,
      });

      const result = await handle.result();
      expect(result).toEqual({ runId, status: 'completed' });
      expect(calls).toEqual([
        'reevaluateRun',
        'executeBuilder:task-1',
        'reevaluateRun',
        'evaluateBuilderOutput:task-1',
        'integrateAcceptedOutput:task-1',
        'finalizeRunState',
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
          authorizedTasks: [{ taskId: 'task-2', bindingId: 'binding-2', attemptId: 'attempt-2' }],
        });
      },
      async executeBuilder(input: ExecuteBuilderInput) {
        calls.push(`executeBuilder:${input.taskId}`);
        return ExecuteBuilderResultSchema.parse({
          runId: input.runId,
          taskId: input.taskId,
          workspaceId: 'workspace-2',
          attemptId: 'builder-attempt-2',
          impactId: 'impact-2',
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
            workspaceId: 'workspace-2',
          },
          reviewId: 'review-2',
        });
      },
      async admitRepair(input: AdmitRepairInput) {
        calls.push(`admitRepair:${input.taskId}`);
        return AdmitRepairResultSchema.parse({
          runId: input.runId,
          taskId: input.taskId,
          repairAttemptId: 'repair-attempt-2',
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
            workspaceId: 'workspace-2',
          },
          reviewId: 'review-3',
        });
      },
      async integrateAcceptedOutput(input: IntegrateAcceptedOutputInput) {
        calls.push(`integrateAcceptedOutput:${input.taskId}`);
        return IntegrateAcceptedOutputResultSchema.parse({
          runId: input.runId,
          taskId: input.taskId,
          status: 'integrated',
        });
      },
      async finalizeRunState(_input: FinalizeRunStateInput) {
        calls.push('finalizeRunState');
        return FinalizeRunStateResultSchema.parse({ runId: 'run-3', status: 'completed' });
      },
    };

    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'temporal-runtime-test-scenario-a-repair',
      workflowsPath: WORKFLOWS_PATH,
      activities,
    });

    const runId = `run-repair-${Date.now()}`;
    const client = new Client({ connection: environment.client.connection });

    const workerPromise = worker.run();
    try {
      const handle = await client.workflow.start(forgeRunWorkflow, {
        taskQueue: 'temporal-runtime-test-scenario-a-repair',
        args: [{ runId }],
        workflowId: `workflow-${runId}`,
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
        'finalizeRunState',
      ]);
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
            authorizedTasks: [{ taskId: 'task-a', bindingId: 'binding-a', attemptId: 'attempt-a' }],
          });
        }

        return ReevaluateRunResultSchema.parse({
          runId: 'run-4',
          authorizedTasks: [{ taskId: 'task-b', bindingId: 'binding-b', attemptId: 'attempt-b' }],
        });
      },
      async executeBuilder(input: ExecuteBuilderInput) {
        calls.push(`executeBuilder:${input.taskId}`);
        return ExecuteBuilderResultSchema.parse({
          runId: input.runId,
          taskId: input.taskId,
          workspaceId: `workspace-${input.taskId}`,
          attemptId: `builder-${input.taskId}`,
          impactId: `impact-${input.taskId}`,
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
            workspaceId: `workspace-${input.taskId}`,
          },
          reviewId: `review-${input.taskId}`,
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
          status: 'integrated',
        });
      },
      async finalizeRunState(_input: FinalizeRunStateInput) {
        calls.push('finalizeRunState');
        return FinalizeRunStateResultSchema.parse({ runId: 'run-4', status: 'completed' });
      },
    };

    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: 'temporal-runtime-test-scenario-a-chain',
      workflowsPath: WORKFLOWS_PATH,
      activities,
    });

    const runId = `run-chain-${Date.now()}`;
    const client = new Client({ connection: environment.client.connection });

    const workerPromise = worker.run();
    try {
      const handle = await client.workflow.start(forgeRunWorkflow, {
        taskQueue: 'temporal-runtime-test-scenario-a-chain',
        args: [{ runId }],
        workflowId: `workflow-${runId}`,
      });

      const result = await handle.result();
      expect(result).toEqual({ runId, status: 'completed' });
      expect(calls).toEqual([
        'reevaluateRun',
        'executeBuilder:task-a',
        'reevaluateRun',
        'evaluateBuilderOutput:task-a',
        'integrateAcceptedOutput:task-a',
        'executeBuilder:task-b',
        'reevaluateRun',
        'evaluateBuilderOutput:task-b',
        'integrateAcceptedOutput:task-b',
        'finalizeRunState',
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
    expect(ForgeRunResultSchema.safeParse({ runId: 'r1', status: 'completed' }).success).toBe(
      true,
    );
    expect(ForgeRunResultSchema.safeParse({ runId: 'r1', status: 'failed' }).success).toBe(true);
    expect(ForgeRunResultSchema.safeParse({ runId: 'r1', status: 'unknown' }).success).toBe(
      false,
    );
  });
});
