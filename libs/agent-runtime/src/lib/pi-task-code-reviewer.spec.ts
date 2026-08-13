import type { TaskCodeReviewRequest } from '@ai-native-software-delivery-orchestrator/domain';
import { describe, expect, it, vi } from 'vitest';

const { createAgentSession } = vi.hoisted(() => ({ createAgentSession: vi.fn() }));

vi.mock('@mariozechner/pi-coding-agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mariozechner/pi-coding-agent')>()),
  createAgentSession
}));

import type { PiTaskCodeReviewGateway } from './pi-task-code-reviewer.js';
import {
  PiTaskCodeReviewer,
  PiCodeReviewModelResolver,
  PiTaskCodeReviewGatewayAdapter,
  type PiTaskCodeReviewSessionFactory
} from './pi-task-code-reviewer.js';

const policy = {
  version: 1,
  reviewer: {
    implementation: 'pi-task-code-reviewer',
    agentBackend: 'pi' as const,
    model: { provider: 'test-provider', id: 'test-model' },
    toolProfile: 'workspace-read-only-v1' as const,
    outputSchemaVersion: 1,
    promptVersion: 'v1'
  }
};
const modelResolver = { resolve: vi.fn(() => undefined) };

const request: TaskCodeReviewRequest = {
  runId: 'run-1',
  task: {
    id: 'task-1',
    title: 'Validate values',
    goal: 'Validate values before persistence',
    dependencies: [],
    expectedReads: [],
    expectedWrites: [{ type: 'file', value: 'core:value.txt' }],
    sharedResources: [],
    verification: []
  },
  workspace: {
    id: 'workspace-1',
    runId: 'run-1',
    taskId: 'task-1',
    integrationRepositoryPath: '/integration',
    workspacePath: '/workspace',
    branchName: 'task-1',
    baseRef: 'base',
    integrationRef: 'main',
    revision: 1,
    phase: 'READY_TO_INTEGRATE'
  },
  impact: {
    predicted: {
      taskId: 'task-1',
      projectsRead: new Set(),
      projectsWritten: new Set(),
      explicitProjectsWritten: new Set(),
      filesRead: new Set(),
      filesWritten: new Set(['core:value.txt']),
      explicitFilesWritten: new Set(['core:value.txt']),
      globFilesWritten: new Set(),
      symbolDerivedFilesWritten: new Set(),
      symbolsRead: new Set(),
      symbolsWritten: new Set(),
      sharedResources: new Set(),
      sharedResourceAccesses: [],
      downstreamProjects: new Set(),
      riskSignals: []
    },
    observed: {
      taskId: 'task-1',
      filesRead: new Set(),
      filesCreated: new Set(),
      filesWritten: new Set(['core:value.txt']),
      filesDeleted: new Set(),
      symbolsWritten: new Set(),
      dependencyRequests: new Set(),
      manifestFilesChanged: new Set(),
      generatedFilesChanged: new Set()
    }
  },
  builderAttempt: {
    id: 'attempt-1',
    runId: 'run-1',
    taskId: 'task-1',
    agentId: 'agent-1',
    workspaceId: 'workspace-1',
    leasePlanFingerprint: 'lease-plan-1',
    state: 'COMPLETED',
    revision: 1,
    startedAt: new Date('2026-08-13T00:00:00.000Z'),
    completedAt: new Date('2026-08-13T00:01:00.000Z')
  },
  subject: {
    builderAttemptId: 'attempt-1',
    outputAttemptId: 'attempt-1',
    workspaceId: 'workspace-1',
    workspaceRevision: 1,
    workspaceChangeFingerprint: `sha256:${'1'.repeat(64)}`,
    impactFingerprint: `sha256:${'2'.repeat(64)}`,
    verificationFingerprint: `sha256:${'3'.repeat(64)}`
  },
  repository: { files: new Map(), symbols: new Map() },
  iteration: 1
};

