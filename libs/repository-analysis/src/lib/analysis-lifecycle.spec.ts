import { describe, expect, it, vi } from 'vitest';

import type { RepositoryGraph } from '@apra-amcos-admin-coding-orchestrator/domain';

import { cleanupAnalysisResources, resolveAnalysisOutcome } from './analysis-lifecycle.js';
import { ProjectGraphError } from './project-graph-error.js';

const graph: RepositoryGraph = {
  repositoryPath: '/fixture',
  projects: new Map(),
  files: new Map(),
  symbols: new Map(),
  projectDependencies: [],
  fileDependencies: [],
  symbolReferences: [],
  diagnostics: []
};

describe('TypeScript analysis lifecycle', () => {
  it('returns a successful result after successful cleanup', () => {
    expect(resolveAnalysisOutcome(graph, graph, undefined, undefined)).toBe(graph);
  });

  it('preserves a structured analysis failure over a cleanup failure', () => {
    const analysisFailure = new ProjectGraphError(
      'INVALID_TYPESCRIPT_CONFIGURATION',
      'Invalid config',
      '/fixture/tsconfig.json'
    );

    expect(() =>
      resolveAnalysisOutcome(graph, undefined, analysisFailure, new Error('cleanup failed'))
    ).toThrow(
      expect.objectContaining({
        code: 'INVALID_TYPESCRIPT_CONFIGURATION',
        message: 'Invalid config'
      })
    );
  });

  it('reports native analysis, cleanup, and missing-result failures distinctly', () => {
    const analysisFailure = new Error('analysis failed');
    expect(() => resolveAnalysisOutcome(graph, undefined, analysisFailure, undefined)).toThrow(
      expect.objectContaining({
        cause: analysisFailure,
        message: expect.stringContaining('failed')
      })
    );

    const cleanupFailure = new Error('cleanup failed');
    expect(() => resolveAnalysisOutcome(graph, graph, undefined, cleanupFailure)).toThrow(
      expect.objectContaining({
        cause: cleanupFailure,
        message: expect.stringContaining('cleanup')
      })
    );

    expect(() => resolveAnalysisOutcome(graph, undefined, undefined, undefined)).toThrow(
      expect.objectContaining({ message: expect.stringContaining('no result') })
    );
  });

  it('attempts both cleanup actions and retains the first cleanup failure', () => {
    const disposeFailure = new Error('dispose failed');
    const closeApi = vi.fn(() => {
      throw new Error('close failed');
    });

    expect(
      cleanupAnalysisResources(() => {
        throw disposeFailure;
      }, closeApi)
    ).toBe(disposeFailure);
    expect(closeApi).toHaveBeenCalledOnce();
  });
});
