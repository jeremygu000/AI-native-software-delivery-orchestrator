import type {
  AgentExecutionAttempt,
  TaskCodeReviewStore,
  TaskRepairAdmissionStore,
  TaskVerificationEvidenceStore,
  WriteGuard
} from '@ai-native-software-delivery-orchestrator/domain';
import { describe, expect, it } from 'vitest';

import {
  RepairExecutionCoordinator,
  RepairExecutionError
} from './repair-execution-coordinator.js';
import { TaskCodeReviewCollector } from './task-code-review-collector.js';
import { TaskRepairCoordinator } from './task-repair-coordinator.js';

const subject = {
  builderAttemptId: 'builder-1',
  outputAttemptId: 'builder-1',
  workspaceId: 'workspace-1',
  workspaceRevision: 1,
  workspaceChangeFingerprint: `sha256:${'1'.repeat(64)}`,
  impactFingerprint: `sha256:${'2'.repeat(64)}`,
  verificationFingerprint: `sha256:${'3'.repeat(64)}`
};

const builderAttempt: AgentExecutionAttempt = {
  id: 'builder-1',
  runId: 'run-1',
  taskId: 'task-1',
  agentId: 'builder',
  workspaceId: 'workspace-1',
  leasePlanFingerprint: 'lease-builder',
  state: 'COMPLETED',
  revision: 1,
  startedAt: new Date('2026-08-13T00:00:00.000Z'),
  completedAt: new Date('2026-08-13T00:01:00.000Z')
};

const workspace = {
  id: 'workspace-1',
  runId: 'run-1',
  taskId: 'task-1',
  integrationRepositoryPath: '/integration',
  workspacePath: '/workspace',
  branchName: 'task-1',
  baseRef: 'base',
  integrationRef: 'main',
  revision: 1,
  phase: 'READY_TO_INTEGRATE' as const
};

const task = {
  id: 'task-1',
  title: 'Validate values',
  goal: 'Validate values before persistence',
  dependencies: [],
  expectedReads: [],
  expectedWrites: [],
  sharedResources: [],
  verification: []
};

const impact = {
  predicted: {
    taskId: 'task-1',
    projectsRead: new Set<string>(),
    projectsWritten: new Set<string>(),
    explicitProjectsWritten: new Set<string>(),
    filesRead: new Set<string>(),
    filesWritten: new Set<string>(['core:value.txt']),
    explicitFilesWritten: new Set<string>(['core:value.txt']),
    globFilesWritten: new Set<string>(),
    symbolDerivedFilesWritten: new Set<string>(),
    symbolsRead: new Set<string>(),
    symbolsWritten: new Set<string>(),
    sharedResources: new Set<string>(),
    sharedResourceAccesses: [],
    downstreamProjects: new Set<string>(),
    riskSignals: []
  }
};

const repairReview = {
  recommendation: 'repair' as const,
  summary: 'Repair required.',
  findings: [
    {
      id: 'finding-1',
      severity: 'high' as const,
      fileIds: ['core:value.txt'],
      symbolIds: [],
      description: 'Validate values.'
    }
  ]
};

const store = () => {
  const attempts: any[] = [];
  const repairStore: TaskRepairAdmissionStore = {
    persistRepairAttempt: async (record) => {
      const index = attempts.findIndex(({ attempt }) => attempt.id === record.attempt.id);
      if (index >= 0) {
        attempts[index] = record;
      } else {
        attempts.push(record);
      }
    },
    recoverRepairAttempts: async () => attempts,
    admitRepairAttempt: async ({ attempt }) => {
      const existing = attempts.find(
        ({ attempt: stored }) =>
          stored.parentReviewIteration === attempt.parentReviewIteration &&
          JSON.stringify(stored.parentReviewSubject) === JSON.stringify(attempt.parentReviewSubject)
      );
      if (existing !== undefined) {
        return existing.attempt;
      }
      attempts.push({ runId: attempt.runId, attempt });
      return attempt;
    }
  };
  return { attempts, repairStore };
};

const writeGuard = (): WriteGuard => ({
  acquire: async () => ({ status: 'blocked', conflictingLeaseIds: [] }),
  heartbeat: async () => ({ status: 'not-found' }),
  markStale: async () => ({ status: 'not-found' }),
  release: async ({ leaseId }) => ({
    status: 'released',
    lease: {
      id: leaseId,
      runId: 'run-1',
      agentId: 'repair',
      taskId: 'task-1',
      resource: { type: 'project', projectId: 'core' },
      mode: 'exclusive',
      version: 2,
      state: 'RELEASED',
      acquiredAt: new Date(),
      lastHeartbeatAt: new Date(),
      releasedAt: new Date()
    }
  })
});

