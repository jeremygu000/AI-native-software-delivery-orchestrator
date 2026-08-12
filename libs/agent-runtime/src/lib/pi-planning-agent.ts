import type {
  PlannerAgent,
  PlannerProposalRequest
} from '@ai-native-software-delivery-orchestrator/planning';
import {
  createExtensionRuntime,
  createAgentSession,
  defineTool,
  type ResourceLoader
} from '@mariozechner/pi-coding-agent';
import { Type } from 'typebox';

type PiSdkSessionOptions = Parameters<typeof createAgentSession>[0];

interface PiPlanningAssistantMessage {
  readonly role: 'assistant';
  readonly content: readonly (
    | { readonly type: 'text'; readonly text: string }
    | { readonly type: string }
  )[];
  readonly stopReason: string;
  readonly errorMessage?: string;
}

interface PiPlanningSessionFacade {
  readonly sessionId: string;
  setActiveToolsByName(toolNames: string[]): void;
  prompt(prompt: string): Promise<void>;
  assistantMessages(): readonly PiPlanningAssistantMessage[];
  dispose(): void;
}

export type PiPlanningSessionFactory = (
  options: PiSdkSessionOptions
) => Promise<{ readonly session: PiPlanningSessionFacade }>;

export type PiPlanningToolCall =
  | {
      readonly name: 'forge_projects';
      readonly after?: string;
      readonly limit?: unknown;
    }
  | {
      readonly name: 'forge_files';
      readonly projectId?: string;
      readonly prefix?: string;
      readonly after?: string;
      readonly limit?: unknown;
    }
  | {
      readonly name: 'forge_symbols';
      readonly query?: string;
      readonly fileId?: string;
      readonly after?: string;
      readonly limit?: unknown;
    }
  | {
      readonly name: 'forge_relationships';
      readonly kind: 'project-dependency' | 'file-dependency' | 'symbol-reference';
      readonly nodeId?: string;
      readonly direction?: 'incoming' | 'outgoing' | 'either';
      readonly after?: string;
      readonly limit?: unknown;
    };

export interface PiPlanningToolResult {
  readonly content: string;
  readonly isError?: boolean;
}

export interface PiPlanningGateway {
  generate(options: {
    readonly cwd: string;
    readonly prompt: string;
    readonly executeTool: (call: PiPlanningToolCall) => Promise<PiPlanningToolResult>;
  }): Promise<{ readonly sessionId: string; readonly output: string }>;
}

export const createIsolatedPlanningResourceLoader = async (): Promise<ResourceLoader> =>
  new IsolatedPlanningResourceLoader();

class IsolatedPlanningResourceLoader implements ResourceLoader {
  readonly #extensions = {
    extensions: [],
    errors: [],
    runtime: createExtensionRuntime()
  };

  getExtensions() {
    return this.#extensions;
  }

  getSkills() {
    return { skills: [], diagnostics: [] };
  }

  getPrompts() {
    return { prompts: [], diagnostics: [] };
  }

  getThemes() {
    return { themes: [], diagnostics: [] };
  }

  getAgentsFiles() {
    return { agentsFiles: [] };
  }

  getSystemPrompt(): string {
    return 'You are a repository-aware planning component. Follow the supplied role and use only read-only repository facts.';
  }

  getAppendSystemPrompt(): string[] {
    return [];
  }

  extendResources(_paths: Parameters<ResourceLoader['extendResources']>[0]): void {}

  async reload(): Promise<void> {}
}

const asToolResult = async (
  call: PiPlanningToolCall,
  executeTool: (call: PiPlanningToolCall) => Promise<PiPlanningToolResult>
) => {
  const result = await executeTool(call);
  return {
    content: [{ type: 'text' as const, text: result.content }],
    details: {},
    ...(result.isError === true ? { isError: true } : {})
  };
};

export const createPlanningFactTools = (
  executeTool: (call: PiPlanningToolCall) => Promise<PiPlanningToolResult>
) => [
  defineTool({
    name: 'forge_projects',
    label: 'Forge projects',
    description: 'List exact project identities from the analyzed repository facts.',
    parameters: Type.Object({
      after: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 }))
    }),
    execute: async (_id, params) => asToolResult({ name: 'forge_projects', ...params }, executeTool)
  }),
  defineTool({
    name: 'forge_files',
    label: 'Forge files',
    description: 'List exact file identities from repository facts with stable pagination.',
    parameters: Type.Object({
      projectId: Type.Optional(Type.String()),
      prefix: Type.Optional(Type.String()),
      after: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 }))
    }),
    execute: async (_id, params) => asToolResult({ name: 'forge_files', ...params }, executeTool)
  }),
  defineTool({
    name: 'forge_symbols',
    label: 'Forge symbols',
    description: 'Find exact symbol identities by query or file with stable pagination.',
    parameters: Type.Object({
      query: Type.Optional(Type.String()),
      fileId: Type.Optional(Type.String()),
      after: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 }))
    }),
    execute: async (_id, params) => asToolResult({ name: 'forge_symbols', ...params }, executeTool)
  }),
  defineTool({
    name: 'forge_relationships',
    label: 'Forge relationships',
    description:
      'List project dependencies, file dependencies, or symbol references from repository facts.',
    parameters: Type.Object({
      kind: Type.Union([
        Type.Literal('project-dependency'),
        Type.Literal('file-dependency'),
        Type.Literal('symbol-reference')
      ]),
      nodeId: Type.Optional(Type.String()),
      direction: Type.Optional(
        Type.Union([Type.Literal('incoming'), Type.Literal('outgoing'), Type.Literal('either')])
      ),
      after: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 }))
    }),
    execute: async (_id, params) =>
      asToolResult({ name: 'forge_relationships', ...params }, executeTool)
  })
];

