import { z } from 'zod';

import type {
  HardTaskConflict,
  ObservedTaskImpact,
  RiskTaskConflict,
  TaskImpact
} from './conflict.js';
import { ConflictAction, conflictActionSchema } from './conflict.js';
import type { AgentExecutionAttempt, AgentSessionRef } from './agent-execution.js';
import type { AgentCommandPolicy } from './command-policy.js';
import type { AgentCommandSandboxProfile } from './command-sandbox.js';
import type { WriteLease } from './write-lease.js';
import type { TaskContract } from './task-contract.js';
import { TaskState, taskStateSchema } from './task-state.js';
import type { TaskWorkspace } from './workspace.js';

const taskIdSchema = z.string().trim().min(1);

export interface ExecutionWave {
  readonly index: number;
  readonly taskIds: readonly string[];
}

export interface ExecutionPlan {
  readonly waves: readonly ExecutionWave[];
}

export const scheduleOptionsSchema = z.object({
  maxConcurrency: z.int().positive()
});

export type ScheduleOptions = z.infer<typeof scheduleOptionsSchema>;

const taskEventSchema = z.object({ taskId: taskIdSchema });

export const schedulerEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run-started') }),
  taskEventSchema.extend({
    type: z.literal('agent-completed'),
    state: z.literal(TaskState.VERIFYING)
  }),
  taskEventSchema.extend({
    type: z.literal('task-completed'),
    state: z.literal(TaskState.COMPLETED)
  }),
  taskEventSchema.extend({ type: z.literal('task-failed'), state: z.literal(TaskState.FAILED) }),
  taskEventSchema.extend({
    type: z.literal('workspace-integrated'),
    state: z.literal(TaskState.COMPLETED)
  }),
  taskEventSchema.extend({
    type: z.literal('verification-completed'),
    state: z.literal(TaskState.INTEGRATING)
  }),
  taskEventSchema.extend({ type: z.literal('lease-blocked'), leaseId: taskIdSchema }),
  taskEventSchema.extend({ type: z.literal('lease-released'), leaseId: taskIdSchema }),
  taskEventSchema.extend({ type: z.literal('lease-release-failed'), leaseId: taskIdSchema }),
  taskEventSchema.extend({ type: z.literal('lease-stale'), leaseId: taskIdSchema }),
  taskEventSchema.extend({
    type: z.literal('runtime-conflict-discovered'),
    conflictId: taskIdSchema
  }),
  taskEventSchema.extend({ type: z.literal('runtime-conflict-resolved'), conflictId: taskIdSchema })
]);

export type SchedulerEvent = z.infer<typeof schedulerEventSchema>;

export const schedulerRuntimeBlockerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('lease'), leaseId: taskIdSchema }),
  z.object({ type: z.literal('runtime-conflict'), conflictId: taskIdSchema })
]);

export type SchedulerRuntimeBlocker = z.infer<typeof schedulerRuntimeBlockerSchema>;

export const schedulerTaskStateSchema = z.object({
  taskId: taskIdSchema,
  state: taskStateSchema
});

export type SchedulerTaskState = z.infer<typeof schedulerTaskStateSchema>;

export const schedulerRuntimeBlockSchema = z.object({
  taskId: taskIdSchema,
  blockers: z.array(schedulerRuntimeBlockerSchema).min(1)
});

export type SchedulerRuntimeBlock = z.infer<typeof schedulerRuntimeBlockSchema>;

export const schedulerSnapshotSchema = z.object({
  taskStates: z.array(schedulerTaskStateSchema),
  runtimeBlocks: z.array(schedulerRuntimeBlockSchema)
});

export type SchedulerSnapshot = z.infer<typeof schedulerSnapshotSchema>;

const schedulerDecisionReasonBaseSchema = z.object({
  detail: z.string().trim().min(1).optional()
});

export const schedulerDecisionReasonSchema = z.discriminatedUnion('type', [
  schedulerDecisionReasonBaseSchema.extend({
    type: z.literal('dependencies-completed'),
    dependencyTaskIds: z.array(taskIdSchema)
  }),
  schedulerDecisionReasonBaseSchema.extend({
    type: z.literal('dependency-incomplete'),
    dependencyTaskIds: z.array(taskIdSchema).min(1)
  }),
  schedulerDecisionReasonBaseSchema.extend({
    type: z.literal('task-state-not-runnable'),
    taskState: taskStateSchema
  }),
  schedulerDecisionReasonBaseSchema.extend({
    type: z.literal('hard-conflict'),
    conflictingTaskIds: z.array(taskIdSchema).min(1),
    constraintTypes: z.array(z.string().min(1)).min(1)
  }),
  schedulerDecisionReasonBaseSchema.extend({
    type: z.literal('producer-must-complete'),
    producerTaskIds: z.array(taskIdSchema).min(1)
  }),
  schedulerDecisionReasonBaseSchema.extend({
    type: z.literal('max-concurrency-reached'),
    maxConcurrency: z.int().positive(),
    runningTaskIds: z.array(taskIdSchema)
  }),
  schedulerDecisionReasonBaseSchema.extend({
    type: z.literal('risk-policy-deferred'),
    conflictingTaskIds: z.array(taskIdSchema).min(1),
    recommendedActions: z
      .array(conflictActionSchema.extract([ConflictAction.stagger, ConflictAction.serialize]))
      .min(1)
  }),
  schedulerDecisionReasonBaseSchema.extend({
    type: z.literal('risk-policy-allowed'),
    conflictingTaskIds: z.array(taskIdSchema).min(1),
    recommendedActions: z
      .array(
        conflictActionSchema.extract([ConflictAction.parallel, ConflictAction['guarded-parallel']])
      )
      .min(1)
  }),
  schedulerDecisionReasonBaseSchema.extend({
    type: z.literal('selected-by-priority'),
    priority: z.int()
  }),
  schedulerDecisionReasonBaseSchema.extend({
    type: z.literal('runtime-blocked'),
    blockers: z.array(schedulerRuntimeBlockerSchema).min(1)
  }),
  schedulerDecisionReasonBaseSchema.extend({
    type: z.literal('runtime-blocker-released'),
    blockers: z.array(schedulerRuntimeBlockerSchema).min(1)
  }),
  schedulerDecisionReasonBaseSchema.extend({
    type: z.literal('dependency-failed'),
    failedTaskIds: z.array(taskIdSchema).min(1)
  }),
  schedulerDecisionReasonBaseSchema.extend({
    type: z.literal('dependency-cancelled'),
    cancelledTaskIds: z.array(taskIdSchema).min(1)
  })
]);

