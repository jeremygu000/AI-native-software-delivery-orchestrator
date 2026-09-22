import { DrizzleSqliteOrchestrationPersistence } from './drizzle-sqlite-orchestration-persistence.js';
import { durableAuthorityContract } from './durable-authority.contract.test.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

durableAuthorityContract('SQLite reference', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-authority-contract-'));
  const path = join(directory, 'authority.sqlite');
  const store = new DrizzleSqliteOrchestrationPersistence(path);
  const peer = new DrizzleSqliteOrchestrationPersistence(path);
  return {
    store,
    peer,
    close: async () => {
      peer.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
});
