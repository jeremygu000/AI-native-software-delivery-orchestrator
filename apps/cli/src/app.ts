import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

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
  type PreparedOrchestrationPlan
} from '@ai-native-software-delivery-orchestrator/planning';
import {
  analyzeRepository,
  ProjectGraphError,
  type RepositoryGraphAnalysis
} from '@ai-native-software-delivery-orchestrator/repository-analysis';
import { DeterministicScheduler } from '@ai-native-software-delivery-orchestrator/scheduler';
import {
  RepositoryTaskImpactAnalyzer,
  SharedResourceRegistry,
  sharedResourceRegistryConfigSchema
} from '@ai-native-software-delivery-orchestrator/task-impact';
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
    readonly semanticReviewAuthorized: true;
  }) => Promise<PreparedOrchestrationPlan>;
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

const createRepositoryPlan = async (request: {
  readonly specificationPath: string;
  readonly repositoryPath: string;
  readonly sharedResourcesPath?: string;
  readonly maxAttempts: number;
  readonly maxConcurrency: number;
  readonly semanticReviewAuthorized: true;
}): Promise<PreparedOrchestrationPlan> => {
  const [content, analysis, registry] = await Promise.all([
    readFile(request.specificationPath, 'utf8'),
    analyzeRepository(request.repositoryPath),
    loadSharedResourceRegistry(request.sharedResourcesPath)
  ]);
  return new AutonomousPlanPhase({
    planner: new PiPlanningAgent(),
    reviewer: new PiSemanticPlanReviewer(),
    impactAnalyzer: new RepositoryTaskImpactAnalyzer(registry),
    conflictAnalyzer: new DeterministicConflictEngine(registry),
    scheduler: new DeterministicScheduler()
  }).create({
    source: {
      type: 'markdown-spec',
      content,
      path: request.specificationPath
    },
    repository: analysis.graph,
    sharedResourceIds: registry.list().map((resource) => resource.id),
    options: {
      maxAttempts: request.maxAttempts,
      schedule: { maxConcurrency: request.maxConcurrency }
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

const serializePlan = (plan: PreparedOrchestrationPlan) => ({
  attempts: plan.attempts,
  semanticReview: plan.semanticReview,
  specification: plan.specification,
  impacts: plan.impacts.map((impact) => ({
    ...impact,
    projectsRead: [...impact.projectsRead],
    projectsWritten: [...impact.projectsWritten],
    explicitProjectsWritten: [...impact.explicitProjectsWritten],
    filesRead: [...impact.filesRead],
    filesWritten: [...impact.filesWritten],
    explicitFilesWritten: [...impact.explicitFilesWritten],
    globFilesWritten: [...impact.globFilesWritten],
    symbolDerivedFilesWritten: [...impact.symbolDerivedFilesWritten],
    symbolsRead: [...impact.symbolsRead],
    symbolsWritten: [...impact.symbolsWritten],
    sharedResources: [...impact.sharedResources],
    downstreamProjects: [...impact.downstreamProjects]
  })),
  hardConflicts: plan.hardConflicts,
  riskConflicts: plan.riskConflicts,
  executionPlan: plan.executionPlan,
  schedule: plan.schedule
});

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
          semanticReview: true;
        }
      ) => {
        try {
          const result = await planRepository({
            specificationPath: resolve(cwd, specification),
            repositoryPath: resolve(cwd, options.repository),
            ...(options.sharedResources === undefined
              ? {}
              : { sharedResourcesPath: resolve(cwd, options.sharedResources) }),
            maxAttempts: options.maxAttempts,
            maxConcurrency: options.maxConcurrency,
            semanticReviewAuthorized: options.semanticReview
          });
          writeOutput(`${JSON.stringify(serializePlan(result), null, 2)}\n`);
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

  return program;
};
