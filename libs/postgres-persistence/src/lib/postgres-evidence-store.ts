import type {
  OrchestrationPersistence,
  TaskCodeReviewStore,
  TaskRepairAttemptStore,
  TaskRepairWorkItemStore,
  TaskVerificationEvidenceStore
} from '@ai-native-software-delivery-orchestrator/domain';
import postgres from 'postgres';

/**
 * Candidate configuration metadata for a future Forge authority persistence adapter.
 *
 * Schema and role are validation metadata only at this milestone. A future adapter must configure and test
 * search_path and role isolation with a real PostgreSQL deployment.
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

/** Opens a candidate Forge authority connection; it does not yet enforce schema or role isolation. */
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