export class PiPlanningGatewayAdapter implements PiPlanningGateway {
  readonly #createSession: PiPlanningSessionFactory;

  constructor(
    createSession: PiPlanningSessionFactory = async (options) => {
      const resourceLoader = await createIsolatedPlanningResourceLoader();
      const { session } = await createAgentSession({ ...options, resourceLoader });
      return {
        session: {
          sessionId: session.sessionId,
          setActiveToolsByName: (toolNames) => session.setActiveToolsByName(toolNames),
          prompt: (prompt) => session.prompt(prompt),
          dispose: () => session.dispose(),
          assistantMessages: () =>
            session.state.messages.flatMap((message) =>
              message.role === 'assistant'
                ? [
                    {
                      role: 'assistant' as const,
                      content: message.content,
                      stopReason: message.stopReason,
                      ...(message.errorMessage === undefined
                        ? {}
                        : { errorMessage: message.errorMessage })
                    }
                  ]
                : []
            )
        }
      };
    }
  ) {
    this.#createSession = createSession;
  }

  async generate(options: {
    readonly cwd: string;
    readonly prompt: string;
    readonly executeTool: (call: PiPlanningToolCall) => Promise<PiPlanningToolResult>;
  }): Promise<{ readonly sessionId: string; readonly output: string }> {
    const toolNames = ['forge_projects', 'forge_files', 'forge_symbols', 'forge_relationships'];
    const { session } = await this.#createSession({
      cwd: options.cwd,
      noTools: 'builtin',
      tools: toolNames,
      customTools: createPlanningFactTools(options.executeTool)
    });
    let generated: { readonly sessionId: string; readonly output: string } | undefined;
    let operationFailure: unknown;
    let operationFailed = false;
    try {
      session.setActiveToolsByName(toolNames);
      await session.prompt(options.prompt);
      const message = session.assistantMessages().at(-1);
      if (message === undefined) {
        throw new Error('Pi planner returned no assistant response');
      }
      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        throw new Error(message.errorMessage ?? `Pi planner stopped with ${message.stopReason}`);
      }
      const output = message.content
        .flatMap((content) => (content.type === 'text' && 'text' in content ? [content.text] : []))
        .join('\n')
        .trim();
      if (output.length === 0) {
        throw new Error('Pi planner returned no text response');
      }
      generated = { sessionId: session.sessionId, output };
    } catch (error) {
      operationFailed = true;
      operationFailure = error;
    }
    try {
      session.dispose();
    } catch (disposalFailure) {
      if (!operationFailed) {
        operationFailed = true;
        operationFailure = disposalFailure;
      }
    }
    if (operationFailed) {
      throw operationFailure instanceof Error
        ? operationFailure
        : new Error('Pi planning session failed with a non-error value', {
            cause: operationFailure
          });
    }
    if (generated === undefined) {
      throw new Error('Pi planning session completed without a result');
    }
    return generated;
  }
}

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const paginate = <T extends { readonly id: string }>(
  values: readonly T[],
  after: string | undefined,
  requestedLimit: unknown,
  defaultLimit: number,
  maximumLimit: number
): { readonly items: readonly T[]; readonly nextAfter?: string } => {
  const finiteLimit =
    typeof requestedLimit !== 'number' || !Number.isFinite(requestedLimit)
      ? defaultLimit
      : Math.floor(requestedLimit);
  const limit = Math.min(maximumLimit, Math.max(1, finiteLimit));
  const sorted = [...values].toSorted((left, right) => compareStrings(left.id, right.id));
  const filtered = after === undefined ? sorted : sorted.filter((value) => value.id > after);
  const items = filtered.slice(0, limit);
  const hasMore = filtered.length > items.length;
  return {
    items,
    ...(hasMore && items.length > 0 ? { nextAfter: items.at(-1)!.id } : {})
  };
};

