import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AssistantMessage } from '@mariozechner/pi-ai';
import { PiCodeReviewModelResolver } from './pi-task-code-reviewer.js';
import {
  ApprovedPiHostModelProxy,
  isolatedPiModel,
  parseIsolatedAssistant
} from './pi-model-proxy.js';

export const modelReply = (tool = false): AssistantMessage => ({
  role: 'assistant',
  api: 'openai-completions',
  provider: 'openai',
  model: 'approved',
  content: tool
    ? [
        {
          type: 'toolCall',
          id: 'call-1',
          name: 'forge_write',
          arguments: { path: 'value.txt', content: 'model edit' }
        }
      ]
    : [{ type: 'text', text: 'Done' }],
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  },
  stopReason: tool ? 'toolUse' : 'stop',
  timestamp: Date.now()
});

describe('approved host model proxy', () => {
  it('sends enabled/high DeepSeek thinking and preserves tool continuation through the real SDK', async () => {
    const bodies: unknown[] = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on('end', () => {
        bodies.push(JSON.parse(body));
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(
          `data: ${JSON.stringify({ id: 'deepseek-local', choices: [{ index: 0, delta: { role: 'assistant', content: 'Done' }, finish_reason: null }] })}\n\n`
        );
        response.write(
          `data: ${JSON.stringify({ id: 'deepseek-local', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`
        );
        response.end('data: [DONE]\n\n');
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('Missing provider port');
      }
      const model = new PiCodeReviewModelResolver().resolve({
        provider: 'deepseek',
        id: 'deepseek-flash'
      });
      if (model === undefined) {
        throw new Error('Missing approved DeepSeek model');
      }
      const proxy = new ApprovedPiHostModelProxy({
        model: { ...model, baseUrl: `http://127.0.0.1:${address.port}` },
        apiKey: 'local-test-only',
        reasoning: 'high'
      });
      await proxy.complete(
        {
          messages: [
            { role: 'user', content: 'Edit', timestamp: 1 },
            {
              ...modelReply(true),
              content: [
                {
                  type: 'thinking',
                  thinking: 'ephemeral continuation',
                  thinkingSignature: 'reasoning_content'
                },
                {
                  type: 'toolCall',
                  id: 'call-1',
                  name: 'forge_write',
                  arguments: { path: 'value.txt', content: 'edit' }
                }
              ]
            },
            {
              role: 'toolResult',
              toolCallId: 'call-1',
              toolName: 'forge_write',
              content: [{ type: 'text', text: 'saved' }],
              isError: false,
              timestamp: 2
            }
          ],
          tools: [{ name: 'forge_write' }]
        },
        ['forge_write'],
        new AbortController().signal
      );
      expect(bodies).toEqual([
        expect.objectContaining({
          model: 'deepseek-flash',
          thinking: { type: 'enabled' },
          reasoning_effort: 'high',
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: 'assistant',
              reasoning_content: 'ephemeral continuation'
            })
          ])
        })
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done, reject) =>
        server.close((error) => (error === undefined ? done() : reject(error)))
      );
    }
  });
  it('preserves only the DeepSeek continuation marker and sends host-approved high reasoning', async () => {
    const complete = vi.fn(async () => modelReply());
    const proxy = new ApprovedPiHostModelProxy({
      model: isolatedPiModel,
      apiKey: 'host-only',
      reasoning: 'high',
      complete
    });
    const prior = parseIsolatedAssistant({
      ...modelReply(true),
      content: [
        {
          type: 'thinking',
          thinking: 'ephemeral continuation',
          thinkingSignature: 'reasoning_content'
        },
        {
          type: 'toolCall',
          id: 'call-1',
          name: 'forge_write',
          arguments: { path: 'value.txt', content: 'edit' }
        }
      ]
    });
    await proxy.complete(
      { messages: [prior], tools: [{ name: 'forge_write' }] },
      ['forge_write'],
      new AbortController().signal
    );
    expect(complete).toHaveBeenCalledWith(
      isolatedPiModel,
      expect.objectContaining({ messages: [expect.objectContaining({ content: prior.content })] }),
      expect.objectContaining({ reasoning: 'high' })
    );
    expect(
      parseIsolatedAssistant({
        ...modelReply(),
        content: [
          {
            type: 'thinking',
            thinking: 'ephemeral',
            thinkingSignature: 'arbitrary-private-metadata'
          }
        ]
      }).content
    ).toEqual([{ type: 'thinking', thinking: 'ephemeral' }]);
  });
  it('uses the real provider SDK against a host-only HTTP endpoint', async () => {
    let requests = 0;
    const server = createServer((request, response) => {
      expect(request.headers.authorization).toBe('Bearer host-private-key');
      expect(request.url).toBe('/v1/chat/completions');
      requests++;
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(
          `data: ${JSON.stringify({ id: 'local-response', object: 'chat.completion.chunk', model: 'approved', choices: [{ index: 0, delta: { role: 'assistant', content: 'Local provider response' }, finish_reason: null }] })}\n\n`
        );
        response.write(
          `data: ${JSON.stringify({ id: 'local-response', object: 'chat.completion.chunk', model: 'approved', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`
        );
        response.end('data: [DONE]\n\n');
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('Missing local provider port');
      }
      const proxy = new ApprovedPiHostModelProxy({
        model: {
          ...isolatedPiModel,
          provider: 'openai',
          id: 'approved',
          baseUrl: `http://127.0.0.1:${address.port}/v1`
        },
        apiKey: 'host-private-key'
      });
      const message = await proxy.complete(
        { messages: [{ role: 'user', content: 'Approved', timestamp: 1 }], tools: [] },
        [],
        new AbortController().signal
      );
      expect(message.content).toEqual([{ type: 'text', text: 'Local provider response' }]);
      expect(JSON.stringify(message)).not.toContain('host-private-key');
      expect(JSON.stringify(message)).not.toContain(String(address.port));
      expect(requests).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      );
    }
  });
  it('fixes endpoint/auth/budgets on the host and reconstructs approved tool schemas', async () => {
    const complete = vi.fn(async () => ({
      ...modelReply(),
      errorMessage: 'secret diagnostics',
      responseId: 'private-id'
    }));
    const model = {
      ...isolatedPiModel,
      provider: 'openai',
      id: 'approved',
      baseUrl: 'https://approved.example/v1'
    };
    const signal = new AbortController().signal;
    const proxy = new ApprovedPiHostModelProxy({
      model,
      apiKey: 'host-secret',
      maxTokens: 123,
      complete
    });
    const result = await proxy.complete(
      {
        messages: [{ role: 'user', content: 'Edit', timestamp: 1 }],
        tools: [{ name: 'forge_write', parameters: { forged: true } }]
      },
      ['forge_write'],
      signal
    );
    expect(complete).toHaveBeenCalledWith(
      model,
      expect.objectContaining({
        tools: [
          expect.objectContaining({
            name: 'forge_write',
            parameters: expect.objectContaining({
              properties: expect.objectContaining({
                path: expect.anything(),
                content: expect.anything()
              })
            })
          })
        ]
      }),
      expect.objectContaining({ apiKey: 'host-secret', signal, maxTokens: 123, maxRetries: 0 })
    );
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result).not.toHaveProperty('responseId');
    expect(result.provider).toBe('forge-host-proxy');
  });

  it.each([
    { messages: [], apiKey: 'container-key' },
    { messages: [], baseUrl: 'https://evil.invalid' },
    { messages: [], tools: [{ name: 'bash' }] },
    { messages: [], tools: [{ name: 'forge_read' }, { name: 'forge_read' }] },
    { messages: [{ role: 'user', content: [{ type: 'image', data: 'x' }], timestamp: 1 }] },
    { messages: [{ role: 'system', content: 'x', timestamp: 1 }] }
  ])('rejects unsupported context before contacting a provider', async (context) => {
    const complete = vi.fn(async () => modelReply());
    const proxy = new ApprovedPiHostModelProxy({
      model: isolatedPiModel,
      apiKey: 'secret',
      complete
    });
    await expect(
      proxy.complete(context, ['forge_read'], new AbortController().signal)
    ).rejects.toThrow();
    expect(complete).not.toHaveBeenCalled();
  });

  it('rejects provider error bodies and invalid numeric/content fields', () => {
    expect(() => new ApprovedPiHostModelProxy({ model: isolatedPiModel, apiKey: '' })).toThrow();
    expect(() =>
      parseIsolatedAssistant({ ...modelReply(), stopReason: 'error', errorMessage: 'key' })
    ).toThrow();
    expect(() => parseIsolatedAssistant({ ...modelReply(), timestamp: -1 })).toThrow();
    expect(() =>
      parseIsolatedAssistant({ ...modelReply(), content: [{ type: 'image', data: 'x' }] })
    ).toThrow();
    expect(
      parseIsolatedAssistant({
        ...modelReply(),
        content: [{ type: 'thinking', thinking: 'Reason' }]
      }).content
    ).toEqual([{ type: 'thinking', thinking: 'Reason' }]);
  });
});
