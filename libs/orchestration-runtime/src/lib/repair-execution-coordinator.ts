import type {
  AgentExecutionAttempt,
  AgentRunResult,
  OrchestrationPersistence,
  RepositorySnapshotProvider,
  TaskCodeReviewSubjectProvider,
  TaskContract,
  TaskImpact,
  TaskImpactReconciler,
  TaskRepairAttempt,
  TaskRepairExecutionResult,
  TaskRepairRunner,
  RepairRuntimeFeedback,
  TaskVerificationEvidenceStore,
  TaskVerificationEvidence,
  TaskVerifier,
  TaskWorkspace,
  WriteLease,
  WriteGuard
} from '@ai-native-software-delivery-orchestrator/domain';
import { TaskCodeReviewCollector } from './task-code-review-collector.js';
import { TaskRepairCoordinator } from './task-repair-coordinator.js';

export class RepairExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepairExecutionError';
  }
}

type CreateVerificationEvidence = (request: {
  readonly id: string;
  readonly attempt: AgentExecutionAttempt;
  readonly workspace: TaskWorkspace;
  readonly snapshot: Awaited<ReturnType<RepositorySnapshotProvider['capture']>>;
  readonly verificationPolicyFingerprint: string;
  readonly verifiedAt: Date;
}) => TaskVerificationEvidence;

export class RepairExecutionCoordinator {
  readonly #repairs: TaskRepairCoordinator;
  readonly #runner: TaskRepairRunner;
  readonly #reconciler: TaskImpactReconciler;
  readonly #verifier: TaskVerifier;
  readonly #snapshots: RepositorySnapshotProvider;
  readonly #subjects: TaskCodeReviewSubjectProvider;
  readonly #reviews: TaskCodeReviewCollector;
  readonly #verificationEvidence: TaskVerificationEvidenceStore;
  readonly #writeGuard: WriteGuard;
  readonly #persistence: Pick<OrchestrationPersistence, 'persistImpact' | 'persistLease'>;
  readonly #feedback: RepairRuntimeFeedback;
  readonly #now: () => Date;
  readonly #createEvidenceId: () => string;
  readonly #createVerificationEvidence: CreateVerificationEvidence;

  constructor(options: {
    readonly repairs: TaskRepairCoordinator;
    readonly runner: TaskRepairRunner;
    readonly reconciler: TaskImpactReconciler;
    readonly verifier: TaskVerifier;
    readonly snapshots: RepositorySnapshotProvider;
    readonly subjects: TaskCodeReviewSubjectProvider;
    readonly reviews: TaskCodeReviewCollector;
    readonly verificationEvidence: TaskVerificationEvidenceStore;
    readonly writeGuard: WriteGuard;
    readonly persistence: Pick<OrchestrationPersistence, 'persistImpact' | 'persistLease'>;
    readonly feedback: RepairRuntimeFeedback;
    readonly now?: () => Date;
    readonly createEvidenceId: () => string;
    readonly createVerificationEvidence: CreateVerificationEvidence;
  }) {
    this.#repairs = options.repairs;
    this.#runner = options.runner;
    this.#reconciler = options.reconciler;
    this.#verifier = options.verifier;
    this.#snapshots = options.snapshots;
    this.#subjects = options.subjects;
    this.#reviews = options.reviews;
    this.#verificationEvidence = options.verificationEvidence;
    this.#writeGuard = options.writeGuard;
    this.#persistence = options.persistence;
    this.#feedback = options.feedback;
    this.#now = options.now ?? (() => new Date());
    this.#createEvidenceId = options.createEvidenceId;
    this.#createVerificationEvidence = options.createVerificationEvidence;
  }

