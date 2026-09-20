import type { TaskConflict, TaskImpact } from './conflict.js';
import type { AgentExecutionAttempt } from './agent-execution.js';
import type { AgentCommandPolicy } from './command-policy.js';
import type {
  ScheduleOptions,
  SchedulerDecision,
  SchedulerEvent,
  SchedulerSnapshot,
  Scheduler,
  SchedulerTaskDecision
} from './execution.js';
import type { TaskContract } from './task-contract.js';
import type { TaskState } from './task-state.js';
import type { WriteLease } from './write-lease.js';
import {
  CreateTaskWorkspaceRequest,
  TaskWorkspace,
  createTaskWorkspaceRequestSchema
} from './workspace.js';
import type { TaskCodeReview } from './task-code-review.js';
import type { TaskCodeReviewSubject } from './task-code-review.js';
import type { TaskRepairAttempt } from './task-repair-attempt.js';
import type { TaskVerificationEvidence } from './task-verification-evidence.js';
import type { TaskRepairWorkItem } from './task-repair-work-item.js';
import { z } from 'zod';
import { agentCommandPolicySchema } from './command-policy.js';
import { taskImpactSchema } from './conflict.js';
import { taskLeasePlanSchema, type TaskLeasePlan } from './write-lease.js';

export type OrchestrationRunState =
  | 'ACTIVE'
  | 'CANCEL_REQUESTED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type CancellationRequestResult =
  | { readonly status: 'requested'; readonly state: 'CANCEL_REQUESTED' }
  | { readonly status: 'already-requested'; readonly state: 'CANCEL_REQUESTED' }
  | { readonly status: 'terminal'; readonly state: 'COMPLETED' | 'FAILED' | 'CANCELLED' };

export type CancellationFinalizationResult =
  | { readonly status: 'cancelled'; readonly state: 'CANCELLED' }
  | {
      readonly status: 'not-requested';
      readonly state: 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
    };

export type CancellationSettlementResult =
  | { readonly status: 'settled'; readonly attemptId: string }
  | { readonly status: 'not-unknown'; readonly state: string }
  | { readonly status: 'version-conflict'; readonly actualRevision: number };

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const recordIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const nonEmptyStringSchema = z.string().trim().min(1);

export const runAuthorityEvidenceSchema = z.object({
  artifactId: recordIdSchema,
  artifactRevision: z.int().positive(),
  approvalId: recordIdSchema,
  planFingerprint: digestSchema,
  approvalFingerprint: digestSchema,
  claimFingerprint: digestSchema,
  executionFingerprint: digestSchema,
  repositoryRoot: z.string().trim().min(1),
  baseCommit: z.string().regex(/^[0-9a-f]{40,64}$/),
  workingTreeFingerprint: digestSchema,
  repositoryFactsFingerprint: digestSchema,
  sharedResourcePolicyFingerprint: digestSchema,
  verificationPolicyFingerprint: digestSchema,
  codeReviewPolicyFingerprint: digestSchema
});

export type RunAuthorityEvidence = z.infer<typeof runAuthorityEvidenceSchema>;

export type PersistedTaskExecutionBinding = {
  readonly runId: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly leasePlan: TaskLeasePlan;
  readonly impact?: TaskImpact;
  readonly commandPolicy?: AgentCommandPolicy;
  readonly trustedCommandPath?: string;
  readonly workspace: CreateTaskWorkspaceRequest;
};

