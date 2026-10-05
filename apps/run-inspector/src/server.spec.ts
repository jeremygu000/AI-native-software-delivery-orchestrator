import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type {
  ForgeRunInspection,
  InspectionEnvironment
} from '@ai-native-software-delivery-orchestrator/run-inspection/inspection';
import { InspectionError } from '@ai-native-software-delivery-orchestrator/run-inspection/observations';
import { createInspectorServer } from './server.js';

const environment: InspectionEnvironment = {
  id: 'explicit-env',
  label: 'Neon fixture',
  authorityMode: 'global',
  database: 'neondb',
  host: 'fixture.example',
  schema: 'forge_comparison_20261005',
  role: 'forge_runtime',
  taskQueue: 'neon-queue',
  namespace: 'default',
  repository: '/fixture'
};
const inspection: ForgeRunInspection = {
  version: 1,
  environment,
  runId: 'run-1',
  refreshedAt: new Date().toISOString(),
  tasks: [],
  nodes: [],
  edges: [],
  sources: []
};
const inspect = vi.fn(async (_runId: string) => inspection);
let assets: string;
let origin: string;
let server: ReturnType<typeof createInspectorServer>;
beforeAll(async () => {
  assets = await mkdtemp(join(tmpdir(), 'forge-inspector-http-'));
  await writeFile(join(assets, 'index.html'), '<html>Fixture</html>');
  await writeFile(join(assets, 'app.js'), '// fixture');
  await writeFile(join(assets, 'app.css'), 'body {}');
  server = createInspectorServer({ environment, origin: 'http://127.0.0.1:4777', assets, inspect });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Missing test address');
  }
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(assets, { recursive: true, force: true });
});
const call = (path: string, method = 'GET', headers: Record<string, string> = {}) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      `${origin}${path}`,
      { method, headers: { host: '127.0.0.1:4777', ...headers } },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (part: string) => {
          body += part;
        });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
it('serves the fixed credential-free environment and exact inspection', async () => {
  const response = await call('/api/environment');
  expect(response.status).toBe(200);
  expect(JSON.parse(response.body)).toEqual(environment);
  const run = await call('/api/runs/run-1?environment=explicit-env');
  expect(run.status).toBe(200);
  expect(JSON.parse(run.body)).toEqual(inspection);
  expect(inspect).toHaveBeenCalledWith('run-1');
});
it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('has no %s mutation API', async (method) => {
  expect((await call('/api/runs/run-1?environment=explicit-env', method)).status).toBe(405);
});
it('rejects missing and mismatched environment without reaching a data source', async () => {
  inspect.mockClear();
  expect((await call('/api/runs/run-1')).status).toBe(409);
  expect((await call('/api/runs/run-1?environment=local-env')).status).toBe(409);
  expect(inspect).not.toHaveBeenCalled();
});
it('rejects foreign origins/hosts', async () => {
  expect(
    (await call('/api/environment', 'GET', { origin: 'https://external.example' })).status
  ).toBe(403);
  expect((await call('/api/environment', 'GET', { host: 'external.example' })).status).toBe(403);
});
it('never discloses database/provider exception bodies', async () => {
  inspect.mockRejectedValueOnce(new Error('private-test-password / driver detail'));
  const response = await call('/api/runs/run-1?environment=explicit-env');
  expect(response.status).toBe(503);
  expect(response.body).not.toContain('private-test-password');
});
it('reports an authoritative mismatch/not-found distinctly', async () => {
  inspect.mockRejectedValueOnce(new InspectionError('Run not found in selected environment', 404));
  expect((await call('/api/runs/run-1?environment=explicit-env')).status).toBe(404);
  inspect.mockResolvedValueOnce({ ...inspection, environment: { ...environment, id: 'other' } });
  expect((await call('/api/runs/run-1?environment=explicit-env')).status).toBe(409);
});
it.each(['/', '/app.js', '/app.css'])('serves only the known asset %s', async (path) =>
  expect((await call(path)).status).toBe(200)
);
it.each(['/api/recover', '/private.env', '/../../.env.local'])(
  'refuses unknown or private route %s',
  async (path) => expect((await call(path)).status).toBe(404)
);
