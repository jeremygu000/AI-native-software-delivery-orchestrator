import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { RecoveredRun } from '@ai-native-software-delivery-orchestrator/domain';
import { WorkflowNotFoundError } from '@temporalio/common';
import { beforeEach, expect, it, vi } from 'vitest';
import { durableAuthorityRunRequest } from '../../../persistence/src/lib/durable-authority.contract.test.js';
import {
  inspectRun,
  readGitObservation,
  readLocalObservation,
  readPostgresObservation,
  readTemporalObservation
} from './observations.js';
import type { InspectorConfiguration } from './configuration.js';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  open: vi.fn(),
  recover: vi.fn(),
  query: vi.fn(),
  close: vi.fn(),
  end: vi.fn(),
  git: vi.fn(),
  temporalConnect: vi.fn(),
  describe: vi.fn(),
  history: vi.fn(),
  temporalClose: vi.fn()
}));
vi.mock('@ai-native-software-delivery-orchestrator/postgres-persistence', () => ({
  PostgresOrchestrationPersistence: { connectReadOnly: mocks.connect },
  openPostgresConnection: mocks.open
}));
vi.mock('@temporalio/client', () => ({
  Connection: { connect: mocks.temporalConnect },
  Client: class {
    workflow = { getHandle: () => ({ describe: mocks.describe, fetchHistory: mocks.history }) };
  }
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execute = vi.fn();
  Object.defineProperty(execute, promisify.custom, { value: mocks.git });
  return { ...actual, execFile: execute };
});
const configuration: InspectorConfiguration = {
  authority: {
    connectionString: 'postgresql://forge_runtime:private-test@database.example/neondb',
    schema: 'fixture_schema',
    role: 'forge_runtime',
    ssl: 'verify-full'
  },
  environment: {
    id: 'fixture-env',
    label: 'Neon fixture',
    authorityMode: 'global',
    host: 'database.example',
    database: 'neondb',
    schema: 'fixture_schema',
    role: 'forge_runtime',
    repository: '/contract-repository',
    taskQueue: 'fixture-queue',
    namespace: 'default'
  },
  temporalAddress: 'localhost:7233',
  operatorRoot: '/fixture'
};
const recoveredFixture = (): RecoveredRun => {
  const initial = durableAuthorityRunRequest('run-1');
  return {
    run: initial.run,
    tasks: initial.tasks,
    taskBindings: [],
    hardConflicts: [],
    riskConflicts: [],
    scheduleOptions: initial.scheduleOptions,
    events: [],
    decisions: [],
    transitions: [],
    impacts: [],
    conflicts: [],
    leases: [],
    workspaces: [],
    attempts: [
      {
        runId: 'run-1',
        attempt: {
          id: 'launch-1',
          runId: 'run-1',
          taskId: 'task-1',
          agentId: 'agent-1',
          workspaceId: 'workspace-1',
          leasePlanFingerprint: 'fingerprint',
          state: 'PREPARING',
          revision: 1
        }
      }
    ]
  };
};
let recovered: RecoveredRun;
let rows: Record<string, unknown>[][];
beforeEach(() => {
  vi.clearAllMocks();
  recovered = recoveredFixture();
  rows = [
    [
      {
        run_id: 'run-1',
        repository_id: recovered.run.repositoryId,
        scope_id: 'scope-1',
        alias_scope_id: 'scope-1'
      }
    ],
    [],
    [],
    [],
    []
  ];
  mocks.recover.mockImplementation(async () => recovered);
  mocks.connect.mockResolvedValue({
    recoverRun: mocks.recover,
    recoverReviews: async () => [],
    recoverRepairAttempts: async () => [],
    recoverVerificationEvidence: async () => [],
    close: mocks.close
  });
  mocks.query.mockImplementation(async (query: string, args: unknown[]) => {
    expect(query.trim().toLowerCase().startsWith('select ')).toBe(true);
    expect(query).not.toMatch(/for update|for share|insert|delete|\.forge_workspace_recovery_/i);
    expect(args).toEqual(['run-1']);
    return rows.shift() ?? [];
  });
  mocks.open.mockReturnValue({
    begin: async (
      isolation: string,
      operation: (tx: { unsafe: typeof mocks.query }) => Promise<unknown>
    ) => {
      expect(isolation).toBe('isolation level repeatable read read only');
      return operation({ unsafe: mocks.query });
    },
    end: mocks.end
  });
  mocks.git.mockResolvedValue({ stdout: 'worktree /contract-repository\0HEAD abc\0\0' });
  mocks.temporalConnect.mockResolvedValue({
    withDeadline: async (_deadline: number, operation: () => Promise<unknown>) => operation(),
    close: mocks.temporalClose
  });
  mocks.describe.mockResolvedValue({
    taskQueue: 'fixture-queue',
    status: { name: 'RUNNING' },
    runId: 'temporal-run-1',
    startTime: new Date('2026-10-05T00:00:00Z')
  });
  mocks.history.mockResolvedValue({ events: [] });
});
it('reads only the selected schema and reuses the existing read model with read-only connections', async () => {
  const result = await readPostgresObservation(configuration, 'run-1');
  expect(result.run.tasks[0]?.attempts[0]?.state).toBe('PREPARING');
  expect(result.setup).toEqual([]);
  expect(mocks.connect).toHaveBeenCalledWith(configuration.authority);
  expect(mocks.open).toHaveBeenCalledWith(
    configuration.authority,
    expect.objectContaining({
      connection: expect.objectContaining({ default_transaction_read_only: true })
    })
  );
  expect(mocks.query).toHaveBeenCalledTimes(5);
  expect(mocks.close).toHaveBeenCalled();
  expect(mocks.end).toHaveBeenCalled();
  expect(JSON.stringify(result.identity)).not.toContain('private-test');
});
it('composes direct setup, generation, permit, attestation, settlement and child observations', async () => {
  const owner = JSON.stringify({ runId: 'run-1', taskId: 'task-1', attemptId: 'launch-1' });
  rows[1] = [
    {
      scope_id: 'scope-1',
      claim_id: 'parent-1',
      state: 'RELEASED',
      version: 3,
      owner_json: owner,
      phase: 'HANDOFF_COMMITTED',
      workspace_id: 'workspace-1',
      signing_key: 'key-1',
      authorization_digest: 'authorization-1',
      child_claim_id: 'child-1',
      handoff_attestation_id: 'attestation-1',
      handoff_attestation_digest: 'digest-1'
    },
    {
      scope_id: 'scope-1',
      claim_id: 'child-1',
      state: 'ACTIVE',
      version: 1,
      owner_json: owner,
      phase: null
    }
  ];
  rows[2] = [
    {
      id: 'generation-1',
      scope_id: 'scope-1',
      parent_claim_id: 'parent-1',
      task_id: 'task-1',
      attempt_id: 'launch-1',
      workspace_id: 'workspace-1',
      state: 'ISSUED'
    }
  ];
  rows[3] = [
    {
      scope_id: 'scope-1',
      parent_claim_id: 'parent-1',
      permit_id: 'permit-1',
      generation_id: 'generation-1',
      workspace_id: 'workspace-1',
      completed: true,
      settlement_id: 'attestation-1',
      settlement_digest: 'digest-1',
      owner_json: owner,
      verifier: 'secret-never-export'
    }
  ];
  recovered = {
    ...recovered,
    workspaces: [
      {
        runId: 'run-1',
        workspace: {
          id: 'workspace-1',
          runId: 'run-1',
          taskId: 'task-1',
          workspacePath: '/worktree-1',
          integrationRepositoryPath: '/contract-repository',
          branchName: 'fixture-branch',
          baseRef: 'main',
          integrationRef: 'main',
          revision: 2,
          phase: 'INTEGRATED',
          integrationCommit: 'a'.repeat(40)
        }
      }
    ]
  };
  const result = await readPostgresObservation(configuration, 'run-1');
  for (const stage of [
    'admission',
    'generation',
    'permit',
    'persistence',
    'attestation',
    'settlement',
    'child',
    'integration'
  ]) {
    expect(result.setup.find((row) => row.stage === stage)?.state).toBe('complete');
  }
  expect(result.setup.find((row) => row.stage === 'arming')?.state).toBe('unknown');
  expect(JSON.stringify(result.setup)).not.toContain('secret-never-export');
});
it.each([
  ['WORKSPACE_ARMED', false, 'ISSUED'],
  ['WORKSPACE_UNCERTAIN', true, 'REVOKED'],
  ['INITIAL_ADMITTED', false, 'unrecognized']
])(
  'retains partial %s setup without inventing child or settlement',
  async (phase, completed, generationState) => {
    const owner = JSON.stringify({ taskId: 'task-1', attemptId: 'launch-1' });
    rows[1] = [
      {
        scope_id: 'scope-1',
        claim_id: 'parent-1',
        state: 'HELD_UNCERTAIN',
        owner_json: owner,
        phase,
        workspace_id: 'workspace-1'
      }
    ];
    rows[2] = [
      { id: 'generation-1', task_id: 'task-1', attempt_id: 'launch-1', state: generationState }
    ];
    rows[3] = [{ owner_json: owner, completed, permit_id: 'permit-1' }];
    const result = await readPostgresObservation(configuration, 'run-1');
    expect(result.setup.find((row) => row.stage === 'child')?.state).toBe('unknown');
    expect(result.setup.find((row) => row.stage === 'settlement')?.state).toBe('unknown');
  }
);
it('does not complete child handoff from a claim belonging to a different attempt', async () => {
  rows[1] = [
    {
      scope_id: 'scope-1',
      claim_id: 'parent-1',
      phase: 'HANDOFF_COMMITTED',
      owner_json: JSON.stringify({ runId: 'run-1', taskId: 'task-1', attemptId: 'launch-1' }),
      child_claim_id: 'child-1'
    },
    {
      scope_id: 'scope-1',
      claim_id: 'child-1',
      phase: null,
      owner_json: JSON.stringify({ runId: 'run-1', taskId: 'task-1', attemptId: 'other-attempt' })
    }
  ];
  const result = await readPostgresObservation(configuration, 'run-1');
  expect(result.setup.find((row) => row.stage === 'child')?.state).toBe('unknown');
});
it('rejects malformed claim identity while closing every opened database connection', async () => {
  rows[1] = [{ owner_json: '[]' }];
  await expect(readPostgresObservation(configuration, 'run-1')).rejects.toThrow('Malformed');
  expect(mocks.end).toHaveBeenCalled();
  expect(mocks.close).toHaveBeenCalled();
});
it.each(['missing', 'repository', 'binding', 'alias'])(
  'refuses %s environment evidence without another authority lookup',
  async (failure) => {
    if (failure === 'missing') {
      mocks.recover.mockResolvedValue(undefined);
    }
    if (failure === 'repository') {
      recovered = {
        ...recovered,
        run: {
          ...recovered.run,
          authority: { ...recovered.run.authority, repositoryRoot: '/other-repository' }
        }
      };
    }
    if (failure === 'binding') {
      rows[0] = [];
    }
    if (failure === 'alias') {
      rows[0] = [
        { repository_id: recovered.run.repositoryId, scope_id: 'scope-1', alias_scope_id: 'other' }
      ];
    }
    await expect(readPostgresObservation(configuration, 'run-1')).rejects.toThrow();
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalled();
  }
);
it('does not disclose activity inputs, failure bodies or provider results from Temporal', async () => {
  mocks.describe.mockResolvedValue({
    taskQueue: 'fixture-queue',
    status: { name: 'COMPLETED' },
    runId: 'temporal-run-1',
    startTime: new Date(),
    closeTime: new Date()
  });
  mocks.history.mockResolvedValue({
    events: [
      {
        eventId: 1,
        activityTaskScheduledEventAttributes: {
          activityId: 'activity-1',
          activityType: { name: 'executeBuilder' },
          input: 'private-input'
        }
      },
      { eventId: 2, activityTaskStartedEventAttributes: { scheduledEventId: 1 } },
      {
        eventId: 3,
        activityTaskCompletedEventAttributes: { scheduledEventId: 1, result: 'private-result' }
      },
      {
        eventId: 4,
        activityTaskFailedEventAttributes: { scheduledEventId: 1, failure: 'private-failure' }
      },
      { eventId: 5, activityTaskCanceledEventAttributes: { scheduledEventId: 1 } },
      { eventId: 6 }
    ]
  });
  const result = await readTemporalObservation(configuration, 'run-1');
  expect(result.state).toBe('complete');
  expect(result.fields.activityObservations).toContain('activity-1');
  expect(JSON.stringify(result)).not.toMatch(/private-input|private-result|private-failure/);
  expect(mocks.temporalClose).toHaveBeenCalled();
});
it('fails visibly when Temporal reports a different configured queue', async () => {
  mocks.describe.mockResolvedValue({ taskQueue: 'other-queue' });
  await expect(readTemporalObservation(configuration, 'run-1')).rejects.toThrow(
    'different task queue'
  );
  expect(mocks.temporalClose).toHaveBeenCalled();
});
it('observes a missing current Temporal workflow without claiming historical absence or an outage', async () => {
  mocks.describe.mockRejectedValueOnce(
    new WorkflowNotFoundError('private Temporal diagnostic', 'forge-run:run-1', undefined)
  );
  const result = await inspectRun(configuration, 'run-1');
  expect(result.sources.find((row) => row.source === 'Temporal')?.status).toBe('observed');
  const node = result.nodes.find((row) => row.id === 'temporal');
  expect(node?.state).toBe('unknown');
  expect(node?.unknownReason).toBe('no-current-workflow');
  expect(node?.evidence[0]?.fields).toMatchObject({
    workflowId: 'forge-run:run-1',
    lookupResult: 'not-found'
  });
  expect(JSON.stringify(result)).not.toContain('private Temporal diagnostic');
  expect(mocks.temporalClose).toHaveBeenCalled();
});
it('observes only matching persisted Git worktrees and leaves absent paths unknown', async () => {
  mocks.git.mockResolvedValue({
    stdout: 'worktree /worktree-1\0HEAD abc\0\0worktree /unrelated-worktree\0\0'
  });
  const result = await readGitObservation(configuration, [
    { id: 'workspace-1', taskId: 'task-1', workspacePath: '/worktree-1' },
    { id: 'workspace-2', taskId: 'task-2', workspacePath: '/missing' }
  ]);
  expect(result.map((row) => row.state)).toEqual(['complete', 'unknown']);
  expect(JSON.stringify(result)).not.toContain('/unrelated-worktree');
});
it('reads exact scoped operator files, never keys, and treats unverified local evidence as unknown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-inspector-local-'));
  await mkdir(join(root, '.local'));
  try {
    await writeFile(
      join(root, '.local/run-1-task-1-setup.json'),
      JSON.stringify({
        runId: 'run-1',
        taskId: 'task-1',
        generation: { generationId: 'generation-1', workspaceId: 'workspace-1' },
        child: { verifier: 'private' }
      })
    );
    await writeFile(
      join(root, '.local/run-1-task-1-recovery.json'),
      JSON.stringify({
        generation: { generationId: 'generation-1' },
        attestation: {
          signature: 'private-signature',
          observation: { authority: { owner: { runId: 'run-1', taskId: 'task-1' } } }
        }
      })
    );
    const result = await readLocalObservation({ ...configuration, operatorRoot: root }, 'run-1', [
      { id: 'task-1' }
    ]);
    expect(result).toHaveLength(2);
    expect(result.every((row) => row.fields.generationId === 'generation-1')).toBe(true);
    expect(result.every((row) => row.state === 'unknown')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private');
    await writeFile(
      join(root, '.local/run-1-task-1-setup.json'),
      JSON.stringify({ runId: 'other', taskId: 'task-1', generation: {} })
    );
    await expect(
      readLocalObservation({ ...configuration, operatorRoot: root }, 'run-1', [{ id: 'task-1' }])
    ).rejects.toThrow('identity mismatch');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('rejects unsafe local evidence task IDs without filesystem traversal', async () =>
  await expect(
    readLocalObservation(configuration, 'run-1', [{ id: '../../private' }])
  ).rejects.toThrow('Unsafe'));
it('composes unavailable auxiliary sources as UNKNOWN without fallback or diagnostics', async () => {
  mocks.temporalConnect.mockRejectedValue(new Error('private-temporal-diagnostic'));
  mocks.git.mockRejectedValue(new Error('private-git-diagnostic'));
  const result = await inspectRun(configuration, 'run-1');
  expect(result.nodes.find((row) => row.id === 'temporal')?.state).toBe('unknown');
  expect(result.sources.filter((row) => row.status === 'unavailable')).toHaveLength(2);
  expect(JSON.stringify(result)).not.toContain('private-');
  expect(mocks.connect).toHaveBeenCalledTimes(1);
});
it('stops the whole inspection on a confirmed cross-source environment mismatch', async () => {
  mocks.describe.mockResolvedValue({ taskQueue: 'other-queue' });
  await expect(inspectRun(configuration, 'run-1')).rejects.toThrow('different task queue');
});
it('rejects malformed run IDs before any data source call', async () => {
  await expect(inspectRun(configuration, '../other')).rejects.toThrow('Invalid run ID');
  expect(mocks.connect).not.toHaveBeenCalled();
});
