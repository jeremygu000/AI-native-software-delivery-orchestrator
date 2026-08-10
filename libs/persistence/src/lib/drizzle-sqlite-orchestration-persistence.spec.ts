import type {
  CreatePersistedRunRequest,
  PersistedReevaluation,
  PersistedTaskConflict,
  PersistedTaskImpact,
  PersistedWriteLease,
  TaskContract
} from '@ai-native-software-delivery-orchestrator/domain';
import { DeterministicScheduler } from '@ai-native-software-delivery-orchestrator/scheduler';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DrizzleSqliteOrchestrationPersistence,
  PersistenceInputError,
  PersistenceReplayError
} from './drizzle-sqlite-orchestration-persistence.js';

const task = (id: string, dependencies: readonly string[] = []): TaskContract => ({
  id,
  title: id,
  goal: `Complete ${id}`,
  dependencies: [...dependencies],
  expectedReads: [],
  expectedWrites: [],
  sharedResources: [],
  verification: []
});

const createRunRequest = (id = 'run-1'): CreatePersistedRunRequest => ({
  run: {
    id,
    repositoryId: 'repository-1',
    state: 'ACTIVE',
    createdAt: '2026-08-11T00:00:00.000Z'
  },
  tasks: [task('A'), task('B', ['A'])],
  hardConflicts: [
    {
      taskA: 'A',
      taskB: 'B',
      score: 90,
      reasons: [
        {
          type: 'producer-consumer',
          score: 90,
          detail: 'A produces facts for B.',
          resourceIds: ['core:file']
        }
      ],
      severity: 'hard',
      constraints: [
        {
          type: 'producer-consumer',
          detail: 'A produces core:file for B.',
          resourceIds: ['core:file'],
          producerTaskId: 'A',
          consumerTaskId: 'B'
        }
      ],
      recommendedAction: 'stagger'
    }
  ],
  riskConflicts: [],
  scheduleOptions: { maxConcurrency: 2 }
});

const reevaluation = (sequence = 1): PersistedReevaluation => ({
  event: {
    runId: 'run-1',
    sequence,
    occurredAt: '2026-08-11T00:01:00.000Z',
    event: { type: 'task-completed', taskId: 'A', state: 'COMPLETED' }
  },
  transitions: [
    {
      runId: 'run-1',
      sequence,
      taskId: 'B',
      fromState: 'PENDING',
      toState: 'READY'
    }
  ],
  decision: {
    runId: 'run-1',
    sequence,
    inputSnapshot: {
      taskStates: [
        { taskId: 'A', state: 'COMPLETED' },
        { taskId: 'B', state: 'PENDING' }
      ],
      runtimeBlocks: []
    },
    decision: {
      taskDecisions: [
        {
          taskId: 'B',
          action: 'ready',
          fromState: 'PENDING',
          toState: 'READY',
          reasons: [{ type: 'dependencies-completed', dependencyTaskIds: ['A'] }]
        },
        {
          taskId: 'B',
          action: 'start',
          fromState: 'READY',
          toState: 'RUNNING',
          reasons: [{ type: 'selected-by-priority', priority: 0 }]
        }
      ]
    }
  }
});

const impactRecord = (): PersistedTaskImpact => ({
  runId: 'run-1',
  taskId: 'A',
  impact: {
    predicted: {
      taskId: 'A',
      projectsRead: new Set(['core']),
      projectsWritten: new Set(['core']),
      explicitProjectsWritten: new Set(),
      filesRead: new Set(['core:file']),
      filesWritten: new Set(['core:file']),
      explicitFilesWritten: new Set(['core:file']),
      globFilesWritten: new Set(),
      symbolDerivedFilesWritten: new Set(),
      symbolsRead: new Set(),
      symbolsWritten: new Set(['core:file:Service.run']),
      sharedResources: new Set(['lockfile', 'release-channel']),
      sharedResourceAccesses: [
        { resourceId: 'lockfile', modes: ['write'] },
        { resourceId: 'release-channel', modes: ['read'] }
      ],
      downstreamProjects: new Set(['consumer', 'web']),
      riskSignals: [{ type: 'public-api-touch', detail: 'Exported symbol.' }]
    }
  }
});