export const persistedTaskExecutionBindingSchema = z
  .object({
    runId: nonEmptyStringSchema,
    taskId: nonEmptyStringSchema,
    agentId: nonEmptyStringSchema,
    leasePlan: taskLeasePlanSchema,
    impact: taskImpactSchema.optional(),
    commandPolicy: agentCommandPolicySchema.optional(),
    trustedCommandPath: nonEmptyStringSchema.optional(),
    workspace: createTaskWorkspaceRequestSchema
  })
  .superRefine((binding, context) => {
    if (binding.leasePlan.taskId !== binding.taskId) {
      context.addIssue({
        code: 'custom',
        message: 'Task execution binding lease plan must match task ID',
        path: ['leasePlan', 'taskId']
      });
    }
    if (binding.workspace.runId !== binding.runId || binding.workspace.taskId !== binding.taskId) {
      context.addIssue({
        code: 'custom',
        message: 'Task execution binding workspace must match run and task IDs',
        path: ['workspace']
      });
    }
    if (binding.impact !== undefined) {
      if (binding.impact.predicted.taskId !== binding.taskId) {
        context.addIssue({
          code: 'custom',
          message: 'Task execution binding impact must match task ID',
          path: ['impact', 'predicted', 'taskId']
        });
      }
      if (
        binding.impact.observed !== undefined &&
        binding.impact.observed.taskId !== binding.taskId
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Task execution binding observed impact must match task ID',
          path: ['impact', 'observed', 'taskId']
        });
      }
    }
  });

export interface PersistedRun {
  readonly id: string;
  readonly repositoryId: string;
  readonly state: OrchestrationRunState;
  readonly createdAt: string;
  readonly authority: RunAuthorityEvidence;
}

export interface CreatePersistedRunRequest {
  readonly run: PersistedRun;
  readonly tasks: readonly TaskContract[];
  readonly taskBindings: readonly PersistedTaskExecutionBinding[];
  readonly hardConflicts: readonly Extract<TaskConflict, { readonly severity: 'hard' }>[];
  readonly riskConflicts: readonly Extract<TaskConflict, { readonly severity: 'none' | 'soft' }>[];
  readonly scheduleOptions: ScheduleOptions;
}

export interface PersistedSchedulerEvent {
  readonly runId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly event: SchedulerEvent;
}

export interface PersistedTaskTransition {
  readonly runId: string;
  readonly sequence: number;
  readonly taskId: string;
  readonly fromState: TaskState;
  readonly toState: TaskState;
}

export interface PersistedSchedulerDecision {
  readonly runId: string;
  readonly sequence: number;
  readonly inputSnapshot: SchedulerSnapshot;
  readonly decision: SchedulerDecision;
}

export interface PersistedTaskImpact {
  readonly runId: string;
  readonly taskId: string;
  readonly impact: TaskImpact;
}

export interface PersistedTaskCodeReview {
  readonly runId: string;
  readonly taskId: string;
  readonly iteration: number;
  /** Undefined only for legacy evidence created before review-subject binding existed. */
  readonly subject?: TaskCodeReviewSubject;
  readonly review: TaskCodeReview;
}

export interface PersistedTaskRepairAttempt {
  readonly runId: string;
  readonly attempt: TaskRepairAttempt;
}

export interface PersistedTaskConflict {
  readonly runId: string;
  readonly taskA: string;
  readonly taskB: string;
  readonly conflict: TaskConflict;
  /** The first scheduler sequence that may use this runtime-discovered conflict. */
  readonly effectiveFromSequence?: number;
}

export interface PersistedWriteLease {
  readonly runId: string;
  readonly lease: WriteLease;
}

export interface PersistedTaskWorkspace {
  readonly runId: string;
  readonly workspace: TaskWorkspace;
}

export interface PersistedAgentExecutionAttempt {
  readonly runId: string;
  readonly attempt: AgentExecutionAttempt;
}

export interface PersistedReevaluation {
  readonly event: PersistedSchedulerEvent;
  readonly transitions: readonly PersistedTaskTransition[];
  readonly decision: PersistedSchedulerDecision;
  /** Runtime conflict knowledge mutations atomically committed with this reevaluation. */
  readonly runtimeConflicts?: readonly PersistedTaskConflict[];
}

export interface PersistedDispatch {
  readonly reevaluation: PersistedReevaluation;
  readonly attempts: readonly PersistedAgentExecutionAttempt[];
}

export interface PersistedRepairResumeDispatch {
  readonly runId: string;
  readonly taskId: string;
  readonly repairAttemptId: string;
  readonly repairRevision: number;
  readonly dispatchId: string;
  readonly authorizedAt: string;
}

