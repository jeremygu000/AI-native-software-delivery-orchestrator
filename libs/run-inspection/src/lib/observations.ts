import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { Client, Connection } from '@temporalio/client';
import { ForgeReadModel } from '@ai-native-software-delivery-orchestrator/orchestration-runtime';
import {
  openPostgresConnection,
  PostgresOrchestrationPersistence
} from '@ai-native-software-delivery-orchestrator/postgres-persistence';
import type { InspectorConfiguration } from './configuration.js';
import {
  buildRunInspection,
  observedState,
  type AuxiliaryObservation,
  type EvidenceFields,
  type ForgeRunInspection,
  type InspectionInput,
  type SetupObservation,
  type SourceObservation
} from './inspection.js';

export class InspectionError extends Error {
  constructor(
    message: string,
    readonly status = 503
  ) {
    super(message);
  }
}
const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InspectionError('Malformed durable inspection evidence');
  }
  return Object.fromEntries(Object.entries(value));
};
const decode = (value: unknown): Record<string, unknown> =>
  object(typeof value === 'string' ? JSON.parse(value) : value);
const fields = (value: Record<string, unknown>, keys: readonly string[]): EvidenceFields =>
  Object.fromEntries(
    keys.map((key) => [
      key,
      typeof value[key] === 'string' ||
      typeof value[key] === 'number' ||
      typeof value[key] === 'boolean'
        ? value[key]
        : null
    ])
  );
const workflowId = (runId: string) => `forge-run:${runId}`;

