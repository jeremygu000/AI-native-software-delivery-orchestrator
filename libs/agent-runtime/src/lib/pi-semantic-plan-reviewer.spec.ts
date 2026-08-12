import type { RepositoryGraph } from '@ai-native-software-delivery-orchestrator/domain';
import type { SemanticPlanReviewRequest } from '@ai-native-software-delivery-orchestrator/planning';
import { describe, expect, it, vi } from 'vitest';

import type { PiPlanningGateway } from './pi-planning-agent.js';
import { PiSemanticPlanReviewer } from './pi-semantic-plan-reviewer.js';

const repository: RepositoryGraph = {
  repositoryPath: '/repo',
  projects: new Map([
    [
      'project:api',
      {
        id: 'project:api',
        name: 'api',
        root: 'apps/api',
        packageJsonPath: 'apps/api/package.json',
        dependencies: [],
        scripts: { test: 'vitest run' },
        sourceRoots: ['apps/api/src'],
        tsconfigPaths: ['apps/api/tsconfig.json']
      }
    ]
  ]),
  projectDependencies: [],
  files: new Map([
    [
      'project:api:apps/api/src/auth.ts',
      {
        id: 'project:api:apps/api/src/auth.ts',
        projectId: 'project:api',
        path: 'apps/api/src/auth.ts',
        isGenerated: false
      }
    ]
  ]),
  symbols: new Map(),
  fileDependencies: [],
  symbolReferences: [],
  diagnostics: []
};

const request: SemanticPlanReviewRequest = {
  attempt: 2,
  source: {
    type: 'markdown-spec',
    content: 'Add login and logout.',
    path: '/repo/request.md'
  },
  repository,
  specification: {
    tasks: [
      {
        id: 'auth-login',
        title: 'Add login',
        goal: 'Implement login',
        dependencies: [],
        expectedReads: [],
        expectedWrites: [{ type: 'file', value: 'apps/api/src/auth.ts' }],
        sharedResources: [],
        verification: [{ type: 'package-script', packageName: 'api', script: 'test' }]
      }
    ]
  }
};

describe('PiSemanticPlanReviewer', () => {
  it('requests an advisory structured review with only repository-fact tool execution', async () => {
    const generate = vi.fn(async (_options: Parameters<PiPlanningGateway['generate']>[0]) => ({
      sessionId: 'review-session',
      output: '{"recommendation":"revise"}'
    }));
    const gateway: PiPlanningGateway = { generate };

    await expect(new PiSemanticPlanReviewer(gateway).review(request)).resolves.toBe(
      '{"recommendation":"revise"}'
    );

    const options = generate.mock.calls[0][0];
    expect(options.cwd).toBe('/repo');
    expect(options.prompt).toContain('Do not authorize execution');
    expect(options.prompt).toContain('Add login and logout.');
    expect(options.prompt).toContain('"id":"auth-login"');
    await expect(options.executeTool({ name: 'forge_projects', limit: 1 })).resolves.toMatchObject({
      content: expect.stringContaining('project:api')
    });
  });

  it('propagates gateway failures unchanged', async () => {
    const failure = new Error('review model unavailable');
    const gateway: PiPlanningGateway = {
      generate: async () => Promise.reject(failure)
    };

    await expect(new PiSemanticPlanReviewer(gateway).review(request)).rejects.toBe(failure);
  });
});