export interface RecoveredRun {
  readonly run: PersistedRun;
  readonly tasks: readonly TaskContract[];
  readonly taskBindings: readonly PersistedTaskExecutionBinding[];
  readonly hardConflicts: readonly Extract<TaskConflict, { readonly severity: 'hard' }>[];
  readonly riskConflicts: readonly Extract<TaskConflict, { readonly severity: 'none' | 'soft' }>[];
  readonly scheduleOptions: ScheduleOptions;
  readonly events: readonly PersistedSchedulerEvent[];
  readonly transitions: readonly PersistedTaskTransition[];
  readonly decisions: readonly PersistedSchedulerDecision[];
  readonly impacts: readonly PersistedTaskImpact[];
  readonly conflicts: readonly PersistedTaskConflict[];
  readonly leases: readonly PersistedWriteLease[];
  readonly workspaces: readonly PersistedTaskWorkspace[];
  readonly attempts: readonly PersistedAgentExecutionAttempt[];
}

export interface OrchestrationPersistence {
  createRun(request: CreatePersistedRunRequest): Promise<void>;
  recoverTaskBindings(runId: string): Promise<readonly PersistedTaskExecutionBinding[]>;
  recoverTaskBinding(
    runId: string,
    taskId: string
  ): Promise<PersistedTaskExecutionBinding | undefined>;
  persistReevaluation(reevaluation: PersistedReevaluation): Promise<void>;
  persistDispatch(dispatch: PersistedDispatch): Promise<void>;
  recoverDispatches(runId: string): Promise<readonly PersistedDispatch[]>;
  recoverAttempts(runId: string): Promise<readonly PersistedAgentExecutionAttempt[]>;
  recoverLeases(runId: string): Promise<readonly PersistedWriteLease[]>;
  persistIntegration(
    runId: string,
    status: 'integrated' | 'blocked',
    outputAttemptId?: string
  ): Promise<void>;
  recoverIntegration(
    runId: string
  ): Promise<
    { readonly status: 'integrated' | 'blocked'; readonly outputAttemptId?: string } | undefined
  >;
  persistRepairResumeDispatch(dispatch: PersistedRepairResumeDispatch): Promise<void>;
  recoverRepairResumeDispatches(runId: string): Promise<readonly PersistedRepairResumeDispatch[]>;
  persistImpact(impact: PersistedTaskImpact): Promise<void>;
  persistConflict(conflict: PersistedTaskConflict): Promise<void>;
  persistLease(lease: PersistedWriteLease): Promise<void>;
  persistWorkspace(workspace: PersistedTaskWorkspace): Promise<void>;
  persistAttempt(attempt: PersistedAgentExecutionAttempt): Promise<void>;
  updateRunState(runId: string, state: OrchestrationRunState): Promise<void>;
  recoverRun(runId: string): Promise<RecoveredRun | undefined>;
  replayRun(runId: string, scheduler: Scheduler): Promise<readonly PersistedSchedulerDecision[]>;
}

/**
 * Durable control-plane transitions deliberately stay separate from normal
 * orchestration persistence. Historical runtimes only need the data-plane
 * contract above, while operators require atomic cancellation CAS semantics.
 */
export interface CancellationPersistence {
  requestCancellation(runId: string): Promise<CancellationRequestResult>;
  finalizeCancellation(runId: string): Promise<CancellationFinalizationResult>;
}

/**
 * Atomically hands an already-authorized PREPARING attempt to the mutation
 * runtime while the durable run is still ACTIVE. This is deliberately a
 * narrow control-plane capability so historical orchestration consumers do
 * not acquire cancellation authority accidentally.
 */
export interface ActiveMutationClaimPersistence {
  claimBuilderStart(record: PersistedAgentExecutionAttempt): Promise<AgentExecutionAttempt>;
  claimRepairStart(record: PersistedTaskRepairAttempt): Promise<TaskRepairAttempt>;
}

/**
 * Operator-only settlement of an UNKNOWN external agent during cancellation.
 * The caller must have independently confirmed the external process stopped.
 */
