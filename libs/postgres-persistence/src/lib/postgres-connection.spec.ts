import postgres from 'postgres';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openPostgresConnection, resolvePostgresConnectionSsl } from './postgres-connection.js';

vi.mock('postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof import('postgres')>();
  // Use the real lazy client; observe constructor calls without opening a socket.
  return { ...actual, default: vi.fn(actual.default) };
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('explicit PostgreSQL transport', () => {
  it.each([undefined, false] as const)(
    'rejects non-loopback ssl=%s before client creation, even with PGSSL',
    (ssl) => {
      vi.stubEnv('PGSSL', 'verify-full');
      expect(() =>
        openPostgresConnection({
          connectionString: 'postgresql://forge_runtime:private-test@database.example/forge',
          ssl
        })
      ).toThrow('explicit ssl=verify-full');
      expect(postgres).not.toHaveBeenCalled();
    }
  );

  it.each(['runtime', 'owner', 'trust', 'issuer', 'setup', 'recovery'])(
    'passes verified TLS into the real %s client despite a conflicting environment',
    async (role) => {
      vi.stubEnv('PGSSL', 'false');
      const connectionString = `postgresql://forge_${role}:private-test@database.example/forge`;
      const sql = openPostgresConnection({ connectionString, ssl: 'verify-full' }, { max: 1 });
      try {
        expect(postgres).toHaveBeenCalledWith(connectionString, {
          max: 1,
          ssl: 'verify-full',
          connection: { search_path: 'pg_catalog, pg_temp' }
        });
        expect(sql.options.ssl).toBe('verify-full');
      } finally {
        await sql.end();
      }
    }
  );

  it('keeps catalog resolution ahead of temporary objects and overrides caller search_path', async () => {
    const sql = openPostgresConnection(
      { connectionString: 'postgresql://forge@localhost/forge' },
      { connection: { search_path: 'public' } }
    );
    expect(sql.options.connection.search_path).toBe('pg_catalog, pg_temp');
    await sql.end();
  });

  it('keeps loopback development explicit and independent of PGSSL', async () => {
    vi.stubEnv('PGSSL', 'verify-full');
    const sql = openPostgresConnection({ connectionString: 'postgresql://forge@127.0.0.1/forge' });
    expect(sql.options.ssl).toBe(false);
    await sql.end();
  });

  it.each(['?options=-c%20role=owner', '?sslmode=verify-full', '?user=owner'])(
    'rejects URL query configuration %s even with verified TLS',
    (query) => {
      expect(() =>
        openPostgresConnection({
          connectionString: `postgresql://forge_runtime@database.example/forge${query}`,
          ssl: 'verify-full'
        })
      ).toThrow('query-free');
      expect(postgres).not.toHaveBeenCalled();
    }
  );

  it('does not expose malformed credential input', () => {
    expect(() =>
      openPostgresConnection({ connectionString: 'invalid-private-test-secret' })
    ).toThrow('Invalid private PostgreSQL connection');
    expect(postgres).not.toHaveBeenCalled();
  });

  it.each(['require', 'prefer', 'true', 'verify-ca', ''])(
    'rejects weakened or malformed deployment TLS %s',
    (value) => {
      expect(() => resolvePostgresConnectionSsl(value)).toThrow('FORGE_POSTGRES_SSL');
      const untypedDeployment = {
        connectionString: 'postgresql://forge@localhost/forge',
        ssl: false as const
      };
      Reflect.set(untypedDeployment, 'ssl', value);
      expect(() => openPostgresConnection(untypedDeployment)).toThrow(
        'ssl=false or ssl=verify-full'
      );
      expect(postgres).not.toHaveBeenCalled();
    }
  );

  it('resolves only supported explicit deployment options', () => {
    expect(resolvePostgresConnectionSsl(undefined)).toBeUndefined();
    expect(resolvePostgresConnectionSsl('false')).toBe(false);
    expect(resolvePostgresConnectionSsl('verify-full')).toBe('verify-full');
  });
});
