import type {
  RecoveredRuntimeRun,
  StartRuntimeRunRequest
} from '@ai-native-software-delivery-orchestrator/orchestration-runtime';
import {
  fingerprintPlanValue,
  parsePlanExecutionIntent,
  type PlanExecutionIntent
} from '@ai-native-software-delivery-orchestrator/planning';
import {
  taskLeasePlanFingerprint,
  taskLeasePlanFromPredictedImpact
} from '@ai-native-software-delivery-orchestrator/domain';

export interface ExecutionAuthorityRevalidator {
  revalidate(intent: PlanExecutionIntent): Promise<PlanExecutionIntent>;
}

export interface IntegrationCheckout {
  readonly repositoryPath: string;
  readonly baseCommit: string;
  readonly integrationRef: string;
}

export interface IntegrationCheckoutProvisioner {
  provision(request: {
    readonly runId: string;
    readonly sourceRepositoryPath: string;
    readonly baseCommit: string;
  }): Promise<IntegrationCheckout>;
}

export interface RuntimeBindingPolicy {
  bind(request: {
    readonly intent: PlanExecutionIntent;
    readonly checkout: IntegrationCheckout;
  }): Promise<StartRuntimeRunRequest>;
}

export interface RuntimeStarter {
  startOrResumeRun(request: StartRuntimeRunRequest): Promise<RecoveredRuntimeRun>;
}

export class RunPreparationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunPreparationError';
  }
}

export class RunPreparation {
  readonly #authority: ExecutionAuthorityRevalidator;
  readonly #checkouts: IntegrationCheckoutProvisioner;
  readonly #bindings: RuntimeBindingPolicy;
  readonly #runtime: RuntimeStarter;

  constructor(options: {
    readonly authority: ExecutionAuthorityRevalidator;
    readonly checkouts: IntegrationCheckoutProvisioner;
    readonly bindings: RuntimeBindingPolicy;
    readonly runtime: RuntimeStarter;
  }) {
    this.#authority = options.authority;
    this.#checkouts = options.checkouts;
    this.#bindings = options.bindings;
    this.#runtime = options.runtime;
  }

