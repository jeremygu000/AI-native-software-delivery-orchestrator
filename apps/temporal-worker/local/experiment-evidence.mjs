import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import postgres from 'postgres';
import { Connection, Client } from '@temporalio/client';

const root = resolve(import.meta.dirname, '../../..');
const env = { ...parseEnv(await readFile(resolve(root, '.env.local'), 'utf8')), ...process.env };
const runIds = process.argv.slice(2);
if (runIds.length === 0) {
  throw new Error('Usage: experiment-evidence.mjs run-id [run-id ...]');
}
const sql = postgres(env.FORGE_POSTGRES_CONNECTION_STRING, { max: 1 });
const connection = await Connection.connect({ address: new URL(env.TEMPORAL_SERVER_URL).host });
try {
  const client = new Client({ connection, namespace: env.TEMPORAL_NAMESPACE });
  const results = [];
  for (const runId of runIds) {
    const runs = await sql`select state, payload from forge.forge_runs where id=${runId}`;
    if (runs.length !== 1) {
      throw new Error('Requested run does not exist');
    }
    const request = JSON.parse(runs[0].payload);
    const claims = await sql`
      select state, count(*)::int as count from forge.forge_global_claims
      where owner_json::jsonb->>'runId'=${runId} group by state order by state`;
    const permits = await sql`
      select count(*)::int as count from forge.forge_global_permits
      where owner_json::jsonb->>'runId'=${runId}`;
    const lineages = await sql`
      select count(*)::int as count from forge.forge_global_workspace_permit_lineages
      where owner_json::jsonb->>'runId'=${runId} and not completed`;
    const records = await sql`
      select kind, key, payload from forge.forge_records where run_id=${runId}
       and kind in ('builder', 'repair', 'verification', 'review', 'integration-claim') order by kind, key`;
    const facts = records.map((record) => {
      const value = JSON.parse(record.payload);
      return {
        kind: record.kind,
        id: record.key,
        state: value.state,
        status: value.status,
        recommendation: record.kind === 'review' ? value.review?.recommendation : undefined,
        fingerprint: value.fingerprint,
        startedAt: value.startedAt,
        completedAt: value.completedAt
      };
    });
    const description = await client.workflow.getHandle(`forge-run:${runId}`).describe();
    const history = await client.workflow.getHandle(`forge-run:${runId}`).fetchHistory();
    const activityAttempts = (history.events ?? []).flatMap((event) => {
      const started = event.activityTaskStartedEventAttributes;
      return started ? [{ attempt: started.attempt, workerIdentity: started.identity }] : [];
    });
    results.push({
      runId,
      state: runs[0].state,
      workflowStatus: description.status.name,
      workflowRunId: description.runId,
      workflowStartedAt: description.startTime,
      workflowClosedAt: description.closeTime,
      elapsedMs: description.closeTime
        ? description.closeTime.getTime() - description.startTime.getTime()
        : undefined,
      activityAttempts,
      authority: request.run.authority,
      claims,
      unresolvedGenericPermits: permits[0].count,
      unresolvedWorkspacePermits: lineages[0].count,
      records: facts
    });
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  await sql.end();
  await connection.close();
}
