import type { AgentRunner } from '@ai-native-software-delivery-orchestrator/domain';

import { AgentToolDeniedError, AgentToolRuntime } from './agent-tool-runtime.js';
import type { PiSessionGateway, PiToolCall, PiToolResult } from './pi-gateway.js';

export class PiAgentRunner implements AgentRunner {
  readonly #gateway: PiSessionGateway;
  readonly #createTools: (request: Parameters<AgentRunner['run']>[0]) => AgentToolRuntime;

  constructor(options: {
    readonly gateway: PiSessionGateway;
    readonly createTools: (request: Parameters<AgentRunner['run']>[0]) => AgentToolRuntime;
  }) {
    this.#gateway = options.gateway;
    this.#createTools = options.createTools;
  }

  async run(request: Parameters<AgentRunner['run']>[0]) {
    let blockedLeaseId: string | undefined;
    let sessionEstablished = false;
    try {
      const tools = this.#createTools(request);
      const session = await this.#gateway.start({
        cwd: request.workspace.workspacePath,
        prompt: request.instructions,
        tools: ['forge_read', 'forge_list', 'forge_find', 'forge_edit', 'forge_write'],
        executeTool: async (call) => {
          if (!sessionEstablished) {
            return { content: 'Pi session is not durably established', isError: true };
          }
          if (blockedLeaseId !== undefined) {
            return { content: `Write blocked by lease: ${blockedLeaseId}`, isError: true };
          }
          try {
            return await this.#executeTool(tools, call);
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
      return {
        status: 'failed' as const,
        detail: error instanceof Error ? error.message : 'Pi agent runner failed.'
      };
    }
  }

  async #executeTool(tools: AgentToolRuntime, call: PiToolCall): Promise<PiToolResult> {
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
