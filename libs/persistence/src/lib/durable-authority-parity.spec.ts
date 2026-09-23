import { DrizzleSqliteOrchestrationPersistence } from './drizzle-sqlite-orchestration-persistence.js';
import { durableAuthorityContract } from './durable-authority.contract.test.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

durableAuthorityContract('SQLite reference', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-authority-contract-'));
  const path = join(directory, 'authority.sqlite');
  const store = new DrizzleSqliteOrchestrationPersistence(path);
  const peer = new DrizzleSqliteOrchestrationPersistence(path);
  return {
    store,
    peer,
    corruptRecord: async (kind, key, transform) => {
      const sqlite = new Database(path);
      try {
        const table = kind === 'binding' ? 'task_execution_bindings' : 'task_verification_evidence';
        const column = kind === 'binding' ? 'binding_json' : 'evidence_json';
        const keyColumn = kind === 'binding' ? 'task_id' : 'attempt_id';
        const row = sqlite
          .prepare(`select ${column} as payload from ${table} where ${keyColumn} = ?`)
          .get(key);
        if (
          row === null ||
          typeof row !== 'object' ||
          !('payload' in row) ||
          typeof row.payload !== 'string'
        ) {
          throw new Error(`Missing ${kind} corruption fixture: ${key}`);
        }
        const value: unknown = JSON.parse(row.payload);
        sqlite
          .prepare(`update ${table} set ${column} = ? where ${keyColumn} = ?`)
          .run(JSON.stringify(transform(value)), key);
      } finally {
        sqlite.close();
      }
    },
    removeRecord: async (_kind, key) => {
      const sqlite = new Database(path);
      try {
        sqlite.prepare('delete from task_execution_bindings where task_id = ?').run(key);
      } finally {
        sqlite.close();
      }
    },
    close: async () => {
      peer.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
});
