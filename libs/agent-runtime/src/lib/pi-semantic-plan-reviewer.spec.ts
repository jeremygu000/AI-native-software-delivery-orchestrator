import type { RepositoryGraph } from '@ai-native-software-delivery-orchestrator/domain';
import type { SemanticPlanReviewRequest } from '@ai-native-software-delivery-orchestrator/planning';
import { describe, expect, it, vi } from 'vitest';

import { PiPlanningGatewayAdapter, type PiPlanningGateway } from './pi-planning-agent.js';
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
  it.each([
    {
      type: 'markdown-spec' as const,
      content: 'Specification without a file.',
      label: 'Markdown specification:'
    },
    {
      type: 'user-request' as const,
      content: 'A directly entered request.',
      label: 'User request:'
    }
  ])('labels $type sources without inventing a file path', async ({ label, ...source }) => {
    const generate = vi.fn(async (_options: Parameters<PiPlanningGateway['generate']>[0]) => ({
      sessionId: 'source-review',
      output: 'unvalidated model output'
    }));
    const output = await new PiSemanticPlanReviewer({ generate }).review({ ...request, source });
    const { prompt } = generate.mock.calls[0][0];
    expect(prompt).toContain(`${label}\n\n${source.content}`);
    expect(prompt).not.toContain('/repo/request.md');
    // The adapter passes output to the semantic validator rather than authorizing it itself.
    expect(output).toBe('unvalidated model output');
  });

  it('sorts task summaries deterministically without mutating the supplied specification', async () => {
    const task = request.specification.tasks[0];
    const tasks = ['z-task', 'a-task', 'm-task'].map((id) => ({
      ...task,
      id,
      description: `Detailed requirements for ${id}`,
      dependencies: id === 'z-task' ? ['a-task', 'm-task'] : [],
      expectedReads: [{ type: 'file' as const, value: 'apps/api/src/auth.ts' }],
      sharedResources: ['auth-contract']
    }));
    const original = structuredClone(tasks);
    const generate = vi.fn(async (_options: Parameters<PiPlanningGateway['generate']>[0]) => ({
      sessionId: 'ordered-review',
      output: '{}'
    }));
    await new PiSemanticPlanReviewer({ generate }).review({
      ...request,
      specification: { tasks }
    });
    const prompt = generate.mock.calls[0][0].prompt;
    const summaries = prompt.split('\n\n').find((part) => part.startsWith('Proposed tasks: '));
    expect(summaries).toBeDefined();
    expect(JSON.parse(summaries?.slice('Proposed tasks: '.length) ?? 'null')).toEqual([
      tasks[1],
      tasks[2],
      tasks[0]
    ]);
    expect(prompt).toContain('Review attempt: 2');
    expect(tasks).toEqual(original);
  });

  it('preserves equal-key summaries for downstream validation instead of silently dropping them', async () => {
    const tasks = [
      { ...request.specification.tasks[0], title: 'First supplied summary' },
      { ...request.specification.tasks[0], title: 'Second supplied summary' }
    ];
    const generate = vi.fn(async (_options: Parameters<PiPlanningGateway['generate']>[0]) => ({
      sessionId: 'equal-key-review',
      output: '{}'
    }));
    await new PiSemanticPlanReviewer({ generate }).review({ ...request, specification: { tasks } });
    expect(generate.mock.calls[0][0].prompt).toContain(`Proposed tasks: ${JSON.stringify(tasks)}`);
  });

  it('uses the default planning adapter without performing live inference in this test', async () => {
    const generate = vi.spyOn(PiPlanningGatewayAdapter.prototype, 'generate').mockResolvedValue({
      sessionId: 'default-review',
      output: '{"recommendation":"accept"}'
    });
    try {
      await expect(new PiSemanticPlanReviewer().review(request)).resolves.toBe(
        '{"recommendation":"accept"}'
      );
      expect(generate).toHaveBeenCalledOnce();
      expect(generate.mock.calls[0][0].cwd).toBe(repository.repositoryPath);
    } finally {
      generate.mockRestore();
    }
  });

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