export async function readPostgresObservation(
  configuration: InspectorConfiguration,
  runId: string
) {
  const persistence = await PostgresOrchestrationPersistence.connectReadOnly(
    configuration.authority
  );
  try {
    const recovered = await persistence.recoverRun(runId);
    if (recovered === undefined) {
      throw new InspectionError('Run not found in the selected environment', 404);
    }
    if (resolve(recovered.run.authority.repositoryRoot) !== configuration.environment.repository) {
      throw new InspectionError('Run repository differs from the selected environment', 409);
    }
    const run = await new ForgeReadModel({ persistence, workflowId }).read(runId);
    if (run === undefined) {
      throw new InspectionError('Run disappeared during inspection', 409);
    }
    const sql = openPostgresConnection(configuration.authority, {
      max: 1,
      connect_timeout: 5,
      connection: {
        application_name: 'forge-run-inspector',
        default_transaction_read_only: true,
        statement_timeout: 10000
      },
      onnotice: () => undefined
    });
    try {
      return await sql.begin('isolation level repeatable read read only', async (tx) => {
        const schema = `"${configuration.authority.schema}"`;
        const bindings = await tx.unsafe(
          `select b.run_id,b.repository_id,b.scope_id,a.scope_id as alias_scope_id from ${schema}.forge_global_run_bindings b left join ${schema}.forge_global_aliases a on a.repository_id=b.repository_id where b.run_id=$1`,
          [runId]
        );
        const binding = bindings[0];
        if (
          binding === undefined ||
          binding.repository_id !== recovered.run.repositoryId ||
          binding.scope_id !== binding.alias_scope_id
        ) {
          throw new InspectionError(
            'Run has no matching repository/scope binding in the selected environment',
            409
          );
        }
        const claims = await tx.unsafe(
          `select c.claim_id,c.scope_id,c.state,c.version,c.owner_json,p.phase,p.workspace_id,p.signing_key,p.authorization_digest,p.child_claim_id,p.handoff_attestation_id,p.handoff_attestation_digest from ${schema}.forge_global_claims c left join ${schema}.forge_global_workspace_phases p on p.scope_id=c.scope_id and p.parent_claim_id=c.claim_id where c.owner_json::jsonb->>'runId'=$1`,
          [runId]
        );
        const generations = await tx.unsafe(
          `select id,scope_id,parent_claim_id,task_id,attempt_id,workspace_id,state from ${schema}.forge_global_generations where run_id=$1`,
          [runId]
        );
        const permits = await tx.unsafe(
          `select scope_id,parent_claim_id,permit_id,generation_id,workspace_id,completed,settlement_id,settlement_digest,owner_json from ${schema}.forge_global_workspace_permit_lineages where owner_json::jsonb->>'runId'=$1`,
          [runId]
        );
        const genericPermits = await tx.unsafe(
          `select id,scope_id,claim_id,owner_json from ${schema}.forge_global_permits where owner_json::jsonb->>'runId'=$1`,
          [runId]
        );
        const setup: SetupObservation[] = [];
        for (const row of claims) {
          const owner = decode(row.owner_json);
          const taskId = String(owner.taskId);
          const attemptId = String(owner.attemptId);
          const identity = {
            taskId,
            attemptId,
            ...fields(row, ['scope_id', 'claim_id', 'state', 'version', 'workspace_id', 'phase'])
          };
          if (row.phase !== null) {
            setup.push({
              taskId,
              attemptId,
              stage: 'admission',
              state:
                typeof row.authorization_digest === 'string' && typeof row.signing_key === 'string'
                  ? 'complete'
                  : 'unknown',
              fields: { ...identity, ...fields(row, ['signing_key', 'authorization_digest']) }
            });
            setup.push({
              taskId,
              attemptId,
              stage: 'arming',
              state: row.phase === 'WORKSPACE_ARMED' ? 'complete' : 'unknown',
              fields: identity
            });
            setup.push({
              taskId,
              attemptId,
              stage: 'attestation',
              state: typeof row.handoff_attestation_id === 'string' ? 'complete' : 'unknown',
              fields: {
                ...identity,
                ...fields(row, ['handoff_attestation_id', 'handoff_attestation_digest'])
              }
            });
            const child = claims.find(
              (candidate) =>
                candidate.claim_id === row.child_claim_id &&
                candidate.scope_id === row.scope_id &&
                decode(candidate.owner_json).taskId === taskId &&
                decode(candidate.owner_json).attemptId === attemptId
            );
            setup.push({
              taskId,
              attemptId,
              stage: 'child',
              state:
                row.phase === 'HANDOFF_COMMITTED' && child !== undefined ? 'complete' : 'unknown',
              fields: {
                ...identity,
                ...fields(row, ['child_claim_id']),
                childState: child === undefined ? null : String(child.state)
              }
            });
          }
        }
        for (const row of generations) {
          setup.push({
            taskId: String(row.task_id),
            attemptId: String(row.attempt_id),
            stage: 'generation',
            state:
              row.state === 'ISSUED' ? 'complete' : row.state === 'REVOKED' ? 'failed' : 'unknown',
            fields: fields(row, [
              'id',
              'scope_id',
              'parent_claim_id',
              'task_id',
              'attempt_id',
              'workspace_id',
              'state'
            ])
          });
        }
        for (const row of permits) {
          const owner = decode(row.owner_json);
          const identity = fields(row, [
            'scope_id',
            'parent_claim_id',
            'permit_id',
            'generation_id',
            'workspace_id',
            'completed',
            'settlement_id',
            'settlement_digest'
          ]);
          setup.push({
            taskId: String(owner.taskId),
            attemptId: String(owner.attemptId),
            stage: 'permit',
            state: row.completed === true ? 'complete' : 'active',
            fields: identity
          });
          setup.push({
            taskId: String(owner.taskId),
            attemptId: String(owner.attemptId),
            stage: 'settlement',
            state:
              row.completed === true && typeof row.settlement_id === 'string'
                ? 'complete'
                : 'unknown',
            fields: identity
          });
        }
        for (const workspace of recovered.workspaces.map((row) => row.workspace)) {
          const attempt = recovered.attempts.find(
            (row) => row.attempt.workspaceId === workspace.id
          )?.attempt;
          if (attempt !== undefined) {
            setup.push({
              taskId: workspace.taskId,
              attemptId: attempt.id,
              stage: 'persistence',
              state: 'complete',
              fields: fields({ ...workspace }, [
                'id',
                'taskId',
                'workspacePath',
                'branchName',
                'revision',
                'phase'
              ])
            });
          }
          setup.push({
            taskId: workspace.taskId,
            attemptId: attempt?.id ?? '',
            stage: 'integration',
            state:
              workspace.phase === 'INTEGRATED'
                ? 'complete'
                : workspace.phase === 'INTEGRATION_BLOCKED'
                  ? 'unknown'
                  : 'pending',
            fields: fields({ ...workspace }, ['id', 'phase', 'revision', 'integrationCommit'])
          });
        }
        // Permit secrets/verifiers and claim diagnostic bodies never leave this server.
        return {
          run,
          recovered,
          identity: fields(
            {
              ...recovered.run.authority,
              repositoryId: recovered.run.repositoryId,
              scopeId: binding.scope_id,
              unresolvedGenericPermits: genericPermits.length,
              claimCount: claims.length
            },
            [
              'artifactId',
              'artifactRevision',
              'approvalId',
              'repositoryId',
              'repositoryRoot',
              'baseCommit',
              'scopeId',
              'unresolvedGenericPermits',
              'claimCount'
            ]
          ),
          binding: {
            state: 'complete' as const,
            fields: fields(binding, ['run_id', 'repository_id', 'scope_id', 'alias_scope_id'])
          },
          setup
        };
      });
    } finally {
      await sql.end({ timeout: 5 });
    }
  } finally {
    await persistence.close();
  }
}

