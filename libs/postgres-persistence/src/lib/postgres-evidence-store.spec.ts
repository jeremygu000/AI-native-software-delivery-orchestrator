import { describe, expect, it } from 'vitest';

import {
  assertPostgresEvidenceStoreConfiguration,
  connectPostgresEvidenceStore,
  PostgresEvidenceStoreConfigurationError
} from './postgres-evidence-store.js';

describe('PostgreSQL evidence-store configuration', () => {
  it('accepts valid Forge authority schema and role metadata', () => {
    expect(() =>
      assertPostgresEvidenceStoreConfiguration({
        connectionString: 'postgresql://forge:secret@localhost:5432/forge_authority',
        schema: 'forge_authority',
        role: 'forge_authority_writer'
      })
    ).not.toThrow();
  });

  it('rejects configuration that cannot identify a Forge PostgreSQL authority store', () => {
    expect(() =>
      assertPostgresEvidenceStoreConfiguration({
        connectionString: 'sqlite://authority.db',
        schema: 'forge_authority',
        role: 'forge_authority_writer'
      })
    ).toThrow(PostgresEvidenceStoreConfigurationError);
    expect(() =>
      assertPostgresEvidenceStoreConfiguration({
        connectionString: 'postgresql://forge:secret@localhost:5432/forge_authority',
        schema: 'forge-authority',
        role: 'forge_authority_writer'
      })
    ).toThrow('PostgreSQL identifier');
    expect(() =>
      assertPostgresEvidenceStoreConfiguration({
        connectionString: 'postgresql://forge:secret@localhost:5432/forge_authority',
        schema: 'forge_authority',
        role: ' '
      })
    ).toThrow('database role is required');
  });

  it('creates a candidate Forge authority connection with a bounded close operation', async () => {
    const connection = connectPostgresEvidenceStore({
      connectionString: 'postgresql://forge:secret@localhost:5432/forge_authority',
      schema: 'forge_authority',
      role: 'forge_authority_writer'
    });
    await expect(connection.close()).resolves.toBeUndefined();
  });
});
