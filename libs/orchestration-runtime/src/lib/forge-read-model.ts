import type {
  OrchestrationPersistence,
  PersistedTaskCodeReview,
  RecoveredRun,
  SchedulerDecisionReason,
  TaskCodeReviewStore,
  TaskRepairAttemptStore,
  TaskVerificationEvidenceStore
} from '@ai-native-software-delivery-orchestrator/domain';
import type { WritableResource } from '@ai-native-software-delivery-orchestrator/domain';

export interface ForgeCorrelation {
  readonly runId: string;
  readonly taskId?: string;
  readonly attemptId?: string;
  readonly repairAttemptId?: string;
  readonly workspaceId?: string;
  readonly workflowId?: string;
  /** A provider-neutral orchestration operation, not a Temporal activity type. */
  readonly activity?: string;
}

export interface ForgeBlockingReason {
  readonly type: string;
  readonly detail?: string;
  readonly blockers?: readonly ForgeBlockingReference[];
}

export type ForgeBlockingReference =
  | { readonly type: 'lease'; readonly leaseId: string }
  | { readonly type: 'runtime-conflict'; readonly conflictId: string };

export type ForgeLeaseResource =
  | { readonly type: 'project'; readonly projectId: string }
  | { readonly type: 'file'; readonly projectId: string; readonly fileId: string }
  | {
      readonly type: 'symbol';
      readonly projectId: string;
      readonly fileId: string;
      readonly symbolId: string;
      readonly ancestorSymbolIds: readonly string[];
    }
  | { readonly type: 'shared-resource'; readonly resourceId: string };

export interface ForgeAttemptSummary {
  readonly id: string;
  readonly kind: 'builder' | 'repair';
  readonly state: string;
  readonly revision: number;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly failure?: { readonly type: string; readonly detail?: string };
  readonly correlation: ForgeCorrelation;
}

export interface ForgeVerificationReference {
  readonly id: string;
  readonly status: 'passed';
  readonly verifiedAt: string;
  readonly fingerprint: string;
  readonly correlation: ForgeCorrelation;
}

export interface ForgeReviewReference {
  readonly iteration: number;
  readonly recommendation: 'accept' | 'repair' | 'reject';
  readonly summary: string;
  readonly correlation: ForgeCorrelation;
}

export interface ForgeLeaseSummary {
  readonly id: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly resource: ForgeLeaseResource;
  readonly state: 'ACTIVE' | 'RELEASED' | 'STALE';
  readonly acquiredAt: string;
  readonly lastHeartbeatAt: string;
  readonly releasedAt?: string;
  readonly staleDetectedAt?: string;
  readonly staleEvidence?: string;
  readonly correlation: ForgeCorrelation;
}

export interface ForgeTimelineEntry {
  readonly sequence: number;
  readonly occurredAt: string;
  readonly type: string;
  readonly correlation: ForgeCorrelation;
  readonly detail?: string;
}

export interface ForgeTaskSummary {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly currentBlockingReason?: ForgeBlockingReason;
  readonly attempts: readonly ForgeAttemptSummary[];
  readonly verification: readonly ForgeVerificationReference[];
  readonly reviews: readonly ForgeReviewReference[];
}

export interface ForgeRunReadModel {
  readonly runId: string;
  readonly state: string;
  readonly createdAt: string;
  readonly correlation: ForgeCorrelation;
  readonly tasks: readonly ForgeTaskSummary[];
  readonly leases: readonly ForgeLeaseSummary[];
  readonly timeline: readonly ForgeTimelineEntry[];
}

export type ForgeReadModelPersistence = Pick<OrchestrationPersistence, 'recoverRun'> &
  Pick<TaskCodeReviewStore, 'recoverReviews'> &
  Pick<TaskRepairAttemptStore, 'recoverRepairAttempts'> &
  Pick<TaskVerificationEvidenceStore, 'recoverVerificationEvidence'>;