export const createPlanningFactToolExecutor =
  (
    graph: PlannerProposalRequest['repository']
  ): ((call: PiPlanningToolCall) => Promise<PiPlanningToolResult>) =>
  async (call) => {
    if (call.name === 'forge_projects') {
      return {
        content: JSON.stringify(
          paginate([...graph.projects.values()], call.after, call.limit, 100, 200)
        )
      };
    }
    if (call.name === 'forge_files') {
      const files = [...graph.files.values()].filter(
        (file) =>
          (call.projectId === undefined || file.projectId === call.projectId) &&
          (call.prefix === undefined || file.path.startsWith(call.prefix))
      );
      return { content: JSON.stringify(paginate(files, call.after, call.limit, 200, 500)) };
    }
    if (call.name === 'forge_relationships') {
      const direction = call.direction ?? 'either';
      const edges = (
        call.kind === 'project-dependency'
          ? graph.projectDependencies.map((edge) => ({ ...edge }))
          : call.kind === 'file-dependency'
            ? graph.fileDependencies.map((edge) => ({ ...edge }))
            : graph.symbolReferences.map((edge) => ({ ...edge }))
      )
        .filter(
          (edge) =>
            call.nodeId === undefined ||
            (direction !== 'incoming' && edge.from === call.nodeId) ||
            (direction !== 'outgoing' && edge.to === call.nodeId)
        )
        .map((edge) => ({ ...edge, id: `${edge.from}\u0000${edge.to}` }));
      return {
        content: JSON.stringify(paginate(edges, call.after, call.limit, 200, 500))
      };
    }
    if (call.query === undefined && call.fileId === undefined) {
      return {
        content: 'forge_symbols requires query or fileId.',
        isError: true
      };
    }
    const query = call.query?.toLowerCase();
    const symbols = [...graph.symbols.values()].filter(
      (symbol) =>
        (call.fileId === undefined || symbol.fileId === call.fileId) &&
        (query === undefined ||
          symbol.id.toLowerCase().includes(query) ||
          symbol.name.toLowerCase().includes(query) ||
          symbol.path.toLowerCase().includes(query))
    );
    return { content: JSON.stringify(paginate(symbols, call.after, call.limit, 100, 200)) };
  };

const buildPrompt = (request: PlannerProposalRequest): string => {
  const sourceLabel =
    request.source.type === 'markdown-spec'
      ? `Markdown specification${request.source.path === undefined ? '' : ` (${request.source.path})`}`
      : 'User request';
  const projectSummary = [...request.repository.projects.values()]
    .toSorted((left, right) => compareStrings(left.id, right.id))
    .map((project) => ({ id: project.id, name: project.name, root: project.root }));
  return [
    'You are the planning agent for a repository-aware coding orchestrator.',
    'Return exactly one JSON object and no prose or Markdown fence.',
    'The object must have this shape:',
    '{"tasks":[{"id":"stable-id","title":"...","goal":"...","description":"optional","dependencies":[],"expectedReads":[{"type":"project|file|glob|symbol|shared-resource","value":"exact selector"}],"expectedWrites":[],"sharedResources":[],"verification":[{"type":"package-script","packageName":"...","script":"..."}],"priority":0}]}',
    'Use forge_projects, forge_files, forge_symbols, and forge_relationships to inspect deterministic repository facts.',
    'Exact project, file, and symbol selectors must resolve to one fact. Glob selectors may match many files.',
    'Every task must define at least one package-script verification backed by repository facts.',
    'Never emit free-form command verification. Autonomous planning does not authorize command strings.',
    'Do not invent shared-resource IDs. Do not use tools other than the four repository-fact tools.',
    `Known shared-resource IDs: ${JSON.stringify(request.sharedResourceIds)}`,
    `Repository: ${request.repository.repositoryPath}`,
    `Repository counts: ${JSON.stringify({
      projects: request.repository.projects.size,
      files: request.repository.files.size,
      symbols: request.repository.symbols.size
    })}`,
    `Projects: ${JSON.stringify(projectSummary)}`,
    `Planning attempt: ${request.attempt}`,
    `Previous deterministic diagnostics: ${JSON.stringify(request.previousDiagnostics)}`,
    `${sourceLabel}:`,
    request.source.content
  ].join('\n\n');
};

export class PiPlanningAgent implements PlannerAgent {
  readonly #gateway: PiPlanningGateway;

  constructor(gateway: PiPlanningGateway = new PiPlanningGatewayAdapter()) {
    this.#gateway = gateway;
  }

  async propose(request: PlannerProposalRequest): Promise<unknown> {
    const graph = request.repository;
    const result = await this.#gateway.generate({
      cwd: graph.repositoryPath,
      prompt: buildPrompt(request),
      executeTool: createPlanningFactToolExecutor(graph)
    });
    return result.output;
  }
}
