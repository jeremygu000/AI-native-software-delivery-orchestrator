import type { RepositoryGraph } from '@ai-native-software-delivery-orchestrator/domain';
import { createAgentSession, SessionManager, SettingsManager } from '@mariozechner/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';

import { createControlledPiTools } from './pi-gateway.js';
import {
  createIsolatedPlanningResourceLoader,
  createPlanningFactTools,
  PiPlanningAgent,
  PiPlanningGatewayAdapter,
  type PiPlanningGateway,
  type PiPlanningToolCall
} from './pi-planning-agent.js';

const graph: RepositoryGraph = {
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
  files: new Map(
    ['a.ts', 'b.ts', 'c.ts'].map((name) => [
      `project:api:apps/api/src/${name}`,
      {
        id: `project:api:apps/api/src/${name}`,
        projectId: 'project:api',
        path: `apps/api/src/${name}`,
        isGenerated: false
      }
    ])
  ),
  symbols: new Map([
    [
      'symbol:value-a',
      {
        id: 'symbol:value-a',
        fileId: 'project:api:apps/api/src/a.ts',
        name: 'valueA',
        path: 'valueA',
        kind: 'variable',
        exported: true
      }
    ],
    [
      'symbol:nested-special',
      {
        id: 'symbol:nested-special',
        fileId: 'project:api:apps/api/src/b.ts',
        name: 'otherName',
        path: 'Nested.Special',
        kind: 'variable',
        exported: false
      }
    ]
  ]),
  fileDependencies: [
    {
      from: 'project:api:apps/api/src/a.ts',
      to: 'project:api:apps/api/src/b.ts'
    }
  ],
  symbolReferences: [{ from: 'symbol:value-a', to: 'symbol:nested-special' }],
  diagnostics: []
};

const proposalRequest = {
  attempt: 2,
  source: {
    type: 'markdown-spec' as const,
    content: '# Change API\nUpdate the exported value.',
    path: 'request.md'
  },
  repository: graph,
  sharedResourceIds: ['database-schema'],
  previousDiagnostics: [
    {
      code: 'UNRESOLVED_SELECTOR' as const,
      taskId: 'task-a',
      detail: 'Selector file:missing.ts matched 0 repository facts.'
    }
  ]
};

const executePiToolDefinition = <T>(
  tool: {
    execute: (
      id: string,
      params: T,
      signal: AbortSignal | undefined,
      onUpdate: undefined,
      context: never
    ) => unknown;
  },
  id: string,
  params: T
) => tool.execute(id, params, undefined, undefined, undefined!);

