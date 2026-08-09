import { resolve } from 'node:path';

import type {
  ProjectGraphProvider,
  RepositoryGraph
} from '@apra-amcos-admin-coding-orchestrator/domain';

import { PnpmWorkspaceProvider } from './pnpm-workspace-provider.js';
import { ProjectGraphError } from './project-graph-error.js';
import { analyzeTypeScriptRepository } from './typescript-repository-analyzer.js';

export interface ProjectGraphAnalysis {
  readonly providerId: string;
  readonly graph: RepositoryGraph;
}

export const analyzeProjectGraph = async (
  repositoryPath: string,
  providers: readonly ProjectGraphProvider[] = [new PnpmWorkspaceProvider()]
): Promise<ProjectGraphAnalysis> => {
  const absoluteRepositoryPath = resolve(repositoryPath);

  for (const provider of providers) {
    if (await provider.supports(absoluteRepositoryPath)) {
      return {
        providerId: provider.id,
        graph: await provider.analyze({ repositoryPath: absoluteRepositoryPath })
      };
    }
  }

  throw new ProjectGraphError(
    'UNSUPPORTED_REPOSITORY',
    `No project graph provider supports ${absoluteRepositoryPath}`,
    absoluteRepositoryPath
  );
};

export const analyzeRepository = async (
  repositoryPath: string,
  providers: readonly ProjectGraphProvider[] = [new PnpmWorkspaceProvider()]
): Promise<ProjectGraphAnalysis> => {
  const projectAnalysis = await analyzeProjectGraph(repositoryPath, providers);
  return {
    providerId: projectAnalysis.providerId,
    graph: await analyzeTypeScriptRepository(projectAnalysis.graph)
  };
};
