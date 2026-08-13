import type {
  CreatePersistedRunRequest,
  PersistedReevaluation,
  PersistedTaskConflict,
  PersistedTaskImpact,
  PersistedWriteLease,
  PersistedAgentExecutionAttempt,
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
import { taskVerificationEvidenceFingerprint } from '@ai-native-software-delivery-orchestrator/domain';

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
    createdAt: '2026-08-11T00:00:00.000Z',
    authority: {
      artifactId: 'plan-1',
      artifactRevision: 1,
      approvalId: 'approval-1',
      planFingerprint: `sha256:${'1'.repeat(64)}`,
      approvalFingerprint: `sha256:${'2'.repeat(64)}`,
      claimFingerprint: `sha256:${'3'.repeat(64)}`,
      executionFingerprint: `sha256:${'4'.repeat(64)}`,
      repositoryRoot: '/repository',
      baseCommit: '5'.repeat(40),
      workingTreeFingerprint: `sha256:${'6'.repeat(64)}`,
      repositoryFactsFingerprint: `sha256:${'7'.repeat(64)}`,
      sharedResourcePolicyFingerprint: `sha256:${'8'.repeat(64)}`,
      verificationPolicyFingerprint: `sha256:${'9'.repeat(64)}`
    }
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
    },
    {
      runId: 'run-1',
      sequence,
      taskId: 'B',
      fromState: 'READY',
      toState: 'RUNNING'
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

const runtimeConflictMutation = (taskB = 'B'): PersistedTaskConflict => ({
  runId: 'run-1',
  taskA: 'A',
  taskB,
  effectiveFromSequence: 1,
  conflict: {
    taskA: 'A',
    taskB,
    score: 100,
    severity: 'hard',
    reasons: [
      {
        type: 'same-file',
        score: 100,
        detail: 'Observed runtime scope conflicts with another task lease-plan resource.',
        resourceIds: ['core:file']
      }
    ],
    constraints: [
      {
        type: 'runtime-scope-expansion',
        detail: 'Observed runtime scope expansion must be reconciled before future dispatch.',
        resourceIds: ['core:file']
      }
    ],
    recommendedAction: 'serialize'
  }
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
      run: {
        id: 'run-1',
        repositoryId: 'repository-1',
        state: 'COMPLETED',
        authority: createRunRequest().run.authority
      },
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
        { runId: 'run-1', sequence: 1, taskId: 'B', fromState: 'PENDING', toState: 'READY' },
        { runId: 'run-1', sequence: 1, taskId: 'B', fromState: 'READY', toState: 'RUNNING' }
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

  it('persists task code review evidence idempotently by task iteration', async () => {
    const persistence = new DrizzleSqliteOrchestrationPersistence();
    const review = {
      recommendation: 'accept' as const,
      summary: 'Implementation matches the task contract.',
      findings: []
    };
    const subject = {
      builderAttemptId: 'attempt-A',
      outputAttemptId: 'attempt-A',
      workspaceId: 'workspace-A',
      workspaceRevision: 1,
      workspaceChangeFingerprint: `sha256:${'a'.repeat(64)}`,
      impactFingerprint: `sha256:${'b'.repeat(64)}`,
      verificationFingerprint: `sha256:${'c'.repeat(64)}`
    };
    await persistence.createRun(createRunRequest());
    await persistence.persistReview({ runId: 'run-1', taskId: 'A', iteration: 1, subject, review });
    await expect(
      persistence.persistReview({ runId: 'run-1', taskId: 'A', iteration: 1, subject, review })
    ).resolves.toBeUndefined();
    await expect(
      persistence.persistReview({
        runId: 'run-1',
        taskId: 'A',
        iteration: 1,
        subject,
        review: {
          recommendation: 'repair',
          summary: 'Changed evidence.',
          findings: [
            {
              id: 'finding-1',
              severity: 'high',
              fileIds: ['core:file'],
              symbolIds: [],
              description: 'Repair required.'
            }
          ]
        }
      })
    ).rejects.toThrow(PersistenceInputError);
    await expect(
      persistence.persistReview({ runId: 'run-1', taskId: 'B', iteration: 1, review })
    ).rejects.toThrow('requires a review subject');
    await expect(persistence.recoverReviews('run-1')).resolves.toMatchObject([
      { taskId: 'A', iteration: 1, subject, review }
    ]);
    await expect(
      persistence.persistReview({
        runId: 'run-1',
        taskId: 'A',
        iteration: 1,
        subject: { ...subject, workspaceChangeFingerprint: `sha256:${'d'.repeat(64)}` },
        review
      })
    ).rejects.toThrow(PersistenceInputError);
    persistence.close();
  });

  it('persists a separate revisioned repair attempt lineage', async () => {
    const persistence = new DrizzleSqliteOrchestrationPersistence();
    const subject = {
      builderAttemptId: 'attempt-A',
      outputAttemptId: 'attempt-A',
      workspaceId: 'workspace-A',
      workspaceRevision: 1,
      workspaceChangeFingerprint: `sha256:${'a'.repeat(64)}`,
      impactFingerprint: `sha256:${'b'.repeat(64)}`,
      verificationFingerprint: `sha256:${'c'.repeat(64)}`
    };
    const preparing = {
      id: 'repair-1',
      runId: 'run-1',
      taskId: 'A',
      agentId: 'repair-agent',
      workspaceId: 'workspace-A',
      parentReviewIteration: 1,
      parentReviewSubject: subject,
      repairIteration: 1,
      state: 'PREPARING' as const,
      revision: 1
    };
    await persistence.createRun(createRunRequest());
    await persistence.persistRepairAttempt({ runId: 'run-1', attempt: preparing });
    await expect(
      persistence.persistRepairAttempt({ runId: 'run-1', attempt: preparing })
    ).resolves.toBeUndefined();
    const completed = {
      ...preparing,
      state: 'COMPLETED' as const,
      revision: 2,
      startedAt: new Date('2026-08-13T00:00:00.000Z'),
      completedAt: new Date('2026-08-13T00:01:00.000Z')
    };
    await persistence.persistRepairAttempt({ runId: 'run-1', attempt: completed });
    await expect(persistence.recoverRepairAttempts('run-1')).resolves.toMatchObject([
      { attempt: { id: 'repair-1', state: 'COMPLETED', parentReviewSubject: subject } }
    ]);
    await expect(
      persistence.persistRepairAttempt({
        runId: 'run-1',
        attempt: { ...preparing, agentId: 'other' }
      })
    ).rejects.toThrow(PersistenceInputError);
    await expect(
      persistence.persistRepairAttempt({
        runId: 'run-1',
        attempt: {
          ...completed,
          revision: 3,
          parentReviewSubject: {
            ...subject,
            workspaceChangeFingerprint: `sha256:${'d'.repeat(64)}`
          }
        }
      })
    ).rejects.toThrow('Repair attempt lineage cannot change across revisions');
    persistence.close();
  });

  it('resumes only an exact current blocked repair attempt', async () => {
    const persistence = new DrizzleSqliteOrchestrationPersistence();
    const subject = {
      builderAttemptId: 'attempt-A',
      outputAttemptId: 'attempt-A',
      workspaceId: 'workspace-A',
      workspaceRevision: 1,
      workspaceChangeFingerprint: `sha256:${'a'.repeat(64)}`,
      impactFingerprint: `sha256:${'b'.repeat(64)}`,
      verificationFingerprint: `sha256:${'c'.repeat(64)}`
    };
    const blocked = {
      id: 'repair-1',
      runId: 'run-1',
      taskId: 'A',
      agentId: 'repair-agent',
      workspaceId: 'workspace-A',
      parentReviewIteration: 1,
      parentReviewSubject: subject,
      repairIteration: 1,
      state: 'BLOCKED' as const,
      revision: 2,
      startedAt: new Date('2026-08-13T00:00:00.000Z'),
      blocker: { type: 'lease' as const, leaseId: 'owner-lease' }
    };
    await persistence.createRun(createRunRequest());
    await expect(
      persistence.resumeRepairAttempt({ runId: 'run-1', attemptId: 'missing', expectedRevision: 1 })
    ).resolves.toEqual({ status: 'not-found' });
    await persistence.persistRepairAttempt({
      runId: 'run-1',
      attempt: {
        ...blocked,
        state: 'PREPARING',
        revision: 1,
        startedAt: undefined,
        blocker: undefined
      }
    });
    await expect(
      persistence.resumeRepairAttempt({
        runId: 'run-1',
        attemptId: 'repair-1',
        expectedRevision: 1
      })
    ).resolves.toEqual({ status: 'not-blocked', state: 'PREPARING' });
    await persistence.persistRepairAttempt({ runId: 'run-1', attempt: blocked });
    await expect(
      persistence.resumeRepairAttempt({
        runId: 'run-1',
        attemptId: 'repair-1',
        expectedRevision: 1
      })
    ).resolves.toEqual({ status: 'version-conflict', actualRevision: 2 });
    await expect(
      persistence.resumeRepairAttempt({
        runId: 'run-1',
        attemptId: 'repair-1',
        expectedRevision: 2
      })
    ).resolves.toMatchObject({ status: 'resumed', attempt: { state: 'PREPARING', revision: 3 } });
    persistence.close();
  });

  it('persists exact-idempotent verification evidence by execution attempt', async () => {
    const persistence = new DrizzleSqliteOrchestrationPersistence();
    const verificationPayload = {
      id: 'verification-1',
      runId: 'run-1',
      taskId: 'A',
      attemptId: 'attempt-A',
      workspaceId: 'workspace-A',
      workspaceRevision: 1,
      workspaceChangeFingerprint: `sha256:${'a'.repeat(64)}`,
      verificationPolicyFingerprint: `sha256:${'b'.repeat(64)}`,
      status: 'passed' as const,
      verifiedAt: '2026-08-13T00:02:00.000Z'
    };
    const evidence = {
      ...verificationPayload,
      fingerprint: taskVerificationEvidenceFingerprint(verificationPayload)
    };
    await persistence.createRun(createRunRequest());
    await persistence.persistVerificationEvidence(evidence);
    await expect(persistence.persistVerificationEvidence(evidence)).resolves.toBeUndefined();
    await expect(
      persistence.persistVerificationEvidence({
        ...evidence,
        workspaceChangeFingerprint: `sha256:${'d'.repeat(64)}`,
        fingerprint: taskVerificationEvidenceFingerprint({
          ...verificationPayload,
          workspaceChangeFingerprint: `sha256:${'d'.repeat(64)}`
        })
      })
    ).rejects.toThrow(PersistenceInputError);
    await expect(
      persistence.persistVerificationEvidence({
        ...evidence,
        fingerprint: `sha256:${'f'.repeat(64)}`
      })
    ).rejects.toThrow('Verification evidence fingerprint does not match its content');
    await expect(persistence.recoverVerificationEvidence('run-1')).resolves.toEqual([evidence]);
    persistence.close();
  });

  it('rejects schema-shaped verification evidence whose self fingerprint was corrupted', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orchestration-persistence-'));
    const filename = join(directory, 'corrupt-verification.sqlite');
    try {
      const writer = new DrizzleSqliteOrchestrationPersistence(filename);
      const payload = {
        id: 'verification-1',
        runId: 'run-1',
        taskId: 'A',
        attemptId: 'attempt-A',
        workspaceId: 'workspace-A',
        workspaceRevision: 1,
        workspaceChangeFingerprint: `sha256:${'a'.repeat(64)}`,
        verificationPolicyFingerprint: `sha256:${'b'.repeat(64)}`,
        status: 'passed' as const,
        verifiedAt: '2026-08-13T00:02:00.000Z'
      };
      await writer.createRun(createRunRequest());
      await writer.persistVerificationEvidence({
        ...payload,
        fingerprint: taskVerificationEvidenceFingerprint(payload)
      });
      writer.close();
      const sqlite = new Database(filename);
      const stored = sqlite
        .prepare("SELECT evidence_json FROM task_verification_evidence WHERE run_id = 'run-1'")
        .get();
      if (
        typeof stored !== 'object' ||
        stored === null ||
        !('evidence_json' in stored) ||
        typeof stored.evidence_json !== 'string'
      ) {
        throw new Error('Expected stored verification evidence');
      }
      const parsed: unknown = JSON.parse(stored.evidence_json);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('Expected verification evidence JSON object');
      }
      const corrupted = { ...parsed, fingerprint: `sha256:${'f'.repeat(64)}` };
      sqlite
        .prepare("UPDATE task_verification_evidence SET evidence_json = ? WHERE run_id = 'run-1'")
        .run(JSON.stringify(corrupted));
      sqlite.close();

      const reader = new DrizzleSqliteOrchestrationPersistence(filename);
      await expect(reader.recoverVerificationEvidence('run-1')).rejects.toThrow(
        'Verification evidence fingerprint does not match its content'
      );
      reader.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('admits exactly one repair attempt for an idempotent parent review retry', async () => {
    const persistence = new DrizzleSqliteOrchestrationPersistence();
    const subject = {
      builderAttemptId: 'attempt-A',
      outputAttemptId: 'attempt-A',
      workspaceId: 'workspace-A',
      workspaceRevision: 1,
      workspaceChangeFingerprint: `sha256:${'a'.repeat(64)}`,
      impactFingerprint: `sha256:${'b'.repeat(64)}`,
      verificationFingerprint: `sha256:${'c'.repeat(64)}`
    };
    const request = {
      attempt: {
        id: 'repair-first-request',
        runId: 'run-1',
        taskId: 'A',
        agentId: 'repair-agent',
        workspaceId: 'workspace-A',
        parentReviewIteration: 1,
        parentReviewSubject: subject,
        repairIteration: 1,
        state: 'PREPARING' as const,
        revision: 1
      },
      maxRepairs: 1
    };
    await persistence.createRun(createRunRequest());
    const [first, retry] = await Promise.all([
      persistence.admitRepairAttempt(request),
      persistence.admitRepairAttempt({
        ...request,
        attempt: { ...request.attempt, id: 'repair-retry-request' }
      })
    ]);
    expect(first).toMatchObject({ id: 'repair-first-request', repairIteration: 1 });
    expect(retry).toMatchObject({ id: 'repair-first-request', repairIteration: 1 });
    await expect(persistence.recoverRepairAttempts('run-1')).resolves.toHaveLength(1);
    await expect(
      persistence.admitRepairAttempt({
        ...request,
        attempt: {
          ...request.attempt,
          id: 'repair-second-review',
          parentReviewIteration: 2,
          parentReviewSubject: {
            ...subject,
            workspaceChangeFingerprint: `sha256:${'d'.repeat(64)}`
          }
        }
      })
    ).rejects.toThrow('Repair budget exhausted for task: A');
    persistence.close();
  });

  it('rejects corrupted durable run authority evidence', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orchestration-persistence-'));
    const filename = join(directory, 'corrupt-authority.sqlite');
    try {
      const writer = new DrizzleSqliteOrchestrationPersistence(filename);
      await writer.createRun(createRunRequest());
      writer.close();

      const sqlite = new Database(filename);
      sqlite
        .prepare("UPDATE orchestration_runs SET authority_json = '{}' WHERE id = 'run-1'")
        .run();
      sqlite.close();

      const reader = new DrizzleSqliteOrchestrationPersistence(filename);
      await expect(reader.recoverRun('run-1')).rejects.toThrow(
        'Invalid persisted run authority evidence'
      );
      reader.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['NULL', 'NULL'],
    ['malformed JSON', "'{'"]
  ])('rejects %s durable run authority evidence', async (_case, replacement) => {
    const directory = mkdtempSync(join(tmpdir(), 'orchestration-persistence-'));
    const filename = join(directory, 'invalid-authority.sqlite');
    try {
      const writer = new DrizzleSqliteOrchestrationPersistence(filename);
      await writer.createRun(createRunRequest());
      writer.close();

      const sqlite = new Database(filename);
      sqlite.exec(
        `UPDATE orchestration_runs SET authority_json = ${replacement} WHERE id = 'run-1'`
      );
      sqlite.close();

      const reader = new DrizzleSqliteOrchestrationPersistence(filename);
      await expect(reader.recoverRun('run-1')).rejects.toThrow(
        'Invalid persisted run authority evidence'
      );
      reader.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('adds the authority column when opening a pre-Stage-20 run database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orchestration-persistence-'));
    const filename = join(directory, 'legacy.sqlite');
    try {
      const sqlite = new Database(filename);
      sqlite.exec(`
        CREATE TABLE orchestration_runs (
          id TEXT PRIMARY KEY NOT NULL,
          repository_id TEXT NOT NULL,
          state TEXT NOT NULL,
          created_at TEXT NOT NULL,
          tasks_json TEXT NOT NULL,
          hard_conflicts_json TEXT NOT NULL,
          risk_conflicts_json TEXT NOT NULL,
          schedule_options_json TEXT NOT NULL
        )
      `);
      sqlite.close();

      const persistence = new DrizzleSqliteOrchestrationPersistence(filename);
      persistence.close();
      const migrated = new Database(filename);
      const columns = migrated.prepare('PRAGMA table_info(orchestration_runs)').all();
      migrated.close();
      expect(
        columns.some(
          (column) =>
            typeof column === 'object' &&
            column !== null &&
            'name' in column &&
            column.name === 'authority_json'
        )
      ).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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

    await expect(persistence.persistReevaluation(reevaluation())).resolves.toBeUndefined();

    const recovered = await persistence.recoverRun('run-1');
    expect(recovered?.events).toHaveLength(1);
    expect(recovered?.transitions).toHaveLength(2);
    expect(recovered?.decisions).toHaveLength(1);
    persistence.close();
  });

  it.each([
    {
      label: 'wrong transition state',
      transitions: [
        {
          runId: 'run-1',
          sequence: 1,
          taskId: 'B',
          fromState: 'PENDING' as const,
          toState: 'RUNNING' as const
        }
      ]
    },
    { label: 'missing transition', transitions: [] },
    {
      label: 'extra transition',
      transitions: [
        ...reevaluation().transitions,
        {
          runId: 'run-1',
          sequence: 1,
          taskId: 'A',
          fromState: 'COMPLETED' as const,
          toState: 'CANCELLED' as const
        }
      ]
    }
  ])('rejects $label that does not match decision transitions', async ({ transitions }) => {
    const persistence = new DrizzleSqliteOrchestrationPersistence();
    await persistence.createRun(createRunRequest());

    await expect(
      persistence.persistReevaluation({ ...reevaluation(), transitions })
    ).rejects.toThrow('Persisted transitions must match the scheduler decision');
    expect((await persistence.recoverRun('run-1'))?.events).toEqual([]);
    persistence.close();
  });

  it('detects transitions altered after a valid reevaluation was persisted', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orchestration-persistence-'));
    const filename = join(directory, 'corrupt-transition.sqlite');
    try {
      const writer = new DrizzleSqliteOrchestrationPersistence(filename);
      await writer.createRun(createRunRequest());
      await writer.persistReevaluation(reevaluation());
      writer.close();
      const sqlite = new Database(filename);
      sqlite
        .prepare(
          "UPDATE task_transitions SET to_state = 'RUNNING' WHERE run_id = 'run-1' AND sequence = 1"
        )
        .run();
      sqlite.close();

      const reader = new DrizzleSqliteOrchestrationPersistence(filename);
      await expect(reader.replayRun('run-1', new DeterministicScheduler())).rejects.toThrow(
        PersistenceReplayError
      );
      reader.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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

  it('accepts identical reevaluation retries and rejects different evidence at the same sequence', async () => {
    const persistence = new DrizzleSqliteOrchestrationPersistence();
    const record = reevaluation();
    await persistence.createRun(createRunRequest());
    await persistence.persistReevaluation(record);
    await expect(persistence.persistReevaluation(record)).resolves.toBeUndefined();
    await expect(
      persistence.persistReevaluation({
        ...record,
        event: { ...record.event, occurredAt: '2026-08-11T00:02:00.000Z' }
      })
    ).rejects.toThrow('Scheduler event sequence 1 already recorded with different evidence');

    const recovered = await persistence.recoverRun('run-1');
    expect(recovered?.events).toHaveLength(1);
    expect(recovered?.transitions).toHaveLength(2);
    persistence.close();
  });

  it('requires exact runtime conflict mutations for an idempotent reevaluation retry', async () => {
    const persistence = new DrizzleSqliteOrchestrationPersistence();
    const record: PersistedReevaluation = {
      ...reevaluation(),
      runtimeConflicts: [runtimeConflictMutation()]
    };
    await persistence.createRun(createRunRequest());

    await persistence.persistReevaluation(record);
    await expect(persistence.persistReevaluation(record)).resolves.toBeUndefined();
    await expect(
      persistence.persistReevaluation({
        ...record,
        runtimeConflicts: [runtimeConflictMutation('C')]
      })
    ).rejects.toThrow('Scheduler event sequence 1 already recorded with different evidence');
    await expect(persistence.recoverRun('run-1')).resolves.toMatchObject({
      conflicts: [{ taskA: 'A', taskB: 'B', effectiveFromSequence: 1 }]
    });
    persistence.close();
  });

  it('rejects a replay when persisted decision evidence is inconsistent', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orchestration-persistence-'));
    const filename = join(directory, 'corrupt-decision.sqlite');
    try {
      const writer = new DrizzleSqliteOrchestrationPersistence(filename);
      await writer.createRun(createRunRequest());
      await writer.persistReevaluation(reevaluation());
      writer.close();
      const sqlite = new Database(filename);
      sqlite
        .prepare(
          "UPDATE scheduler_decisions SET decision_json = '{\"taskDecisions\":[]}' WHERE run_id = 'run-1'"
        )
        .run();
      sqlite.close();

      const reader = new DrizzleSqliteOrchestrationPersistence(filename);
      await expect(reader.replayRun('run-1', new DeterministicScheduler())).rejects.toThrow(
        PersistenceReplayError
      );
      reader.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rolls back every reevaluation record when a later decision insert fails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orchestration-persistence-'));
    const filename = join(directory, 'rollback.sqlite');
    try {
      const writer = new DrizzleSqliteOrchestrationPersistence(filename);
      await writer.createRun(createRunRequest());
      writer.close();
      const sqlite = new Database(filename);
      sqlite
        .prepare(
          "INSERT INTO scheduler_decisions (run_id, sequence, snapshot_json, decision_json) VALUES ('run-1', 1, '{}', '{}')"
        )
        .run();
      sqlite.close();

      const persistence = new DrizzleSqliteOrchestrationPersistence(filename);
      await expect(persistence.persistReevaluation(reevaluation())).rejects.toThrow();
      persistence.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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

  it.each([
    {
      label: 'impact task ID',
      persist: (persistence: DrizzleSqliteOrchestrationPersistence) =>
        persistence.persistImpact({ ...impactRecord(), taskId: 'B' }),
      error: 'Task impact key must match payload task ID'
    },
    {
      label: 'conflict task IDs',
      persist: (persistence: DrizzleSqliteOrchestrationPersistence) =>
        persistence.persistConflict({ ...conflictRecord(), taskA: 'B' }),
      error: 'Task conflict keys must match payload task IDs'
    },
    {
      label: 'lease run ID',
      persist: (persistence: DrizzleSqliteOrchestrationPersistence) =>
        persistence.persistLease({ ...leaseRecord(), runId: 'run-2' }),
      error: 'Write lease run ID must match payload run ID'
    }
  ])('rejects mismatched persisted $label keys', async ({ persist, error }) => {
    const persistence = new DrizzleSqliteOrchestrationPersistence();
    await persistence.createRun(createRunRequest());
    await expect(persist(persistence)).rejects.toThrow(error);
    persistence.close();
  });

  it('rejects lease version regression and accepts an identical lease retry', async () => {
    const persistence = new DrizzleSqliteOrchestrationPersistence();
    const newest = { ...leaseRecord(), lease: { ...leaseRecord().lease, version: 4 } };
    await persistence.createRun(createRunRequest());
    await persistence.persistLease(newest);
    await expect(persistence.persistLease(newest)).resolves.toBeUndefined();
    await expect(
      persistence.persistLease({ ...leaseRecord(), lease: { ...leaseRecord().lease, version: 3 } })
    ).rejects.toThrow('Lease version regression rejected: stored version 4, incoming version 3');
    await expect(
      persistence.persistLease({
        ...newest,
        lease: { ...newest.lease, staleEvidence: 'Different evidence.' }
      })
    ).rejects.toThrow('Lease version already recorded with different evidence');
    await expect(
      persistence.persistLease({
        ...newest,
        lease: {
          ...newest.lease,
          lastHeartbeatAt: new Date('1999-01-01T00:00:00.000Z')
        }
      })
    ).rejects.toThrow('Lease version already recorded with different evidence');
    persistence.close();
  });

  it('isolates current-record upserts by run ID and returns no-event replay for a new run', async () => {
    const persistence = new DrizzleSqliteOrchestrationPersistence();
    await persistence.createRun(createRunRequest('run-1'));
    await persistence.createRun(createRunRequest('run-2'));
    await persistence.persistImpact(impactRecord());
    await persistence.persistImpact({ ...impactRecord(), runId: 'run-2' });
    await persistence.persistLease(leaseRecord());
    await persistence.persistLease({
      ...leaseRecord(),
      runId: 'run-2',
      lease: { ...leaseRecord().lease, runId: 'run-2' }
    });

    const recoveredFirst = await persistence.recoverRun('run-1');
    const recoveredSecond = await persistence.recoverRun('run-2');
    expect(recoveredFirst?.impacts[0]?.runId).toBe('run-1');
    expect(recoveredSecond?.impacts[0]?.runId).toBe('run-2');
    expect(recoveredFirst?.leases[0]?.runId).toBe('run-1');
    expect(recoveredSecond?.leases[0]?.runId).toBe('run-2');
    await expect(persistence.replayRun('run-2', new DeterministicScheduler())).resolves.toEqual([]);
    persistence.close();
  });

  it('recovers phase-aware integration workspace evidence', async () => {
    const persistence = new DrizzleSqliteOrchestrationPersistence();
    await persistence.createRun(createRunRequest());
    await persistence.persistWorkspace({
      runId: 'run-1',
      workspace: {
        id: 'workspace-1',
        runId: 'run-1',
        taskId: 'A',
        integrationRepositoryPath: '/repository',
        workspacePath: '/workspace',
        branchName: 'orchestrator/run-1/A',
        baseRef: 'main',
        integrationRef: 'main',
        revision: 2,
        phase: 'INTEGRATION_BLOCKED',
        blocker: {
          type: 'rebase-conflict',
          detail: 'Rebase conflicted.',
          conflictPaths: ['src/value.ts']
        }
      }
    });

    const recovered = await persistence.recoverRun('run-1');
    expect(recovered?.workspaces).toEqual([
      {
        runId: 'run-1',
        workspace: expect.objectContaining({
          phase: 'INTEGRATION_BLOCKED',
          blocker: expect.objectContaining({ conflictPaths: ['src/value.ts'] })
        })
      }
    ]);
    persistence.close();
  });

  it('rejects workspace revision regression and conflicting same-revision evidence', async () => {
    const persistence = new DrizzleSqliteOrchestrationPersistence();
    const newest = {
      runId: 'run-1',
      workspace: {
        id: 'workspace-1',
        runId: 'run-1',
        taskId: 'A',
        integrationRepositoryPath: '/repository',
        workspacePath: '/workspace',
        branchName: 'orchestrator/run-1/A',
        baseRef: 'main',
        integrationRef: 'main',
        revision: 2,
        phase: 'INTEGRATED' as const,
        integrationCommit: 'commit-2'
      }
    };
    await persistence.createRun(createRunRequest());
    await persistence.persistWorkspace(newest);
    await expect(persistence.persistWorkspace(newest)).resolves.toBeUndefined();
    await expect(
      persistence.persistWorkspace({
        ...newest,
        workspace: { ...newest.workspace, revision: 1, phase: 'READY_TO_INTEGRATE' }
      })
    ).rejects.toThrow(
      'Workspace revision regression rejected: stored revision 2, incoming revision 1'
    );
    await expect(
      persistence.persistWorkspace({
        ...newest,
        workspace: {
          ...newest.workspace,
          phase: 'INTEGRATION_BLOCKED',
          blocker: { type: 'fast-forward-failed', detail: 'Different evidence.', conflictPaths: [] }
        }
      })
    ).rejects.toThrow('Workspace revision already recorded with different evidence');
    persistence.close();
  });

  it('persists dispatch attempts atomically and protects attempt revisions', async () => {
    const persistence = new DrizzleSqliteOrchestrationPersistence();
    await persistence.createRun(createRunRequest());
    const dispatch = {
      reevaluation: reevaluation(),
      attempts: [
        {
          runId: 'run-1',
          attempt: {
            id: 'attempt-1',
            runId: 'run-1',
            taskId: 'B',
            agentId: 'agent-B',
            workspaceId: 'workspace-B',
            leasePlanFingerprint: 'lease-plan-B',
            state: 'PREPARING' as const,
            revision: 1
          }
        }
      ] satisfies readonly PersistedAgentExecutionAttempt[]
    };

    await persistence.persistDispatch(dispatch);
    await expect(persistence.persistDispatch(dispatch)).resolves.toBeUndefined();
    await expect(
      persistence.persistAttempt({
        runId: 'run-1',
        attempt: {
          ...dispatch.attempts[0].attempt,
          state: 'STARTING',
          revision: 2,
          startedAt: new Date('2026-08-13T00:00:00.000Z')
        }
      })
    ).resolves.toBeUndefined();
    await expect(
      persistence.persistAttempt({
        runId: 'run-1',
        attempt: { ...dispatch.attempts[0].attempt, revision: 1 }
      })
    ).rejects.toThrow(
      'Agent execution attempt revision regression rejected: stored revision 2, incoming revision 1'
    );
    await expect(
      persistence.persistAttempt({
        runId: 'run-1',
        attempt: {
          ...dispatch.attempts[0].attempt,
          state: 'RUNNING',
          revision: 2,
          startedAt: new Date('2026-08-13T00:00:00.000Z')
        }
      })
    ).rejects.toThrow('Agent execution attempt revision already recorded with different evidence');
    await expect(persistence.persistDispatch({ ...dispatch, attempts: [] })).rejects.toThrow(
      'Dispatch attempts must exactly match scheduler starts as revision 1 PREPARING evidence'
    );
    const recovered = await persistence.recoverRun('run-1');
    expect(recovered?.events).toHaveLength(1);
    expect(recovered?.attempts).toMatchObject([{ attempt: { state: 'STARTING', revision: 2 } }]);
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
