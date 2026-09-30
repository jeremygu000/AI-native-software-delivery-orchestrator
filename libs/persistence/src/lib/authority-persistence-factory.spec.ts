import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import {
  authorityConfigurationFingerprint,
  openAuthorityPersistence,
  resolveAuthorityConfiguration
} from './authority-persistence-factory.js';

const sqlite = join(process.cwd(), 'fixture', 'authority.sqlite');
const postgres = {
  FORGE_AUTHORITY_BACKEND: 'postgres',
  FORGE_POSTGRES_CONNECTION_STRING: 'postgresql://forge_runtime:secret@localhost:5432/forge',
  FORGE_POSTGRES_SCHEMA: 'forge_prod',
  FORGE_POSTGRES_ROLE: 'forge_runtime'
};

describe('production authority routing', () => {
  it('keeps the documented SQLite compatibility route without guessing from DATABASE_URL', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'forge-route-sqlite-'));
    const configuration = resolveAuthorityConfiguration({
      FORGE_WORKER_DATABASE_PATH: join(directory, 'run.sqlite'),
      DATABASE_URL: 'postgresql://unexpected:secret@localhost/forge'
    });
    try {
      expect(configuration).toEqual({
        backend: 'sqlite',
        databasePath: join(directory, 'run.sqlite')
      });
      const store = await openAuthorityPersistence(configuration);
      try {
        expect(await store.recoverRun('missing')).toBeUndefined();
      } finally {
        await store.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses a legacy worker after SQLite global cutover rather than falling back to local tools', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'forge-route-cutover-'));
    const databasePath = join(directory, 'run.sqlite');
    try {
      const store = await openAuthorityPersistence({ backend: 'sqlite', databasePath });
      try {
        expect(store.assertLegacyWorkerCompositionAllowed()).toBeUndefined();
        const control = new Database(databasePath);
        try {
          control.prepare("update forge_global_control set state='GLOBAL_READY' where id=1").run();
        } finally {
          control.close();
        }
        expect(() => store.assertLegacyWorkerCompositionAllowed()).toThrow(
          'Legacy mutation admission is closed by global cutover'
        );
      } finally {
        await store.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects partial and contradictory deployment configuration', () => {
    expect(() => resolveAuthorityConfiguration({ FORGE_AUTHORITY_BACKEND: 'other' })).toThrow(
      'FORGE_AUTHORITY_BACKEND must be sqlite or postgres'
    );
    expect(() => resolveAuthorityConfiguration({ FORGE_AUTHORITY_BACKEND: 'postgres' })).toThrow(
      'FORGE_POSTGRES_CONNECTION_STRING'
    );
    expect(() =>
      resolveAuthorityConfiguration({ ...postgres, FORGE_WORKER_DATABASE_PATH: sqlite })
    ).toThrow('PostgreSQL authority cannot use FORGE_WORKER_DATABASE_PATH');
    expect(() =>
      resolveAuthorityConfiguration({
        FORGE_POSTGRES_SCHEMA: 'forge_prod',
        FORGE_WORKER_DATABASE_PATH: sqlite
      })
    ).toThrow('PostgreSQL authority settings require');
    expect(() =>
      resolveAuthorityConfiguration({
        FORGE_AUTHORITY_BACKEND: 'sqlite',
        FORGE_WORKER_DATABASE_PATH: './relative'
      })
    ).toThrow('SQLite authority requires an absolute');
  });

  it('requires deployment identity for explicit SQLite but preserves backend-unset compatibility', () => {
    expect(() =>
      resolveAuthorityConfiguration({
        FORGE_AUTHORITY_BACKEND: 'sqlite',
        FORGE_WORKER_DATABASE_PATH: sqlite
      })
    ).toThrow('FORGE_AUTHORITY_ID does not match');
    expect(resolveAuthorityConfiguration({ FORGE_WORKER_DATABASE_PATH: sqlite })).toEqual({
      backend: 'sqlite',
      databasePath: sqlite
    });
    const expected = authorityConfigurationFingerprint({ backend: 'sqlite', databasePath: sqlite });
    expect(
      resolveAuthorityConfiguration({
        FORGE_AUTHORITY_BACKEND: 'sqlite',
        FORGE_WORKER_DATABASE_PATH: sqlite,
        FORGE_AUTHORITY_ID: expected
      })
    ).toEqual({ backend: 'sqlite', databasePath: sqlite });
    expect(() =>
      resolveAuthorityConfiguration({
        FORGE_WORKER_DATABASE_PATH: join(process.cwd(), 'fixture', 'other.sqlite'),
        FORGE_AUTHORITY_ID: expected
      })
    ).toThrow('FORGE_AUTHORITY_ID does not match');
  });

  it('rejects a worker configured for SQLite B with the expected identity of CLI SQLite A', () => {
    const cliDatabase = join(process.cwd(), 'authority', 'A.sqlite');
    const workerDatabase = join(process.cwd(), 'authority', 'B.sqlite');
    const expected = authorityConfigurationFingerprint({
      backend: 'sqlite',
      databasePath: cliDatabase
    });
    expect(
      resolveAuthorityConfiguration({
        FORGE_AUTHORITY_BACKEND: 'sqlite',
        FORGE_WORKER_DATABASE_PATH: cliDatabase,
        FORGE_AUTHORITY_ID: expected
      })
    ).toEqual({ backend: 'sqlite', databasePath: cliDatabase });
    expect(() =>
      resolveAuthorityConfiguration({
        FORGE_AUTHORITY_BACKEND: 'sqlite',
        FORGE_WORKER_DATABASE_PATH: workerDatabase,
        FORGE_AUTHORITY_ID: expected
      })
    ).toThrow('FORGE_AUTHORITY_ID does not match');
  });

  it('binds both processes to one backend, database, schema and role without exposing credentials', () => {
    const configuration = resolveAuthorityConfiguration({
      ...postgres,
      FORGE_AUTHORITY_ID: authorityConfigurationFingerprint({
        backend: 'postgres',
        connectionString: postgres.FORGE_POSTGRES_CONNECTION_STRING,
        schema: 'forge_prod',
        role: 'forge_runtime'
      })
    });
    expect(configuration.backend).toBe('postgres');
    expect(authorityConfigurationFingerprint(configuration)).not.toContain('secret');
    for (const mismatch of [
      { FORGE_AUTHORITY_BACKEND: 'sqlite', FORGE_WORKER_DATABASE_PATH: sqlite },
      { ...postgres, FORGE_POSTGRES_SCHEMA: 'other' },
      {
        ...postgres,
        FORGE_POSTGRES_CONNECTION_STRING: 'postgresql://forge_runtime:secret@localhost/other'
      }
    ]) {
      expect(() =>
        resolveAuthorityConfiguration({
          ...mismatch,
          FORGE_AUTHORITY_ID: authorityConfigurationFingerprint(configuration)
        })
      ).toThrow('FORGE_AUTHORITY_ID does not match');
    }
    expect(() => resolveAuthorityConfiguration(postgres)).toThrow(
      'FORGE_AUTHORITY_ID does not match'
    );
  });
});
