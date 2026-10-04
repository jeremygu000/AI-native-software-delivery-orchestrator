import { randomUUID } from 'node:crypto';
import { realpath, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import {
  PiPlanningGatewayAdapter,
  PiPlanningAgent,
  PiSemanticPlanReviewer,
  resolveForgeModelSelection,
  type loginModelSubscription
} from '@ai-native-software-delivery-orchestrator/agent-runtime';
import { DeterministicConflictEngine } from '@ai-native-software-delivery-orchestrator/conflict-engine';
import type {
  CancellationSettlementPersistence,
  FileNode,
  IntegrationMutationClaimPersistence,
  RepositoryDiagnostic,
  RepositoryGraph,
  SymbolNode
} from '@ai-native-software-delivery-orchestrator/domain';
import {
  AutonomousPlanPhase,
  AutonomousPlanningError,
  assertStableRepositorySnapshot,
  createPlanApproval,
  createPlanArtifact,
  PlanExecutionBinder,
  PlanExecutionBindingError,
  type PlanApproval,
  type PlanExecutionIntent,
  type PlanArtifact,
  type PlanningSource
} from '@ai-native-software-delivery-orchestrator/planning';
import {
  openAuthorityPersistence,
  resolveAuthorityConfiguration,
  JsonFilePlanApprovalStore,
  JsonFilePlanArtifactStore,
  resolvePlanArtifactDirectory
} from '@ai-native-software-delivery-orchestrator/persistence';
import {
  ForgeReadModel,
  type ForgeRunReadModel
} from '@ai-native-software-delivery-orchestrator/orchestration-runtime';
import {
  analyzeRepository,
  ProjectGraphError,
  type RepositoryGraphAnalysis
} from '@ai-native-software-delivery-orchestrator/repository-analysis';
import { DeterministicScheduler } from '@ai-native-software-delivery-orchestrator/scheduler';
import {
  LocalRuntimeBindingPolicy,
  resolveVerificationPolicy,
  RunPreparation,
  TemporalRunLauncher
} from '@ai-native-software-delivery-orchestrator/run-preparation';
import {
  RepositoryTaskImpactAnalyzer,
  SharedResourceRegistry,
  sharedResourceRegistryConfigSchema
} from '@ai-native-software-delivery-orchestrator/task-impact';
import {
  GitIntegrationCheckoutProvisioner,
  GitRepositorySnapshotProvider
} from '@ai-native-software-delivery-orchestrator/workspace-git';
import {
  forgeRunWorkflowId,
  requestForgeRunCancellation,
  resolveTemporalConfig,
  startForgeRun
} from '@ai-native-software-delivery-orchestrator/temporal-runtime';
import { Command } from 'commander';
import { tracePlanningModelRequest } from './cli-telemetry.js';
import {
  createModelSelectionTerminal,
  listForgeModels,
  selectForgeModel,
  resolvePlanModelSelection,
  loginForgeModel,
  ModelSelectionError,
  type ModelSelectionTerminal
} from './model-selection.js';
import { checkInteractiveDeployment } from '@ai-native-software-delivery-orchestrator/temporal-worker/interactive-deployment';
import { prepareApprovedWorkspaces } from '@ai-native-software-delivery-orchestrator/temporal-worker/operator-workspaces';
import {
  startInteractiveCoding,
  type InteractiveCodingDependencies
} from './interactive-coding.js';
import { createInteractiveTerminal, type InteractiveTerminal } from './interactive-terminal.js';
import { resolveCliReviewPolicy } from './review-policy.js';

export interface ForgeProgramDependencies {
  readonly interactiveTerminal?: InteractiveTerminal;
  readonly planSource?: typeof planRepositoryFromSource;
  readonly validateInteractiveRepository?: InteractiveCodingDependencies['validateRepository'];
  readonly checkInteractiveWorker?: InteractiveCodingDependencies['checkWorker'];
  readonly setupInteractiveRun?: InteractiveCodingDependencies['setup'];
  readonly interactiveWait?: InteractiveCodingDependencies['wait'];
  readonly modelTerminal?: ModelSelectionTerminal;
  readonly modelEnvironment?: NodeJS.ProcessEnv;
  readonly loginModel?: typeof loginModelSubscription;
  readonly cwd?: string;
  readonly analyzeRepository?: (repositoryPath: string) => Promise<RepositoryGraphAnalysis>;
  readonly planRepository?: (request: {
    readonly specificationPath: string;
    readonly repositoryPath: string;
    readonly sharedResourcesPath?: string;
    readonly maxAttempts: number;
    readonly maxConcurrency: number;
    readonly planDirectory?: string;
    readonly semanticReviewAuthorized: true;
    readonly reviewProvider: string;
    readonly reviewModel: string;
    readonly reasoningEffort?: string;
  }) => Promise<PlanArtifact>;
  readonly approvePlan?: (request: {
    readonly artifactId: string;
    readonly artifactRevision: number;
    readonly approvalId: string;
    readonly approvedBy: string;
    readonly repositoryIntegrationTasks?: readonly string[];
    readonly repositoryPath: string;
    readonly planDirectory?: string;
  }) => Promise<PlanApproval>;
  readonly bindPlan?: (request: {
    readonly artifactId: string;
    readonly artifactRevision: number;
    readonly approvalId: string;
    readonly runId: string;
    readonly repositoryPath: string;
    readonly sharedResourcesPath?: string;
    readonly planDirectory?: string;
    readonly reviewProvider: string;
    readonly reviewModel: string;
    readonly reasoningEffort?: string;
  }) => Promise<PlanExecutionIntent>;
  readonly runPlan?: (request: {
    readonly artifactId: string;
    readonly artifactRevision: number;
    readonly approvalId: string;
    readonly runId: string;
    readonly repositoryPath: string;
    readonly sharedResourcesPath?: string;
    readonly planDirectory?: string;
    readonly runDirectory?: string;
    readonly prepareOnly?: boolean;
    readonly reviewProvider: string;
    readonly reviewModel: string;
    readonly reasoningEffort?: string;
  }) => Promise<unknown>;
  readonly statusRun?: (request: {
    readonly runId: string;
    readonly runDirectory: string;
  }) => Promise<RunStatusResult>;
  readonly cancelRun?: (request: {
    readonly runId: string;
    readonly runDirectory: string;
  }) => Promise<{ readonly runId: string; readonly state: string }>;
  readonly settleCancellation?: (request: {
    readonly runId: string;
    readonly runDirectory: string;
    readonly attemptKind: 'builder' | 'repair';
    readonly attemptId: string;
    readonly expectedRevision: number;
    readonly detail: string;
  }) => Promise<{ readonly attemptId: string; readonly state: 'CANCELLED' }>;
  readonly settleIntegrationCancellation?: (request: {
    readonly runId: string;
    readonly runDirectory: string;
    readonly taskId: string;
    readonly workspaceId: string;
    readonly outputAttemptId: string;
    readonly detail: string;
  }) => Promise<{ readonly taskId: string; readonly state: 'SETTLED' }>;
  readonly requestWorkflowCancellation?: (runId: string) => Promise<void>;
  readonly writeOutput?: (output: string) => void;
}

interface SerializableProjectGraph {
  readonly provider: string;
  readonly repositoryPath: string;
  readonly counts: {
    readonly projects: number;
    readonly files: number;
    readonly symbols: number;
    readonly projectDependencies: number;
    readonly fileDependencies: number;
    readonly symbolReferences: number;
    readonly diagnostics: number;
  };
  readonly projects: readonly {
    readonly id: string;
    readonly name: string;
    readonly root: string;
    readonly packageJsonPath: string;
    readonly dependencies: readonly {
      readonly name: string;
      readonly version: string;
      readonly kind: string;
      readonly workspaceProtocol: boolean;
    }[];
    readonly scripts: Readonly<Record<string, string>>;
    readonly sourceRoots: readonly string[];
    readonly tsconfigPaths: readonly string[];
  }[];
  readonly projectDependencies: readonly {
    readonly from: string;
    readonly to: string;
    readonly sources: readonly string[];
  }[];
  readonly diagnostics: readonly RepositoryDiagnostic[];
  readonly files?: readonly FileNode[];
  readonly symbols?: readonly SymbolNode[];
  readonly fileDependencies?: readonly {
    readonly from: string;
    readonly to: string;
  }[];
  readonly symbolReferences?: readonly {
    readonly from: string;
    readonly to: string;
  }[];
}

const verificationPolicy = resolveVerificationPolicy(
  {
    version: 2,
    autonomousRules: ['package-script-required', 'free-form-command-forbidden'],
    packageScriptRunner: 'npm-from-pinned-node-image',
    executionProfile: {
      kind: 'docker-read-only',
      image:
        'node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43',
      assurance: 'production-validation',
      network: 'deny',
      workspaceAccess: 'read-only',
      processTree: 'container',
      memoryBytes: 1_073_741_824,
      cpuCount: 2,
      pidLimit: 256
    }
  } as const,
  process.env
);

const operationalAuthority = (runId: string, runDirectory: string) =>
  openAuthorityPersistence(
    resolveAuthorityConfiguration(process.env, join(runDirectory, runId, 'run.sqlite'))
  );

export const planRepositoryFromSource = async (request: {
  readonly signal?: AbortSignal;
  readonly source: PlanningSource;
  readonly repositoryPath: string;
  readonly sharedResourcesPath?: string;
  readonly maxAttempts: number;
  readonly maxConcurrency: number;
  readonly planDirectory?: string;
  readonly semanticReviewAuthorized: true;
  readonly reviewProvider: string;
  readonly reviewModel: string;
  readonly reasoningEffort?: string;
  readonly onProgress?: (stage: 'analysis' | 'planning' | 'semantic-review') => void;
}): Promise<PlanArtifact> => {
  request.signal?.throwIfAborted();
  const { policy, model, execution } = resolveCliReviewPolicy(
    request.reviewProvider,
    request.reviewModel,
    request.reasoningEffort
  );
  const planningGateway = new PiPlanningGatewayAdapter(undefined, {
    model,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(execution === undefined ? {} : { execution }),
    ...(process.env.FORGE_MODEL_API_KEY === undefined
      ? {}
      : { apiKey: process.env.FORGE_MODEL_API_KEY })
  });
  const reasoningEffort =
    request.reasoningEffort ??
    execution?.target.reasoningConfig.effort ??
    process.env.FORGE_MODEL_REASONING_EFFORT ??
    (model?.reasoning ? 'high' : 'off');
  const planner = new PiPlanningAgent(planningGateway);
  const semanticReviewer = new PiSemanticPlanReviewer(planningGateway);
  const snapshotProvider = new GitRepositorySnapshotProvider();
  const [registry, snapshotBeforeAnalysis] = await Promise.all([
    loadSharedResourceRegistry(request.sharedResourcesPath),
    snapshotProvider.capture({ repositoryPath: request.repositoryPath })
  ]);
  request.onProgress?.('analysis');
  const analysis = await analyzeRepository(request.repositoryPath);
  const repositorySnapshot = assertStableRepositorySnapshot(
    snapshotBeforeAnalysis,
    await snapshotProvider.capture({ repositoryPath: request.repositoryPath })
  );
  request.signal?.throwIfAborted();
  const source = request.source;
  const preparedPlan = await new AutonomousPlanPhase({
    planner: {
      propose: (input) => {
        request.signal?.throwIfAborted();
        request.onProgress?.('planning');
        return tracePlanningModelRequest(
          {
            provider: request.reviewProvider,
            model: request.reviewModel,
            reasoningEffort,
            role: 'planner',
            attemptId: String(input.attempt)
          },
          () => planner.propose(input)
        );
      }
    },
    reviewer: {
      review: (input) => {
        request.signal?.throwIfAborted();
        request.onProgress?.('semantic-review');
        return tracePlanningModelRequest(
          {
            provider: request.reviewProvider,
            model: request.reviewModel,
            reasoningEffort,
            role: 'reviewer',
            attemptId: String(input.attempt)
          },
          () => semanticReviewer.review(input)
        );
      }
    },
    impactAnalyzer: new RepositoryTaskImpactAnalyzer(registry),
    conflictAnalyzer: new DeterministicConflictEngine(registry),
    scheduler: new DeterministicScheduler()
  }).create({
    source,
    repository: analysis.graph,
    sharedResourceIds: registry.list().map((resource) => resource.id),
    options: {
      maxAttempts: request.maxAttempts,
      schedule: { maxConcurrency: request.maxConcurrency }
    }
  });
  request.signal?.throwIfAborted();
  const artifact = createPlanArtifact({
    artifactId: randomUUID(),
    revision: 1,
    createdAt: new Date().toISOString(),
    source,
    repository: analysis.graph,
    repositorySnapshot,
    sharedResourcePolicy: registry.list(),
    verificationPolicy,
    codeReviewPolicy: policy,
    preparedPlan
  });
  const artifactDirectory = await resolvePlanArtifactDirectory(
    repositorySnapshot,
    request.planDirectory
  );
  request.signal?.throwIfAborted();
  await new JsonFilePlanArtifactStore(artifactDirectory, repositorySnapshot.repositoryRoot).save(
    artifact
  );
  return artifact;
};

const createRepositoryPlan = async (
  request: Parameters<NonNullable<ForgeProgramDependencies['planRepository']>>[0]
): Promise<PlanArtifact> => {
  const { specificationPath, ...configuration } = request;
  return planRepositoryFromSource({
    ...configuration,
    source: {
      type: 'markdown-spec',
      content: await readFile(specificationPath, 'utf8'),
      path: specificationPath
    }
  });
};

export const loadSharedResourceRegistry = async (
  configurationPath: string | undefined
): Promise<SharedResourceRegistry> => {
  if (configurationPath === undefined) {
    return new SharedResourceRegistry({ resources: [] });
  }
  const source = await readFile(configurationPath, 'utf8');
  const configuration: unknown = JSON.parse(source);
  return new SharedResourceRegistry(sharedResourceRegistryConfigSchema.parse(configuration));
};

export type RunStatusResult = ForgeRunReadModel;

const cancelRun =
  (requestWorkflowCancellation: (runId: string) => Promise<void>) =>
  async (request: {
    readonly runId: string;
    readonly runDirectory: string;
  }): Promise<{ readonly runId: string; readonly state: string }> => {
    const persistence = await operationalAuthority(request.runId, request.runDirectory);
    try {
      const cancellation = await persistence.requestCancellation(request.runId);
      if (cancellation.status === 'terminal') {
        throw new Error(`Cannot cancel run ${request.runId} in state ${cancellation.state}`);
      }
      await requestWorkflowCancellation(request.runId);
      return { runId: request.runId, state: 'CANCEL_REQUESTED' };
    } finally {
      await persistence.close();
    }
  };

const statusRun = async (request: {
  readonly runId: string;
  readonly runDirectory: string;
}): Promise<RunStatusResult> => {
  const persistence = await operationalAuthority(request.runId, request.runDirectory);
  try {
    const readModel = await new ForgeReadModel({
      persistence,
      workflowId: forgeRunWorkflowId
    }).read(request.runId);
    if (readModel === undefined) {
      throw new Error(`Run not found: ${request.runId}`);
    }
    return readModel;
  } finally {
    await persistence.close();
  }
};

const settleCancellation = async (request: {
  readonly runId: string;
  readonly runDirectory: string;
  readonly attemptKind: 'builder' | 'repair';
  readonly attemptId: string;
  readonly expectedRevision: number;
  readonly detail: string;
}): Promise<{ readonly attemptId: string; readonly state: 'CANCELLED' }> => {
  const persistence = await operationalAuthority(request.runId, request.runDirectory);
  try {
    const settlementStore: CancellationSettlementPersistence = persistence;
    const result =
      request.attemptKind === 'builder'
        ? await settlementStore.settleUnknownBuilderCancellation(request)
        : await settlementStore.settleUnknownRepairCancellation(request);
    if (result.status !== 'settled') {
      throw new Error(
        result.status === 'version-conflict'
          ? `Cancellation settlement revision conflict: ${request.attemptId}/${result.actualRevision}`
          : `Cancellation settlement requires UNKNOWN attempt: ${request.attemptId}/${result.state}`
      );
    }
    return { attemptId: result.attemptId, state: 'CANCELLED' };
  } finally {
    await persistence.close();
  }
};

const settleIntegrationCancellation = async (request: {
  readonly runId: string;
  readonly runDirectory: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly outputAttemptId: string;
  readonly detail: string;
}): Promise<{ readonly taskId: string; readonly state: 'SETTLED' }> => {
  const persistence = await operationalAuthority(request.runId, request.runDirectory);
  try {
    const settlementStore: IntegrationMutationClaimPersistence = persistence;
    await settlementStore.settleIntegrationCancellation(request);
    return { taskId: request.taskId, state: 'SETTLED' };
  } finally {
    await persistence.close();
  }
};

const planStores = async (request: {
  readonly repositoryPath: string;
  readonly planDirectory?: string;
}) => {
  const snapshot = await new GitRepositorySnapshotProvider().capture({
    repositoryPath: request.repositoryPath
  });
  const directory = await resolvePlanArtifactDirectory(snapshot, request.planDirectory);
  return {
    artifactStore: new JsonFilePlanArtifactStore(directory, snapshot.repositoryRoot),
    approvalStore: new JsonFilePlanApprovalStore(directory, snapshot.repositoryRoot),
    snapshot
  };
};

const approveRepositoryPlan = async (request: {
  readonly artifactId: string;
  readonly artifactRevision: number;
  readonly approvalId: string;
  readonly approvedBy: string;
  readonly repositoryIntegrationTasks?: readonly string[];
  readonly repositoryPath: string;
  readonly planDirectory?: string;
}): Promise<PlanApproval> => {
  const { artifactStore, approvalStore } = await planStores(request);
  const artifact = await artifactStore.load(request.artifactId, request.artifactRevision);
  if (artifact === undefined) {
    throw new Error(
      `Plan artifact not found: ${request.artifactId} revision ${request.artifactRevision}`
    );
  }
  const approval = createPlanApproval({
    approvalId: request.approvalId,
    artifact,
    approvedBy: request.approvedBy,
    ...(request.repositoryIntegrationTasks === undefined
      ? {}
      : { repositoryIntegrationTasks: request.repositoryIntegrationTasks }),
    approvedAt: new Date().toISOString()
  });
  await approvalStore.save(approval);
  return approval;
};

const bindRepositoryPlan = async (request: {
  readonly artifactId: string;
  readonly artifactRevision: number;
  readonly approvalId: string;
  readonly runId: string;
  readonly repositoryPath: string;
  readonly sharedResourcesPath?: string;
  readonly planDirectory?: string;
  readonly reviewProvider: string;
  readonly reviewModel: string;
  readonly reasoningEffort?: string;
}): Promise<PlanExecutionIntent> => {
  const { policy } = resolveCliReviewPolicy(
    request.reviewProvider,
    request.reviewModel,
    request.reasoningEffort
  );
  const [stores, registry] = await Promise.all([
    planStores(request),
    loadSharedResourceRegistry(request.sharedResourcesPath)
  ]);
  return new PlanExecutionBinder({
    artifactStore: stores.artifactStore,
    approvalStore: stores.approvalStore,
    snapshotProvider: new GitRepositorySnapshotProvider(),
    factsProvider: {
      analyze: async (repository) => (await analyzeRepository(repository.repositoryPath)).graph
    }
  }).bind({
    artifactId: request.artifactId,
    artifactRevision: request.artifactRevision,
    approvalId: request.approvalId,
    runId: request.runId,
    repository: { repositoryPath: request.repositoryPath },
    sharedResourcePolicy: registry.list(),
    verificationPolicy,
    codeReviewPolicy: policy
  });
};

const runRepositoryPlan = async (request: {
  readonly artifactId: string;
  readonly artifactRevision: number;
  readonly approvalId: string;
  readonly runId: string;
  readonly repositoryPath: string;
  readonly sharedResourcesPath?: string;
  readonly planDirectory?: string;
  readonly runDirectory?: string;
  readonly prepareOnly?: boolean;
  readonly reviewProvider: string;
  readonly reviewModel: string;
  readonly reasoningEffort?: string;
}): Promise<unknown> => {
  const { policy } = resolveCliReviewPolicy(
    request.reviewProvider,
    request.reviewModel,
    request.reasoningEffort
  );
  const authorityConfiguration = resolveAuthorityConfiguration(process.env);
  const workerRepositoryPath = process.env.FORGE_WORKER_REPOSITORY_PATH;
  if (
    workerRepositoryPath === undefined ||
    workerRepositoryPath.trim().length === 0 ||
    !isAbsolute(workerRepositoryPath)
  ) {
    throw new Error('Temporal launch requires nonempty absolute FORGE_WORKER_REPOSITORY_PATH');
  }
  if (workerRepositoryPath !== resolve(request.repositoryPath)) {
    throw new Error('Temporal worker repository scope does not match the requested repository');
  }
  // Fail before binding or provisioning a checkout if the selected deployment cannot open
  // its existing authority schema with the restricted runtime credential.
  const preflight = await openAuthorityPersistence(authorityConfiguration);
  const globalMode = process.env.FORGE_WORKER_AUTHORITY_MODE === 'global';
  try {
    // The production worker cannot service a legacy launch once cutover closes
    // its writer admission. Refuse before provisioning a checkout or creating a run.
    if (globalMode) {
      if (
        !('assertGlobalWorkerCompositionAllowed' in preflight) ||
        typeof preflight.assertGlobalWorkerCompositionAllowed !== 'function'
      ) {
        throw new Error('Global launch requires PostgreSQL global authority');
      }
      await preflight.assertGlobalWorkerCompositionAllowed();
    } else {
      await preflight.assertLegacyWorkerCompositionAllowed();
    }
  } finally {
    await preflight.close();
  }
  const [stores, registry] = await Promise.all([
    planStores(request),
    loadSharedResourceRegistry(request.sharedResourcesPath)
  ]);
  const binder = new PlanExecutionBinder({
    artifactStore: stores.artifactStore,
    approvalStore: stores.approvalStore,
    snapshotProvider: new GitRepositorySnapshotProvider(),
    factsProvider: {
      analyze: async (repository) => (await analyzeRepository(repository.repositoryPath)).graph
    }
  });
  const bind = () =>
    binder.bind({
      artifactId: request.artifactId,
      artifactRevision: request.artifactRevision,
      approvalId: request.approvalId,
      runId: request.runId,
      repository: { repositoryPath: request.repositoryPath },
      sharedResourcePolicy: registry.list(),
      verificationPolicy,
      codeReviewPolicy: policy
    });
  const intent = await bind();
  const runDirectory = resolve(
    request.runDirectory ??
      join(homedir(), '.forge', 'runs', intent.artifact.repository.repositoryId.replace(':', '-'))
  );
  return new RunPreparation({
    authority: { revalidate: bind },
    checkouts: globalMode
      ? {
          provision: async ({ sourceRepositoryPath, baseCommit }) => ({
            repositoryPath: sourceRepositoryPath,
            baseCommit,
            integrationRef: `forge/integration/${intent.runId}`
          })
        }
      : new GitIntegrationCheckoutProvisioner(runDirectory),
    bindings: new LocalRuntimeBindingPolicy({ workspaceRoot: runDirectory }),
    runtime: {
      startOrResumeRun: async (runtimeRequest) => {
        const persistence = await openAuthorityPersistence(authorityConfiguration);
        const launcher = new TemporalRunLauncher({
          persistence,
          mode: globalMode ? 'global' : 'legacy',
          workflow: {
            start: (runId: string) =>
              startForgeRun(
                resolveTemporalConfig({
                  serverUrl: process.env.TEMPORAL_SERVER_URL,
                  namespace: process.env.TEMPORAL_NAMESPACE,
                  taskQueue: process.env.TEMPORAL_TASK_QUEUE
                }),
                runId
              )
          }
        });
        try {
          return (request.prepareOnly ?? process.env.FORGE_PREPARE_ONLY === 'true')
            ? await launcher.prepareRun(runtimeRequest)
            : await launcher.startOrResumeRun(runtimeRequest);
        } finally {
          await persistence.close();
        }
      }
    }
  }).start(intent);
};

const parsePositiveInteger = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received ${value}`);
  }
  return parsed;
};

const serializeProjectGraph = (
  providerId: string,
  graph: RepositoryGraph,
  full: boolean
): SerializableProjectGraph => {
  const summary: SerializableProjectGraph = {
    provider: providerId,
    repositoryPath: graph.repositoryPath,
    counts: {
      projects: graph.projects.size,
      files: graph.files.size,
      symbols: graph.symbols.size,
      projectDependencies: graph.projectDependencies.length,
      fileDependencies: graph.fileDependencies.length,
      symbolReferences: graph.symbolReferences.length,
      diagnostics: graph.diagnostics.length
    },
    projects: [...graph.projects.values()],
    projectDependencies: graph.projectDependencies,
    diagnostics: graph.diagnostics
  };
  if (!full) {
    return summary;
  }
  return {
    ...summary,
    files: [...graph.files.values()],
    symbols: [...graph.symbols.values()],
    fileDependencies: graph.fileDependencies,
    symbolReferences: graph.symbolReferences
  };
};

export const createForgeProgram = (dependencies: ForgeProgramDependencies = {}): Command => {
  const cwd = dependencies.cwd ?? process.cwd();
  const analyze = dependencies.analyzeRepository ?? analyzeRepository;
  const planRepository = dependencies.planRepository ?? createRepositoryPlan;
  const approvePlan = dependencies.approvePlan ?? approveRepositoryPlan;
  const bindPlan = dependencies.bindPlan ?? bindRepositoryPlan;
  const runPlan = dependencies.runPlan ?? runRepositoryPlan;
  const statusRunFn = dependencies.statusRun ?? statusRun;
  const requestWorkflowCancellation =
    dependencies.requestWorkflowCancellation ??
    ((runId: string) =>
      requestForgeRunCancellation(
        resolveTemporalConfig({
          serverUrl: process.env.TEMPORAL_SERVER_URL,
          namespace: process.env.TEMPORAL_NAMESPACE
        }),
        runId
      ));
  const cancelRunFn = dependencies.cancelRun ?? cancelRun(requestWorkflowCancellation);
  const settleCancellationFn = dependencies.settleCancellation ?? settleCancellation;
  const settleIntegrationCancellationFn =
    dependencies.settleIntegrationCancellation ?? settleIntegrationCancellation;
  const writeOutput =
    dependencies.writeOutput ?? ((output: string) => process.stdout.write(output));

  const modelTerminal = dependencies.modelTerminal ?? createModelSelectionTerminal();
  const modelEnvironment = dependencies.modelEnvironment ?? process.env;

  const program = new Command()
    .name('forge')
    .description('Repository-aware multi-agent coding orchestrator')
    .version('0.0.1');

  program.action(async () => {
    // OpenTUI is lazy-loaded: explicit commands retain the existing Node runtime boundary.
    if (dependencies.interactiveTerminal === undefined) {
      const { supportsCodingTui } = await import('./tui/runtime.js');
      if (!supportsCodingTui(process.versions.node, process.execArgv, process.env.NODE_OPTIONS)) {
        throw new ModelSelectionError(
          'Interactive Forge requires Node >=26.4.0 with --experimental-ffi. Non-interactive forge commands retain their existing runtime.'
        );
      }
    }
    const terminal = dependencies.interactiveTerminal ?? createInteractiveTerminal();
    const interactive: InteractiveCodingDependencies = {
      terminal,
      cwd,
      environment: modelEnvironment,
      validateRepository:
        dependencies.validateInteractiveRepository ??
        (async (path) => {
          const snapshots = new GitRepositorySnapshotProvider();
          const before = await snapshots.capture({
            repositoryPath: await realpath(path)
          });
          await analyze(before.repositoryRoot);
          const after = await snapshots.capture({
            repositoryPath: before.repositoryRoot
          });
          assertStableRepositorySnapshot(before, after);
          return await realpath(before.repositoryRoot);
        }),
      planSource: dependencies.planSource ?? planRepositoryFromSource,
      approvePlan,
      bindPlan,
      runPlan,
      statusRun: statusRunFn,
      cancelRun: cancelRunFn,
      checkWorker:
        dependencies.checkInteractiveWorker ?? ((request) => checkInteractiveDeployment(request)),
      setup:
        dependencies.setupInteractiveRun ??
        (async (request) => {
          if (process.env.FORGE_WORKER_AUTHORITY_MODE !== 'global') {
            return;
          }
          dependencies.interactiveTerminal?.write('Preparing run metadata...\n');
          request.onProgress?.('metadata', 'active');
          await runPlan({ ...request, prepareOnly: true });
          request.onProgress?.('metadata', 'complete');
          request.onProgress?.('workspace', 'active');
          dependencies.interactiveTerminal?.write('✓ Run metadata prepared\n');
          dependencies.interactiveTerminal?.write('Preparing isolated workspaces...\n');
          const authority = resolveAuthorityConfiguration(process.env);
          if (authority.backend !== 'postgres') {
            throw new Error('Global setup requires PostgreSQL authority');
          }
          await prepareApprovedWorkspaces({
            root: cwd,
            runId: request.runId,
            artifactId: request.artifactId,
            artifactRevision: request.artifactRevision,
            approvalId: request.approvalId,
            approvedBy: request.approvedBy,
            authorizeWorkspaceCreation: true,
            planDirectory: await resolvePlanArtifactDirectory(
              request.artifact.repository,
              request.planDirectory
            ),
            runtimeConnectionString: authority.connectionString,
            runtimeSchema: authority.schema,
            onProgress: request.onProgress
          });
          dependencies.interactiveTerminal?.write('✓ Isolated workspaces ready\n');
          request.onProgress?.('workspace', 'complete');
          request.onProgress?.('authority', 'complete');
        }),
      ...(dependencies.interactiveWait === undefined ? {} : { wait: dependencies.interactiveWait })
    };
    if (dependencies.interactiveTerminal !== undefined) {
      await startInteractiveCoding(interactive);
    } else {
      const { startCodingTui } = await import('./tui/start.js');
      await startCodingTui(interactive);
    }
  });

  const modelCommand = program
    .command('model')
    .description('Inspect and select Forge execution profiles');
  modelCommand
    .command('list')
    .description('List supported profiles and local Forge credential status')
    .action(async () => {
      writeOutput(await listForgeModels(modelEnvironment));
    });
  modelCommand
    .command('select')
    .description('Select and confirm an execution profile without saving it')
    .action(async () => {
      const selection = await selectForgeModel(modelTerminal, modelEnvironment);
      writeOutput(
        `${JSON.stringify(resolveForgeModelSelection(selection, modelEnvironment), null, 2)}\n`
      );
    });
  modelCommand
    .command('login')
    .description('Authorize a subscription in the explicit Forge private store')
    .argument('<provider>', 'canonical provider ID')
    .action(async (provider: string) => {
      await loginForgeModel(provider, modelTerminal, modelEnvironment, dependencies.loginModel);
    });

  program
    .command('analyze')
    .description('Analyze repository projects, TypeScript files, symbols, and references')
    .argument('[repository]', 'repository to analyze', cwd)
    .option('--full', 'include complete file, symbol, and reference details')
    .action(async (repository: string, options: { full?: boolean }) => {
      try {
        const result = await analyze(resolve(cwd, repository));
        writeOutput(
          `${JSON.stringify(serializeProjectGraph(result.providerId, result.graph, options.full === true), null, 2)}\n`
        );
      } catch (error) {
        if (error instanceof ProjectGraphError) {
          program.error(`${error.code}: ${error.message}`);
        }
        throw error;
      }
    });

  program
    .command('plan')
    .description('Create and validate an autonomous task plan from a Markdown specification')
    .argument('<specification>', 'path to a Markdown specification')
    .option('-r, --repository <path>', 'repository to plan against', cwd)
    .option(
      '--shared-resources <path>',
      'JSON shared-resource policy consumed by the deterministic impact and conflict engines'
    )
    .option('--max-attempts <count>', 'maximum planner attempts', parsePositiveInteger, 3)
    .option('--max-concurrency <count>', 'maximum concurrent tasks', parsePositiveInteger, 1)
    .option(
      '--plan-directory <path>',
      'directory for immutable plan artifacts (default: ~/.forge/plans/<repository-id>)'
    )
    .requiredOption(
      '--semantic-review',
      'authorize an independent Pi review using the specification and read-only repository facts'
    )
    .option('--review-provider <provider>', 'approved provider for independent code review')
    .option('--review-model <model>', 'approved model ID for independent code review')
    .option('--reasoning-effort <effort>', 'explicit model reasoning effort')
    .action(
      async (
        specification: string,
        options: {
          repository: string;
          sharedResources?: string;
          maxAttempts: number;
          maxConcurrency: number;
          planDirectory?: string;
          semanticReview: true;
          reviewProvider?: string;
          reviewModel?: string;
          reasoningEffort?: string;
        }
      ) => {
        try {
          const selection = await resolvePlanModelSelection(
            options,
            modelTerminal,
            modelEnvironment
          );
          const repositoryPath = resolve(cwd, options.repository);
          const result = await planRepository({
            specificationPath: resolve(cwd, specification),
            repositoryPath,
            ...(options.sharedResources === undefined
              ? {}
              : { sharedResourcesPath: resolve(cwd, options.sharedResources) }),
            maxAttempts: options.maxAttempts,
            maxConcurrency: options.maxConcurrency,
            ...(options.planDirectory === undefined
              ? {}
              : { planDirectory: resolve(cwd, options.planDirectory) }),
            semanticReviewAuthorized: options.semanticReview,
            ...selection
          });
          writeOutput(`${JSON.stringify(result, null, 2)}\n`);
        } catch (error) {
          if (error instanceof AutonomousPlanningError) {
            const missingRegistryHint =
              options.sharedResources === undefined &&
              error.diagnostics.some((diagnostic) => diagnostic.code === 'UNKNOWN_SHARED_RESOURCE')
                ? '\nNo shared-resource policy was configured. Pass --shared-resources <path> with a JSON registry when the plan uses named shared resources.'
                : '';
            program.error(
              `PLANNING_REJECTED: ${error.message}\n${JSON.stringify(error.diagnostics, null, 2)}${missingRegistryHint}`
            );
          }
          throw error;
        }
      }
    );

  program
    .command('approve')
    .description('Approve one exact immutable plan artifact revision')
    .argument('<artifact-id>', 'plan artifact ID')
    .requiredOption('--approved-by <actor>', 'provider-neutral identity of the approving actor')
    .option('--approval-id <id>', 'approval record ID', randomUUID())
    .option('--revision <number>', 'plan artifact revision', parsePositiveInteger, 1)
    .option('-r, --repository <path>', 'repository associated with the plan', cwd)
    .option('--plan-directory <path>', 'directory containing immutable plan artifacts')
    .option(
      '--allow-repository-integration <task-ids>',
      'Explicitly approve repository Git execution rights for comma-separated task IDs'
    )
    .action(
      async (
        artifactId: string,
        options: {
          approvedBy: string;
          approvalId: string;
          revision: number;
          repository: string;
          planDirectory?: string;
          allowRepositoryIntegration?: string;
        }
      ) => {
        const approval = await approvePlan({
          artifactId,
          artifactRevision: options.revision,
          approvalId: options.approvalId,
          approvedBy: options.approvedBy,
          ...(options.allowRepositoryIntegration === undefined
            ? {}
            : {
                repositoryIntegrationTasks: options.allowRepositoryIntegration
                  .split(',')
                  .map((id) => id.trim())
              }),
          repositoryPath: resolve(cwd, options.repository),
          ...(options.planDirectory === undefined
            ? {}
            : { planDirectory: resolve(cwd, options.planDirectory) })
        });
        writeOutput(`${JSON.stringify(approval, null, 2)}\n`);
      }
    );

  program
    .command('bind')
    .description('Bind an exact approved plan to current repository and policy authority')
    .argument('<artifact-id>', 'plan artifact ID')
    .requiredOption('--approval <id>', 'exact approval record ID')
    .requiredOption('--run-id <id>', 'stable runtime run identity used for single-use claiming')
    .option('--revision <number>', 'plan artifact revision', parsePositiveInteger, 1)
    .option('-r, --repository <path>', 'repository to revalidate', cwd)
    .option(
      '--shared-resources <path>',
      'current JSON shared-resource policy to revalidate against the artifact'
    )
    .option('--plan-directory <path>', 'directory containing plan and approval records')
    .requiredOption('--review-provider <provider>', 'approved provider for independent code review')
    .requiredOption('--review-model <model>', 'approved model ID for independent code review')
    .option('--reasoning-effort <effort>', 'explicit model reasoning effort')
    .action(
      async (
        artifactId: string,
        options: {
          approval: string;
          runId: string;
          revision: number;
          repository: string;
          sharedResources?: string;
          planDirectory?: string;
          reviewProvider: string;
          reviewModel: string;
          reasoningEffort?: string;
        }
      ) => {
        try {
          const intent = await bindPlan({
            artifactId,
            artifactRevision: options.revision,
            approvalId: options.approval,
            runId: options.runId,
            repositoryPath: resolve(cwd, options.repository),
            ...(options.sharedResources === undefined
              ? {}
              : { sharedResourcesPath: resolve(cwd, options.sharedResources) }),
            ...(options.planDirectory === undefined
              ? {}
              : { planDirectory: resolve(cwd, options.planDirectory) }),
            reviewProvider: options.reviewProvider,
            reviewModel: options.reviewModel,
            ...(options.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: options.reasoningEffort })
          });
          writeOutput(`${JSON.stringify(intent, null, 2)}\n`);
        } catch (error) {
          if (error instanceof PlanExecutionBindingError) {
            program.error(
              `BINDING_REJECTED: ${error.message}\n${JSON.stringify(error.mismatches, null, 2)}`
            );
          }
          throw error;
        }
      }
    );

  program
    .command('run')
    .description('Revalidate and execute one exact approved plan in isolated Git worktrees')
    .argument('<artifact-id>', 'plan artifact ID')
    .requiredOption('--approval <id>', 'exact approval record ID')
    .requiredOption('--run-id <id>', 'stable runtime run identity')
    .option('--revision <number>', 'plan artifact revision', parsePositiveInteger, 1)
    .option('-r, --repository <path>', 'repository to revalidate and execute', cwd)
    .option('--shared-resources <path>', 'current JSON shared-resource policy')
    .option('--plan-directory <path>', 'directory containing plan and approval records')
    .requiredOption('--review-provider <provider>', 'approved provider for independent code review')
    .requiredOption('--review-model <model>', 'approved model ID for independent code review')
    .option('--reasoning-effort <effort>', 'explicit model reasoning effort')
    .option(
      '--run-directory <path>',
      'directory for integration checkout, task worktrees, and run DB'
    )
    .action(
      async (
        artifactId: string,
        options: {
          approval: string;
          runId: string;
          revision: number;
          repository: string;
          sharedResources?: string;
          planDirectory?: string;
          runDirectory?: string;
          reviewProvider: string;
          reviewModel: string;
          reasoningEffort?: string;
        }
      ) => {
        try {
          const result = await runPlan({
            artifactId,
            artifactRevision: options.revision,
            approvalId: options.approval,
            runId: options.runId,
            repositoryPath: resolve(cwd, options.repository),
            ...(options.sharedResources === undefined
              ? {}
              : { sharedResourcesPath: resolve(cwd, options.sharedResources) }),
            ...(options.planDirectory === undefined
              ? {}
              : { planDirectory: resolve(cwd, options.planDirectory) }),
            ...(options.runDirectory === undefined
              ? {}
              : { runDirectory: resolve(cwd, options.runDirectory) }),
            reviewProvider: options.reviewProvider,
            reviewModel: options.reviewModel,
            ...(options.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: options.reasoningEffort })
          });
          writeOutput(`${JSON.stringify(result, null, 2)}\n`);
        } catch (error) {
          if (error instanceof PlanExecutionBindingError) {
            program.error(
              `RUN_BINDING_REJECTED: ${error.message}\n${JSON.stringify(error.mismatches, null, 2)}`
            );
          }
          throw error;
        }
      }
    );

  program
    .command('status')
    .description('Show the current state of a run, including tasks, leases, and recent events')
    .requiredOption('--run-id <id>', 'run identity to query')
    .requiredOption(
      '--run-directory <path>',
      'directory containing the exact run database authority'
    )
    .action(async (options: { runId: string; runDirectory: string }) => {
      try {
        const result = await statusRunFn({
          runId: options.runId,
          runDirectory: options.runDirectory
        });
        writeOutput(`${JSON.stringify(result, null, 2)}\n`);
      } catch (error) {
        if (error instanceof Error) {
          program.error(error.message);
        }
        throw error;
      }
    });

  program
    .command('cancel')
    .description('Request cancellation of an active run')
    .requiredOption('--run-id <id>', 'run identity to cancel')
    .requiredOption(
      '--run-directory <path>',
      'directory containing the exact run database authority'
    )
    .action(async (options: { runId: string; runDirectory: string }) => {
      try {
        const result = await cancelRunFn({
          runId: options.runId,
          runDirectory: options.runDirectory
        });
        writeOutput(`${JSON.stringify(result, null, 2)}\n`);
      } catch (error) {
        if (error instanceof Error) {
          program.error(error.message);
        }
        throw error;
      }
    });

  program
    .command('settle-cancellation')
    .description('Record operator-confirmed settlement of an UNKNOWN cancelled agent attempt')
    .requiredOption('--run-id <id>', 'run identity containing the unknown attempt')
    .requiredOption(
      '--run-directory <path>',
      'directory containing the exact run database authority'
    )
    .requiredOption('--attempt-kind <kind>', 'attempt kind: builder or repair')
    .requiredOption('--attempt-id <id>', 'UNKNOWN attempt identity to settle')
    .requiredOption(
      '--expected-revision <number>',
      'exact current UNKNOWN attempt revision',
      parsePositiveInteger
    )
    .requiredOption('--detail <text>', 'operator confirmation that the external agent has stopped')
    .action(
      async (options: {
        runId: string;
        runDirectory: string;
        attemptKind: string;
        attemptId: string;
        expectedRevision: number;
        detail: string;
      }) => {
        if (options.attemptKind !== 'builder' && options.attemptKind !== 'repair') {
          program.error('--attempt-kind must be builder or repair');
          return;
        }
        try {
          const result = await settleCancellationFn({
            runId: options.runId,
            runDirectory: options.runDirectory,
            attemptKind: options.attemptKind,
            attemptId: options.attemptId,
            expectedRevision: options.expectedRevision,
            detail: options.detail
          });
          writeOutput(`${JSON.stringify(result, null, 2)}\n`);
        } catch (error) {
          if (error instanceof Error) {
            program.error(error.message);
          }
          throw error;
        }
      }
    );

  program
    .command('settle-integration-cancellation')
    .description('Record operator-confirmed settlement of an orphaned integration claim')
    .requiredOption('--run-id <id>', 'run identity containing the integration claim')
    .requiredOption(
      '--run-directory <path>',
      'directory containing the exact run database authority'
    )
    .requiredOption('--task-id <id>', 'task identity owning the integration claim')
    .requiredOption('--workspace-id <id>', 'exact workspace identity in the integration claim')
    .requiredOption('--output-attempt-id <id>', 'exact accepted output attempt identity')
    .requiredOption(
      '--detail <text>',
      'operator confirmation that the Git operation has stopped or settled'
    )
    .action(
      async (options: {
        runId: string;
        runDirectory: string;
        taskId: string;
        workspaceId: string;
        outputAttemptId: string;
        detail: string;
      }) => {
        try {
          const result = await settleIntegrationCancellationFn(options);
          writeOutput(`${JSON.stringify(result, null, 2)}\n`);
        } catch (error) {
          if (error instanceof Error) {
            program.error(error.message);
          }
          throw error;
        }
      }
    );

  return program;
};
