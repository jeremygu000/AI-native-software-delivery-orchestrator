import { resolve } from 'node:path';

import type {
  RepositoryGraph,
  WorkspaceGraph,
  WorkspaceGraphProvider
} from '@ai-native-software-delivery-orchestrator/domain';

import { PnpmWorkspaceGraphProvider } from './pnpm-workspace-provider.js';
import { ProjectGraphError } from './project-graph-error.js';
import { analyzeTypeScriptRepository } from './typescript-repository-analyzer.js';

export interface RepositoryGraphAnalysis {
  readonly providerId: string;
  readonly graph: RepositoryGraph;
}

export interface WorkspaceGraphAnalysis {
  readonly providerId: string;
  readonly graph: WorkspaceGraph;
}

export const analyzeWorkspaceGraph = async (
  repositoryPath: string,
  providers: readonly WorkspaceGraphProvider[] = [new PnpmWorkspaceGraphProvider()]
): Promise<WorkspaceGraphAnalysis> => {
  const absoluteRepositoryPath = resolve(repositoryPath);
  const repository = { repositoryPath: absoluteRepositoryPath };

  for (const provider of providers) {
    if (await provider.supports(repository)) {
      return {
        providerId: provider.id,
        graph: await provider.analyze(repository)
      };
    }
  }

  throw new ProjectGraphError(
    'UNSUPPORTED_REPOSITORY',
    `No workspace graph provider supports ${absoluteRepositoryPath}`,
    absoluteRepositoryPath
  );
};

export const analyzeRepository = async (
  repositoryPath: string,
  providers: readonly WorkspaceGraphProvider[] = [new PnpmWorkspaceGraphProvider()]
): Promise<RepositoryGraphAnalysis> => {
  const workspaceAnalysis = await analyzeWorkspaceGraph(repositoryPath, providers);
  const graph: RepositoryGraph = {
    ...workspaceAnalysis.graph,
    files: new Map(),
    symbols: new Map(),
    fileDependencies: [],
    symbolReferences: [],
    diagnostics: []
  };
  return {
    providerId: workspaceAnalysis.providerId,
    graph: await analyzeTypeScriptRepository(graph)
  };
};
