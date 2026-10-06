import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalPlanStore } from './local-plan.js';
import { listLocalPlans, readRunView } from './run-view.js';

/** Loopback GET-only presentation. There is intentionally no approval/run endpoint. */
export async function startObservableServer(
  store: LocalPlanStore,
  port = 0,
  assets = join(dirname(fileURLToPath(import.meta.url)), 'web')
) {
  const server = createServer((request, response) => {
    void (async () => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      if (request.method !== 'GET') {
        response.writeHead(405, { Allow: 'GET' }).end();
        return;
      }
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      try {
        if (path === '/api/plans') {
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify(await listLocalPlans(store)));
          return;
        }
        const match = /^\/api\/plans\/([a-f0-9-]{36})$/.exec(path);
        if (match) {
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify(await readRunView(store, match[1])));
          return;
        }
        const asset = new Map([
          ['/', ['index.html', 'text/html; charset=utf-8']],
          ['/app.js', ['app.js', 'text/javascript']],
          ['/app.css', ['app.css', 'text/css']]
        ]).get(path);
        if (!asset) {
          response.writeHead(404).end();
          return;
        }
        const content = await readFile(join(assets, asset[0]));
        response.setHeader('Content-Type', asset[1]);
        response.end(content);
      } catch {
        response
          .writeHead(404, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ error: 'Local plan or presentation asset is unavailable.' }));
      }
    })().catch(() => {
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end();
    });
  });
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', done);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Local inspector did not bind.');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())))
  };
}
