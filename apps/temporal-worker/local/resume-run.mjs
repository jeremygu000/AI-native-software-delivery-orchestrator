import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import {
  JsonFilePlanApprovalStore,
  JsonFilePlanArtifactStore
} from '@ai-native-software-delivery-orchestrator/persistence';
import { PostgresOrchestrationPersistence } from '@ai-native-software-delivery-orchestrator/postgres-persistence';
import {
  resolveTemporalConfig,
  startForgeRun
} from '@ai-native-software-delivery-orchestrator/temporal-runtime';

// Resume only an already approved durable run, never bind a changed repository
// to a new approval or recreate claims/workspaces after partial integration.
const root = resolve(import.meta.dirname, '../../..');
const env = parseEnv(await readFile(resolve(root, '.env.local'), 'utf8'));
const [runId, artifactId, approvalId] = process.argv.slice(2);
if (!runId || !artifactId || !approvalId) {
  throw new Error('Usage: resume-run run-id artifact-id approval-id');
}
const plans = resolve(root, '.local/plans');
const artifact = await new JsonFilePlanArtifactStore(plans).load(artifactId, 1);
const store = new JsonFilePlanApprovalStore(plans);
const approval = await store.load(approvalId);
const claim = await store.loadClaim(approvalId);
if (
  !artifact ||
  !approval ||
  approval.artifactId !== artifact.artifactId ||
  approval.artifactRevision !== artifact.revision ||
  approval.planFingerprint !== artifact.planFingerprint ||
  claim?.runId !== runId ||
  claim.artifactId !== artifactId ||
  claim.planFingerprint !== artifact.planFingerprint
) {
  throw new Error('Resume requires the exact artifact and already claimed approval');
}
const persistence = await PostgresOrchestrationPersistence.connect({
  connectionString: env.FORGE_POSTGRES_CONNECTION_STRING,
  schema: env.FORGE_POSTGRES_SCHEMA,
  role: env.FORGE_POSTGRES_ROLE
});
try {
  await persistence.assertGlobalWorkerCompositionAllowed();
  const recovered = await persistence.recoverRun(runId);
  const authority = recovered?.run.authority;
  if (
    !recovered ||
    recovered.run.state !== 'ACTIVE' ||
    recovered.run.repositoryId !== artifact.repository.repositoryId ||
    authority?.artifactId !== artifactId ||
    authority.artifactRevision !== artifact.revision ||
    authority.planFingerprint !== artifact.planFingerprint ||
    authority.approvalId !== approvalId ||
    authority.approvalFingerprint !== approval.approvalFingerprint ||
    authority.repositoryRoot !== artifact.repository.repositoryRoot ||
    authority.baseCommit !== artifact.repository.baseCommit
  ) {
    throw new Error('Persisted run differs from its immutable approved identity');
  }
  await persistence.assertGlobalRunBinding(runId, recovered.run.repositoryId, 'global');
  const workflow = await startForgeRun(
    resolveTemporalConfig({
      serverUrl: env.TEMPORAL_SERVER_URL,
      namespace: env.TEMPORAL_NAMESPACE,
      taskQueue: env.TEMPORAL_TASK_QUEUE
    }),
    runId
  );
  console.log(JSON.stringify({ runId, ...workflow }));
} finally {
  await persistence.close();
}
