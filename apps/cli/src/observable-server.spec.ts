import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LocalPlanStore } from './local-plan.js';
import { startObservableServer } from './observable-server.js';

describe('local inspector HTTP failure and lifecycle behavior', () => {
  it('serves only fixed assets and hides missing/corrupt plan and asset details', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'forge-http-'));
    const server = await startObservableServer(
      new LocalPlanStore(join(directory, 'state')),
      0,
      directory
    );
    try {
      await writeFile(join(directory, 'app.js'), 'console.log("fixture")');
      await writeFile(join(directory, 'app.css'), 'body {}');
      for (const [path, type] of [
        ['/app.js', 'text/javascript'],
        ['/app.css', 'text/css']
      ]) {
        const response = await fetch(`${server.url}${path}`);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe(type);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      }
      for (const path of ['/', `/api/plans/${randomUUID()}`]) {
        const response = await fetch(`${server.url}${path}`);
        expect(response.status).toBe(404);
        const body = await response.text();
        expect(body).toBe('{"error":"Local plan or presentation asset is unavailable."}');
        expect(body).not.toContain(directory);
      }
      expect((await fetch(`${server.url}/not-an-asset`)).status).toBe(404);
      const mutation = await fetch(`${server.url}/api/plans`, { method: 'DELETE' });
      expect(mutation.status).toBe(405);
      expect(mutation.headers.get('allow')).toBe('GET');
      const port = Number(new URL(server.url).port);
      await expect(
        startObservableServer(new LocalPlanStore(directory), port, directory)
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
      await server.close();
      await expect(server.close()).rejects.toMatchObject({ code: 'ERR_SERVER_NOT_RUNNING' });
    } finally {
      await server.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
