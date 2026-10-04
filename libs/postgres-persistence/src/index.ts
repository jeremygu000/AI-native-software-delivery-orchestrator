export {
  PostgresEvidenceStoreConfigurationError,
  connectPostgresEvidenceStore,
  type PostgresEvidenceStoreConfiguration,
  type PostgresEvidenceStoreFactory
} from './lib/postgres-evidence-store.js';
export { PostgresOrchestrationPersistence } from './lib/postgres-orchestration-persistence.js';
export { PostgresGlobalMutationAuthority } from './lib/postgres-global-mutation-authority.js';
export type {
  GlobalIntegrationExecution,
  RecoveredExecutionChild,
  ExecutionChildContainer,
  WorkspaceSetupRecoverySnapshot
} from './lib/postgres-global-mutation-authority.js';
export { PostgresWorkspaceSetupAdmission } from './lib/postgres-workspace-setup-admission.js';
export {
  PostgresTrustRegistryAdmin,
  PostgresExecutionGenerationIssuer,
  type GenerationBinding
} from './lib/postgres-trust-writers.js';
export {
  migratePostgresAuthoritySchema,
  assertPostgresAuthorityLogin,
  POSTGRES_AUTHORITY_SCHEMA_VERSION,
  POSTGRES_GLOBAL_AUTHORITY_SCHEMA_VERSION
} from './lib/postgres-authority-schema.js';
// Deployment preflight shares the adapter's explicit supported-major contract.
export {
  POSTGRES_AUTHORITY_SERVER_MAJORS,
  resolvePostgresAuthorityServerMajor
} from './lib/postgres-server-version.js';
// CLI, worker and independent operators share the explicit PostgreSQL transport boundary.
export { openPostgresConnection, resolvePostgresConnectionSsl } from './lib/postgres-connection.js';
// Independent recovery operators must use the same restricted-role membership audit.
export { assertRestrictedPostgresRoleMemberships } from './lib/postgres-role-membership.js';
// Deployment operators prepare a schema without acquiring database-wide authority for Forge roles.
export {
  preparePostgresAuthoritySchema,
  assertEmptyPostgresAuthoritySchema,
  assertComparisonSchemaName
} from './lib/postgres-schema-deployment.js';