const setup = () => {
  const { attempts, repairStore } = store();
  const repairs = new TaskRepairCoordinator({
    store: repairStore,
    maxRepairs: 1,
    createId: () => 'repair-1',
    now: () => new Date('2026-08-13T00:02:00.000Z')
  });
  const reviewRecords: any[] = [];
  const reviews = new TaskCodeReviewCollector({
    reviewer: {
      review: async () => ({ recommendation: 'accept', summary: 'Repaired.', findings: [] })
    },
    store: {
      persistReview: async (record) => {
        reviewRecords.push(record);
      },
      recoverReviews: async () => reviewRecords
    } satisfies TaskCodeReviewStore
  });
  const evidence: any[] = [];
  const verificationEvidence: TaskVerificationEvidenceStore = {
    persistVerificationEvidence: async (record) => {
      evidence.push(record);
    },
    recoverVerificationEvidence: async () => evidence
  };
  const persistedImpacts: any[] = [];
  const persistedLeases: any[] = [];
  return {
    attempts,
    repairs,
    reviews,
    evidence,
    persistedImpacts,
    persistedLeases,
    verificationEvidence,
    persistence: {
      persistImpact: async (record: any) => {
        persistedImpacts.push(record);
      },
      persistLease: async (record: any) => {
        persistedLeases.push(record);
      }
    }
  };
};