export async function readTemporalObservation(
  configuration: InspectorConfiguration,
  runId: string
): Promise<AuxiliaryObservation> {
  const connection = await Connection.connect({
    address: configuration.temporalAddress,
    connectTimeout: '5s'
  });
  try {
    return await connection.withDeadline(Date.now() + 10000, async () => {
      const client = new Client({ connection, namespace: configuration.environment.namespace });
      const handle = client.workflow.getHandle(workflowId(runId));
      const description = await handle.describe();
      if (description.taskQueue !== configuration.environment.taskQueue) {
        throw new InspectionError('Temporal workflow belongs to a different task queue', 409);
      }
      const history = await handle.fetchHistory();
      const activities = (history.events ?? []).flatMap<Record<string, string | null | undefined>>(
        (event) => {
          const scheduled = event.activityTaskScheduledEventAttributes;
          if (scheduled !== null && scheduled !== undefined) {
            return [
              {
                eventId: String(event.eventId),
                activityId: scheduled.activityId,
                type: scheduled.activityType?.name,
                state: 'scheduled'
              }
            ];
          }
          const result =
            event.activityTaskCompletedEventAttributes ??
            event.activityTaskFailedEventAttributes ??
            event.activityTaskCanceledEventAttributes ??
            event.activityTaskStartedEventAttributes;
          return result === null || result === undefined
            ? []
            : [
                {
                  eventId: String(event.eventId),
                  scheduledEventId: String(result.scheduledEventId),
                  state: event.activityTaskCompletedEventAttributes
                    ? 'completed'
                    : event.activityTaskFailedEventAttributes
                      ? 'failed'
                      : event.activityTaskCanceledEventAttributes
                        ? 'cancelled'
                        : 'started'
                }
              ];
        }
      );
      return {
        state: observedState(description.status.name),
        fields: {
          workflowId: workflowId(runId),
          workflowRunId: description.runId,
          state: description.status.name,
          taskQueue: description.taskQueue,
          namespace: configuration.environment.namespace,
          activityObservations: JSON.stringify(activities),
          startedAt: description.startTime.toISOString(),
          closedAt: description.closeTime?.toISOString() ?? null
        }
      };
    });
  } finally {
    await connection.close();
  }
}

