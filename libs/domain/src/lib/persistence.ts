import type { TaskConflict, TaskImpact } from './conflict.js';
import type { AgentExecutionAttempt } from './agent-execution.js';
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
import type { TaskWorkspace } from './workspace.js';
import type { TaskCodeReview } from './task-code-review.js';
import type { TaskCodeReviewSubject } from './task-code-review.js';
import type { TaskRepairAttempt } from './task-repair-attempt.js';
import { z } from 'zod';

export type OrchestrationRunState = 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const recordIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);

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
  verificationPolicyFingerprint: digestSchema
});

export type RunAuthorityEvidence = z.infer<typeof runAuthorityEvidenceSchema>;

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

export interface RecoveredRun {
  readonly run: PersistedRun;
  readonly tasks: readonly TaskContract[];
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
  persistReevaluation(reevaluation: PersistedReevaluation): Promise<void>;
  persistDispatch(dispatch: PersistedDispatch): Promise<void>;
  persistImpact(impact: PersistedTaskImpact): Promise<void>;
  persistConflict(conflict: PersistedTaskConflict): Promise<void>;
  persistLease(lease: PersistedWriteLease): Promise<void>;
  persistWorkspace(workspace: PersistedTaskWorkspace): Promise<void>;
  persistAttempt(attempt: PersistedAgentExecutionAttempt): Promise<void>;
  updateRunState(runId: string, state: OrchestrationRunState): Promise<void>;
  recoverRun(runId: string): Promise<RecoveredRun | undefined>;
  replayRun(runId: string, scheduler: Scheduler): Promise<readonly PersistedSchedulerDecision[]>;
}

/** Durable evidence storage for read-only code review iterations. */
export interface TaskCodeReviewStore {
  persistReview(review: PersistedTaskCodeReview): Promise<void>;
  recoverReviews(runId: string): Promise<readonly PersistedTaskCodeReview[]>;
}

export interface TaskRepairAttemptStore {
  persistRepairAttempt(attempt: PersistedTaskRepairAttempt): Promise<void>;
  recoverRepairAttempts(runId: string): Promise<readonly PersistedTaskRepairAttempt[]>;
}

export interface TaskRepairAdmissionStore extends TaskRepairAttemptStore {
  admitRepairAttempt(request: {
    readonly attempt: TaskRepairAttempt;
    readonly maxRepairs: number;
  }): Promise<TaskRepairAttempt>;
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
