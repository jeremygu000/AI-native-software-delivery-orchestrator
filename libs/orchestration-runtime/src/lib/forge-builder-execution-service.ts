import {
  canonicalTaskLeaseResources,
  type CancellationSignal,
  type AgentExecutionAttempt,
  type AgentRunner,
  type OrchestrationPersistence,
  type TaskContract,
  type TaskImpact,
  type TaskImpactReconciler,
  type TaskWorkspace,
  type WorkspaceManager,
  type WriteGuard,
  type WriteLease
} from '@ai-native-software-delivery-orchestrator/domain';

import type { RuntimeTaskBinding } from './orchestration-runtime.js';

type BuilderPersistence = Pick<
  OrchestrationPersistence,
  'persistWorkspace' | 'persistLease' | 'persistAttempt' | 'persistImpact'
>;

type ScopeExpansionFeedback = (request: {
  readonly runId: string;
  readonly taskId: string;
  readonly expandedResources: readonly import('@ai-native-software-delivery-orchestrator/domain').WritableResource[];
}) => Promise<void>;

type LeaseReleasedFeedback = (request: {
  readonly runId: string;
  readonly taskId: string;
  readonly lease: WriteLease;
}) => Promise<void>;

export class ForgeBuilderExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForgeBuilderExecutionError';
  }
}

export interface ForgeBuilderExecutionResult {
  readonly status: 'completed';
  readonly workspace: TaskWorkspace;
  readonly attempt: AgentExecutionAttempt;
  readonly impact: TaskImpact;
}

export interface ForgeBuilderLeaseBlockedResult {
  readonly status: 'blocked';
  readonly blockerLeaseId: string;
}

export type ForgeBuilderExecutionOutcome =
  | ForgeBuilderExecutionResult
  | ForgeBuilderLeaseBlockedResult;

/** Executes one authorized builder attempt through its first durable continuation boundary. */
export class ForgeBuilderExecutionService {
  readonly #persistence: BuilderPersistence;
  readonly #workspaceManager: WorkspaceManager;
  readonly #writeGuard: WriteGuard;
  readonly #agentRunner: AgentRunner;
  readonly #reconciler: TaskImpactReconciler | undefined;
  readonly #scopeExpanded: ScopeExpansionFeedback | undefined;
  readonly #leaseReleased: LeaseReleasedFeedback | undefined;
  readonly #claimStart:
    | ((attempt: AgentExecutionAttempt) => Promise<AgentExecutionAttempt>)
    | undefined;
  readonly #now: () => Date;

  constructor(options: {
    readonly persistence: BuilderPersistence;
    readonly workspaceManager: WorkspaceManager;
    readonly writeGuard: WriteGuard;
    readonly agentRunner: AgentRunner;
    readonly reconciler?: TaskImpactReconciler;
    readonly scopeExpanded?: ScopeExpansionFeedback;
    readonly leaseReleased?: LeaseReleasedFeedback;
    readonly claimStart?: (attempt: AgentExecutionAttempt) => Promise<AgentExecutionAttempt>;
    readonly now?: () => Date;
  }) {
    this.#persistence = options.persistence;
    this.#workspaceManager = options.workspaceManager;
    this.#writeGuard = options.writeGuard;
    this.#agentRunner = options.agentRunner;
    this.#reconciler = options.reconciler;
    this.#scopeExpanded = options.scopeExpanded;
    this.#leaseReleased = options.leaseReleased;
    this.#claimStart = options.claimStart;
    this.#now = options.now ?? (() => new Date());
  }