describe('PiPlanningAgent', () => {
  it('provides repository facts through bounded read-only tools and returns model output', async () => {
    const calls: PiPlanningToolCall[] = [];
    const gateway: PiPlanningGateway = {
      generate: vi.fn(async ({ prompt, executeTool }) => {
        expect(prompt).toContain('Markdown specification (request.md)');
        expect(prompt).toContain('Known shared-resource IDs: ["database-schema"]');
        expect(prompt).toContain('UNRESOLVED_SELECTOR');
        expect(prompt).toContain('Every task must define at least one package-script verification');
        expect(prompt).toContain('Never emit free-form command verification');
        calls.push({ name: 'forge_projects' });
        expect(JSON.parse((await executeTool(calls.at(-1)!)).content).items).toHaveLength(1);
        calls.push({ name: 'forge_files', projectId: 'project:api', limit: 2 });
        expect(JSON.parse((await executeTool(calls.at(-1)!)).content)).toMatchObject({
          items: [{ path: 'apps/api/src/a.ts' }, { path: 'apps/api/src/b.ts' }],
          nextAfter: 'project:api:apps/api/src/b.ts'
        });
        calls.push({ name: 'forge_files', after: 'project:api:apps/api/src/b.ts' });
        expect(JSON.parse((await executeTool(calls.at(-1)!)).content).items).toEqual([
          expect.objectContaining({ path: 'apps/api/src/c.ts' })
        ]);
        calls.push({ name: 'forge_symbols', query: 'VALUEA' });
        expect(JSON.parse((await executeTool(calls.at(-1)!)).content).items).toEqual([
          expect.objectContaining({ id: 'symbol:value-a' })
        ]);
        calls.push({ name: 'forge_symbols' });
        expect(await executeTool(calls.at(-1)!)).toEqual({
          content: 'forge_symbols requires query or fileId.',
          isError: true
        });
        calls.push({
          name: 'forge_relationships',
          kind: 'file-dependency',
          nodeId: 'project:api:apps/api/src/b.ts',
          direction: 'incoming'
        });
        expect(JSON.parse((await executeTool(calls.at(-1)!)).content).items).toEqual([
          expect.objectContaining({
            from: 'project:api:apps/api/src/a.ts',
            to: 'project:api:apps/api/src/b.ts'
          })
        ]);
        return { sessionId: 'session-1', output: '{"tasks":[]}' };
      })
    };

    await expect(new PiPlanningAgent(gateway).propose(proposalRequest)).resolves.toBe(
      '{"tasks":[]}'
    );
    expect(calls.map((call) => call.name)).toEqual([
      'forge_projects',
      'forge_files',
      'forge_files',
      'forge_symbols',
      'forge_symbols',
      'forge_relationships'
    ]);
  });

  it('supports user-request prompts, default pagination, and symbol lookup by file', async () => {
    const gateway: PiPlanningGateway = {
      generate: async ({ prompt, executeTool }) => {
        expect(prompt).toContain('User request:');
        expect(prompt).not.toContain('Markdown specification');
        const files = JSON.parse((await executeTool({ name: 'forge_files' })).content);
        expect(files.items).toHaveLength(3);
        expect(files).not.toHaveProperty('nextAfter');
        const symbols = JSON.parse(
          (
            await executeTool({
              name: 'forge_symbols',
              fileId: 'project:api:apps/api/src/a.ts'
            })
          ).content
        );
        expect(symbols.items).toEqual([expect.objectContaining({ name: 'valueA' })]);
        const symbolByPath = JSON.parse(
          (await executeTool({ name: 'forge_symbols', query: 'special' })).content
        );
        expect(symbolByPath.items).toEqual([
          expect.objectContaining({ id: 'symbol:nested-special' })
        ]);
        const symbolById = JSON.parse(
          (await executeTool({ name: 'forge_symbols', query: 'symbol:nested-special' })).content
        );
        expect(symbolById.items).toHaveLength(1);
        const noFiles = JSON.parse(
          (
            await executeTool({
              name: 'forge_files',
              projectId: 'missing-project',
              prefix: 'missing/'
            })
          ).content
        );
        expect(noFiles.items).toEqual([]);
        const noFilesByPrefix = JSON.parse(
          (
            await executeTool({
              name: 'forge_files',
              projectId: 'project:api',
              prefix: 'missing/'
            })
          ).content
        );
        expect(noFilesByPrefix.items).toEqual([]);
        return { sessionId: 'session-2', output: '{}' };
      }
    };

    await new PiPlanningAgent(gateway).propose({
      ...proposalRequest,
      source: { type: 'user-request', content: 'Change the API.' },
      repository: { ...graph, files: new Map([...graph.files].toReversed()) },
      previousDiagnostics: []
    });
  });

  it('formats a Markdown source without an optional path', async () => {
    const gateway: PiPlanningGateway = {
      generate: async ({ prompt }) => {
        expect(prompt).toContain('Markdown specification:');
        expect(prompt).not.toContain('Markdown specification (');
        return { sessionId: 'session-3', output: '{}' };
      }
    };

    await new PiPlanningAgent(gateway).propose({
      ...proposalRequest,
      source: { type: 'markdown-spec', content: '# Change API' }
    });
  });

  it('keeps fact ordering stable when a caller supplies duplicate node IDs', async () => {
    const project = graph.projects.get('project:api')!;
    const duplicateIdGraph: RepositoryGraph = {
      ...graph,
      projects: new Map([
        ['first-key', project],
        ['second-key', { ...project, name: 'api-alias' }]
      ])
    };
    const gateway: PiPlanningGateway = {
      generate: async ({ executeTool }) => {
        const projects = JSON.parse((await executeTool({ name: 'forge_projects' })).content);
        expect(projects.items).toHaveLength(2);
        return { sessionId: 'session-4', output: '{}' };
      }
    };

    await new PiPlanningAgent(gateway).propose({
      ...proposalRequest,
      repository: duplicateIdGraph
    });
  });

  it('enforces pagination limits even when a caller bypasses the tool schema', async () => {
    const project = graph.projects.get('project:api')!;
    const largeGraph: RepositoryGraph = {
      ...graph,
      projects: new Map(
        Array.from({ length: 250 }, (_, index) => {
          const id = `project:${String(index).padStart(3, '0')}`;
          return [id, { ...project, id, name: id }] as const;
        })
      ),
      files: new Map(
        Array.from({ length: 600 }, (_, index) => {
          const path = `apps/api/src/${String(index).padStart(3, '0')}.ts`;
          const id = `project:api:${path}`;
          return [id, { ...graph.files.values().next().value!, id, path }] as const;
        })
      ),
      symbols: new Map(
        Array.from({ length: 250 }, (_, index) => {
          const id = `symbol:${String(index).padStart(3, '0')}`;
          return [id, { ...graph.symbols.values().next().value!, id, name: id }] as const;
        })
      )
    };
    const gateway: PiPlanningGateway = {
      generate: async ({ executeTool }) => {
        const projects = JSON.parse(
          (await executeTool({ name: 'forge_projects', limit: 10_000 })).content
        );
        const files = JSON.parse(
          (await executeTool({ name: 'forge_files', limit: 10_000 })).content
        );
        const symbols = JSON.parse(
          (await executeTool({ name: 'forge_symbols', query: 'symbol:', limit: 10_000 })).content
        );
        const zeroLimit = JSON.parse(
          (await executeTool({ name: 'forge_projects', limit: 0 })).content
        );
        const negativeLimit = JSON.parse(
          (await executeTool({ name: 'forge_files', limit: -10 })).content
        );
        const fractionalLimit = JSON.parse(
          (await executeTool({ name: 'forge_symbols', query: 'symbol:', limit: 2.9 })).content
        );
        const nonFiniteLimit = JSON.parse(
          (await executeTool({ name: 'forge_projects', limit: Number.NaN })).content
        );
        const nonNumericLimit = JSON.parse(
          (
            await executeTool({
              name: 'forge_files',
              limit: 'not-a-number'
            })
          ).content
        );
        expect(projects.items).toHaveLength(200);
        expect(projects.nextAfter).toBeDefined();
        expect(files.items).toHaveLength(500);
        expect(files.nextAfter).toBeDefined();
        expect(symbols.items).toHaveLength(200);
        expect(symbols.nextAfter).toBeDefined();
        expect(zeroLimit.items).toHaveLength(1);
        expect(negativeLimit.items).toHaveLength(1);
        expect(fractionalLimit.items).toHaveLength(2);
        expect(nonFiniteLimit.items).toHaveLength(100);
        expect(nonNumericLimit.items).toHaveLength(200);
        return { sessionId: 'session-5', output: '{}' };
      }
    };

    await new PiPlanningAgent(gateway).propose({ ...proposalRequest, repository: largeGraph });
  });

  it('filters and caps repository relationships with stable edge identities', async () => {
    const fileDependencies = Array.from({ length: 520 }, (_, index) => ({
      from: `file:${String(index).padStart(3, '0')}`,
      to: 'file:consumer'
    }));
    const relationshipGraph: RepositoryGraph = {
      ...graph,
      projectDependencies: [
        {
          from: 'project:api',
          to: 'project:domain',
          sources: ['typescript-import']
        }
      ],
      fileDependencies,
      symbolReferences: [{ from: 'symbol:value-a', to: 'symbol:nested-special' }]
    };
    const gateway: PiPlanningGateway = {
      generate: async ({ executeTool }) => {
        const incoming = JSON.parse(
          (
            await executeTool({
              name: 'forge_relationships',
              kind: 'file-dependency',
              nodeId: 'file:consumer',
              direction: 'incoming',
              limit: 10_000
            })
          ).content
        );
        expect(incoming.items).toHaveLength(500);
        expect(incoming.nextAfter).toBe('file:499\u0000file:consumer');

        const outgoing = JSON.parse(
          (
            await executeTool({
              name: 'forge_relationships',
              kind: 'symbol-reference',
              nodeId: 'symbol:value-a',
              direction: 'outgoing'
            })
          ).content
        );
        expect(outgoing.items).toEqual([
          {
            id: 'symbol:value-a\u0000symbol:nested-special',
            from: 'symbol:value-a',
            to: 'symbol:nested-special'
          }
        ]);

        const projects = JSON.parse(
          (
            await executeTool({
              name: 'forge_relationships',
              kind: 'project-dependency'
            })
          ).content
        );
        expect(projects.items[0]).toMatchObject({ sources: ['typescript-import'] });
        return { sessionId: 'session-relationships', output: '{"tasks":[]}' };
      }
    };

    await new PiPlanningAgent(gateway).propose({
      ...proposalRequest,
      repository: relationshipGraph
    });
  });
});

