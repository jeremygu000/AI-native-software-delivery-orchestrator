import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { DockerPiSessionGateway } from './docker-pi-session-gateway.js';
import { ApprovedPiHostModelProxy, isolatedPiModel } from './pi-model-proxy.js';
import { PiSessionCancellationConfirmedError } from './pi-gateway.js';
import { PiCodeReviewModelResolver } from './pi-task-code-reviewer.js';

const image = process.env.FORGE_TEST_PI_SDK_IMAGE;

describe('actual containerized Pi SDK', () => {
  it.skipIf(image === undefined)(
    'runs real Pi inference and tools through a host-only HTTP provider',
    async () => {
      let requests = 0;
      const events: string[] = [];
      const server = createServer((request, response) => {
        expect(request.headers.authorization).toBe('Bearer host-only-secret');
        expect(request.url).toBe('/v1/chat/completions');
        let body = '';
        request.on('data', (chunk) => {
          body += chunk.toString();
        });
        request.on('end', () => {
          requests++;
          if (requests === 2) {
            expect(body).toContain('host-fenced-write');
          }
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          const delta =
            requests === 1
              ? {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'write-1',
                      type: 'function',
                      function: {
                        name: 'forge_write',
                        arguments: JSON.stringify({
                          path: 'approved.txt',
                          content: 'real-sdk-write'
                        })
                      }
                    }
                  ]
                }
              : { role: 'assistant', content: 'Done' };
          response.write(
            `data: ${JSON.stringify({ id: 'reply', object: 'chat.completion.chunk', model: 'approved', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
          );
          response.write(
            `data: ${JSON.stringify({ id: 'reply', object: 'chat.completion.chunk', model: 'approved', choices: [{ index: 0, delta: {}, finish_reason: requests === 1 ? 'tool_calls' : 'stop' }] })}\n\n`
          );
          response.end('data: [DONE]\n\n');
        });
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      try {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          throw new Error('Missing provider');
        }
        const gateway = new DockerPiSessionGateway({
          image: image!,
          executable: '/usr/local/bin/node',
          args: ['/opt/forge/entrypoint.mjs'],
          timeoutMs: 30_000,
          modelProxy: new ApprovedPiHostModelProxy({
            model: {
              ...isolatedPiModel,
              provider: 'openai',
              id: 'approved',
              baseUrl: `http://127.0.0.1:${address.port}/v1`
            },
            apiKey: 'host-only-secret'
          })
        });
        const result = await gateway.start({
          cwd: '/host-workspace-not-mounted',
          prompt: 'Write approved.txt through Forge',
          tools: ['forge_write'],
          onStarted: async (id) => {
            expect(id.length).toBeGreaterThan(0);
            events.push('durable-start');
          },
          executeTool: async (call) => {
            expect(events).toEqual(['durable-start']);
            expect(call).toEqual({
              name: 'forge_write',
              path: 'approved.txt',
              content: 'real-sdk-write'
            });
            events.push('fenced-tool');
            return { content: 'host-fenced-write' };
          }
        });
        expect(result.sessionId.length).toBeGreaterThan(0);
        expect(events).toEqual(['durable-start', 'fenced-tool']);
        expect(requests).toBe(2);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    60_000
  );

  it.skipIf(image === undefined)(
    'preserves DeepSeek reasoning continuation through the actual SDK container',
    async () => {
      let requests = 0;
      const server = createServer((request, response) => {
        let body = '';
        request.on('data', (chunk) => {
          body += chunk.toString();
        });
        request.on('end', () => {
          requests++;
          expect(request.headers.authorization).toBe('Bearer host-only-secret');
          expect(body).toContain('"model":"deepseek-flash"');
          expect(body).toContain('"thinking":{"type":"enabled"}');
          expect(body).toContain('"reasoning_effort":"high"');
          if (requests === 2) {
            expect(body).toContain('"reasoning_content":"transient-reasoning-marker"');
            expect(body).toContain('host-read-result');
          }
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          const delta =
            requests === 1
              ? {
                  role: 'assistant',
                  reasoning_content: 'transient-reasoning-marker',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'read-1',
                      type: 'function',
                      function: {
                        name: 'forge_read',
                        arguments: JSON.stringify({ path: 'approved.txt' })
                      }
                    }
                  ]
                }
              : { role: 'assistant', content: 'Done' };
          response.write(
            `data: ${JSON.stringify({ id: 'reply', object: 'chat.completion.chunk', model: 'deepseek-flash', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
          );
          response.write(
            `data: ${JSON.stringify({ id: 'reply', object: 'chat.completion.chunk', model: 'deepseek-flash', choices: [{ index: 0, delta: {}, finish_reason: requests === 1 ? 'tool_calls' : 'stop' }] })}\n\n`
          );
          response.end('data: [DONE]\n\n');
        });
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      try {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          throw new Error('Missing provider');
        }
        const approved = new PiCodeReviewModelResolver().resolve({
          provider: 'deepseek',
          id: 'deepseek-flash'
        });
        if (approved === undefined) {
          throw new Error('Missing approved DeepSeek model');
        }
        const gateway = new DockerPiSessionGateway({
          image: image!,
          executable: '/usr/local/bin/node',
          args: ['/opt/forge/entrypoint.mjs'],
          timeoutMs: 30_000,
          modelProxy: new ApprovedPiHostModelProxy({
            model: { ...approved, baseUrl: `http://127.0.0.1:${address.port}/v1` },
            apiKey: 'host-only-secret',
            reasoning: 'high'
          })
        });
        await gateway.start({
          cwd: '/unmounted',
          prompt: 'Read approved.txt then finish.',
          tools: ['forge_read'],
          onStarted: async () => {},
          executeTool: async (call) => {
            expect(call.name).toBe('forge_read');
            return { content: 'host-read-result' };
          }
        });
        expect(requests).toBe(2);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
      }
    },
    60_000
  );

  it.skipIf(image === undefined)(
    'cancels actual SDK inference and drains the host model callback',
    async () => {
      const controller = new AbortController();
      let drained = false;
      const gateway = new DockerPiSessionGateway({
        image: image!,
        executable: '/usr/local/bin/node',
        args: ['/opt/forge/entrypoint.mjs'],
        timeoutMs: 30_000,
        modelProxy: new ApprovedPiHostModelProxy({
          model: isolatedPiModel,
          apiKey: 'host-only-secret',
          complete: async (_model, _context, options) => {
            controller.abort();
            if (!options?.signal?.aborted) {
              await once(options!.signal!, 'abort');
            }
            drained = true;
            throw new Error('Aborted provider');
          }
        })
      });
      await expect(
        gateway.start({
          cwd: '/unmounted',
          prompt: 'Wait',
          tools: [],
          cancellationSignal: controller.signal,
          onStarted: async () => {},
          executeTool: async () => {
            throw new Error('No tool');
          }
        })
      ).rejects.toBeInstanceOf(PiSessionCancellationConfirmedError);
      expect(drained).toBe(true);
    },
    60_000
  );
});
