import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import postgres from 'postgres';
import { PostgresGlobalMutationAuthority } from '@ai-native-software-delivery-orchestrator/postgres-persistence';

const [runId, workerPidText] = process.argv.slice(2);
const workerPid = Number(workerPidText);
if (!runId || !Number.isSafeInteger(workerPid) || workerPid <= 1) {
  throw new Error('Usage: recover-integration run-id exited-worker-pid');
}
try {
  process.kill(workerPid, 0);
  throw new Error('Original worker is still alive');
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
if (!/^[a-z_][a-z0-9_]*$/.test(configuration.schema)) {
  throw new Error('Invalid authority schema');
}
const sql = postgres(configuration.connectionString, { max: 1 });
const authority = await PostgresGlobalMutationAuthority.connect(configuration);
try {
  const rows = await sql.unsafe(
    `select c.* from "${configuration.schema}".forge_global_claims c
    join "${configuration.schema}".forge_records r on r.run_id=$1 and r.kind='integration-claim'
      and r.payload::jsonb->>'claimId'=c.claim_id
    where c.owner_json::jsonb->>'runId'=$1 and c.state='HELD_UNCERTAIN'`,
    [runId]
  );
  if (rows.length !== 1) {
    throw new Error('Expected one exact uncertain integration claim');
  }
  const row = rows[0];
  if (
    (await authority.recoverFencedMutationPermits(row.scope_id)).some(
      (p) => p.claimId === row.claim_id
    )
  ) {
    throw new Error('An outstanding callback permit requires independent settlement');
  }
  // This local supervisor owns the Docker daemon. Inspect ALL retained Git
  // command containers: never infer process-tree quiescence from a timeout.
  const names = execFileSync(
    'docker',
    ['ps', '-a', '--filter', 'name=forge-git-', '--format', '{{.Names}}'],
    { encoding: 'utf8' }
  )
    .trim()
    .split('\n')
    .filter(Boolean);
  for (const name of names) {
    const inspected = JSON.parse(
      execFileSync('docker', ['inspect', name], { encoding: 'utf8' })
    )[0];
    if (
      !['exited', 'created'].includes(inspected.State.Status) ||
      inspected.State.Running ||
      inspected.State.Restarting
    ) {
      throw new Error('A Git process tree is not confirmed stopped');
    }
    if (inspected.State.Status === 'created') {
      execFileSync('docker', ['rm', name], { stdio: 'ignore' });
    }
  }
  const saved = JSON.parse(row.owner_json);
  const owner = {
    runId: saved.runId,
    taskId: saved.taskId,
    attemptId: saved.attemptId,
    agentId: saved.agentId,
    workspaceId: saved.workspaceId
  };
  const evidence = `Independent local operator confirmed worker PID ${workerPid} exited, all retained confined Git containers stopped or never started, and exact integration claim has no outstanding permits; no Git replay authorized`;
  await writeFile(
    resolve(`.local/${runId}-integration-quiescence.json`),
    JSON.stringify(
      {
        runId,
        workerPid,
        claimId: row.claim_id,
        verifiedAt: new Date().toISOString(),
        gitContainers: names,
        noPendingPermits: true
      },
      null,
      2
    ),
    { flag: 'wx', mode: 0o600 }
  );
  await authority.reclaimUncertainMutation({
    scopeId: row.scope_id,
    claimId: row.claim_id,
    owner,
    token: Number(row.token),
    expectedVersion: Number(row.version),
    verifiedQuiescenceEvidence: evidence
  });
  console.log(JSON.stringify({ runId, status: 'uncertain-integration-reclaimed-no-git-replay' }));
} finally {
  await authority.close();
  await sql.end();
}
