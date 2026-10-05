import postgres from 'postgres';
import { afterEach, expect, it, vi } from 'vitest';
import { migratePostgresAuthoritySchema } from './postgres-authority-schema.js';
import {
  connectPostgresEvidenceStore,
  type PostgresEvidenceStoreConfiguration
} from './postgres-evidence-store.js';
import { PostgresOrchestrationPersistence } from './postgres-orchestration-persistence.js';
import { PostgresGlobalMutationAuthority } from './postgres-global-mutation-authority.js';
import {
  PostgresTrustRegistryAdmin,
  PostgresExecutionGenerationIssuer
} from './postgres-trust-writers.js';
import { PostgresWorkspaceSetupAdmission } from './postgres-workspace-setup-admission.js';

const observation = vi.hoisted(() => ({ ssl: undefined as unknown }));
vi.mock('postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof import('postgres')>();
  return {
    ...actual,
    default: vi.fn((...args: Parameters<typeof actual.default>) => {
      const sql = actual.default(...args);
      observation.ssl = sql.options.ssl;
      void sql.end();
      // Stop at the real client's configured options, before any startup query or socket.
      throw new Error('observed explicit transport');
    })
  };
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  observation.ssl = undefined;
});

it('configures the audited observation client as read-only at session startup', async () => {
  await expect(
    PostgresOrchestrationPersistence.connectReadOnly({
      connectionString: 'postgresql://forge_runtime:private-test@database.example/forge',
      schema: 'forge',
      role: 'forge_runtime',
      ssl: 'verify-full'
    })
  ).rejects.toThrow('observed explicit transport');
  expect(postgres).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      ssl: 'verify-full',
      connection: expect.objectContaining({
        default_transaction_read_only: true,
        search_path: 'pg_catalog, pg_temp'
      })
    })
  );
});

it.each([
  [
    'migration owner',
    'forge_owner',
    async (config) => migratePostgresAuthoritySchema(config, 'forge_runtime')
  ],
  [
    'runtime persistence',
    'forge_runtime',
    async (config) => PostgresOrchestrationPersistence.connect(config)
  ],
  [
    'global authority',
    'forge_runtime',
    async (config) => PostgresGlobalMutationAuthority.connect(config)
  ],
  [
    'trust administrator',
    'forge_trust',
    async (config) => PostgresTrustRegistryAdmin.connect(config)
  ],
  [
    'generation issuer',
    'forge_issuer',
    async (config) => PostgresExecutionGenerationIssuer.connect(config)
  ],
  [
    'setup admission',
    'forge_setup',
    async (config) => PostgresWorkspaceSetupAdmission.connect(config)
  ],
  ['evidence store', 'forge_runtime', async (config) => connectPostgresEvidenceStore(config)]
] satisfies readonly (readonly [
  string,
  string,
  (configuration: PostgresEvidenceStoreConfiguration) => Promise<unknown>
])[])('%s forwards verified TLS into its real Postgres.js client', async (_name, role, connect) => {
  vi.stubEnv('PGSSL', 'false');
  const connectionString = `postgresql://${role}:private-test@database.example/forge`;
  await expect(
    connect({ connectionString, schema: 'forge', role, ssl: 'verify-full' })
  ).rejects.toThrow('observed explicit transport');
  expect(postgres).toHaveBeenCalledWith(
    connectionString,
    expect.objectContaining({ ssl: 'verify-full' })
  );
  expect(observation.ssl).toBe('verify-full');
});
