import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

import type {
  ActiveMutationClaimPersistence,
  CancellationPersistence,
  CancellationSettlementPersistence,
  IntegrationMutationClaimPersistence,
  OrchestrationPersistence,
  TaskCodeReviewStore,
  TaskRepairWorkItemAdmissionStore,
  TaskRepairResumeStore,
  TaskRepairWorkItemStore,
  TaskVerificationEvidenceStore
} from '@ai-native-software-delivery-orchestrator/domain';
import { PostgresOrchestrationPersistence } from '@ai-native-software-delivery-orchestrator/postgres-persistence';

import { DrizzleSqliteOrchestrationPersistence } from './drizzle-sqlite-orchestration-persistence.js';

/** PostgreSQL is selected only explicitly; absent selection preserves SQLite compatibility. */
export type AuthorityBackend = 'sqlite' | 'postgres';

export type AuthorityPersistence = OrchestrationPersistence &
  ActiveMutationClaimPersistence &
  CancellationPersistence &
  CancellationSettlementPersistence &
  IntegrationMutationClaimPersistence &
  TaskCodeReviewStore &
  TaskRepairWorkItemAdmissionStore &
  TaskRepairResumeStore &
  TaskRepairWorkItemStore &
  TaskVerificationEvidenceStore & {
    ensureInitialDispatch: NonNullable<OrchestrationPersistence['ensureInitialDispatch']>;
    close(): Promise<void> | void;
  };

export type AuthorityConfiguration =
  | { readonly backend: 'sqlite'; readonly databasePath: string }
  | {
      readonly backend: 'postgres';
      readonly connectionString: string;
      readonly schema: string;
      readonly role: string;
    };

/** Stable, credential-free identity serialized into the application deployment contract. */
export function authorityConfigurationIdentity(configuration: AuthorityConfiguration): string {
  if (configuration.backend === 'sqlite') {
    return JSON.stringify(['sqlite', configuration.databasePath]);
  }
  const url = new URL(configuration.connectionString);
  return JSON.stringify([
    'postgres',
    url.hostname.toLowerCase(),
    url.port || '5432',
    url.pathname,
    configuration.schema,
    configuration.role
  ]);
}

/** Excludes credentials while binding the physical database, schema, role and backend. */
export function authorityConfigurationFingerprint(configuration: AuthorityConfiguration): string {
  return `sha256:${createHash('sha256').update(authorityConfigurationIdentity(configuration)).digest('hex')}`;
}

const assertDeploymentIdentity = (
  configuration: AuthorityConfiguration,
  expected: string | undefined,
  allowMissingLegacySqliteIdentity = false
): void => {
  if (allowMissingLegacySqliteIdentity && expected === undefined) {
    return;
  }
  if (expected !== authorityConfigurationFingerprint(configuration)) {
    throw new Error('FORGE_AUTHORITY_ID does not match the configured authority backend and scope');
  }
};

const nonempty = (value: string | undefined, name: string): string => {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Authority deployment requires ${name}`);
  }
  return value;
};

/** Legacy per-run SQLite is available only for operator commands without deployment settings. */
export function resolveAuthorityConfiguration(
  environment: NodeJS.ProcessEnv,
  legacySqlitePath?: string
): AuthorityConfiguration {
  const backend = environment.FORGE_AUTHORITY_BACKEND;
  if (backend === undefined || backend === 'sqlite') {
    if (
      environment.FORGE_POSTGRES_CONNECTION_STRING !== undefined ||
      environment.FORGE_POSTGRES_SCHEMA !== undefined ||
      environment.FORGE_POSTGRES_ROLE !== undefined
    ) {
      throw new Error('PostgreSQL authority settings require FORGE_AUTHORITY_BACKEND=postgres');
    }
    const databasePath =
      environment.FORGE_WORKER_DATABASE_PATH ??
      (legacySqlitePath === undefined
        ? nonempty(undefined, 'FORGE_WORKER_DATABASE_PATH')
        : legacySqlitePath);
    nonempty(databasePath, 'FORGE_WORKER_DATABASE_PATH');
    if (!isAbsolute(databasePath)) {
      throw new Error('SQLite authority requires an absolute FORGE_WORKER_DATABASE_PATH');
    }
    const configuration = { backend: 'sqlite' as const, databasePath };
    assertDeploymentIdentity(configuration, environment.FORGE_AUTHORITY_ID, backend === undefined);
    return configuration;
  }
  if (backend === 'postgres') {
    if (environment.FORGE_WORKER_DATABASE_PATH !== undefined) {
      throw new Error('PostgreSQL authority cannot use FORGE_WORKER_DATABASE_PATH');
    }
    const configuration: AuthorityConfiguration = {
      backend,
      connectionString: nonempty(
        environment.FORGE_POSTGRES_CONNECTION_STRING,
        'FORGE_POSTGRES_CONNECTION_STRING'
      ),
      schema: nonempty(environment.FORGE_POSTGRES_SCHEMA, 'FORGE_POSTGRES_SCHEMA'),
      role: nonempty(environment.FORGE_POSTGRES_ROLE, 'FORGE_POSTGRES_ROLE')
    };
    assertDeploymentIdentity(configuration, environment.FORGE_AUTHORITY_ID);
    return configuration;
  }
  throw new Error('FORGE_AUTHORITY_BACKEND must be sqlite or postgres');
}

/** The sole production backend constructor. PostgreSQL always crosses its reviewed startup gate. */
export async function openAuthorityPersistence(
  configuration: AuthorityConfiguration
): Promise<AuthorityPersistence> {
  if (configuration.backend === 'sqlite') {
    return new DrizzleSqliteOrchestrationPersistence(configuration.databasePath);
  }
  return PostgresOrchestrationPersistence.connect(configuration);
}