  async start(intentCandidate: PlanExecutionIntent): Promise<RecoveredRuntimeRun> {
    const requestedIntent = parsePlanExecutionIntent(intentCandidate);
    const intent = parsePlanExecutionIntent(await this.#authority.revalidate(requestedIntent));
    if (intent.executionFingerprint !== requestedIntent.executionFingerprint) {
      throw new RunPreparationError('Execution authority changed during run preparation');
    }
    if (intent.artifact.repository.dirty) {
      throw new RunPreparationError(
        'Dirty PlanArtifacts cannot run until exact working-tree snapshot materialization is implemented'
      );
    }
    const checkout = await this.#checkouts.provision({
      runId: intent.runId,
      sourceRepositoryPath: intent.artifact.repository.repositoryRoot,
      baseCommit: intent.artifact.repository.baseCommit
    });
    if (checkout.baseCommit !== intent.artifact.repository.baseCommit) {
      throw new RunPreparationError('Integration checkout does not match the approved base commit');
    }
    const runtimeRequest = await this.#bindings.bind({ intent, checkout });
    if (runtimeRequest.run.id !== intent.runId) {
      throw new RunPreparationError('Runtime request run ID does not match execution authority');
    }
    if (runtimeRequest.run.repositoryId !== intent.artifact.repository.repositoryId) {
      throw new RunPreparationError(
        'Runtime request repository ID does not match execution authority'
      );
    }
    this.#assertRuntimeRequest(intent, checkout, runtimeRequest);
    return this.#runtime.startOrResumeRun(runtimeRequest);
  }

  #assertRuntimeRequest(
    intent: PlanExecutionIntent,
    checkout: IntegrationCheckout,
    request: StartRuntimeRunRequest
  ): void {
    const decision = intent.artifact.decision;
    const expectedAuthority = {
      artifactId: intent.artifact.artifactId,
      artifactRevision: intent.artifact.revision,
      approvalId: intent.approval.approvalId,
      planFingerprint: intent.artifact.planFingerprint,
      approvalFingerprint: intent.approval.approvalFingerprint,
      claimFingerprint: intent.approvalClaim.claimFingerprint,
      executionFingerprint: intent.executionFingerprint,
      repositoryRoot: intent.artifact.repository.repositoryRoot,
      baseCommit: intent.artifact.repository.baseCommit,
      workingTreeFingerprint: intent.artifact.repository.workingTreeFingerprint,
      repositoryFactsFingerprint: intent.artifact.repository.factsFingerprint,
      sharedResourcePolicyFingerprint: intent.artifact.authority.sharedResourcePolicyFingerprint,
      verificationPolicyFingerprint: intent.artifact.authority.verificationPolicyFingerprint
    };
    if (fingerprintPlanValue(request.run.authority) !== fingerprintPlanValue(expectedAuthority)) {
      throw new RunPreparationError('Runtime durable authority does not match execution intent');
    }
    for (const [name, actual, expected] of [
      ['task contracts', request.tasks, decision.specification.tasks],
      ['hard conflicts', request.hardConflicts, decision.hardConflicts],
      ['risk conflicts', request.riskConflicts, decision.riskConflicts],
      ['schedule options', request.scheduleOptions, decision.schedule]
    ] as const) {
      if (fingerprintPlanValue(actual) !== fingerprintPlanValue(expected)) {
        throw new RunPreparationError(`Runtime ${name} do not match approved execution authority`);
      }
    }
    const approvedImpacts = new Map(decision.impacts.map((impact) => [impact.taskId, impact]));
    const bindings = new Map(request.taskBindings.map((binding) => [binding.taskId, binding]));
    if (bindings.size !== request.taskBindings.length || bindings.size !== request.tasks.length) {
      throw new RunPreparationError('Runtime task bindings do not match approved tasks');
    }
    for (const task of request.tasks) {
      const impact = approvedImpacts.get(task.id);
      const binding = bindings.get(task.id);
      if (impact === undefined || binding?.impact === undefined) {
        throw new RunPreparationError(`Runtime binding lacks approved impact: ${task.id}`);
      }
      if (
        binding.workspace.integrationRepositoryPath !== checkout.repositoryPath ||
        binding.workspace.baseRef !== checkout.baseCommit ||
        binding.workspace.integrationRef !== checkout.integrationRef
      ) {
        throw new RunPreparationError(`Runtime workspace escapes approved checkout: ${task.id}`);
      }
      const expectedLeasePlan = taskLeasePlanFromPredictedImpact({
        taskId: impact.taskId,
        projectsWritten: new Set(impact.projectsWritten),
        filesWritten: new Set(impact.filesWritten),
        symbolDerivedFilesWritten: new Set(impact.symbolDerivedFilesWritten),
        symbolsWritten: new Set(impact.symbolsWritten),
        sharedResources: new Set(impact.sharedResources)
      });
      if (
        taskLeasePlanFingerprint(binding.leasePlan) !== taskLeasePlanFingerprint(expectedLeasePlan)
      ) {
        throw new RunPreparationError(
          `Runtime lease plan does not match approved impact: ${task.id}`
        );
      }
      const runtimeImpact = binding.impact.predicted;
      const normalizedRuntimeImpact = {
        ...runtimeImpact,
        projectsRead: [...runtimeImpact.projectsRead].toSorted(),
        projectsWritten: [...runtimeImpact.projectsWritten].toSorted(),
        explicitProjectsWritten: [...runtimeImpact.explicitProjectsWritten].toSorted(),
        filesRead: [...runtimeImpact.filesRead].toSorted(),
        filesWritten: [...runtimeImpact.filesWritten].toSorted(),
        explicitFilesWritten: [...runtimeImpact.explicitFilesWritten].toSorted(),
        globFilesWritten: [...runtimeImpact.globFilesWritten].toSorted(),
        symbolDerivedFilesWritten: [...runtimeImpact.symbolDerivedFilesWritten].toSorted(),
        symbolsRead: [...runtimeImpact.symbolsRead].toSorted(),
        symbolsWritten: [...runtimeImpact.symbolsWritten].toSorted(),
        sharedResources: [...runtimeImpact.sharedResources].toSorted(),
        downstreamProjects: [...runtimeImpact.downstreamProjects].toSorted()
      };
      if (fingerprintPlanValue(normalizedRuntimeImpact) !== fingerprintPlanValue(impact)) {
        throw new RunPreparationError(`Runtime impact does not match approved impact: ${task.id}`);
      }
    }
  }
}