describe('RepairExecutionCoordinator', () => {
  it('runs repair through reconciliation, verification evidence, and a new review subject', async () => {
    const setupResult = setup();
    const repair = await setupResult.repairs.prepare({
      runId: 'run-1',
      taskId: 'task-1',
      agentId: 'repair',
      workspaceId: 'workspace-1',
      reviewIteration: 1,
      review: repairReview,
      subject
    });
    const coordinator = new RepairExecutionCoordinator({
      repairs: setupResult.repairs,
      runner: {
        run: async (request) => {
          expect(request.attempt.state).toBe('STARTING');
          await request.onStarted({ sessionRef: { backend: 'pi', value: 'repair-session' } });
          return {
            status: 'completed',
            observedImpact: {
              taskId: 'task-1',
              filesRead: new Set(),
              filesCreated: new Set(),
              filesWritten: new Set(['core:value.txt']),
              filesDeleted: new Set(),
              symbolsWritten: new Set(),
              dependencyRequests: new Set(),
              manifestFilesChanged: new Set(),
              generatedFilesChanged: new Set()
            }
          };
        }
      },
      reconciler: {
        reconcile: async () => ({
          observed: {
            taskId: 'task-1',
            filesRead: new Set(),
            filesCreated: new Set(),
            filesWritten: new Set(['core:value.txt']),
            filesDeleted: new Set(),
            symbolsWritten: new Set(),
            dependencyRequests: new Set(),
            manifestFilesChanged: new Set(),
            generatedFilesChanged: new Set()
          },
          reconciliation: {
            status: 'within-predicted-scope',
            expandedFileIds: new Set(),
            unleasedFileIds: new Set()
          }
        })
      },
      verifier: { verify: async () => ({ status: 'passed' }) },
      snapshots: {
        capture: async () => ({
          repositoryId: `sha256:${'a'.repeat(64)}`,
          repositoryRoot: '/workspace',
          baseCommit: 'b'.repeat(40),
          workingTreeFingerprint: `sha256:${'4'.repeat(64)}`,
          dirty: true
        })
      },
      subjects: {
        createSubject: (request) => ({
          ...subject,
          outputAttemptId: request.outputAttemptId,
          workspaceChangeFingerprint: request.workspaceSnapshot.workingTreeFingerprint,
          verificationFingerprint: request.verificationFingerprint
        })
      },
      reviews: setupResult.reviews,
      verificationEvidence: setupResult.verificationEvidence,
      writeGuard: writeGuard(),
      persistence: setupResult.persistence,
      createEvidenceId: () => 'verification-repair-1',
      createVerificationEvidence: (request) => ({
        id: request.id,
        runId: request.attempt.runId,
        taskId: request.attempt.taskId,
        attemptId: request.attempt.id,
        workspaceId: request.workspace.id,
        workspaceRevision: request.workspace.revision,
        workspaceChangeFingerprint: request.snapshot.workingTreeFingerprint,
        verificationPolicyFingerprint: request.verificationPolicyFingerprint,
        status: 'passed',
        verifiedAt: request.verifiedAt.toISOString(),
        fingerprint: `sha256:${'5'.repeat(64)}`
      })
    });
    const result = await coordinator.execute({
      repair,
      builderAttempt,
      task,
      workspace,
      impact,
      leases: [],
      verificationPolicyFingerprint: `sha256:${'6'.repeat(64)}`,
      repository: {
        files: new Map([
          [
            'core:value.txt',
            { id: 'core:value.txt', projectId: 'core', path: 'value.txt', isGenerated: false }
          ]
        ]),
        symbols: new Map()
      },
      reviewIteration: 2
    });
    expect(result).toMatchObject({
      attempt: { state: 'COMPLETED', sessionRef: { value: 'repair-session' } },
      review: { recommendation: 'accept' },
      reviewSubject: { outputAttemptId: 'repair-1' }
    });
    expect(setupResult.evidence).toHaveLength(1);
    expect(setupResult.persistedImpacts).toHaveLength(1);
  });

  it('marks a started repair UNKNOWN and retains leases when runner throws', async () => {
    const setupResult = setup();
    const repair = await setupResult.repairs.prepare({
      runId: 'run-1',
      taskId: 'task-1',
      agentId: 'repair',
      workspaceId: 'workspace-1',
      reviewIteration: 1,
      review: repairReview,
      subject
    });
    const coordinator = new RepairExecutionCoordinator({
      repairs: setupResult.repairs,
      runner: {
        run: async (request) => {
          await request.onStarted({});
          throw new Error('connection lost');
        }
      },
      reconciler: {
        reconcile: async () => {
          throw new Error('not reached');
        }
      },
      verifier: { verify: async () => ({ status: 'passed' }) },
      snapshots: {
        capture: async () => {
          throw new Error('not reached');
        }
      },
      subjects: { createSubject: () => subject },
      reviews: setupResult.reviews,
      verificationEvidence: setupResult.verificationEvidence,
      writeGuard: writeGuard(),
      persistence: setupResult.persistence,
      createEvidenceId: () => 'unused',
      createVerificationEvidence: () => {
        throw new Error('not reached');
      }
    });
    const lease = {
      id: 'lease-1',
      runId: 'run-1',
      agentId: 'repair',
      taskId: 'task-1',
      resource: { type: 'project' as const, projectId: 'core' },
      mode: 'exclusive' as const,
      version: 1,
      state: 'ACTIVE' as const,
      acquiredAt: new Date(),
      lastHeartbeatAt: new Date()
    };
    await expect(
      coordinator.execute({
        repair,
        builderAttempt,
        task,
        workspace,
        impact,
        leases: [lease],
        verificationPolicyFingerprint: `sha256:${'6'.repeat(64)}`,
        repository: { files: new Map(), symbols: new Map() },
        reviewIteration: 2
      })
    ).rejects.toThrow(RepairExecutionError);
    expect(setupResult.attempts[0]?.attempt).toMatchObject({ state: 'UNKNOWN' });
    expect(setupResult.persistedLeases).toEqual([]);
  });

  it('fails a pre-start repair and releases its active lease', async () => {
    const setupResult = setup();
    const repair = await setupResult.repairs.prepare({
      runId: 'run-1',
      taskId: 'task-1',
      agentId: 'repair',
      workspaceId: 'workspace-1',
      reviewIteration: 1,
      review: repairReview,
      subject
    });
    const lease = {
      id: 'lease-1',
      runId: 'run-1',
      agentId: 'repair',
      taskId: 'task-1',
      resource: { type: 'project' as const, projectId: 'core' },
      mode: 'exclusive' as const,
      version: 1,
      state: 'ACTIVE' as const,
      acquiredAt: new Date(),
      lastHeartbeatAt: new Date()
    };
    const coordinator = new RepairExecutionCoordinator({
      repairs: setupResult.repairs,
      runner: {
        run: async () => {
          throw new Error('startup failed');
        }
      },
      reconciler: {
        reconcile: async () => {
          throw new Error('not reached');
        }
      },
      verifier: { verify: async () => ({ status: 'passed' }) },
      snapshots: {
        capture: async () => {
          throw new Error('not reached');
        }
      },
      subjects: { createSubject: () => subject },
      reviews: setupResult.reviews,
      verificationEvidence: setupResult.verificationEvidence,
      writeGuard: writeGuard(),
      persistence: setupResult.persistence,
      createEvidenceId: () => 'unused',
      createVerificationEvidence: () => {
        throw new Error('not reached');
      }
    });
    await expect(
      coordinator.execute({
        repair,
        builderAttempt,
        task,
        workspace,
        impact,
        leases: [lease],
        verificationPolicyFingerprint: `sha256:${'6'.repeat(64)}`,
        repository: { files: new Map(), symbols: new Map() },
        reviewIteration: 2
      })
    ).rejects.toThrow('failed before start');
    expect(setupResult.attempts[0]?.attempt).toMatchObject({ state: 'FAILED' });
    expect(setupResult.persistedLeases).toHaveLength(1);
  });

  it('fails closed and releases leases when repair reconciliation finds an unleased change', async () => {
    const setupResult = setup();
    const repair = await setupResult.repairs.prepare({
      runId: 'run-1',
      taskId: 'task-1',
      agentId: 'repair',
      workspaceId: 'workspace-1',
      reviewIteration: 1,
      review: repairReview,
      subject
    });
    const lease = {
      id: 'lease-1',
      runId: 'run-1',
      agentId: 'repair',
      taskId: 'task-1',
      resource: { type: 'project' as const, projectId: 'core' },
      mode: 'exclusive' as const,
      version: 1,
      state: 'ACTIVE' as const,
      acquiredAt: new Date(),
      lastHeartbeatAt: new Date()
    };
    const coordinator = new RepairExecutionCoordinator({
      repairs: setupResult.repairs,
      runner: {
        run: async (request) => {
          await request.onStarted({});
          return { status: 'completed' };
        }
      },
      reconciler: {
        reconcile: async () => ({
          observed: {
            taskId: 'task-1',
            filesRead: new Set(),
            filesCreated: new Set(),
            filesWritten: new Set(['core:unleased.txt']),
            filesDeleted: new Set(),
            symbolsWritten: new Set(),
            dependencyRequests: new Set(),
            manifestFilesChanged: new Set(),
            generatedFilesChanged: new Set()
          },
          reconciliation: {
            status: 'unleased-change',
            expandedFileIds: new Set(['core:unleased.txt']),
            unleasedFileIds: new Set(['core:unleased.txt'])
          }
        })
      },
      verifier: { verify: async () => ({ status: 'passed' }) },
      snapshots: {
        capture: async () => {
          throw new Error('not reached');
        }
      },
      subjects: { createSubject: () => subject },
      reviews: setupResult.reviews,
      verificationEvidence: setupResult.verificationEvidence,
      writeGuard: writeGuard(),
      persistence: setupResult.persistence,
      createEvidenceId: () => 'unused',
      createVerificationEvidence: () => {
        throw new Error('not reached');
      }
    });
    await expect(
      coordinator.execute({
        repair,
        builderAttempt,
        task,
        workspace,
        impact,
        leases: [lease],
        verificationPolicyFingerprint: `sha256:${'6'.repeat(64)}`,
        repository: { files: new Map(), symbols: new Map() },
        reviewIteration: 2
      })
    ).rejects.toThrow('without an active write lease');
    expect(setupResult.attempts[0]?.attempt).toMatchObject({ state: 'FAILED' });
    expect(setupResult.persistedLeases).toHaveLength(1);
  });

  it('releases initial and dynamically acquired leases when a started repair is blocked', async () => {
    const setupResult = setup();
    const repair = await setupResult.repairs.prepare({
      runId: 'run-1',
      taskId: 'task-1',
      agentId: 'repair',
      workspaceId: 'workspace-1',
      reviewIteration: 1,
      review: repairReview,
      subject
    });
    const initial = {
      id: 'lease-1',
      runId: 'run-1',
      agentId: 'repair',
      taskId: 'task-1',
      resource: { type: 'project' as const, projectId: 'core' },
      mode: 'exclusive' as const,
      version: 1,
      state: 'ACTIVE' as const,
      acquiredAt: new Date(),
      lastHeartbeatAt: new Date()
    };
    const dynamic = { ...initial, id: 'lease-2' };
    const coordinator = new RepairExecutionCoordinator({
      repairs: setupResult.repairs,
      runner: {
        run: async (request) => {
          await request.onStarted({});
          return {
            status: 'blocked',
            leaseId: 'owner-lease',
            detail: 'Blocked.',
            additionalLeases: [dynamic]
          };
        }
      },
      reconciler: {
        reconcile: async () => {
          throw new Error('not reached');
        }
      },
      verifier: { verify: async () => ({ status: 'passed' }) },
      snapshots: {
        capture: async () => {
          throw new Error('not reached');
        }
      },
      subjects: { createSubject: () => subject },
      reviews: setupResult.reviews,
      verificationEvidence: setupResult.verificationEvidence,
      writeGuard: writeGuard(),
      persistence: setupResult.persistence,
      createEvidenceId: () => 'unused',
      createVerificationEvidence: () => {
        throw new Error('not reached');
      }
    });
    await expect(
      coordinator.execute({
        repair,
        builderAttempt,
        task,
        workspace,
        impact,
        leases: [initial],
        verificationPolicyFingerprint: `sha256:${'6'.repeat(64)}`,
        repository: { files: new Map(), symbols: new Map() },
        reviewIteration: 2
      })
    ).rejects.toThrow('blocked by lease');
    expect(
      setupResult.persistedLeases
        .map(({ lease }) => lease.id)
        .toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    ).toEqual(['lease-1', 'lease-2']);
    expect(setupResult.attempts[0]?.attempt).toMatchObject({ state: 'FAILED' });
  });

  it('does not create review or verification evidence when repair verification fails', async () => {
    const setupResult = setup();
    const repair = await setupResult.repairs.prepare({
      runId: 'run-1',
      taskId: 'task-1',
      agentId: 'repair',
      workspaceId: 'workspace-1',
      reviewIteration: 1,
      review: repairReview,
      subject
    });
    const coordinator = new RepairExecutionCoordinator({
      repairs: setupResult.repairs,
      runner: {
        run: async (request) => {
          await request.onStarted({});
          return { status: 'completed' };
        }
      },
      reconciler: {
        reconcile: async () => ({
          observed: {
            taskId: 'task-1',
            filesRead: new Set(),
            filesCreated: new Set(),
            filesWritten: new Set(),
            filesDeleted: new Set(),
            symbolsWritten: new Set(),
            dependencyRequests: new Set(),
            manifestFilesChanged: new Set(),
            generatedFilesChanged: new Set()
          },
          reconciliation: {
            status: 'within-predicted-scope',
            expandedFileIds: new Set(),
            unleasedFileIds: new Set()
          }
        })
      },
      verifier: { verify: async () => ({ status: 'failed', detail: 'Tests failed.' }) },
      snapshots: {
        capture: async () => {
          throw new Error('not reached');
        }
      },
      subjects: { createSubject: () => subject },
      reviews: setupResult.reviews,
      verificationEvidence: setupResult.verificationEvidence,
      writeGuard: writeGuard(),
      persistence: setupResult.persistence,
      createEvidenceId: () => 'unused',
      createVerificationEvidence: () => {
        throw new Error('not reached');
      }
    });
    await expect(
      coordinator.execute({
        repair,
        builderAttempt,
        task,
        workspace,
        impact,
        leases: [],
        verificationPolicyFingerprint: `sha256:${'6'.repeat(64)}`,
        repository: { files: new Map(), symbols: new Map() },
        reviewIteration: 2
      })
    ).rejects.toThrow('verification failed');
    expect(setupResult.evidence).toEqual([]);
  });

  it('fails a completed result that never establishes the external repair session', async () => {
    const setupResult = setup();
    const repair = await setupResult.repairs.prepare({
      runId: 'run-1',
      taskId: 'task-1',
      agentId: 'repair',
      workspaceId: 'workspace-1',
      reviewIteration: 1,
      review: repairReview,
      subject
    });
    const coordinator = new RepairExecutionCoordinator({
      repairs: setupResult.repairs,
      runner: { run: async () => ({ status: 'completed' }) },
      reconciler: {
        reconcile: async () => {
          throw new Error('not reached');
        }
      },
      verifier: { verify: async () => ({ status: 'passed' }) },
      snapshots: {
        capture: async () => {
          throw new Error('not reached');
        }
      },
      subjects: { createSubject: () => subject },
      reviews: setupResult.reviews,
      verificationEvidence: setupResult.verificationEvidence,
      writeGuard: writeGuard(),
      persistence: setupResult.persistence,
      createEvidenceId: () => 'unused',
      createVerificationEvidence: () => {
        throw new Error('not reached');
      }
    });
    await expect(
      coordinator.execute({
        repair,
        builderAttempt,
        task,
        workspace,
        impact,
        leases: [],
        verificationPolicyFingerprint: `sha256:${'6'.repeat(64)}`,
        repository: { files: new Map(), symbols: new Map() },
        reviewIteration: 2
      })
    ).rejects.toThrow('did not complete');
    expect(setupResult.attempts[0]?.attempt).toMatchObject({ state: 'FAILED' });
  });

  it('rejects a repair runner that reports started twice', async () => {
    const setupResult = setup();
    const repair = await setupResult.repairs.prepare({
      runId: 'run-1',
      taskId: 'task-1',
      agentId: 'repair',
      workspaceId: 'workspace-1',
      reviewIteration: 1,
      review: repairReview,
      subject
    });
    const coordinator = new RepairExecutionCoordinator({
      repairs: setupResult.repairs,
      runner: {
        run: async (request) => {
          await request.onStarted({});
          await request.onStarted({});
          return { status: 'completed' };
        }
      },
      reconciler: {
        reconcile: async () => {
          throw new Error('not reached');
        }
      },
      verifier: { verify: async () => ({ status: 'passed' }) },
      snapshots: {
        capture: async () => {
          throw new Error('not reached');
        }
      },
      subjects: { createSubject: () => subject },
      reviews: setupResult.reviews,
      verificationEvidence: setupResult.verificationEvidence,
      writeGuard: writeGuard(),
      persistence: setupResult.persistence,
      createEvidenceId: () => 'unused',
      createVerificationEvidence: () => {
        throw new Error('not reached');
      }
    });
    await expect(
      coordinator.execute({
        repair,
        builderAttempt,
        task,
        workspace,
        impact,
        leases: [],
        verificationPolicyFingerprint: `sha256:${'6'.repeat(64)}`,
        repository: { files: new Map(), symbols: new Map() },
        reviewIteration: 2
      })
    ).rejects.toThrow('outcome is unknown');
    expect(setupResult.attempts[0]?.attempt).toMatchObject({ state: 'UNKNOWN' });
  });

  it('fails closed when a completed repair lease cannot be released', async () => {
    const setupResult = setup();
    const repair = await setupResult.repairs.prepare({
      runId: 'run-1',
      taskId: 'task-1',
      agentId: 'repair',
      workspaceId: 'workspace-1',
      reviewIteration: 1,
      review: repairReview,
      subject
    });
    const lease = {
      id: 'lease-1',
      runId: 'run-1',
      agentId: 'repair',
      taskId: 'task-1',
      resource: { type: 'project' as const, projectId: 'core' },
      mode: 'exclusive' as const,
      version: 1,
      state: 'ACTIVE' as const,
      acquiredAt: new Date(),
      lastHeartbeatAt: new Date()
    };
    const brokenGuard: WriteGuard = {
      acquire: async () => ({ status: 'blocked', conflictingLeaseIds: [] }),
      heartbeat: async () => ({ status: 'not-found' }),
      markStale: async () => ({ status: 'not-found' }),
      release: async () => ({ status: 'version-conflict', actualVersion: 2 })
    };
    const coordinator = new RepairExecutionCoordinator({
      repairs: setupResult.repairs,
      runner: {
        run: async (request) => {
          await request.onStarted({});
          return { status: 'completed' };
        }
      },
      reconciler: {
        reconcile: async () => ({
          observed: {
            taskId: 'task-1',
            filesRead: new Set(),
            filesCreated: new Set(),
            filesWritten: new Set(),
            filesDeleted: new Set(),
            symbolsWritten: new Set(),
            dependencyRequests: new Set(),
            manifestFilesChanged: new Set(),
            generatedFilesChanged: new Set()
          },
          reconciliation: {
            status: 'within-predicted-scope',
            expandedFileIds: new Set(),
            unleasedFileIds: new Set()
          }
        })
      },
      verifier: { verify: async () => ({ status: 'passed' }) },
      snapshots: {
        capture: async () => {
          throw new Error('not reached');
        }
      },
      subjects: { createSubject: () => subject },
      reviews: setupResult.reviews,
      verificationEvidence: setupResult.verificationEvidence,
      writeGuard: brokenGuard,
      persistence: setupResult.persistence,
      createEvidenceId: () => 'unused',
      createVerificationEvidence: () => {
        throw new Error('not reached');
      }
    });
    await expect(
      coordinator.execute({
        repair,
        builderAttempt,
        task,
        workspace,
        impact,
        leases: [lease],
        verificationPolicyFingerprint: `sha256:${'6'.repeat(64)}`,
        repository: { files: new Map(), symbols: new Map() },
        reviewIteration: 2
      })
    ).rejects.toThrow('lease release failed');
    expect(setupResult.evidence).toEqual([]);
  });
});