const conflictRecord = (): PersistedTaskConflict => ({
  runId: 'run-1',
  taskA: 'A',
  taskB: 'B',
  conflict: createRunRequest().hardConflicts[0]
});

const leaseRecord = (): PersistedWriteLease => ({
  runId: 'run-1',
  lease: {
    id: 'lease-1',
    runId: 'run-1',
    agentId: 'agent-1',
    taskId: 'A',
    resource: {
      type: 'symbol',
      projectId: 'core',
      fileId: 'core:file',
      symbolId: 'core:file:Service.run',
      ancestorSymbolIds: ['core:file:Service']
    },
    mode: 'exclusive',
    version: 3,
    state: 'STALE',
    acquiredAt: new Date('2026-08-11T00:00:00.000Z'),
    lastHeartbeatAt: new Date('2026-08-11T00:01:00.000Z'),
    staleDetectedAt: new Date('2026-08-11T00:02:00.000Z'),
    staleEvidence: 'Agent process exited.'
  }
});

describe('DrizzleSqliteOrchestrationPersistence', () => {
  it('recovers a complete reconstructable run with structured collections and dates', async () => {
    const persistence = new DrizzleSqliteOrchestrationPersistence();
    await persistence.createRun(createRunRequest());
    await persistence.persistReevaluation(reevaluation());
    await persistence.persistImpact(impactRecord());
    await persistence.persistConflict(conflictRecord());
    await persistence.persistLease(leaseRecord());
    await persistence.updateRunState('run-1', 'COMPLETED');

    const recovered = await persistence.recoverRun('run-1');

    expect(recovered).toMatchObject({
      run: { id: 'run-1', repositoryId: 'repository-1', state: 'COMPLETED' },
      tasks: [task('A'), task('B', ['A'])],
      scheduleOptions: { maxConcurrency: 2 },
      events: [
        {
          runId: 'run-1',
          sequence: 1,
          event: { type: 'task-completed', taskId: 'A', state: 'COMPLETED' }
        }
      ],
      transitions: [
        { runId: 'run-1', sequence: 1, taskId: 'B', fromState: 'PENDING', toState: 'READY' }
      ]
    });
    expect(recovered?.impacts[0]?.impact.predicted.projectsWritten).toEqual(new Set(['core']));
    expect(recovered?.impacts[0]?.impact.predicted.sharedResources).toEqual(
      new Set(['lockfile', 'release-channel'])
    );
    expect(recovered?.leases[0]?.lease.acquiredAt).toEqual(new Date('2026-08-11T00:00:00.000Z'));
    expect(recovered?.leases[0]?.lease.staleEvidence).toBe('Agent process exited.');
    persistence.close();
  });

  it('recovers persisted state after reopening a SQLite file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orchestration-persistence-'));
    const filename = join(directory, 'run.sqlite');
    try {
      const writer = new DrizzleSqliteOrchestrationPersistence(filename);
      await writer.createRun(createRunRequest());
      await writer.persistReevaluation(reevaluation());
      writer.close();

      const reader = new DrizzleSqliteOrchestrationPersistence(filename);
      const recovered = await reader.recoverRun('run-1');
      expect(recovered?.events).toHaveLength(1);
      expect(recovered?.decisions[0]?.inputSnapshot.taskStates).toEqual([
        { taskId: 'A', state: 'COMPLETED' },
        { taskId: 'B', state: 'PENDING' }
      ]);
      reader.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects corrupted persisted run state instead of recovering an invalid domain record', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orchestration-persistence-'));
    const filename = join(directory, 'corrupt.sqlite');
    try {
      const writer = new DrizzleSqliteOrchestrationPersistence(filename);
      await writer.createRun(createRunRequest());
      writer.close();

      const sqlite = new Database(filename);
      sqlite.prepare("UPDATE orchestration_runs SET state = 'BROKEN' WHERE id = 'run-1'").run();
      sqlite.close();

      const reader = new DrizzleSqliteOrchestrationPersistence(filename);
      await expect(reader.recoverRun('run-1')).rejects.toThrow('Invalid persisted run state');
      reader.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects corrupted scheduler event JSON instead of exposing a parser exception', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orchestration-persistence-'));
    const filename = join(directory, 'corrupt-event.sqlite');
    try {
      const writer = new DrizzleSqliteOrchestrationPersistence(filename);
      await writer.createRun(createRunRequest());
      await writer.persistReevaluation(reevaluation());
      writer.close();

      const sqlite = new Database(filename);
      sqlite.prepare("UPDATE scheduler_events SET event_json = '{' WHERE run_id = 'run-1'").run();
      sqlite.close();

      const reader = new DrizzleSqliteOrchestrationPersistence(filename);
      await expect(reader.recoverRun('run-1')).rejects.toThrow('Invalid persisted scheduler event');
      reader.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    [
      'task conflict',
      'UPDATE task_conflicts SET conflict_json = \'{"taskA":"A","taskB":"B","score":1,"reasons":[],"severity":"hard","constraints":[],"recommendedAction":"stagger"}\' WHERE run_id = \'run-1\'',
      'Invalid persisted task conflict'
    ],
    [
      'task impact',
      'UPDATE task_impacts SET impact_json = \'{"predicted":{"taskId":"A"}}\' WHERE run_id = \'run-1\'',
      'Invalid persisted task impact'
    ],
    [
      'write lease',
      'UPDATE write_leases SET lease_json = \'{"id":"lease-1","runId":"run-1","version":1}\' WHERE run_id = \'run-1\'',
      'Invalid persisted write lease'
    ]
  ])('rejects corrupted %s records', async (_label, updateSql, expectedError) => {
    const directory = mkdtempSync(join(tmpdir(), 'orchestration-persistence-'));
    const filename = join(directory, 'corrupt-record.sqlite');
    try {
      const writer = new DrizzleSqliteOrchestrationPersistence(filename);
      await writer.createRun(createRunRequest());
      await writer.persistConflict(conflictRecord());
      await writer.persistImpact(impactRecord());
      await writer.persistLease(leaseRecord());
      writer.close();

      const sqlite = new Database(filename);
      sqlite.exec(updateSql);
      sqlite.close();

      const reader = new DrizzleSqliteOrchestrationPersistence(filename);
      await expect(reader.recoverRun('run-1')).rejects.toThrow(expectedError);
      reader.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('writes an event, transitions, and decision atomically', async () => {
    const persistence = new DrizzleSqliteOrchestrationPersistence();
    await persistence.createRun(createRunRequest());
    await persistence.persistReevaluation(reevaluation());

    await expect(persistence.persistReevaluation(reevaluation())).rejects.toThrow();

    const recovered = await persistence.recoverRun('run-1');
    expect(recovered?.events).toHaveLength(1);
    expect(recovered?.transitions).toHaveLength(1);
    expect(recovered?.decisions).toHaveLength(1);
    persistence.close();
  });

  it('requires contiguous append-only event sequences and replays saved decisions', async () => {
    const persistence = new DrizzleSqliteOrchestrationPersistence();
    await persistence.createRun(createRunRequest());
    await expect(persistence.persistReevaluation(reevaluation(2))).rejects.toThrow(
      'Scheduler event sequence must be 1: run-1'
    );
    await persistence.persistReevaluation(reevaluation());

    await expect(persistence.replayRun('run-1', new DeterministicScheduler())).resolves.toEqual([
      reevaluation().decision
    ]);
    persistence.close();
  });

  it('rejects a replay when persisted decision evidence is inconsistent', async () => {
    const persistence = new DrizzleSqliteOrchestrationPersistence();
    await persistence.createRun(createRunRequest());
    await persistence.persistReevaluation({
      ...reevaluation(),
      decision: { ...reevaluation().decision, decision: { taskDecisions: [] } }
    });

    await expect(persistence.replayRun('run-1', new DeterministicScheduler())).rejects.toThrow(
      PersistenceReplayError
    );
    persistence.close();
  });

  it('rolls back every reevaluation record when a later transition insert fails', async () => {
    const persistence = new DrizzleSqliteOrchestrationPersistence();
    await persistence.createRun(createRunRequest());
    const record = reevaluation();

    await expect(
      persistence.persistReevaluation({
        ...record,
        transitions: [...record.transitions, record.transitions[0]]
      })
    ).rejects.toThrow();

    const recovered = await persistence.recoverRun('run-1');
    expect(recovered?.events).toEqual([]);
    expect(recovered?.transitions).toEqual([]);
    expect(recovered?.decisions).toEqual([]);
    persistence.close();
  });

  it('upserts current impact, conflict, and lease records while preserving their run identity', async () => {
    const persistence = new DrizzleSqliteOrchestrationPersistence();
    await persistence.createRun(createRunRequest());
    await persistence.persistImpact(impactRecord());
    await persistence.persistImpact({
      ...impactRecord(),
      impact: {
        predicted: {
          ...impactRecord().impact.predicted,
          downstreamProjects: new Set(['consumer', 'web'])
        }
      }
    });
    await persistence.persistConflict(conflictRecord());
    await persistence.persistConflict({
      ...conflictRecord(),
      conflict: { ...conflictRecord().conflict, score: 100 }
    });
    await persistence.persistLease(leaseRecord());
    await persistence.persistLease({
      ...leaseRecord(),
      lease: { ...leaseRecord().lease, version: 4 }
    });

    const recovered = await persistence.recoverRun('run-1');
    expect(recovered?.impacts).toHaveLength(1);
    expect(recovered?.impacts[0]?.impact.predicted.downstreamProjects).toEqual(
      new Set(['consumer', 'web'])
    );
    expect(recovered?.conflicts).toHaveLength(1);
    expect(recovered?.conflicts[0]?.conflict.score).toBe(100);
    expect(recovered?.leases).toHaveLength(1);
    expect(recovered?.leases[0]?.lease.version).toBe(4);
    persistence.close();
  });

  it('isolates current-record upserts by run ID and returns no-event replay for a new run', async () => {
    const persistence = new DrizzleSqliteOrchestrationPersistence();
    await persistence.createRun(createRunRequest('run-1'));
    await persistence.createRun(createRunRequest('run-2'));
    await persistence.persistImpact(impactRecord());
    await persistence.persistImpact({ ...impactRecord(), runId: 'run-2' });
    await persistence.persistLease(leaseRecord());
    await persistence.persistLease({ ...leaseRecord(), runId: 'run-2' });

    const recoveredFirst = await persistence.recoverRun('run-1');
    const recoveredSecond = await persistence.recoverRun('run-2');
    expect(recoveredFirst?.impacts[0]?.runId).toBe('run-1');
    expect(recoveredSecond?.impacts[0]?.runId).toBe('run-2');
    expect(recoveredFirst?.leases[0]?.runId).toBe('run-1');
    expect(recoveredSecond?.leases[0]?.runId).toBe('run-2');
    await expect(persistence.replayRun('run-2', new DeterministicScheduler())).resolves.toEqual([]);
    persistence.close();
  });

  it('serializes concurrently requested consecutive reevaluations', async () => {
    const persistence = new DrizzleSqliteOrchestrationPersistence();
    await persistence.createRun(createRunRequest());

    await expect(
      Promise.all([
        persistence.persistReevaluation(reevaluation(1)),
        persistence.persistReevaluation(reevaluation(2))
      ])
    ).resolves.toEqual([undefined, undefined]);

    const recovered = await persistence.recoverRun('run-1');
    expect(recovered?.events.map(({ sequence }) => sequence)).toEqual([1, 2]);
    persistence.close();
  });

  it('rejects unknown runs and mismatched reevaluation records without partial persistence', async () => {
    const persistence = new DrizzleSqliteOrchestrationPersistence();
    await expect(persistence.persistImpact(impactRecord())).rejects.toThrow(PersistenceInputError);
    await persistence.createRun(createRunRequest());
    await expect(
      persistence.persistReevaluation({
        ...reevaluation(),
        decision: { ...reevaluation().decision, sequence: 2 }
      })
    ).rejects.toThrow('Reevaluation records must share a run ID and sequence');
    await expect(persistence.updateRunState('missing', 'COMPLETED')).rejects.toThrow(
      'Unknown orchestration run: missing'
    );
    await expect(
      persistence.createRun({ ...createRunRequest(), run: { ...createRunRequest().run, id: ' ' } })
    ).rejects.toThrow('runId must not be empty');
    await expect(
      persistence.persistReevaluation({
        ...reevaluation(),
        event: { ...reevaluation().event, sequence: 0 }
      })
    ).rejects.toThrow('sequence must be a positive integer');
    expect(await persistence.recoverRun('missing')).toBeUndefined();
    persistence.close();
  });
});
