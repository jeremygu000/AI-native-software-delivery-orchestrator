import type {
  TaskCodeReviewer,
  TaskCodeReviewRequest
} from '@ai-native-software-delivery-orchestrator/domain';
import type { CodeReviewPolicy } from '@ai-native-software-delivery-orchestrator/planning';
import { AuthStorage, createAgentSession, ModelRegistry } from '@mariozechner/pi-coding-agent';

import { createIsolatedPlanningResourceLoader } from './pi-planning-agent.js';
import { createReadOnlyPiTools, type PiToolCall, type PiToolResult } from './pi-gateway.js';

type PiSdkSessionOptions = NonNullable<Parameters<typeof createAgentSession>[0]>;

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export interface TaskCodeReviewTools {
  read(path: string): Promise<string>;
  list(path?: string): Promise<readonly string[]>;
  find(path: string, text: string): Promise<readonly number[]>;
}

export interface PiTaskCodeReviewGateway {
  generate(options: {
    readonly cwd: string;
    readonly prompt: string;
    readonly model: PiSdkSessionOptions['model'];
    readonly executeTool: (call: PiToolCall) => Promise<PiToolResult>;
  }): Promise<{ readonly sessionId: string; readonly output: string }>;
}

interface TaskCodeReviewAssistantMessage {
  readonly role: 'assistant';
  readonly content: readonly { readonly type: string; readonly text?: string }[];
  readonly stopReason: string;
  readonly errorMessage?: string;
}

interface TaskCodeReviewSession {
  readonly sessionId: string;
  setActiveToolsByName(toolNames: string[]): void;
  prompt(prompt: string): Promise<void>;
  dispose(): void;
  assistantMessages(): readonly TaskCodeReviewAssistantMessage[];
}

export type PiTaskCodeReviewSessionFactory = (
  options: PiSdkSessionOptions
) => Promise<{ readonly session: TaskCodeReviewSession }>;

export interface CodeReviewModelResolver {
  resolve(model: CodeReviewPolicy['reviewer']['model']): PiSdkSessionOptions['model'];
}

export class PiCodeReviewModelResolver implements CodeReviewModelResolver {
  readonly #registry: Pick<ModelRegistry, 'find'>;

  constructor(registry: Pick<ModelRegistry, 'find'> = ModelRegistry.create(AuthStorage.create())) {
    this.#registry = registry;
  }

  resolve(model: CodeReviewPolicy['reviewer']['model']): PiSdkSessionOptions['model'] {
    const resolved = this.#registry.find(model.provider, model.id);
    if (resolved === undefined) {
      throw new Error(`Approved code review model is unavailable: ${model.provider}/${model.id}`);
    }
    return resolved;
  }
}

const buildPrompt = (request: TaskCodeReviewRequest): string =>
  [
    'You are an independent read-only code reviewer for a repository-aware coding orchestrator.',
    'Review the task workspace after deterministic verification. You cannot write files, run commands, approve integration, or authorize repair.',
    'Return exactly one JSON object and no prose or Markdown fence.',
    'Use this shape:',
    '{"recommendation":"accept|repair","summary":"...","findings":[{"id":"...","severity":"critical|high|medium|low","fileIds":["..."],"symbolIds":["..."],"description":"...","requirementReference":"..."}]}',
    'Use accept only when findings is empty. Use repair only when every finding identifies at least one affected file ID.',
    'Use only forge_read, forge_list, and forge_find. Do not request any other tool.',
    `Task: ${JSON.stringify({
      id: request.task.id,
      title: request.task.title,
      goal: request.task.goal,
      expectedReads: request.task.expectedReads,
      expectedWrites: request.task.expectedWrites,
      verification: request.task.verification
    })}`,
    `Review iteration: ${request.iteration}`,
    `Observed written file IDs: ${JSON.stringify(
      [...(request.impact.observed?.filesWritten ?? [])].toSorted(compareText)
    )}`
  ].join('\n\n');

export class PiTaskCodeReviewer implements TaskCodeReviewer {
  readonly #gateway: PiTaskCodeReviewGateway;
  readonly #createTools: (request: TaskCodeReviewRequest) => TaskCodeReviewTools;
  readonly #policy: CodeReviewPolicy;
  readonly #modelResolver: CodeReviewModelResolver;

  constructor(options: {
    readonly gateway?: PiTaskCodeReviewGateway;
    readonly policy: CodeReviewPolicy;
    readonly modelResolver?: CodeReviewModelResolver;
    readonly createTools: (request: TaskCodeReviewRequest) => TaskCodeReviewTools;
  }) {
    if (options.policy.reviewer.agentBackend !== 'pi') {
      throw new Error('Unsupported code review agent backend');
    }
    const modelResolver = options.modelResolver ?? new PiCodeReviewModelResolver();
    this.#gateway = options.gateway ?? new PiTaskCodeReviewGatewayAdapter();
    this.#createTools = options.createTools;
    this.#policy = options.policy;
    this.#modelResolver = modelResolver;
  }

  async review(request: TaskCodeReviewRequest): Promise<unknown> {
    const tools = this.#createTools(request);
    const result = await this.#gateway.generate({
      cwd: request.workspace.workspacePath,
      prompt: buildPrompt(request),
      model: this.#modelResolver.resolve(this.#policy.reviewer.model),
      executeTool: async (call) => this.#executeTool(tools, call)
    });
    return result.output;
  }

  async #executeTool(tools: TaskCodeReviewTools, call: PiToolCall): Promise<PiToolResult> {
    switch (call.name) {
      case 'forge_read':
        return { content: await tools.read(call.path) };
      case 'forge_list':
        return { content: (await tools.list(call.path)).join('\n') };
      case 'forge_find':
        return { content: (await tools.find(call.path, call.text)).join('\n') };
      default:
        return { content: 'Code reviewer tool is not allowed', isError: true };
    }
  }
}

export class PiTaskCodeReviewGatewayAdapter implements PiTaskCodeReviewGateway {
  readonly #createSession: PiTaskCodeReviewSessionFactory;

  constructor(
    createSession: PiTaskCodeReviewSessionFactory = async (options) => {
      const { session } = await createAgentSession(options);
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
    readonly model: PiSdkSessionOptions['model'];
    readonly executeTool: (call: PiToolCall) => Promise<PiToolResult>;
  }): Promise<{ readonly sessionId: string; readonly output: string }> {
    const toolNames = ['forge_read', 'forge_list', 'forge_find'];
    const resourceLoader = await createIsolatedPlanningResourceLoader();
    const { session } = await this.#createSession({
      cwd: options.cwd,
      model: options.model,
      noTools: 'builtin',
      tools: [...toolNames],
      customTools: createReadOnlyPiTools(options.executeTool),
      resourceLoader
    });
    try {
      session.setActiveToolsByName(toolNames);
      await session.prompt(options.prompt);
      const message = session.assistantMessages().at(-1);
      if (
        message === undefined ||
        message.stopReason === 'error' ||
        message.stopReason === 'aborted'
      ) {
        throw new Error(
          message?.errorMessage ?? 'Pi task code reviewer returned no assistant response'
        );
      }
      const output = message.content
        .flatMap((content) =>
          content.type === 'text' && content.text !== undefined ? [content.text] : []
        )
        .join('\n')
        .trim();
      if (output.length === 0) {
        throw new Error('Pi task code reviewer returned no text response');
      }
      return { sessionId: session.sessionId, output };
    } finally {
      session.dispose();
    }
  }
}
