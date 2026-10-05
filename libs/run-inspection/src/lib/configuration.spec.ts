import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorityConfigurationFingerprint } from '@ai-native-software-delivery-orchestrator/persistence';
import { expect, it } from 'vitest';
import { resolveInspectorConfiguration } from './configuration.js';

const authority = {
  backend: 'postgres' as const,
  connectionString: 'postgresql://forge_runtime:private-test@neon.example/neondb',
  schema: 'forge_comparison_20261005',
  role: 'forge_runtime',
  ssl: 'verify-full' as const
};
const environment = {
  FORGE_AUTHORITY_BACKEND: 'postgres',
  FORGE_WORKER_AUTHORITY_MODE: 'global',
  FORGE_POSTGRES_CONNECTION_STRING: authority.connectionString,
  FORGE_POSTGRES_SCHEMA: authority.schema,
  FORGE_POSTGRES_ROLE: authority.role,
  FORGE_POSTGRES_SSL: 'verify-full',
  FORGE_AUTHORITY_ID: authorityConfigurationFingerprint(authority),
  TEMPORAL_SERVER_URL: 'http://localhost:7233',
  TEMPORAL_NAMESPACE: 'default'
};
it('binds canonical repository, physical authority and task queue without disclosing credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-inspector-config-'));
  try {
    await mkdir(join(root, 'repository'));
    await symlink(join(root, 'repository'), join(root, 'alias'));
    const config = await resolveInspectorConfiguration({
      environment,
      label: 'Neon comparison',
      repository: join(root, 'alias'),
      taskQueue: 'neon-queue',
      operatorRoot: root
    });
    expect(config.environment.repository.endsWith('/repository')).toBe(true);
    expect(config.environment).toMatchObject({
      label: 'Neon comparison',
      schema: authority.schema,
      taskQueue: 'neon-queue',
      host: 'neon.example',
      database: 'neondb'
    });
    expect(JSON.stringify(config.environment)).not.toContain('private-test');
    const other = await resolveInspectorConfiguration({
      environment,
      label: 'Neon comparison',
      repository: join(root, 'alias'),
      taskQueue: 'other-queue',
      operatorRoot: root
    });
    expect(other.environment.id).not.toBe(config.environment.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it.each([
  ['missing backend', { FORGE_AUTHORITY_BACKEND: undefined }],
  ['local fallback', { FORGE_AUTHORITY_BACKEND: 'sqlite' }],
  ['legacy mode', { FORGE_WORKER_AUTHORITY_MODE: 'legacy' }],
  ['missing Neon URL', { FORGE_POSTGRES_CONNECTION_STRING: undefined }],
  ['missing identity', { FORGE_AUTHORITY_ID: undefined }],
  ['mismatched identity', { FORGE_AUTHORITY_ID: 'sha256:other' }],
  ['missing Temporal', { TEMPORAL_SERVER_URL: undefined }],
  ['missing namespace', { TEMPORAL_NAMESPACE: undefined }],
  ['different queue', { TEMPORAL_TASK_QUEUE: 'other' }],
  ['invalid schema', { FORGE_POSTGRES_SCHEMA: 'schema;drop' }],
  ['invalid endpoint', { TEMPORAL_SERVER_URL: 'http://localhost:7233/?credential=private' }]
])('rejects %s without querying an alternative backend', async (_label, change) => {
  await expect(
    resolveInspectorConfiguration({
      environment: { ...environment, ...change },
      label: 'Neon',
      repository: process.cwd(),
      taskQueue: 'neon-queue',
      operatorRoot: process.cwd()
    })
  ).rejects.toThrow();
});
it('refuses deployment repository mismatch', async () => {
  await expect(
    resolveInspectorConfiguration({
      environment: {
        ...environment,
        FORGE_WORKER_REPOSITORY_PATH: '/definitely-missing-deployment-repository'
      },
      label: 'Neon',
      repository: process.cwd(),
      taskQueue: 'neon-queue',
      operatorRoot: process.cwd()
    })
  ).rejects.toThrow();
});
it.each(['label', 'repository', 'taskQueue'])('requires explicit %s', async (key) => {
  await expect(
    resolveInspectorConfiguration({
      environment,
      label: 'Neon',
      repository: process.cwd(),
      taskQueue: 'neon-queue',
      operatorRoot: process.cwd(),
      [key]: ''
    })
  ).rejects.toThrow();
});
