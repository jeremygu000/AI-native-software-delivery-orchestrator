import { readFile } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import { resolve } from 'node:path';
import type {
  ForgeRunInspection,
  InspectionEnvironment
} from '@ai-native-software-delivery-orchestrator/run-inspection/inspection';
import { InspectionError } from '@ai-native-software-delivery-orchestrator/run-inspection/observations';

export function inspectorHandler(input: {
  readonly environment: InspectionEnvironment;
  readonly origin: string;
  readonly assets: string;
  readonly inspect: (runId: string) => Promise<ForgeRunInspection>;
}): RequestListener {
  return async (request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'"
      });
      response.end(JSON.stringify(body));
    };
    if (
      request.headers.host !== new URL(input.origin).host ||
      (request.headers.origin !== undefined && request.headers.origin !== input.origin)
    ) {
      send(403, { error: 'Inspector is restricted to its loopback origin' });
      return;
    }
    if (request.method !== 'GET') {
      send(405, { error: 'Read-only inspector: GET requests only' });
      return;
    }
    try {
      const url = new URL(request.url ?? '/', input.origin);
      if (url.pathname === '/api/environment') {
        send(200, input.environment);
        return;
      }
      if (url.pathname.startsWith('/api/runs/')) {
        if (url.searchParams.get('environment') !== input.environment.id) {
          send(409, {
            error:
              'Selected environment differs from this inspector. Reload and explicitly select the environment.'
          });
          return;
        }
        const result = await input.inspect(
          decodeURIComponent(url.pathname.slice('/api/runs/'.length))
        );
        if (result.environment.id !== input.environment.id) {
          throw new InspectionError('Inspection environment mismatch', 409);
        }
        send(200, result);
        return;
      }
      const asset = {
        '/': ['index.html', 'text/html'],
        '/app.js': ['app.js', 'text/javascript'],
        '/app.css': ['app.css', 'text/css']
      }[url.pathname];
      if (asset === undefined) {
        send(404, { error: 'Not found' });
        return;
      }
      const body = await readFile(resolve(input.assets, asset[0]));
      response.writeHead(200, {
        'Content-Type': asset[1],
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy':
          "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
      });
      response.end(body);
    } catch (error) {
      send(error instanceof InspectionError ? error.status : 503, {
        error:
          error instanceof InspectionError
            ? error.message
            : 'Observation unavailable in the selected environment. No fallback was attempted.'
      });
    }
  };
}

export const createInspectorServer = (input: Parameters<typeof inspectorHandler>[0]) =>
  createServer(inspectorHandler(input));