describe('PiPlanningGatewayAdapter', () => {
  it('registers controlled coding and planning tools through the real Pi SDK', async () => {
    const resourceLoader = await createIsolatedPlanningResourceLoader();
    const controlledTools = createControlledPiTools(async () => ({ content: 'ok' }));
    const planningTools = createPlanningFactTools(async () => ({ content: 'ok' }));
    const { session } = await createAgentSession({
      cwd: '/repo',
      noTools: 'builtin',
      tools: [
        'forge_read',
        'forge_list',
        'forge_find',
        'forge_edit',
        'forge_write',
        'forge_command',
        'forge_projects',
        'forge_files',
        'forge_symbols',
        'forge_relationships'
      ],
      customTools: [...controlledTools, ...planningTools],
      resourceLoader,
      sessionManager: SessionManager.inMemory('/repo'),
      settingsManager: SettingsManager.inMemory()
    });

    try {
      const activeToolNames = [
        'forge_read',
        'forge_list',
        'forge_find',
        'forge_edit',
        'forge_write',
        'forge_command',
        'forge_projects',
        'forge_files',
        'forge_symbols',
        'forge_relationships'
      ];
      session.setActiveToolsByName(activeToolNames);

      expect(session.state.tools.map((tool) => tool.name)).toEqual(activeToolNames);
      expect(session.state.tools.map((tool) => tool.name)).not.toContain('bash');
    } finally {
      session.dispose();
    }
  });

  it('builds an isolated resource loader without project or extension discovery', async () => {
    const loader = await createIsolatedPlanningResourceLoader();

    expect(loader.getAgentsFiles()).toEqual({ agentsFiles: [] });
    expect(loader.getExtensions().extensions).toEqual([]);
    expect(loader.getSkills()).toEqual({ skills: [], diagnostics: [] });
    expect(loader.getPrompts()).toEqual({ prompts: [], diagnostics: [] });
    expect(loader.getThemes()).toEqual({ themes: [], diagnostics: [] });
    expect(loader.getSystemPrompt()).toBe(
      'You are a repository-aware planning component. Follow the supplied role and use only read-only repository facts.'
    );
    await expect(createIsolatedPlanningResourceLoader()).resolves.toBeInstanceOf(
      loader.constructor
    );
  });

  it('starts with no built-in tools and extracts the final assistant text', async () => {
    const setActiveToolsByName = vi.fn();
    const prompt = vi.fn(async () => undefined);
    const dispose = vi.fn();
    const createSession = vi.fn(async () => ({
      session: {
        sessionId: 'session-1',
        setActiveToolsByName,
        prompt,
        dispose,
        assistantMessages: () => [
          {
            role: 'assistant' as const,
            content: [{ type: 'thinking' }, { type: 'text' as const, text: '{"tasks":[]}' }],
            stopReason: 'stop'
          }
        ]
      }
    }));

    const result = await new PiPlanningGatewayAdapter(createSession).generate({
      cwd: '/repo',
      prompt: 'plan this',
      executeTool: async () => ({ content: '[]' })
    });

    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/repo',
        noTools: 'builtin',
        tools: ['forge_projects', 'forge_files', 'forge_symbols', 'forge_relationships'],
        customTools: expect.any(Array)
      })
    );
    expect(setActiveToolsByName).toHaveBeenCalledWith([
      'forge_projects',
      'forge_files',
      'forge_symbols',
      'forge_relationships'
    ]);
    expect(prompt).toHaveBeenCalledWith('plan this');
    expect(dispose).toHaveBeenCalledOnce();
    expect(result).toEqual({ sessionId: 'session-1', output: '{"tasks":[]}' });
  });

  it('fails when Pi reports an aborted response', async () => {
    const dispose = vi.fn();
    const gateway = new PiPlanningGatewayAdapter(async () => ({
      session: {
        sessionId: 'session-1',
        setActiveToolsByName: () => undefined,
        prompt: async () => undefined,
        dispose,
        assistantMessages: () => [
          {
            role: 'assistant',
            content: [],
            stopReason: 'aborted',
            errorMessage: 'cancelled'
          }
        ]
      }
    }));

    await expect(
      gateway.generate({ cwd: '/repo', prompt: 'plan', executeTool: async () => ({ content: '' }) })
    ).rejects.toThrow('cancelled');
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('disposes the planning session when prompting fails', async () => {
    const failure = new Error('provider unavailable');
    const dispose = vi.fn();
    const gateway = new PiPlanningGatewayAdapter(async () => ({
      session: {
        sessionId: 'session-1',
        setActiveToolsByName: () => undefined,
        prompt: async () => Promise.reject(failure),
        dispose,
        assistantMessages: () => []
      }
    }));

    await expect(
      gateway.generate({ cwd: '/repo', prompt: 'plan', executeTool: async () => ({ content: '' }) })
    ).rejects.toBe(failure);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('preserves the primary planning failure when session disposal also fails', async () => {
    const providerFailure = new Error('provider unavailable');
    const disposalFailure = new Error('dispose failed');
    const gateway = new PiPlanningGatewayAdapter(async () => ({
      session: {
        sessionId: 'session-1',
        setActiveToolsByName: () => undefined,
        prompt: async () => Promise.reject(providerFailure),
        dispose: () => {
          throw disposalFailure;
        },
        assistantMessages: () => []
      }
    }));

    await expect(
      gateway.generate({ cwd: '/repo', prompt: 'plan', executeTool: async () => ({ content: '' }) })
    ).rejects.toBe(providerFailure);
  });

  it('surfaces session disposal failure after otherwise successful planning', async () => {
    const disposalFailure = new Error('dispose failed');
    const gateway = new PiPlanningGatewayAdapter(async () => ({
      session: {
        sessionId: 'session-1',
        setActiveToolsByName: () => undefined,
        prompt: async () => undefined,
        dispose: () => {
          throw disposalFailure;
        },
        assistantMessages: () => [
          {
            role: 'assistant',
            content: [{ type: 'text', text: '{"tasks":[]}' }],
            stopReason: 'stop'
          }
        ]
      }
    }));

    await expect(
      gateway.generate({ cwd: '/repo', prompt: 'plan', executeTool: async () => ({ content: '' }) })
    ).rejects.toBe(disposalFailure);
  });

  it('fails when Pi produces no assistant response', async () => {
    const gateway = new PiPlanningGatewayAdapter(async () => ({
      session: {
        sessionId: 'session-1',
        setActiveToolsByName: () => undefined,
        prompt: async () => undefined,
        dispose: () => undefined,
        assistantMessages: () => []
      }
    }));

    await expect(
      gateway.generate({ cwd: '/repo', prompt: 'plan', executeTool: async () => ({ content: '' }) })
    ).rejects.toThrow('Pi planner returned no assistant response');
  });

  it('fails when Pi produces no text and reports stop errors without provider detail', async () => {
    const dispose = vi.fn();
    const messages = [
      {
        role: 'assistant' as const,
        content: [{ type: 'thinking' }],
        stopReason: 'stop'
      },
      {
        role: 'assistant' as const,
        content: [],
        stopReason: 'error'
      }
    ];
    const gateway = new PiPlanningGatewayAdapter(async () => ({
      session: {
        sessionId: 'session-1',
        setActiveToolsByName: () => undefined,
        prompt: async () => undefined,
        dispose,
        assistantMessages: () => [messages.shift()!]
      }
    }));
    const request = { cwd: '/repo', prompt: 'plan', executeTool: async () => ({ content: '' }) };

    await expect(gateway.generate(request)).rejects.toThrow('Pi planner returned no text response');
    await expect(gateway.generate(request)).rejects.toThrow('Pi planner stopped with error');
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it('maps every registered repository-fact tool call without adding mutation tools', async () => {
    const executeTool = vi.fn(async (_call: PiPlanningToolCall) => ({ content: 'ok' }));
    const tools = createPlanningFactTools(executeTool);

    expect(tools.map((tool) => tool.name)).toEqual([
      'forge_projects',
      'forge_files',
      'forge_symbols',
      'forge_relationships'
    ]);
    await executePiToolDefinition(tools[0], 'call-1', {});
    await executePiToolDefinition(tools[1], 'call-2', {
      projectId: 'project:api',
      prefix: 'apps/api',
      after: 'a',
      limit: 10
    });
    await executePiToolDefinition(tools[2], 'call-3', {
      query: 'value',
      fileId: 'file-a',
      after: 'a',
      limit: 10
    });
    await executePiToolDefinition(tools[3], 'call-4', {
      kind: 'symbol-reference',
      nodeId: 'symbol-a',
      direction: 'outgoing',
      after: 'a',
      limit: 10
    });

    expect(executeTool.mock.calls.map(([call]) => call)).toEqual([
      { name: 'forge_projects' },
      {
        name: 'forge_files',
        projectId: 'project:api',
        prefix: 'apps/api',
        after: 'a',
        limit: 10
      },
      {
        name: 'forge_symbols',
        query: 'value',
        fileId: 'file-a',
        after: 'a',
        limit: 10
      },
      {
        name: 'forge_relationships',
        kind: 'symbol-reference',
        nodeId: 'symbol-a',
        direction: 'outgoing',
        after: 'a',
        limit: 10
      }
    ]);
  });

  it('preserves repository-fact tool errors for Pi', async () => {
    const [projects] = createPlanningFactTools(async () => ({
      content: 'facts unavailable',
      isError: true
    }));

    await expect(executePiToolDefinition(projects, 'call-1', {})).resolves.toEqual({
      content: [{ type: 'text', text: 'facts unavailable' }],
      details: {},
      isError: true
    });
  });
});