const eventDetail = (event: Record<string, unknown>): string | undefined => {
  if (typeof event.detail === 'string') {
    return event.detail;
  }
  if (typeof event.leaseId === 'string') {
    return `leaseId=${event.leaseId}`;
  }
  if (typeof event.conflictId === 'string') {
    return `conflictId=${event.conflictId}`;
  }
  return undefined;
};

const taskIdForEvent = (event: Record<string, unknown>): string | undefined =>
  typeof event.taskId === 'string' ? event.taskId : undefined;

const leaseResource = (resource: WritableResource): ForgeLeaseResource => resource;

const blockingReferences = (
  reason: SchedulerDecisionReason
): readonly ForgeBlockingReference[] | undefined => {
  if (reason.type !== 'runtime-blocked' && reason.type !== 'runtime-blocker-released') {
    return undefined;
  }
  return reason.blockers;
};

const blockingReason = (
  recovered: RecoveredRun,
  taskId: string
): ForgeBlockingReason | undefined => {
  if (latestTaskState(recovered, taskId) !== 'BLOCKED') {
    return undefined;
  }
  for (const decision of recovered.decisions.toReversed()) {
    const taskDecision = decision.decision.taskDecisions.find(
      (candidate) =>
        candidate.taskId === taskId &&
        (candidate.action === 'block' || candidate.action === 'defer')
    );
    const reason = taskDecision?.reasons[0];
    if (reason !== undefined) {
      return {
        type: reason.type,
        detail: reason.detail,
        ...(blockingReferences(reason) === undefined
          ? {}
          : { blockers: blockingReferences(reason) })
      };
    }
  }
  return undefined;
};

const latestTaskState = (recovered: RecoveredRun, taskId: string): string =>
  recovered.transitions
    .filter((transition) => transition.taskId === taskId)
    .toSorted((left, right) => right.sequence - left.sequence)[0]?.toState ?? 'PENDING';

const reviewReference = (
  review: PersistedTaskCodeReview,
  workflowId: string | undefined
): ForgeReviewReference => ({
  iteration: review.iteration,
  recommendation: review.review.recommendation,
  summary: review.review.summary,
  correlation: {
    runId: review.runId,
    taskId: review.taskId,
    attemptId: review.subject?.builderAttemptId,
    ...(review.subject?.outputAttemptId === review.subject?.builderAttemptId
      ? {}
      : { repairAttemptId: review.subject?.outputAttemptId }),
    workspaceId: review.subject?.workspaceId,
    workflowId,
    activity: 'evaluate-output'
  }
});

/**
 * Builds provider-neutral operator data exclusively from durable authority
 * records. Process runtimes can contribute only a string workflow identifier.
 */
export class ForgeReadModel {
  readonly #persistence: ForgeReadModelPersistence;
  readonly #workflowId: (runId: string) => string | undefined;

  constructor(dependencies: {
    readonly persistence: ForgeReadModelPersistence;
    readonly workflowId?: (runId: string) => string | undefined;
  }) {
    this.#persistence = dependencies.persistence;
    this.#workflowId = dependencies.workflowId ?? (() => undefined);
  }

