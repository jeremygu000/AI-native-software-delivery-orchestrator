import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  authorityConfigurationFingerprint,
  resolveAuthorityConfiguration
} from '@ai-native-software-delivery-orchestrator/persistence';
import type { PostgresEvidenceStoreConfiguration } from '@ai-native-software-delivery-orchestrator/postgres-persistence';
import type { InspectionEnvironment } from './inspection.js';

export interface InspectorConfiguration {
  readonly authority: PostgresEvidenceStoreConfiguration;
  readonly environment: InspectionEnvironment;
  readonly temporalAddress: string;
  readonly operatorRoot: string;
}
export async function resolveInspectorConfiguration(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly label: string;
  readonly repository: string;
  readonly taskQueue: string;
  readonly operatorRoot: string;
}): Promise<InspectorConfiguration> {
  const env = input.environment;
  if (env.FORGE_AUTHORITY_BACKEND !== 'postgres' || env.FORGE_WORKER_AUTHORITY_MODE !== 'global') {
    throw new Error('Inspector requires an explicitly configured global PostgreSQL environment');
  }
  for (const value of [
    input.label,
    input.repository,
    input.taskQueue,
    env.TEMPORAL_SERVER_URL,
    env.TEMPORAL_NAMESPACE
  ]) {
    if (value === undefined || value.trim() === '') {
      throw new Error(
        'Inspector requires environment label, repository, task queue and Temporal server/namespace'
      );
    }
  }
  const authority = resolveAuthorityConfiguration(env);
  if (authority.backend !== 'postgres') {
    throw new Error('Inspector cannot fall back to another authority');
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(authority.schema)) {
    throw new Error('Invalid inspector schema');
  }
  const repository = await realpath(resolve(input.repository));
  if (
    env.FORGE_WORKER_REPOSITORY_PATH !== undefined &&
    (await realpath(env.FORGE_WORKER_REPOSITORY_PATH)) !== repository
  ) {
    throw new Error('Inspector repository differs from the selected deployment');
  }
  if (env.TEMPORAL_TASK_QUEUE !== undefined && env.TEMPORAL_TASK_QUEUE !== input.taskQueue) {
    throw new Error('Inspector task queue differs from the selected deployment');
  }
  const url = new URL(authority.connectionString);
  const temporal = new URL(env.TEMPORAL_SERVER_URL!);
  if (
    !['http:', 'https:'].includes(temporal.protocol) ||
    temporal.username ||
    temporal.password ||
    temporal.search ||
    temporal.pathname !== '/'
  ) {
    throw new Error('Invalid Temporal endpoint');
  }
  const id = createHash('sha256')
    .update(
      JSON.stringify([
        authorityConfigurationFingerprint(authority),
        repository,
        temporal.host,
        env.TEMPORAL_NAMESPACE,
        input.taskQueue
      ])
    )
    .digest('hex');
  return {
    authority,
    temporalAddress: temporal.host,
    operatorRoot: await realpath(resolve(input.operatorRoot)),
    environment: {
      id,
      label: input.label,
      authorityMode: 'global',
      database: decodeURIComponent(url.pathname.slice(1)),
      host: url.hostname,
      schema: authority.schema,
      role: authority.role,
      repository,
      taskQueue: input.taskQueue,
      namespace: env.TEMPORAL_NAMESPACE!
    }
  };
}
