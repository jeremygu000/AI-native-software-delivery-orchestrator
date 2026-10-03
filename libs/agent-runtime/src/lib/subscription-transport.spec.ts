import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { completeSimple } from '@mariozechner/pi-ai';
import {
  GitHubCopilotExecutionAdapter,
  CodexSubscriptionExecutionAdapter,
  type SubscriptionCredentialStore
} from './model-execution-provider.js';

describe('Independent subscription SDK transports', () => {
  it.each(['github-copilot', 'openai-codex'] as const)(
    'exercises real %s HTTP/SSE transport with host-only session credentials',
    async (provider) => {
      const access =
        provider === 'openai-codex'
          ? `test.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url')}.test`
          : 'fixture-copilot-session';
      const requests: {
        path: string;
        authorization: string | undefined;
        account: string | undefined;
        body: Record<string, unknown>;
      }[] = [];
      const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        requests.push({
          path: request.url ?? '',
          authorization: request.headers.authorization,
          account:
            typeof request.headers['chatgpt-account-id'] === 'string'
              ? request.headers['chatgpt-account-id']
              : undefined,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
        });
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (provider === 'github-copilot') {
          response.write(
            `data: ${JSON.stringify({ id: 'fixture-response', choices: [{ index: 0, delta: { role: 'assistant', content: 'subscription-ready' }, finish_reason: null }] })}\n\n`
          );
          response.write(
            `data: ${JSON.stringify({ id: 'fixture-response', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`
          );
          response.end('data: [DONE]\n\n');
        } else {
          const item = {
            id: 'msg_fixture',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'subscription-ready', annotations: [] }]
          };
          for (const event of [
            {
              type: 'response.created',
              response: { id: 'resp_fixture', status: 'in_progress', output: [] }
            },
            {
              type: 'response.output_item.added',
              output_index: 0,
              item: { ...item, status: 'in_progress', content: [] }
            },
            {
              type: 'response.content_part.added',
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              part: { type: 'output_text', text: '', annotations: [] }
            },
            {
              type: 'response.output_text.delta',
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              delta: 'subscription-ready'
            },
            { type: 'response.output_item.done', output_index: 0, item },
            {
              type: 'response.completed',
              response: {
                id: 'resp_fixture',
                status: 'completed',
                output: [item],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
              }
            }
          ]) {
            response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          }
          response.end();
        }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          throw new Error('Missing fixture HTTP port');
        }
        const store: SubscriptionCredentialStore = {
          load: async () => ({ access, refresh: 'fixture-refresh', expires: Date.now() + 600_000 }),
          save: async () => {
            throw new Error('No refresh expected');
          },
          withLock: async (_id, work) => work()
        };
        const complete: typeof completeSimple = (model, context, options) =>
          completeSimple(
            {
              ...model,
              baseUrl: `http://127.0.0.1:${address.port}${provider === 'github-copilot' ? '/v1' : '/backend-api'}`
            },
            context,
            options
          );
        const adapter =
          provider === 'github-copilot'
            ? new GitHubCopilotExecutionAdapter(store, { complete })
            : new CodexSubscriptionExecutionAdapter(store, { complete });
        const target = adapter.resolve(
          provider === 'github-copilot' ? 'gpt-4.1' : 'gpt-5.4',
          provider === 'github-copilot' ? 'off' : 'high'
        );
        const reply = await adapter.complete(
          target,
          { messages: [{ role: 'user', content: 'Return a short response.', timestamp: 1 }] },
          new AbortController().signal
        );
        expect(reply.content).toContainEqual(
          expect.objectContaining({ type: 'text', text: 'subscription-ready' })
        );
        expect(requests).toHaveLength(1);
        expect(requests[0]?.authorization).toBe(`Bearer ${access}`);
        expect(requests[0]?.path).toBe(
          provider === 'github-copilot' ? '/v1/chat/completions' : '/backend-api/codex/responses'
        );
        if (provider === 'openai-codex') {
          expect(requests[0]?.account).toBe('fixture-account');
          expect(requests[0]?.body.reasoning).toMatchObject({ effort: 'high' });
        }
        expect(JSON.stringify(target)).not.toContain(access);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error === undefined ? resolve() : reject(error)))
        );
      }
    }
  );
});
