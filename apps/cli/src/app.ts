import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  PiPlanningAgent,
  PiSemanticPlanReviewer
} from '@ai-native-software-delivery-orchestrator/agent-runtime';
import { DeterministicConflictEngine } from '@ai-native-software-delivery-orchestrator/conflict-engine';
import type {
  FileNode,
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
  type PlanArtifact
} from '@ai-native-software-delivery-orchestrator/planning';
import {
  JsonFilePlanApprovalStore,
  JsonFilePlanArtifactStore,
  resolvePlanArtifactDirectory
} from '@ai-native-software-delivery-orchestrator/persistence';
import {
  analyzeRepository,
  ProjectGraphError,
  type RepositoryGraphAnalysis
} from '@ai-native-software-delivery-orchestrator/repository-analysis';
import { DeterministicScheduler } from '@ai-native-software-delivery-orchestrator/scheduler';
import {
  LocalRuntimeBindingPolicy,
  LocalRuntimeStarter,
  RunPreparation
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
import { Command } from 'commander';

export interface ForgeProgramDependencies {
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
  }) => Promise<PlanArtifact>;
  readonly approvePlan?: (request: {
    readonly artifactId: string;
    readonly artifactRevision: number;
    readonly approvalId: string;
    readonly approvedBy: string;
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
  }) => Promise<unknown>;
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
  readonly fileDependencies?: readonly { readonly from: string; readonly to: string }[];
  readonly symbolReferences?: readonly { readonly from: string; readonly to: string }[];
}

const verificationPolicy = {
  version: 2,
  autonomousRules: ['package-script-required', 'free-form-command-forbidden'],
  packageScriptRunner: 'npm-from-pinned-node-image',
  executionProfile: {
    kind: 'docker-read-only',
    image: 'node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43',
    assurance: 'production-validation',
    network: 'deny',
    workspaceAccess: 'read-only',
    processTree: 'container',
    memoryBytes: 1_073_741_824,
    cpuCount: 2,
    pidLimit: 256
  }
} as const;

const createRepositoryPlan = async (request: {
  readonly specificationPath: string;
  readonly repositoryPath: string;
  readonly sharedResourcesPath?: string;
  readonly maxAttempts: number;
  readonly maxConcurrency: number;
  readonly planDirectory?: string;
  readonly semanticReviewAuthorized: true;
}): Promise<PlanArtifact> => {
  const snapshotProvider = new GitRepositorySnapshotProvider();
  const [content, registry, snapshotBeforeAnalysis] = await Promise.all([
    readFile(request.specificationPath, 'utf8'),
    loadSharedResourceRegistry(request.sharedResourcesPath),
    snapshotProvider.capture({ repositoryPath: request.repositoryPath })
  ]);
  const analysis = await analyzeRepository(request.repositoryPath);
  const repositorySnapshot = assertStableRepositorySnapshot(
    snapshotBeforeAnalysis,
    await snapshotProvider.capture({ repositoryPath: request.repositoryPath })
  );
  const source = {
    type: 'markdown-spec' as const,
    content,
    path: request.specificationPath
  };
  const preparedPlan = await new AutonomousPlanPhase({
    planner: new PiPlanningAgent(),
    reviewer: new PiSemanticPlanReviewer(),
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
  const artifact = createPlanArtifact({
    artifactId: randomUUID(),
    revision: 1,
    createdAt: new Date().toISOString(),
    source,
    repository: analysis.graph,
    repositorySnapshot,
    sharedResourcePolicy: registry.list(),
    verificationPolicy,
    preparedPlan
  });
  const artifactDirectory = await resolvePlanArtifactDirectory(
    repositorySnapshot,
    request.planDirectory
  );
  await new JsonFilePlanArtifactStore(artifactDirectory, repositorySnapshot.repositoryRoot).save(
    artifact
  );
  return artifact;
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
}): Promise<PlanExecutionIntent> => {
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
    verificationPolicy
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
}): Promise<unknown> => {
  const [stores, registry] = await Promise.all([
    planStores(request),
    loadSharedResourceRegistry(request.sharedResourcesPath)
  ]);
  let currentGraph: RepositoryGraph | undefined;
  const binder = new PlanExecutionBinder({
    artifactStore: stores.artifactStore,
    approvalStore: stores.approvalStore,
    snapshotProvider: new GitRepositorySnapshotProvider(),
    factsProvider: {
      analyze: async (repository) => {
        currentGraph = (await analyzeRepository(repository.repositoryPath)).graph;
        return currentGraph;
      }
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
      verificationPolicy
    });
  const intent = await bind();
  const runDirectory = resolve(
    request.runDirectory ??
      join(homedir(), '.forge', 'runs', intent.artifact.repository.repositoryId.replace(':', '-'))
  );
  return new RunPreparation({
    authority: { revalidate: bind },
    checkouts: new GitIntegrationCheckoutProvisioner(runDirectory),
    bindings: new LocalRuntimeBindingPolicy({ workspaceRoot: runDirectory }),
    runtime: {
      startOrResumeRun: async (runtimeRequest) => {
        if (currentGraph === undefined) {
          throw new Error('Repository Facts were not available after execution revalidation');
        }
        const runtime = new LocalRuntimeStarter({
          graph: currentGraph,
          databasePath: join(runDirectory, request.runId, 'run.sqlite'),
          verificationPolicy
        });
        try {
          return await runtime.startOrResumeRun(runtimeRequest);
        } finally {
          runtime.close();
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
  const writeOutput =
    dependencies.writeOutput ?? ((output: string) => process.stdout.write(output));

  const program = new Command()
    .name('forge')
    .description('Repository-aware multi-agent coding orchestrator')
    .version('0.0.1');

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
        }
      ) => {
        try {
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
            semanticReviewAuthorized: options.semanticReview
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
    .action(
      async (
        artifactId: string,
        options: {
          approvedBy: string;
          approvalId: string;
          revision: number;
          repository: string;
          planDirectory?: string;
        }
      ) => {
        const approval = await approvePlan({
          artifactId,
          artifactRevision: options.revision,
          approvalId: options.approvalId,
          approvedBy: options.approvedBy,
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
              : { planDirectory: resolve(cwd, options.planDirectory) })
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
              : { runDirectory: resolve(cwd, options.runDirectory) })
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

  return program;
};