  async execute(request: {
    readonly runId: string;
    readonly task: TaskContract;
    readonly binding: RuntimeTaskBinding;
    readonly attempt: AgentExecutionAttempt;
    readonly cancellationSignal?: CancellationSignal;
  }): Promise<ForgeBuilderExecutionOutcome> {
    if (request.attempt.state !== 'PREPARING' && request.attempt.state !== 'STARTING') {
      throw new ForgeBuilderExecutionError(
        'Builder execution requires a PREPARING or STARTING attempt'
      );
    }
    const workspace = await this.#workspaceManager.create(request.binding.workspace);
    await this.#persistence.persistWorkspace({ runId: request.runId, workspace });
    const acquisition = await this.#acquire(request.runId, request.binding);
    if (acquisition.status === 'blocked') {
      return acquisition;
    }
    const leases = acquisition.leases;
    const startingCandidate: AgentExecutionAttempt =
      request.attempt.state === 'STARTING'
        ? request.attempt
        : {
            ...request.attempt,
            state: 'STARTING',
            revision: request.attempt.revision + 1,
            startedAt: this.#now()
          };
    let starting = startingCandidate;
    if (request.attempt.state === 'PREPARING') {
      if (this.#claimStart === undefined) {
        await this.#persistence.persistAttempt({
          runId: request.runId,
          attempt: startingCandidate
        });
      } else {
        starting = await this.#claimStart(startingCandidate);
      }
    }
    let running: AgentExecutionAttempt = starting;
    let established = false;
    let result: Awaited<ReturnType<AgentRunner['run']>>;
    try {
      result = await this.#agentRunner.run({
        attempt: starting,
        runId: request.runId,
        taskId: request.task.id,
        task: request.task,
        impact: request.binding.impact,
        leases,
        commandPolicy: request.binding.commandPolicy,
        trustedCommandPath: request.binding.trustedCommandPath,
        workspace,
        instructions: request.task.goal,
        cancellationSignal: request.cancellationSignal,
        onStarted: async ({ sessionRef }) => {
          if (established) {
            throw new ForgeBuilderExecutionError('Builder started twice');
          }
          established = true;
          running = {
            ...starting,
            state: 'RUNNING',
            revision: starting.revision + 1,
            sessionRef
          };
          await this.#persistence.persistAttempt({ runId: request.runId, attempt: running });
        }
      });
    } catch (error) {
      const failure = {
        type: established ? ('unknown-outcome' as const) : ('execution-failed' as const),
        detail: error instanceof Error ? error.message : 'Builder runner threw a non-error value.'
      };
      const failed: AgentExecutionAttempt = {
        ...running,
        state: established ? 'UNKNOWN' : 'FAILED',
        revision: running.revision + 1,
        completedAt: this.#now(),
        failure
      };
      await this.#persistence.persistAttempt({ runId: request.runId, attempt: failed });
      if (!established) {
        await this.#release(leases);
      }
      throw new ForgeBuilderExecutionError(`Builder runner failed: ${failure.detail}`);
    }
    if (result.status !== 'completed' || !established) {
      const detail =
        result.status === 'failed' || result.status === 'cancelled'
          ? result.detail
          : 'Builder did not establish';
      const failed: AgentExecutionAttempt = {
        ...running,
        state: result.status === 'cancelled' ? 'CANCELLED' : established ? 'UNKNOWN' : 'FAILED',
        revision: running.revision + 1,
        completedAt: this.#now(),
        failure: {
          type:
            result.status === 'cancelled'
              ? 'cancelled'
              : established
                ? 'unknown-outcome'
                : 'execution-failed',
          detail
        }
      };
      await this.#persistence.persistAttempt({ runId: request.runId, attempt: failed });
      if (!established || result.status === 'cancelled') {
        await this.#release(leases);
      }
      throw new ForgeBuilderExecutionError(`Builder did not complete: ${detail}`);
    }
    const completed: AgentExecutionAttempt = {
      ...running,
      state: 'COMPLETED',
      revision: running.revision + 1,
      completedAt: this.#now(),
      sessionRef: result.sessionRef ?? running.sessionRef
    };
    await this.#persistence.persistAttempt({ runId: request.runId, attempt: completed });
    const impact = request.binding.impact ?? { predicted: this.#emptyImpact(request.task.id) };
    const reconciliation = await this.#reconcile({
      runId: request.runId,
      taskId: request.task.id,
      impact,
      reportedImpact: result.observedImpact,
      leases: [...leases, ...(result.additionalLeases ?? [])],
      workspace
    });
    const effectiveImpact = { ...impact, ...reconciliation };
    await this.#persistence.persistImpact({
      runId: request.runId,
      taskId: request.task.id,
      impact: effectiveImpact
    });
    if (reconciliation.reconciliation.status === 'unleased-change') {
      await this.#release([...leases, ...(result.additionalLeases ?? [])]);
      throw new ForgeBuilderExecutionError('Builder changed a file without an active write lease');
    }
    if (
      reconciliation.reconciliation.status === 'runtime-scope-expanded' &&
      reconciliation.expandedResources !== undefined
    ) {
      await this.#scopeExpanded?.({
        runId: request.runId,
        taskId: request.task.id,
        expandedResources: reconciliation.expandedResources
      });
    }
    await this.#release([...leases, ...(result.additionalLeases ?? [])]);
    return { status: 'completed', workspace, attempt: completed, impact: effectiveImpact };
  }

  async #acquire(
    runId: string,
    binding: RuntimeTaskBinding
  ): Promise<
    | { readonly status: 'granted'; readonly leases: readonly WriteLease[] }
    | ForgeBuilderLeaseBlockedResult
  > {
    const leases: WriteLease[] = [];
    for (const resource of canonicalTaskLeaseResources(binding.leasePlan.predictedResources)) {
      const acquired = await this.#writeGuard.acquire({
        runId,
        agentId: binding.agentId,
        taskId: binding.taskId,
        resource,
        mode: 'exclusive'
      });
      if (acquired.status !== 'granted') {
        await this.#release(leases);
        const blockerLeaseId = acquired.conflictingLeaseIds[0];
        if (blockerLeaseId === undefined) {
          throw new ForgeBuilderExecutionError('Builder lease block is missing an owner');
        }
        return { status: 'blocked', blockerLeaseId };
      }
      leases.push(acquired.lease);
      await this.#persistence.persistLease({ runId, lease: acquired.lease });
    }
    return { status: 'granted', leases };
  }

  async #release(leases: readonly WriteLease[]): Promise<void> {
    for (const activeLease of [
      ...new Map(leases.map((entry) => [entry.id, entry])).values()
    ].toReversed()) {
      if (activeLease.state !== 'ACTIVE') {
        continue;
      }
      const released = await this.#writeGuard.release({
        leaseId: activeLease.id,
        expectedVersion: activeLease.version
      });
      if (released.status !== 'released') {
        throw new ForgeBuilderExecutionError(`Lease release failed: ${activeLease.id}`);
      }
      await this.#persistence.persistLease({ runId: activeLease.runId, lease: released.lease });
      await this.#leaseReleased?.({
        runId: activeLease.runId,
        taskId: activeLease.taskId,
        lease: released.lease
      });
    }
  }

  async #reconcile(
    request: Parameters<TaskImpactReconciler['reconcile']>[0]
  ): Promise<Awaited<ReturnType<TaskImpactReconciler['reconcile']>>> {
    if (this.#reconciler !== undefined) {
      return this.#reconciler.reconcile(request);
    }
    return {
      observed: request.reportedImpact ?? {
        taskId: request.taskId,
        filesRead: new Set<string>(),
        filesCreated: new Set<string>(),
        filesWritten: new Set<string>(),
        filesDeleted: new Set<string>(),
        symbolsWritten: new Set<string>(),
        dependencyRequests: new Set<string>(),
        manifestFilesChanged: new Set<string>(),
        generatedFilesChanged: new Set<string>()
      },
      reconciliation: {
        status: 'within-predicted-scope',
        expandedFileIds: new Set<string>(),
        unleasedFileIds: new Set<string>()
      }
    };
  }

  #emptyImpact(taskId: string): TaskImpact['predicted'] {
    return {
      taskId,
      projectsRead: new Set(),
      projectsWritten: new Set(),
      explicitProjectsWritten: new Set(),
      filesRead: new Set(),
      filesWritten: new Set(),
      explicitFilesWritten: new Set(),
      globFilesWritten: new Set(),
      symbolDerivedFilesWritten: new Set(),
      symbolsRead: new Set(),
      symbolsWritten: new Set(),
      sharedResources: new Set(),
      sharedResourceAccesses: [],
      downstreamProjects: new Set(),
      riskSignals: []
    };
  }
}