export type SchedulerDecisionReason = z.infer<typeof schedulerDecisionReasonSchema>;

const schedulerDecisionBaseSchema = z.object({
  taskId: taskIdSchema,
  reasons: z.array(schedulerDecisionReasonSchema).min(1)
});

export const schedulerTaskDecisionSchema = z.discriminatedUnion('action', [
  schedulerDecisionBaseSchema.extend({
    action: z.literal('ready'),
    fromState: z.literal(TaskState.PENDING),
    toState: z.literal(TaskState.READY)
  }),
  schedulerDecisionBaseSchema.extend({
    action: z.literal('start'),
    fromState: z.literal(TaskState.READY),
    toState: z.literal(TaskState.RUNNING)
  }),
  schedulerDecisionBaseSchema.extend({
    action: z.literal('block'),
    fromState: z.literal(TaskState.RUNNING),
    toState: z.literal(TaskState.BLOCKED)
  }),
  schedulerDecisionBaseSchema.extend({
    action: z.literal('unblock'),
    fromState: z.literal(TaskState.BLOCKED),
    toState: z.literal(TaskState.READY)
  }),
  schedulerDecisionBaseSchema.extend({
    action: z.literal('cancel'),
    fromState: taskStateSchema.exclude([
      TaskState.COMPLETED,
      TaskState.FAILED,
      TaskState.CANCELLED
    ]),
    toState: z.literal(TaskState.CANCELLED)
  }),
  schedulerDecisionBaseSchema.extend({ action: z.literal('defer') })
]);

export type SchedulerTaskDecision = z.infer<typeof schedulerTaskDecisionSchema>;

export interface SchedulerDecision {
  readonly taskDecisions: readonly SchedulerTaskDecision[];
}

export class SchedulerInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchedulerInputError';
  }
}

export interface Scheduler {
  createInitialPlan(
    tasks: readonly TaskContract[],
    hardConflicts: readonly HardTaskConflict[],
    riskConflicts: readonly RiskTaskConflict[],
    options: ScheduleOptions
  ): ExecutionPlan;
  reevaluate(
    event: SchedulerEvent,
    snapshot: SchedulerSnapshot,
    tasks: readonly TaskContract[],
    hardConflicts: readonly HardTaskConflict[],
    riskConflicts: readonly RiskTaskConflict[],
    options: ScheduleOptions
  ): SchedulerDecision;
}

export interface AgentRunRequest {
  readonly attempt: AgentExecutionAttempt;
  readonly runId: string;
  readonly taskId: string;
  readonly task: TaskContract;
  readonly impact?: TaskImpact;
  readonly leases?: readonly WriteLease[];
  readonly commandPolicy?: AgentCommandPolicy;
  readonly trustedCommandPath?: string;
  readonly commandSandboxProfile?: AgentCommandSandboxProfile;
  readonly workspace: TaskWorkspace;
  readonly instructions: string;
  readonly onStarted: (evidence: { readonly sessionRef?: AgentSessionRef }) => Promise<void>;
}

export const AgentRunStatus = {
  Completed: 'completed',
  Blocked: 'blocked',
  Failed: 'failed'
} as const;
export type AgentRunResult =
  | {
      readonly status: typeof AgentRunStatus.Completed;
      readonly sessionRef?: AgentSessionRef;
      readonly observedImpact?: ObservedTaskImpact;
      readonly additionalLeases?: readonly WriteLease[];
    }
  | {
      readonly status: typeof AgentRunStatus.Blocked;
      readonly leaseId: string;
      readonly detail: string;
      readonly observedImpact?: ObservedTaskImpact;
      readonly additionalLeases?: readonly WriteLease[];
    }
  | { readonly status: typeof AgentRunStatus.Failed; readonly detail: string };

export interface AgentRunner {
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}

export interface TaskVerificationRequest {
  readonly runId: string;
  readonly task: TaskContract;
  readonly workspace: TaskWorkspace;
}

export const TaskVerificationStatus = { Passed: 'passed', Failed: 'failed' } as const;
export type TaskVerificationResult =
  | { readonly status: typeof TaskVerificationStatus.Passed }
  | { readonly status: typeof TaskVerificationStatus.Failed; readonly detail: string };

export interface TaskVerifier {
  verify(request: TaskVerificationRequest): Promise<TaskVerificationResult>;
}

/** Local completion checks finish before the runtime commits or integrates a worktree. */
export interface TaskCompletionGate {
  complete(request: TaskVerificationRequest): Promise<TaskVerificationResult>;
}