export async function readGitObservation(
  configuration: InspectorConfiguration,
  workspaces: readonly { id: string; taskId: string; workspacePath: string }[]
): Promise<AuxiliaryObservation[]> {
  const { stdout } = await promisify(execFile)(
    'git',
    ['-C', configuration.environment.repository, 'worktree', 'list', '--porcelain', '-z'],
    { timeout: 10000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }
  );
  const paths = stdout
    .split('\0')
    .filter((part) => part.startsWith('worktree '))
    .map((part) => part.slice(9));
  return workspaces.map((workspace) => ({
    taskId: workspace.taskId,
    state: paths.includes(workspace.workspacePath) ? 'complete' : 'unknown',
    fields: {
      workspaceId: workspace.id,
      workspacePath: workspace.workspacePath,
      listed: paths.includes(workspace.workspacePath),
      observation:
        'Current Git worktree list; absence does not establish historical non-occurrence.'
    }
  }));
}

export async function readLocalObservation(
  configuration: InspectorConfiguration,
  runId: string,
  tasks: readonly { id: string }[]
): Promise<AuxiliaryObservation[]> {
  const observations: AuxiliaryObservation[] = [];
  for (const task of tasks) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(task.id)) {
      throw new InspectionError('Unsafe task evidence identifier');
    }
    for (const kind of ['setup', 'recovery', 'abandonment']) {
      const file = resolve(
        configuration.operatorRoot,
        '.local',
        `${runId}-${task.id}-${kind}.json`
      );
      try {
        const value = decode(await readFile(file, 'utf8'));
        const generation = object(value.generation);
        const owner =
          value.attestation === undefined
            ? {}
            : object(object(object(object(value.attestation).observation).authority).owner);
        if ((value.runId ?? owner.runId) !== runId || (value.taskId ?? owner.taskId) !== task.id) {
          throw new InspectionError('Local evidence identity mismatch', 409);
        }
        observations.push({
          taskId: task.id,
          state: 'unknown',
          fields: {
            file,
            kind,
            ...fields(generation, [
              'id',
              'generationId',
              'scopeId',
              'parentClaimId',
              'workspaceId',
              'runId',
              'taskId'
            ]),
            observation:
              'File observed; signature/authority settlement is not verified by this inspector.'
          }
        });
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          continue;
        }
        throw error;
      }
    }
  }
  return observations;
}

export async function inspectRun(
  configuration: InspectorConfiguration,
  runId: string
): Promise<ForgeRunInspection> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new InspectionError('Invalid run ID', 400);
  }
  const observedAt = new Date().toISOString();
  const durable = await readPostgresObservation(configuration, runId);
  const sources: SourceObservation[] = [
    {
      source: 'PostgreSQL durable authority',
      observedAt,
      status: 'observed',
      message: 'Read-only observations; cross-source reads are not atomic.'
    }
  ];
  const auxiliary = async <T>(
    source: SourceObservation['source'],
    operation: () => Promise<T>,
    fallback: T
  ): Promise<T> => {
    try {
      const value = await operation();
      sources.push({
        source,
        observedAt: new Date().toISOString(),
        status: 'observed',
        message: 'Source queried in the selected environment.'
      });
      return value;
    } catch (error) {
      if (error instanceof InspectionError && error.status === 409) {
        throw error;
      }
      sources.push({
        source,
        observedAt: new Date().toISOString(),
        status: 'unavailable',
        message:
          'Observation unavailable. No other environment was queried; diagnostics are not disclosed.'
      });
      return fallback;
    }
  };
  const [temporal, git, local] = await Promise.all([
    auxiliary('Temporal', () => readTemporalObservation(configuration, runId), {
      state: 'unknown',
      fields: { workflowId: workflowId(runId), observation: 'Not observed or unavailable' }
    }),
    auxiliary(
      'Git/worktree observation',
      () =>
        readGitObservation(
          configuration,
          durable.recovered.workspaces.map((row) => row.workspace)
        ),
      []
    ),
    auxiliary(
      'local operator evidence',
      () => readLocalObservation(configuration, runId, durable.run.tasks),
      []
    )
  ]);
  const input: InspectionInput = {
    ...durable,
    environment: configuration.environment,
    observedAt,
    temporal,
    git,
    local,
    sources
  };
  return buildRunInspection(input);
}
