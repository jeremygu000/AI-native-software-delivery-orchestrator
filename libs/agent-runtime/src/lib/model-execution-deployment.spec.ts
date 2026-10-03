import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getModel, type AssistantMessage } from '@mariozechner/pi-ai';
import {
  createCodeReviewPolicy,
  codeReviewPolicyFingerprint
} from '@ai-native-software-delivery-orchestrator/planning';
import { resolveSubscriptionExecution } from './model-execution-deployment.js';
import { PiPlanningGatewayAdapter } from './pi-planning-agent.js';

describe('Subscription deployment and real planning SDK', () => {
  it('resolves independent Copilot and Codex transports and pins their approved profiles', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'forge-subscription-')));
    try {
      const environment = { FORGE_SUBSCRIPTION_AUTH_DIRECTORY: directory };
      const copilot = resolveSubscriptionExecution(
        getModel('github-copilot', 'gpt-5.4'),
        environment
      );
      const codex = resolveSubscriptionExecution(getModel('openai-codex', 'gpt-5.4'), environment);
      expect(copilot?.target).toMatchObject({
        providerId: 'github-copilot',
        transport: 'openai-responses'
      });
      expect(codex?.target).toMatchObject({
        providerId: 'openai-codex',
        transport: 'openai-codex-responses'
      });
      expect(copilot?.target.executionProfileFingerprint).not.toBe(
        codex?.target.executionProfileFingerprint
      );
      if (codex === undefined) {
        throw new Error('Missing Codex adapter');
      }
      const policy = createCodeReviewPolicy({
        provider: 'openai-codex',
        model: 'gpt-5.4',
        executionTarget: codex.target
      });
      expect(codeReviewPolicyFingerprint(policy)).not.toBe(
        codeReviewPolicyFingerprint(
          createCodeReviewPolicy({ provider: 'openai-codex', model: 'gpt-5.4' })
        )
      );
      expect(() =>
        createCodeReviewPolicy({
          provider: 'github-copilot',
          model: 'gpt-5.4',
          executionTarget: codex.target
        })
      ).toThrow('identity differs');
      expect(() => resolveSubscriptionExecution(getModel('openai-codex', 'gpt-5.4'), {})).toThrow(
        'DIRECTORY'
      );
      expect(() =>
        resolveSubscriptionExecution(getModel('openai-codex', 'gpt-5.4'), {
          ...environment,
          FORGE_MODEL_REASONING_EFFORT: 'invalid'
        })
      ).toThrow('reasoning');
      expect(resolveSubscriptionExecution(getModel('openai', 'gpt-4o'), {})).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('routes a real SDK planning session through the approved execution contract, without filesystem auth discovery', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'forge-planning-')));
    try {
      const execution = resolveSubscriptionExecution(getModel('openai-codex', 'gpt-5.4'), {
        FORGE_SUBSCRIPTION_AUTH_DIRECTORY: directory
      });
      if (execution === undefined) {
        throw new Error('Missing Codex adapter');
      }
      const calls: string[] = [];
      const complete = async (target: typeof execution.target): Promise<AssistantMessage> => {
        calls.push(target.executionProfileFingerprint);
        return {
          role: 'assistant',
          api: 'openai-codex-responses',
          provider: target.providerId,
          model: target.modelId,
          content: [{ type: 'text', text: '{"planned":true}' }],
          stopReason: 'stop',
          timestamp: Date.now(),
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          }
        };
      };
      const gateway = new PiPlanningGatewayAdapter(undefined, {
        model: getModel('openai-codex', 'gpt-5.4'),
        execution: {
          target: execution.target,
          provider: {
            providerId: execution.provider.providerId,
            auth: execution.provider.auth,
            resolve: () => execution.target,
            complete
          }
        }
      });
      expect(
        await gateway.generate({
          cwd: directory,
          prompt: 'Return the requested JSON.',
          executeTool: async () => {
            throw new Error('No tool requested');
          }
        })
      ).toMatchObject({ output: '{"planned":true}' });
      expect(calls).toEqual([execution.target.executionProfileFingerprint]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
