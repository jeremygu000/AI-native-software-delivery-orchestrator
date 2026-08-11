import { createAgentSession, defineTool } from '@mariozechner/pi-coding-agent';
import { Type } from 'typebox';

type PiSdkSessionOptions = Parameters<typeof createAgentSession>[0];

interface PiSessionFacade {
  readonly sessionId: string;
  setActiveToolsByName(toolNames: string[]): void;
  prompt(prompt: string): Promise<void>;
}

export type PiSessionFactory = (
  options: PiSdkSessionOptions
) => Promise<{ readonly session: PiSessionFacade }>;

export type PiToolCall =
  | { readonly name: 'forge_read'; readonly path: string }
  | { readonly name: 'forge_list'; readonly path?: string }
  | { readonly name: 'forge_find'; readonly path: string; readonly text: string }
  | {
      readonly name: 'forge_edit';
      readonly path: string;
      readonly expected: string;
      readonly replacement: string;
    }
  | { readonly name: 'forge_write'; readonly path: string; readonly content: string }
  | { readonly name: 'forge_command'; readonly commandId: string };

export interface PiToolResult {
  readonly content: string;
  readonly isError?: boolean;
}

export interface PiSessionGateway {
  start(options: {
    readonly cwd: string;
    readonly prompt: string;
    readonly tools: readonly PiToolCall['name'][];
    readonly executeTool: (call: PiToolCall) => Promise<PiToolResult>;
    readonly onStarted: (sessionId: string) => Promise<void>;
  }): Promise<{ readonly sessionId: string }>;
}

const asToolResult = async (
  call: PiToolCall,
  executeTool: (call: PiToolCall) => Promise<PiToolResult>
) => {
  const result = await executeTool(call);
  return {
    content: [{ type: 'text' as const, text: result.content }],
    details: {},
    ...(result.isError === true ? { isError: true } : {})
  };
};

export const createControlledPiTools = (
  executeTool: (call: PiToolCall) => Promise<PiToolResult>
) => [
  defineTool({
    name: 'forge_read',
    label: 'Forge read',
    description: 'Read a workspace-relative file through the orchestrator.',
    parameters: Type.Object({ path: Type.String() }),
    execute: async (_id, params) => asToolResult({ name: 'forge_read', ...params }, executeTool)
  }),
  defineTool({
    name: 'forge_list',
    label: 'Forge list',
    description: 'List a workspace-relative directory through the orchestrator.',
    parameters: Type.Object({ path: Type.Optional(Type.String()) }),
    execute: async (_id, params) => asToolResult({ name: 'forge_list', ...params }, executeTool)
  }),
  defineTool({
    name: 'forge_find',
    label: 'Forge find',
    description: 'Find text in a workspace-relative file through the orchestrator.',
    parameters: Type.Object({ path: Type.String(), text: Type.String() }),
    execute: async (_id, params) => asToolResult({ name: 'forge_find', ...params }, executeTool)
  }),
  defineTool({
    name: 'forge_edit',
    label: 'Forge edit',
    description: 'Replace one exact text span through the orchestrator write guard.',
    parameters: Type.Object({
      path: Type.String(),
      expected: Type.String(),
      replacement: Type.String()
    }),
    execute: async (_id, params) => asToolResult({ name: 'forge_edit', ...params }, executeTool)
  }),
  defineTool({
    name: 'forge_write',
    label: 'Forge write',
    description: 'Write a workspace-relative file through the orchestrator write guard.',
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    execute: async (_id, params) => asToolResult({ name: 'forge_write', ...params }, executeTool)
  }),
  defineTool({
    name: 'forge_command',
    label: 'Forge command',
    description: 'Run one orchestrator-approved command in the task workspace.',
    parameters: Type.Object({ commandId: Type.String() }),
    execute: async (_id, params) => asToolResult({ name: 'forge_command', ...params }, executeTool)
  })
];

export class PiCodingAgentGateway implements PiSessionGateway {
  readonly #createSession: PiSessionFactory;

  constructor(
    createSession: PiSessionFactory = async (options) => {
      const { session } = await createAgentSession(options);
      return {
        session: {
          sessionId: session.sessionId,
          setActiveToolsByName: (toolNames) => session.setActiveToolsByName(toolNames),
          prompt: (prompt) => session.prompt(prompt)
        }
      };
    }
  ) {
    this.#createSession = createSession;
  }

  async start(options: {
    readonly cwd: string;
    readonly prompt: string;
    readonly tools: readonly PiToolCall['name'][];
    readonly executeTool: (call: PiToolCall) => Promise<PiToolResult>;
    readonly onStarted: (sessionId: string) => Promise<void>;
  }): Promise<{ readonly sessionId: string }> {
    const { session } = await this.#createSession({
      cwd: options.cwd,
      noTools: 'all',
      customTools: createControlledPiTools(options.executeTool)
    });
    session.setActiveToolsByName([...options.tools]);
    await options.onStarted(session.sessionId);
    await session.prompt(options.prompt);
    return { sessionId: session.sessionId };
  }
}
