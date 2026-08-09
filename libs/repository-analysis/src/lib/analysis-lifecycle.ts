import type { RepositoryGraph } from '@ai-native-software-delivery-orchestrator/domain';

import { ProjectGraphError } from './project-graph-error.js';

export const cleanupAnalysisResources = (
  disposeSnapshot: () => void,
  closeApi: () => void
): unknown => {
  let cleanupFailure: unknown;
  try {
    disposeSnapshot();
  } catch (error) {
    cleanupFailure = error;
  }
  try {
    closeApi();
  } catch (error) {
    cleanupFailure ??= error;
  }
  return cleanupFailure;
};

export const resolveAnalysisOutcome = (
  graph: RepositoryGraph,
  result: RepositoryGraph | undefined,
  analysisFailure: unknown,
  cleanupFailure: unknown
): RepositoryGraph => {
  if (analysisFailure instanceof ProjectGraphError) {
    throw analysisFailure;
  }
  if (analysisFailure !== undefined) {
    throw new ProjectGraphError(
      'TYPESCRIPT_ANALYSIS_FAILED',
      `TypeScript analysis failed for ${graph.repositoryPath}`,
      graph.repositoryPath,
      { cause: analysisFailure }
    );
  }
  if (cleanupFailure !== undefined) {
    throw new ProjectGraphError(
      'TYPESCRIPT_ANALYSIS_FAILED',
      `TypeScript analysis cleanup failed for ${graph.repositoryPath}`,
      graph.repositoryPath,
      { cause: cleanupFailure }
    );
  }
  if (result === undefined) {
    throw new ProjectGraphError(
      'TYPESCRIPT_ANALYSIS_FAILED',
      `TypeScript analysis produced no result for ${graph.repositoryPath}`,
      graph.repositoryPath
    );
  }
  return result;
};
