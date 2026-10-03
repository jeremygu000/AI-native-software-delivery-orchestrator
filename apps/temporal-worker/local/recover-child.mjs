import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import postgres from 'postgres';
import { DockerPiSessionGateway } from '@ai-native-software-delivery-orchestrator/agent-runtime';
import { PostgresGlobalMutationAuthority } from '@ai-native-software-delivery-orchestrator/postgres-persistence';

// Independent local operator: never infer quiescence from a lease timeout.
const [runId, deadWorkerPidText, repairAttemptId] = process.argv.slice(2);
const deadWorkerPid = Number(deadWorkerPidText);
if (!runId || !Number.isSafeInteger(deadWorkerPid) || deadWorkerPid <= 1) {
  throw new Error('Usage: recover-child run-id exited-worker-pid [repair-attempt-id]');
}
try {
  process.kill(deadWorkerPid, 0);
  throw new Error('Original worker is still alive; no reclamation permitted');
} catch (error) {
  if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') {
    throw error;
  }
}
const env = parseEnv(await readFile(resolve('.env.local'), 'utf8'));
const configuration = {
  connectionString: env.FORGE_POSTGRES_CONNECTION_STRING,
  schema: env.FORGE_POSTGRES_SCHEMA,
  role: env.FORGE_POSTGRES_ROLE
};
const sql = postgres(configuration.connectionString, { max: 1 });
const authority = await PostgresGlobalMutationAuthority.connect(configuration);
try {
  const schema = configuration.schema;
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new Error('Invalid authority schema');
  }
  const rows =
    repairAttemptId === undefined
      ? await sql.unsafe(
          `select p.scope_id,p.parent_claim_id,p.child_claim_id,c.owner_json,c.token,c.version,c.state
     from "${schema}".forge_global_workspace_phases p
     join "${schema}".forge_global_claims c on c.scope_id=p.scope_id and c.claim_id=p.child_claim_id
     where c.owner_json::jsonb->>'runId'=$1 and p.phase='HANDOFF_COMMITTED' and c.state='HELD_UNCERTAIN'`,
          [runId]
        )
      : await sql.unsafe(
          `select c.scope_id,c.claim_id as child_claim_id,c.owner_json,c.token,c.version,c.state
     from "${schema}".forge_global_claims c
     join "${schema}".forge_records r on r.run_id=$1 and r.kind='repair'
       and r.key=c.owner_json::jsonb->>'attemptId'
     where c.owner_json::jsonb->>'runId'=$1 and c.owner_json::jsonb->>'attemptId'=$2
       and c.state='HELD_UNCERTAIN' and r.payload::jsonb->>'state'='UNKNOWN'`,
          [runId, repairAttemptId]
        );
  if (rows.length !== 1) {
    throw new Error('Expected one exact uncertain execution child');
  }
  const row = rows[0];
  const savedOwner = JSON.parse(row.owner_json);
  const owner = {
    runId: savedOwner.runId,
    taskId: savedOwner.taskId,
    attemptId: savedOwner.attemptId,
    agentId: savedOwner.agentId,
    workspaceId: savedOwner.workspaceId
  };
  const request = {
    scopeId: row.scope_id,
    parentClaimId: row.parent_claim_id,
    claimId: row.child_claim_id,
    owner,
    token: Number(row.token)
  };
  if (
    (await authority.recoverFencedMutationPermits(request.scopeId)).some(
      (permit) => permit.claimId === request.claimId
    )
  ) {
    throw new Error('Outstanding callback permit requires its own independent settlement');
  }
  const container =
    repairAttemptId === undefined
      ? await authority.recoverExecutionChildContainer(request)
      : await authority.recoverRepairExecutionContainer(request);
  if (!container) {
    throw new Error('Missing immutable original container identity');
  }
  // A daemon query must succeed, even when the original broker already removed
  // the exited container. Matching both immutable ID and reserved name prevents
  // treating a replacement container as the original stopped generation.
  const containers = execFileSync(
    'docker',
    ['container', 'ls', '--all', '--no-trunc', '--format', '{{json .}}'],
    { encoding: 'utf8' }
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const exact = containers.find(
    (item) => item.ID === container.id || item.Names === container.name
  );
  if (exact !== undefined) {
    if (exact.ID !== container.id || exact.Names !== container.name) {
      throw new Error('Container identity was replaced');
    }
    await new DockerPiSessionGateway({
      image: container.image,
      executable: container.executable,
      args: container.args
    }).stopPersistedContainer(container);
  }
  const evidence = `Independent local operator verified worker PID ${deadWorkerPid} exited, exact Docker container ${container.id} stopped or removed, and no unresolved host callback permits`;
  await writeFile(
    resolve(`.local/${runId}-${repairAttemptId ?? 'child'}-quiescence.json`),
    JSON.stringify(
      {
        runId,
        workerPid: deadWorkerPid,
        containerId: container.id,
        verifiedAt: new Date().toISOString(),
        noPendingPermits: true
      },
      null,
      2
    ),
    { flag: 'wx', mode: 0o600 }
  );
  await authority.reclaimUncertainMutation({
    ...request,
    expectedVersion: Number(row.version),
    verifiedQuiescenceEvidence: evidence
  });
  console.log(JSON.stringify({ runId, status: 'uncertain-child-reclaimed-no-relaunch' }));
} finally {
  await authority.close();
  await sql.end();
}