export interface CancellationSettlementPersistence {
  settleUnknownBuilderCancellation(request: {
    readonly runId: string;
    readonly attemptId: string;
    readonly expectedRevision: number;
    readonly detail: string;
  }): Promise<CancellationSettlementResult>;
  settleUnknownRepairCancellation(request: {
    readonly runId: string;
    readonly attemptId: string;
    readonly expectedRevision: number;
    readonly detail: string;
  }): Promise<CancellationSettlementResult>;
}

/** Durable evidence storage for read-only code review iterations. */
export interface TaskCodeReviewStore {
  persistReview(review: PersistedTaskCodeReview): Promise<void>;
  recoverReviews(runId: string): Promise<readonly PersistedTaskCodeReview[]>;
}

export interface TaskRepairAttemptStore {
  persistRepairAttempt(attempt: PersistedTaskRepairAttempt): Promise<void>;
  recoverRepairAttempts(runId: string): Promise<readonly PersistedTaskRepairAttempt[]>;
  recoverRepairAttemptHistory(runId: string): Promise<readonly PersistedTaskRepairAttempt[]>;
}

export interface TaskRepairAdmissionStore extends TaskRepairAttemptStore {
  admitRepairAttempt(request: {
    readonly attempt: TaskRepairAttempt;
    readonly maxRepairs: number;
  }): Promise<TaskRepairAttempt>;
}

/** Adds atomic persistence of immutable work inputs when a repair is admitted. */
export interface TaskRepairWorkItemAdmissionStore extends TaskRepairAdmissionStore {
  /** Atomically records the admitted lineage and its immutable resume inputs. */
  admitRepairAttemptWithWorkItem(request: {
    readonly attempt: TaskRepairAttempt;
    readonly maxRepairs: number;
    readonly createWorkItem: (attempt: TaskRepairAttempt) => TaskRepairWorkItem;
  }): Promise<TaskRepairAttempt>;
}

export interface TaskRepairResumeStore extends TaskRepairAttemptStore {
  resumeRepairAttempt(request: {
    readonly runId: string;
    readonly attemptId: string;
    readonly expectedRevision: number;
    readonly dispatch?: {
      readonly taskId: string;
      readonly dispatchId: string;
      readonly authorizedAt: string;
    };
  }): Promise<
    | { readonly status: 'resumed'; readonly attempt: TaskRepairAttempt }
    | { readonly status: 'not-found' }
    | { readonly status: 'not-blocked'; readonly state: TaskRepairAttempt['state'] }
    | { readonly status: 'version-conflict'; readonly actualRevision: number }
    | { readonly status: 'lease-not-released'; readonly actualState: WriteLease['state'] }
  >;
}

export interface TaskRepairWorkItemStore {
  persistRepairWorkItem(item: TaskRepairWorkItem): Promise<void>;
  recoverRepairWorkItems(runId: string): Promise<readonly TaskRepairWorkItem[]>;
}

export interface TaskVerificationEvidenceStore {
  persistVerificationEvidence(evidence: TaskVerificationEvidence): Promise<void>;
  recoverVerificationEvidence(runId: string): Promise<readonly TaskVerificationEvidence[]>;
}

export interface TaskIntegrationStore {
  persistIntegration(
    runId: string,
    status: 'integrated' | 'blocked',
    outputAttemptId?: string
  ): Promise<void>;
  recoverIntegration(
    runId: string
  ): Promise<
    { readonly status: 'integrated' | 'blocked'; readonly outputAttemptId?: string } | undefined
  >;
}

export const taskDecisionsWithTransitions = (
  decisions: readonly SchedulerTaskDecision[]
): readonly Extract<
  SchedulerTaskDecision,
  { readonly action: Exclude<SchedulerTaskDecision['action'], 'defer'> }
>[] =>
  decisions.filter(
    (
      decision
    ): decision is Extract<
      SchedulerTaskDecision,
      { readonly action: Exclude<SchedulerTaskDecision['action'], 'defer'> }
    > => decision.action !== 'defer'
  );
