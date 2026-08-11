import type { AgentRunner } from '@ai-native-software-delivery-orchestrator/domain';

import { AgentCommandRuntime, NodeAgentCommandExecutor } from './agent-command-runtime.js';
import { AgentToolDeniedError, AgentToolRuntime } from './agent-tool-runtime.js';
import type { PiSessionGateway, PiToolCall, PiToolResult } from './pi-gateway.js';

export class PiAgentRunner implements AgentRunner {
  readonly #gateway: PiSessionGateway;
  readonly #createTools: (request: Parameters<AgentRunner['run']>[0]) => AgentToolRuntime;
  readonly #createCommands: (request: Parameters<AgentRunner['run']>[0]) => AgentCommandRuntime;

  constructor(options: {
    readonly gateway: PiSessionGateway;
    readonly createTools: (request: Parameters<AgentRunner['run']>[0]) => AgentToolRuntime;
    readonly createCommands?: (request: Parameters<AgentRunner['run']>[0]) => AgentCommandRuntime;
    readonly trustedCommandPath?: string;
  }) {
    this.#gateway = options.gateway;
    this.#createTools = options.createTools;
    this.#createCommands =
      options.createCommands ??
      (() =>
        new AgentCommandRuntime(
          new NodeAgentCommandExecutor({ trustedPath: options.trustedCommandPath })
        ));
  }

  async run(request: Parameters<AgentRunner['run']>[0]) {
    let blockedLeaseId: string | undefined;
    let sessionEstablished = false;
    try {
      const tools = this.#createTools(request);
      tools.bindRuntimeAuthority(request.impact, request.leases);
      const commands = this.#createCommands(request);
      commands.bindRuntimePolicy(request.commandPolicy, request.workspace.workspacePath);
      const toolNames: PiToolCall['name'][] = [
        'forge_read',
        'forge_list',
        'forge_find',
        'forge_edit',
        'forge_write',
        ...(request.commandPolicy === undefined ? [] : ['forge_command' as const])
      ];
      const session = await this.#gateway.start({
        cwd: request.workspace.workspacePath,
        prompt: request.instructions,
        tools: toolNames,
        executeTool: async (call) => {
          if (!sessionEstablished) {
            return { content: 'Pi session is not durably established', isError: true };
          }
          if (blockedLeaseId !== undefined) {
            return { content: `Write blocked by lease: ${blockedLeaseId}`, isError: true };
          }
          try {
            return await this.#executeTool(tools, commands, call);
          } catch (error) {
            if (error instanceof AgentToolBlockedError) {
              blockedLeaseId = error.leaseId;
              return { content: error.message, isError: true };
            }
            throw error;
          }
        },
        onStarted: async (sessionId) => {
          await request.onStarted({ sessionRef: { backend: 'pi', value: sessionId } });
          sessionEstablished = true;
        }
      });
      if (blockedLeaseId !== undefined) {
        return {
          status: 'blocked' as const,
          leaseId: blockedLeaseId,
          detail: `Write blocked by lease: ${blockedLeaseId}`,
          observedImpact: tools.observedImpact(),
          additionalLeases: tools.leases()
        };
      }
      return {
        status: 'completed' as const,
        sessionRef: { backend: 'pi', value: session.sessionId },
        observedImpact: tools.observedImpact(),
        additionalLeases: tools.leases()
      };
    } catch (error) {
      if (sessionEstablished) {
        throw error;
      }
      return {
        status: 'failed' as const,
        detail: error instanceof Error ? error.message : 'Pi agent runner failed.'
      };
    }
  }

  async #executeTool(
    tools: AgentToolRuntime,
    commands: AgentCommandRuntime,
    call: PiToolCall
  ): Promise<PiToolResult> {
    try {
      switch (call.name) {
        case 'forge_read':
          return { content: await tools.read(call.path) };
        case 'forge_list':
          return { content: (await tools.list(call.path)).join('\n') };
        case 'forge_find':
          return { content: (await tools.find(call.path, call.text)).join('\n') };
        case 'forge_edit': {
          const result = await tools.edit(call.path, call.expected, call.replacement);
          if (result.status === 'blocked') {
            throw new AgentToolBlockedError(result.leaseId);
          }
          return { content: `Edited ${result.path}` };
        }
        case 'forge_write': {
          const result = await tools.write(call.path, call.content);
          if (result.status === 'blocked') {
            throw new AgentToolBlockedError(result.leaseId);
          }
          return { content: `Wrote ${result.path}` };
        }
        case 'forge_command': {
          const result = await commands.run(call.commandId);
          const content = [result.stdout, result.stderr]
            .filter((value) => value.length > 0)
            .join('\n');
          const failed = result.status !== 'completed' || result.exitCode !== 0;
          return {
            content: content.length > 0 ? content : result.status,
            ...(failed ? { isError: true } : {})
          };
        }
        default:
          throw new AgentToolDeniedError('Pi tool is not allowed');
      }
    } catch (error) {
      if (error instanceof AgentToolDeniedError) {
        return { content: error.message, isError: true };
      }
      throw error;
    }
  }
}

class AgentToolBlockedError extends Error {
  readonly leaseId: string;

  constructor(leaseId: string) {
    super(`Write blocked by lease: ${leaseId}`);
    this.name = 'AgentToolBlockedError';
    this.leaseId = leaseId;
  }
}