describe('PiTaskCodeReviewer', () => {
  it('resolves the approved provider and model ID or fails closed when unavailable', () => {
    const resolver = new PiCodeReviewModelResolver({
      find: () => undefined
    });
    expect(() => resolver.resolve({ provider: 'test-provider', id: 'missing-model' })).toThrow(
      'Approved code review model is unavailable'
    );
  });

  it('requests structured evidence through read-only workspace tools only', async () => {
    const generate = vi.fn(
      async (_options: Parameters<PiTaskCodeReviewGateway['generate']>[0]) => ({
        sessionId: 'review-session',
        output: '{"recommendation":"accept","summary":"Looks good.","findings":[]}'
      })
    );
    const reviewer = new PiTaskCodeReviewer({
      gateway: { generate },
      policy,
      modelResolver,
      createTools: () => ({
        read: async () => 'value',
        list: async () => ['value.txt'],
        find: async () => [1]
      })
    });

    await expect(reviewer.review(request)).resolves.toContain('"recommendation":"accept"');
    const options = generate.mock.calls[0][0];
    expect(options.cwd).toBe('/workspace');
    expect(modelResolver.resolve).toHaveBeenCalledWith(policy.reviewer.model);
    expect(options.model).toBeUndefined();
    expect(options.prompt).toContain(
      'cannot write files, run commands, approve integration, or authorize repair'
    );
    await expect(options.executeTool({ name: 'forge_read', path: 'value.txt' })).resolves.toEqual({
      content: 'value'
    });
    await expect(options.executeTool({ name: 'forge_list', path: '.' })).resolves.toEqual({
      content: 'value.txt'
    });
    await expect(
      options.executeTool({ name: 'forge_find', path: 'value.txt', text: 'value' })
    ).resolves.toEqual({
      content: '1'
    });
    await expect(
      options.executeTool({ name: 'forge_write', path: 'value.txt', content: 'bad' })
    ).resolves.toMatchObject({
      isError: true
    });
  });

  it('isolates a reviewer session to read-only tools and returns its last text response', async () => {
    const setActiveToolsByName = vi.fn();
    const dispose = vi.fn();
    const factory: PiTaskCodeReviewSessionFactory = async () => ({
      session: {
        sessionId: 'review-session',
        setActiveToolsByName,
        prompt: async () => undefined,
        dispose,
        assistantMessages: () => [
          {
            role: 'assistant',
            stopReason: 'stop',
            content: [
              { type: 'tool_use' },
              { type: 'text', text: '{"recommendation":"accept","summary":"OK","findings":[]}' }
            ]
          }
        ]
      }
    });
    const trackedFactory = vi.fn(factory);
    const gateway = new PiTaskCodeReviewGatewayAdapter(trackedFactory);

    await expect(
      gateway.generate({
        cwd: '/workspace',
        prompt: 'Review.',
        model: undefined,
        executeTool: async () => ({ content: '' })
      })
    ).resolves.toMatchObject({
      sessionId: 'review-session',
      output: expect.stringContaining('accept')
    });
    expect(trackedFactory.mock.calls[0]?.[0]?.tools).toEqual([
      'forge_read',
      'forge_list',
      'forge_find'
    ]);
    expect(setActiveToolsByName).toHaveBeenCalledWith(['forge_read', 'forge_list', 'forge_find']);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('maps the default Pi session into an isolated reviewer facade', async () => {
    const setActiveToolsByName = vi.fn();
    const dispose = vi.fn();
    createAgentSession.mockResolvedValue({
      session: {
        sessionId: 'default-review-session',
        setActiveToolsByName,
        prompt: async () => undefined,
        dispose,
        state: {
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: 'Review this workspace.' }]
            },
            {
              role: 'assistant',
              stopReason: 'stop',
              errorMessage: 'non-fatal provider detail',
              content: [
                { type: 'text', text: '{"recommendation":"accept","summary":"OK","findings":[]}' }
              ]
            }
          ]
        }
      }
    });
    const gateway = new PiTaskCodeReviewGatewayAdapter();

    await expect(
      gateway.generate({
        cwd: '/workspace',
        prompt: 'Review.',
        model: undefined,
        executeTool: async () => ({ content: '' })
      })
    ).resolves.toMatchObject({ sessionId: 'default-review-session' });
    expect(setActiveToolsByName).toHaveBeenCalledWith(['forge_read', 'forge_list', 'forge_find']);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('uses the default isolated gateway when no reviewer gateway is supplied', async () => {
    createAgentSession.mockResolvedValue({
      session: {
        sessionId: 'default-reviewer',
        setActiveToolsByName: () => undefined,
        prompt: async () => undefined,
        dispose: () => undefined,
        state: {
          messages: [
            {
              role: 'assistant',
              stopReason: 'stop',
              content: [
                { type: 'text', text: '{"recommendation":"accept","summary":"OK","findings":[]}' }
              ]
            }
          ]
        }
      }
    });
    const reviewer = new PiTaskCodeReviewer({
      policy,
      modelResolver,
      createTools: () => ({
        read: async () => 'value',
        list: async () => ['value.txt'],
        find: async () => [1]
      })
    });
    const unsortedObserved = {
      ...request,
      impact: {
        ...request.impact,
        observed: {
          ...request.impact.observed!,
          filesWritten: new Set(['core:z.txt', 'core:a.txt'])
        }
      }
    };

    await expect(reviewer.review(unsortedObserved)).resolves.toContain('"recommendation":"accept"');
    expect(createAgentSession.mock.calls.at(-1)?.[0]?.tools).toEqual([
      'forge_read',
      'forge_list',
      'forge_find'
    ]);
    expect(modelResolver.resolve).toHaveBeenCalledWith(policy.reviewer.model);
    expect(createAgentSession.mock.calls.at(-1)?.[0]?.model).toBeUndefined();
  });

  it('fails closed when the approved review model cannot be resolved', async () => {
    const reviewer = new PiTaskCodeReviewer({
      policy,
      modelResolver: {
        resolve: () => {
          throw new Error('Approved code review model is unavailable: test-provider/test-model');
        }
      },
      createTools: () => ({
        read: async () => 'value',
        list: async () => ['value.txt'],
        find: async () => [1]
      })
    });

    await expect(reviewer.review(request)).rejects.toThrow(
      'Approved code review model is unavailable'
    );
  });

  it.each([
    {
      label: 'has no assistant response',
      assistantMessages: () => []
    },
    {
      label: 'stops with a reviewer error',
      assistantMessages: () => [
        {
          role: 'assistant' as const,
          stopReason: 'error',
          errorMessage: 'provider unavailable',
          content: []
        }
      ]
    },
    {
      label: 'is aborted without a reviewer error message',
      assistantMessages: () => [
        {
          role: 'assistant' as const,
          stopReason: 'aborted',
          content: []
        }
      ]
    },
    {
      label: 'returns no text',
      assistantMessages: () => [
        { role: 'assistant' as const, stopReason: 'stop', content: [{ type: 'tool_use' }] }
      ]
    }
  ])('fails closed when the reviewer $label', async ({ assistantMessages }) => {
    const dispose = vi.fn();
    const gateway = new PiTaskCodeReviewGatewayAdapter(async () => ({
      session: {
        sessionId: 'review-session',
        setActiveToolsByName: () => undefined,
        prompt: async () => undefined,
        dispose,
        assistantMessages
      }
    }));

    await expect(
      gateway.generate({
        cwd: '/workspace',
        prompt: 'Review.',
        model: undefined,
        executeTool: async () => ({ content: '' })
      })
    ).rejects.toThrow(Error);
    expect(dispose).toHaveBeenCalledOnce();
  });
});
