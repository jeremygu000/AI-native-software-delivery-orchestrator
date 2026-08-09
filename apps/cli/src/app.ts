import { resolve } from 'node:path';

import type {
  FileNode,
  RepositoryDiagnostic,
  RepositoryGraph,
  SymbolNode
} from '@ai-native-software-delivery-orchestrator/domain';
import {
  analyzeRepository,
  ProjectGraphError,
  type RepositoryGraphAnalysis
} from '@ai-native-software-delivery-orchestrator/repository-analysis';
import { Command } from 'commander';

export interface ForgeProgramDependencies {
  readonly cwd?: string;
  readonly analyzeRepository?: (repositoryPath: string) => Promise<RepositoryGraphAnalysis>;
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
    .description('Validate a task specification and build an execution plan')
    .argument('<specification>', 'path to a YAML task specification')
    .action((specification: string) => {
      program.error(`Planning is not available yet for ${specification}.`);
    });

  return program;
};
