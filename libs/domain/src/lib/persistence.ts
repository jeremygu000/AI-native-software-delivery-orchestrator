import type { TaskConflict, TaskImpact } from './conflict.js';
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

export type OrchestrationRunState = 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface PersistedRun {
  readonly id: string;
  readonly repositoryId: string;
  readonly state: OrchestrationRunState;
  readonly createdAt: string;
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

export interface PersistedTaskConflict {
  readonly runId: string;
  readonly taskA: string;
  readonly taskB: string;
  readonly conflict: TaskConflict;
}

export interface PersistedWriteLease {
  readonly runId: string;
  readonly lease: WriteLease;
}

export interface PersistedTaskWorkspace {
  readonly runId: string;
  readonly workspace: TaskWorkspace;
}

export interface PersistedReevaluation {
  readonly event: PersistedSchedulerEvent;
  readonly transitions: readonly PersistedTaskTransition[];
  readonly decision: PersistedSchedulerDecision;
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
}

export interface OrchestrationPersistence {
  createRun(request: CreatePersistedRunRequest): Promise<void>;
  persistReevaluation(reevaluation: PersistedReevaluation): Promise<void>;
  persistImpact(impact: PersistedTaskImpact): Promise<void>;
  persistConflict(conflict: PersistedTaskConflict): Promise<void>;
  persistLease(lease: PersistedWriteLease): Promise<void>;
  persistWorkspace(workspace: PersistedTaskWorkspace): Promise<void>;
  updateRunState(runId: string, state: OrchestrationRunState): Promise<void>;
  recoverRun(runId: string): Promise<RecoveredRun | undefined>;
  replayRun(runId: string, scheduler: Scheduler): Promise<readonly PersistedSchedulerDecision[]>;
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
