import type {
  OrchestrationPersistence,
  TaskCodeReviewStore,
  TaskRepairAttemptStore,
  TaskRepairWorkItemStore,
  TaskVerificationEvidenceStore
} from '@ai-native-software-delivery-orchestrator/domain';
import postgres from 'postgres';

/**
 * Runtime V2 configuration boundary for Forge authority persistence.
 *
 * A concrete driver is deliberately deferred until the PostgreSQL deployment and driver selection are
 * validated. This prevents Temporal persistence settings from becoming Forge evidence configuration.
 */
export interface PostgresEvidenceStoreConfiguration {
  readonly connectionString: string;
  readonly schema: string;
  readonly role: string;
}

export type PostgresEvidenceStore = OrchestrationPersistence &
  TaskCodeReviewStore &
  TaskRepairAttemptStore &
  TaskRepairWorkItemStore &
  TaskVerificationEvidenceStore;

export interface PostgresEvidenceStoreFactory {
  create(configuration: PostgresEvidenceStoreConfiguration): Promise<PostgresEvidenceStore>;
}

export interface PostgresEvidenceStoreConnection {
  close(): Promise<void>;
}

export class PostgresEvidenceStoreConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PostgresEvidenceStoreConfigurationError';
  }
}

export const assertPostgresEvidenceStoreConfiguration = (
  configuration: PostgresEvidenceStoreConfiguration
): void => {
  if (!configuration.connectionString.startsWith('postgres')) {
    throw new PostgresEvidenceStoreConfigurationError(
      'Forge evidence store requires a PostgreSQL connection string'
    );
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(configuration.schema)) {
    throw new PostgresEvidenceStoreConfigurationError(
      'Forge evidence schema must be a PostgreSQL identifier'
    );
  }
  if (configuration.role.trim().length === 0) {
    throw new PostgresEvidenceStoreConfigurationError('Forge evidence database role is required');
  }
};

/** Opens a Forge authority connection without sharing Temporal persistence configuration. */
export const connectPostgresEvidenceStore = (
  configuration: PostgresEvidenceStoreConfiguration
): PostgresEvidenceStoreConnection => {
  assertPostgresEvidenceStoreConfiguration(configuration);
  const sql = postgres(configuration.connectionString, {
    connection: { application_name: 'forge-authority' },
    onnotice: () => undefined
  });
  return { close: async () => sql.end({ timeout: 5 }) };
};