  async execute(request: {
    readonly repair: TaskRepairAttempt;
    readonly builderAttempt: AgentExecutionAttempt;
    readonly task: TaskContract;
    readonly workspace: TaskWorkspace;
    readonly impact: TaskImpact;
    readonly leases: readonly WriteLease[];
    readonly verificationPolicyFingerprint: string;
    readonly repository: Parameters<TaskCodeReviewCollector['collect']>[0]['repository'];
    readonly reviewIteration: number;
  }): Promise<TaskRepairExecutionResult> {
    let established = false;
    let running = await this.#repairs.markStarting(request.repair);
    let result: AgentRunResult;
    try {
      result = await this.#runner.run({
        attempt: this.#asAgentAttempt(running),
        runId: request.repair.runId,
        taskId: request.task.id,
        task: request.task,
        impact: request.impact,
        leases: request.leases,
        workspace: request.workspace,
        instructions: this.#repairInstructions(request.repair),
        onStarted: async ({ sessionRef }) => {
          if (established) {
            throw new RepairExecutionError(`Repair execution started twice: ${request.repair.id}`);
          }
          established = true;
          running = await this.#repairs.markStarted(running, sessionRef);
        }
      });
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : 'Repair runner threw a non-error value.';
      if (established) {
        await this.#repairs.markUnknown(running, detail);
        // The external repair agent may still mutate this workspace; retain ACTIVE leases.
        throw new RepairExecutionError(`Repair outcome is unknown: ${detail}`);
      }
      await this.#repairs.fail(request.repair, detail);
      await this.#release(request.leases);
      throw new RepairExecutionError(`Repair execution failed before start: ${detail}`);
    }
    if (result.status !== 'completed' || !established) {
      if (result.status === 'blocked') {
        await this.#repairs.markBlocked(running, result.leaseId);
        await this.#feedback.leaseBlocked({
          runId: request.repair.runId,
          taskId: request.task.id,
          repairAttemptId: request.repair.id,
          leaseId: result.leaseId
        });
        await this.#release([...request.leases, ...(result.additionalLeases ?? [])]);
        throw new RepairExecutionError(`Repair blocked by lease: ${result.leaseId}`);
      }
      await this.#repairs.fail(
        running,
        result.status === 'failed' ? result.detail : 'Repair did not establish'
      );
      await this.#release(request.leases);
      throw new RepairExecutionError('Repair did not complete');
    }
    const allLeases = [...request.leases, ...(result.additionalLeases ?? [])];
    const reconciliation = await this.#reconciler.reconcile({
      runId: request.repair.runId,
      taskId: request.task.id,
      impact: request.impact,
      reportedImpact: result.observedImpact,
      leases: allLeases,
      workspace: request.workspace
    });
    if (reconciliation.reconciliation.status === 'unleased-change') {
      await this.#repairs.fail(running, 'Repair changed a file without an active write lease');
      await this.#release(allLeases);
      throw new RepairExecutionError('Repair changed a file without an active write lease');
    }
    await this.#persistence.persistImpact({
      runId: request.repair.runId,
      taskId: request.task.id,
      impact: {
        ...request.impact,
        observed: reconciliation.observed,
        reconciliation: reconciliation.reconciliation
      }
    });
    if (reconciliation.reconciliation.status === 'runtime-scope-expanded') {
      await this.#feedback.scopeExpanded({
        runId: request.repair.runId,
        taskId: request.task.id,
        expandedResources: reconciliation.expandedResources ?? []
      });
    }
    const completed = await this.#repairs.complete(running);
    await this.#release(allLeases);
    const verification = await this.#verifier.verify({
      runId: request.repair.runId,
      task: request.task,
      workspace: request.workspace
    });
    if (verification.status === 'failed') {
      throw new RepairExecutionError(`Repair verification failed: ${verification.detail}`);
    }
    const snapshot = await this.#snapshots.capture({
      repositoryPath: request.workspace.workspacePath
    });
    const evidence = this.#createVerificationEvidence({
      id: this.#createEvidenceId(),
      attempt: this.#asAgentAttempt(completed),
      workspace: request.workspace,
      snapshot,
      verificationPolicyFingerprint: request.verificationPolicyFingerprint,
      verifiedAt: this.#now()
    });
    await this.#verificationEvidence.persistVerificationEvidence(evidence);
    const subject = this.#subjects.createSubject({
      builderAttempt: request.builderAttempt,
      outputAttemptId: completed.id,
      workspace: request.workspace,
      impact: {
        ...request.impact,
        observed: reconciliation.observed,
        reconciliation: reconciliation.reconciliation
      },
      workspaceSnapshot: snapshot,
      verificationFingerprint: evidence.fingerprint
    });
    const review = await this.#reviews.collect({
      runId: request.repair.runId,
      task: request.task,
      workspace: request.workspace,
      impact: {
        ...request.impact,
        observed: reconciliation.observed,
        reconciliation: reconciliation.reconciliation
      },
      builderAttempt: request.builderAttempt,
      subject,
      repository: request.repository,
      iteration: request.reviewIteration
    });
    return { attempt: completed, verification: evidence, reviewSubject: subject, review };
  }

  #asAgentAttempt(attempt: TaskRepairAttempt): AgentExecutionAttempt {
    return {
      id: attempt.id,
      runId: attempt.runId,
      taskId: attempt.taskId,
      agentId: attempt.agentId,
      workspaceId: attempt.workspaceId,
      leasePlanFingerprint: `repair:${attempt.parentReviewSubject.workspaceChangeFingerprint}`,
      state:
        attempt.state === 'RUNNING'
          ? 'RUNNING'
          : attempt.state === 'COMPLETED'
            ? 'COMPLETED'
            : 'STARTING',
      revision: attempt.revision,
      ...(attempt.sessionRef === undefined ? {} : { sessionRef: attempt.sessionRef }),
      startedAt: attempt.startedAt ?? this.#now(),
      ...(attempt.completedAt === undefined ? {} : { completedAt: attempt.completedAt })
    };
  }

  #repairInstructions(attempt: TaskRepairAttempt): string {
    return `Repair task findings from review iteration ${attempt.parentReviewIteration}. Preserve approved task scope and use controlled tools only.`;
  }

  async #release(leases: readonly WriteLease[]): Promise<void> {
    for (const lease of [...leases].toReversed()) {
      if (lease.state !== 'ACTIVE') {
        continue;
      }
      const result = await this.#writeGuard.release({
        leaseId: lease.id,
        expectedVersion: lease.version
      });
      if (result.status !== 'released') {
        throw new RepairExecutionError(`Repair lease release failed: ${lease.id}`);
      }
      await this.#persistence.persistLease({ runId: lease.runId, lease: result.lease });
    }
  }
}