  async read(runId: string): Promise<ForgeRunReadModel | undefined> {
    const [recovered, reviews, repairs, verification] = await Promise.all([
      this.#persistence.recoverRun(runId),
      this.#persistence.recoverReviews(runId),
      this.#persistence.recoverRepairAttempts(runId),
      this.#persistence.recoverVerificationEvidence(runId)
    ]);
    if (recovered === undefined) {
      return undefined;
    }

    const workflowId = this.#workflowId(runId);
    const tasks = recovered.tasks.map((task) => {
      const currentBlockingReason = blockingReason(recovered, task.id);
      const builderAttempts = recovered.attempts
        .filter((record) => record.attempt.taskId === task.id)
        .map((record): ForgeAttemptSummary => ({
          id: record.attempt.id,
          kind: 'builder',
          state: record.attempt.state,
          revision: record.attempt.revision,
          startedAt: record.attempt.startedAt?.toISOString(),
          completedAt: record.attempt.completedAt?.toISOString(),
          failure: record.attempt.failure,
          correlation: {
            runId,
            taskId: task.id,
            attemptId: record.attempt.id,
            workspaceId: record.attempt.workspaceId,
            workflowId,
            activity: 'execute-builder'
          }
        }));
      const repairAttempts = repairs
        .filter((record) => record.attempt.taskId === task.id)
        .map((record): ForgeAttemptSummary => ({
          id: record.attempt.id,
          kind: 'repair',
          state: record.attempt.state,
          revision: record.attempt.revision,
          startedAt: record.attempt.startedAt?.toISOString(),
          completedAt: record.attempt.completedAt?.toISOString(),
          failure: record.attempt.failure,
          correlation: {
            runId,
            taskId: task.id,
            attemptId: record.attempt.parentReviewSubject.builderAttemptId,
            repairAttemptId: record.attempt.id,
            workspaceId: record.attempt.workspaceId,
            workflowId,
            activity: 'execute-repair'
          }
        }));
      return {
        id: task.id,
        title: task.title,
        state: latestTaskState(recovered, task.id),
        ...(currentBlockingReason === undefined ? {} : { currentBlockingReason }),
        attempts: [...builderAttempts, ...repairAttempts],
        verification: verification
          .filter((evidence) => evidence.taskId === task.id)
          .map((evidence): ForgeVerificationReference => {
            const repair = repairs.find((record) => record.attempt.id === evidence.attemptId);
            return {
              id: evidence.id,
              status: evidence.status,
              verifiedAt: evidence.verifiedAt,
              fingerprint: evidence.fingerprint,
              correlation: {
                runId,
                taskId: task.id,
                attemptId:
                  repair?.attempt.parentReviewSubject.builderAttemptId ?? evidence.attemptId,
                ...(repair === undefined ? {} : { repairAttemptId: evidence.attemptId }),
                workspaceId: evidence.workspaceId,
                workflowId,
                activity: 'evaluate-output'
              }
            };
          }),
        reviews: reviews
          .filter((review) => review.taskId === task.id)
          .map((review) => reviewReference(review, workflowId))
      };
    });
    const timeline = recovered.events.map((event): ForgeTimelineEntry => {
      const rawEvent = event.event as Record<string, unknown>;
      const taskId = taskIdForEvent(rawEvent);
      return {
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        type: event.event.type,
        correlation: { runId, taskId, workflowId, activity: 'reevaluate-run' },
        detail: eventDetail(rawEvent)
      };
    });
    const leases = recovered.leases.map((record): ForgeLeaseSummary => ({
      id: record.lease.id,
      taskId: record.lease.taskId,
      agentId: record.lease.agentId,
      resource: leaseResource(record.lease.resource),
      state: record.lease.state,
      acquiredAt: record.lease.acquiredAt.toISOString(),
      lastHeartbeatAt: record.lease.lastHeartbeatAt.toISOString(),
      releasedAt: record.lease.releasedAt?.toISOString(),
      staleDetectedAt: record.lease.staleDetectedAt?.toISOString(),
      staleEvidence: record.lease.staleEvidence,
      correlation: {
        runId,
        taskId: record.lease.taskId,
        workspaceId: recovered.attempts.find(
          (attempt) =>
            attempt.attempt.taskId === record.lease.taskId &&
            attempt.attempt.agentId === record.lease.agentId
        )?.attempt.workspaceId,
        workflowId,
        activity: 'reevaluate-run'
      }
    }));

    return {
      runId: recovered.run.id,
      state: recovered.run.state,
      createdAt: recovered.run.createdAt,
      correlation: { runId, workflowId },
      tasks,
      leases,
      timeline
    };
  }
}
