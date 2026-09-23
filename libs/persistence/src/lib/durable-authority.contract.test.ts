import type {
  ActiveMutationClaimPersistence,
  CancellationPersistence,
  CreatePersistedRunRequest,
  IntegrationMutationClaimPersistence,
  OrchestrationPersistence,
  PersistedDispatch,
  PersistedTaskRepairAttempt,
  TaskCodeReviewStore,
  TaskRepairResumeStore,
  TaskRepairWorkItemAdmissionStore,
  TaskRepairWorkItemStore,
  TaskVerificationEvidenceStore
} from '@ai-native-software-delivery-orchestrator/domain';
import { taskVerificationEvidenceFingerprint } from '@ai-native-software-delivery-orchestrator/domain';
import { describe, expect, it } from 'vitest';

export type DurableAuthorityStore = OrchestrationPersistence &
  ActiveMutationClaimPersistence &
  CancellationPersistence &
  IntegrationMutationClaimPersistence &
  TaskCodeReviewStore &
  TaskRepairWorkItemAdmissionStore &
  TaskRepairResumeStore &
  TaskRepairWorkItemStore &
  TaskVerificationEvidenceStore & {
    ensureInitialDispatch: NonNullable<OrchestrationPersistence['ensureInitialDispatch']>;
  };

export interface DurableAuthorityFixture {
  readonly store: DurableAuthorityStore;
  /** An independent connection to the same durable authority. */
  readonly peer: DurableAuthorityStore;
  close(): Promise<void>;
}

const digest = (digit: string): string => `sha256:${digit.repeat(64)}`;

export const durableAuthorityRunRequest = (runId = 'contract-run'): CreatePersistedRunRequest => ({
  run: {
    id: runId,
    repositoryId: 'contract-repository',
    state: 'ACTIVE',
    createdAt: '2026-09-01T00:00:00.000Z',
    authority: {
      artifactId: 'contract-artifact',
      artifactRevision: 1,
      approvalId: 'contract-approval',
      planFingerprint: digest('1'),
      approvalFingerprint: digest('2'),
      claimFingerprint: digest('3'),
      executionFingerprint: digest('4'),
      repositoryRoot: '/contract-repository',
      baseCommit: '5'.repeat(40),
      workingTreeFingerprint: digest('6'),
      repositoryFactsFingerprint: digest('7'),
      sharedResourcePolicyFingerprint: digest('8'),
      verificationPolicyFingerprint: digest('9'),
      codeReviewPolicyFingerprint: digest('a')
    }
  },
  tasks: [
    {
      id: 'task-1',
      title: 'Contract task',
      goal: 'Exercise durable authority',
      dependencies: [],
      expectedReads: [],
      expectedWrites: [],
      sharedResources: [],
      verification: []
    }
  ],
  taskBindings: [
    {
      runId,
      taskId: 'task-1',
      agentId: 'agent-1',
      leasePlan: {
        taskId: 'task-1',
        predictedResources: [{ type: 'project', projectId: 'project-1' }],
        source: 'manual'
      },
      workspace: {
        id: 'workspace-1',
        runId,
        taskId: 'task-1',
        integrationRepositoryPath: '/integration',
        workspacePath: '/workspaces/task-1',
        branchName: `forge/${runId}/task-1`,
        baseRef: 'main',
        integrationRef: 'main'
      }
    }
  ],
  hardConflicts: [],
  riskConflicts: [],
  scheduleOptions: { maxConcurrency: 1 }
});

export const durableAuthorityInitialDispatch = (runId = 'contract-run'): PersistedDispatch => ({
  reevaluation: {
    event: {
      runId,
      sequence: 1,
      occurredAt: '2026-09-01T00:01:00.000Z',
      event: { type: 'run-started' }
    },
    transitions: [
      { runId, sequence: 1, taskId: 'task-1', fromState: 'PENDING', toState: 'READY' },
      { runId, sequence: 1, taskId: 'task-1', fromState: 'READY', toState: 'RUNNING' }
    ],
    decision: {
      runId,
      sequence: 1,
      inputSnapshot: { taskStates: [{ taskId: 'task-1', state: 'PENDING' }], runtimeBlocks: [] },
      decision: {
        taskDecisions: [
          {
            taskId: 'task-1',
            action: 'ready',
            fromState: 'PENDING',
            toState: 'READY',
            reasons: [{ type: 'dependencies-completed', dependencyTaskIds: [] }]
          },
          {
            taskId: 'task-1',
            action: 'start',
            fromState: 'READY',
            toState: 'RUNNING',
            reasons: [{ type: 'selected-by-priority', priority: 0 }]
          }
        ]
      }
    }
  },
  attempts: [
    {
      runId,
      attempt: {
        id: 'contract-builder',
        runId,
        taskId: 'task-1',
        agentId: 'agent-1',
        workspaceId: 'workspace-1',
        leasePlanFingerprint: digest('b'),
        state: 'PREPARING',
        revision: 1
      }
    }
  ]
});

const reviewSubject = {
  builderAttemptId: 'contract-builder',
  outputAttemptId: 'contract-builder',
  workspaceId: 'workspace-1',
  workspaceRevision: 1,
  workspaceChangeFingerprint: digest('c'),
  impactFingerprint: digest('d'),
  verificationFingerprint: digest('e')
};

export const durableAuthorityRepairAttempt = (
  id: string,
  iteration = 1
): PersistedTaskRepairAttempt['attempt'] => ({
  id,
  runId: 'contract-run',
  taskId: 'task-1',
  agentId: 'repair-agent',
  workspaceId: 'workspace-1',
  parentReviewIteration: iteration,
  parentReviewSubject: {
    ...reviewSubject,
    workspaceChangeFingerprint: iteration === 1 ? digest('c') : digest('f')
  },
  repairIteration: iteration,
  state: 'PREPARING',
  revision: 1
});

export const durableAuthorityRepairWorkItem = (attempt: PersistedTaskRepairAttempt['attempt']) => ({
  runId: attempt.runId,
  taskId: attempt.taskId,
  repairAttemptId: attempt.id,
  builderAttemptId: 'contract-builder',
  workspaceId: attempt.workspaceId,
  leasePlanFingerprint: digest('b'),
  impactFingerprint: digest('d'),
  parentReviewIteration: attempt.parentReviewIteration,
  reviewIteration: attempt.parentReviewIteration + 1,
  verificationPolicyFingerprint: digest('9'),
  codeReviewPolicyFingerprint: digest('a')
});

/** Backend-neutral behavioral suite. Every adapter must run these exact assertions. */
export const durableAuthorityContract = (
  name: string,
  create: () => Promise<DurableAuthorityFixture>
): void => {
  describe(`durable Forge authority: ${name}`, () => {
    it('stores exact run authority and task bindings; duplicate IDs cannot replace them', async () => {
      const fixture = await create();
      try {
        const request = durableAuthorityRunRequest();
        await fixture.store.createRun(request);
        await expect(fixture.store.recoverTaskBindings(request.run.id)).resolves.toEqual(
          request.taskBindings
        );
        await expect(fixture.store.recoverTaskBinding(request.run.id, 'task-1')).resolves.toEqual(
          request.taskBindings[0]
        );
        await expect(fixture.store.createRun(request)).rejects.toThrow();
        await expect(
          fixture.store.createRun({
            ...request,
            run: {
              ...request.run,
              authority: { ...request.run.authority, planFingerprint: digest('f') }
            }
          })
        ).rejects.toThrow();
        expect((await fixture.store.recoverRun(request.run.id))?.run.authority).toEqual(
          request.run.authority
        );
      } finally {
        await fixture.close();
      }
    });

    it('commits sequence-one dispatch once and preserves an already claimed builder', async () => {
      const fixture = await create();
      try {
        await fixture.store.createRun(durableAuthorityRunRequest());
        const dispatch = durableAuthorityInitialDispatch();
        await fixture.store.ensureInitialDispatch(dispatch);
        const started = {
          ...dispatch.attempts[0].attempt,
          state: 'STARTING' as const,
          revision: 2,
          startedAt: new Date('2026-09-01T00:02:00.000Z')
        };
        await fixture.store.claimBuilderStart({
          runId: 'contract-run',
          attempt: started,
          leases: []
        });
        await fixture.peer.ensureInitialDispatch(dispatch);
        expect((await fixture.store.recoverRun('contract-run'))?.events).toHaveLength(1);
        expect((await fixture.store.recoverRun('contract-run'))?.decisions).toHaveLength(1);
        await expect(fixture.store.recoverAttempts('contract-run')).resolves.toMatchObject([
          { attempt: { id: 'contract-builder', state: 'STARTING', revision: 2 } }
        ]);
        await expect(
          fixture.store.ensureInitialDispatch({
            ...dispatch,
            reevaluation: {
              ...dispatch.reevaluation,
              event: { ...dispatch.reevaluation.event, occurredAt: '2026-09-01T00:03:00.000Z' }
            }
          })
        ).rejects.toThrow();
        await expect(
          fixture.store.claimBuilderStart({ runId: 'contract-run', attempt: started, leases: [] })
        ).rejects.toThrow();
      } finally {
        await fixture.close();
      }
    });

    it('permits exactly one builder PREPARING claim across independent connections', async () => {
      const fixture = await create();
      try {
        await fixture.store.createRun(durableAuthorityRunRequest());
        await fixture.store.ensureInitialDispatch(durableAuthorityInitialDispatch());
        const starting = {
          ...durableAuthorityInitialDispatch().attempts[0].attempt,
          state: 'STARTING' as const,
          revision: 2,
          startedAt: new Date('2026-09-01T00:02:00.000Z')
        };
        const outcomes = await Promise.allSettled([
          fixture.store.claimBuilderStart({ runId: 'contract-run', attempt: starting, leases: [] }),
          fixture.peer.claimBuilderStart({ runId: 'contract-run', attempt: starting, leases: [] })
        ]);
        expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
        expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1);
        await expect(fixture.peer.recoverAttempts('contract-run')).resolves.toMatchObject([
          { attempt: { id: 'contract-builder', state: 'STARTING', revision: 2 } }
        ]);
      } finally {
        await fixture.close();
      }
    });

    it('admits one repair per parent review and enforces the budget atomically', async () => {
      const fixture = await create();
      try {
        await fixture.store.createRun(durableAuthorityRunRequest());
        const [first, retry] = await Promise.all([
          fixture.store.admitRepairAttemptWithWorkItem({
            attempt: durableAuthorityRepairAttempt('repair-first'),
            maxRepairs: 1,
            createWorkItem: durableAuthorityRepairWorkItem
          }),
          fixture.peer.admitRepairAttemptWithWorkItem({
            attempt: durableAuthorityRepairAttempt('repair-retry'),
            maxRepairs: 1,
            createWorkItem: durableAuthorityRepairWorkItem
          })
        ]);
        expect(retry.id).toBe(first.id);
        expect(await fixture.peer.recoverRepairWorkItems('contract-run')).toEqual([
          durableAuthorityRepairWorkItem(first)
        ]);
        await expect(
          fixture.store.admitRepairAttemptWithWorkItem({
            attempt: durableAuthorityRepairAttempt('repair-second', 2),
            maxRepairs: 1,
            createWorkItem: durableAuthorityRepairWorkItem
          })
        ).rejects.toThrow();
        await expect(fixture.store.recoverRepairAttempts('contract-run')).resolves.toHaveLength(1);
      } finally {
        await fixture.close();
      }
    });

    it('permits exactly one repair PREPARING claim across independent connections', async () => {
      const fixture = await create();
      try {
        await fixture.store.createRun(durableAuthorityRunRequest());
        const admitted = await fixture.store.admitRepairAttemptWithWorkItem({
          attempt: durableAuthorityRepairAttempt('repair-first'),
          maxRepairs: 1,
          createWorkItem: durableAuthorityRepairWorkItem
        });
        const starting = {
          ...admitted,
          state: 'STARTING' as const,
          revision: admitted.revision + 1,
          startedAt: new Date('2026-09-01T00:02:00.000Z')
        };
        const outcomes = await Promise.allSettled([
          fixture.store.claimRepairStart({ runId: 'contract-run', attempt: starting }),
          fixture.peer.claimRepairStart({ runId: 'contract-run', attempt: starting })
        ]);
        expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
        expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1);
        await expect(fixture.peer.recoverRepairAttempts('contract-run')).resolves.toMatchObject([
          { attempt: { id: admitted.id, state: 'STARTING', revision: 2 } }
        ]);
        await expect(fixture.peer.recoverRepairWorkItems('contract-run')).resolves.toEqual([
          durableAuthorityRepairWorkItem(admitted)
        ]);
      } finally {
        await fixture.close();
      }
    });

    it('rejects all new mutation claims after cancellation holds durable run authority', async () => {
      const fixture = await create();
      try {
        await fixture.store.createRun(durableAuthorityRunRequest());
        await fixture.store.ensureInitialDispatch(durableAuthorityInitialDispatch());
        const admitted = await fixture.store.admitRepairAttemptWithWorkItem({
          attempt: durableAuthorityRepairAttempt('repair-first'),
          maxRepairs: 1,
          createWorkItem: durableAuthorityRepairWorkItem
        });
        await expect(fixture.peer.requestCancellation('contract-run')).resolves.toEqual({
          status: 'requested',
          state: 'CANCEL_REQUESTED'
        });
        await expect(
          fixture.store.claimBuilderStart({
            runId: 'contract-run',
            attempt: {
              ...durableAuthorityInitialDispatch().attempts[0].attempt,
              state: 'STARTING',
              revision: 2,
              startedAt: new Date('2026-09-01T00:02:00.000Z')
            },
            leases: [
              {
                id: 'contract-cancelled-builder-lease',
                runId: 'contract-run',
                agentId: 'agent-1',
                taskId: 'task-1',
                resource: { type: 'project', projectId: 'project-1' },
                mode: 'exclusive',
                version: 1,
                state: 'ACTIVE',
                acquiredAt: new Date('2026-09-01T00:02:00.000Z'),
                lastHeartbeatAt: new Date('2026-09-01T00:02:00.000Z')
              }
            ]
          })
        ).rejects.toThrow();
        await expect(
          fixture.store.claimRepairStart({
            runId: 'contract-run',
            attempt: {
              ...admitted,
              state: 'STARTING',
              revision: 2,
              startedAt: new Date('2026-09-01T00:02:00.000Z')
            }
          })
        ).rejects.toThrow();
        await expect(
          fixture.store.claimIntegrationStart({
            runId: 'contract-run',
            taskId: 'task-1',
            workspaceId: 'workspace-1',
            outputAttemptId: 'contract-builder'
          })
        ).rejects.toThrow();
        await expect(fixture.peer.recoverAttempts('contract-run')).resolves.toMatchObject([
          { attempt: { id: 'contract-builder', state: 'PREPARING', revision: 1 } }
        ]);
        await expect(fixture.peer.recoverRepairAttempts('contract-run')).resolves.toMatchObject([
          { attempt: { id: admitted.id, state: 'PREPARING', revision: 1 } }
        ]);
        await expect(fixture.peer.recoverLeases('contract-run')).resolves.not.toContainEqual(
          expect.objectContaining({
            lease: expect.objectContaining({ id: 'contract-cancelled-builder-lease' })
          })
        );
        await expect(fixture.peer.hasActiveIntegrationClaim('contract-run')).resolves.toBe(false);
        await expect(fixture.peer.recoverRun('contract-run')).resolves.toMatchObject({
          run: { state: 'CANCEL_REQUESTED' }
        });
      } finally {
        await fixture.close();
      }
    });

    it('resumes a blocked repair with a released lease once and records one dispatch', async () => {
      const fixture = await create();
      try {
        await fixture.store.createRun(durableAuthorityRunRequest());
        const admitted = await fixture.store.admitRepairAttemptWithWorkItem({
          attempt: durableAuthorityRepairAttempt('repair-first'),
          maxRepairs: 1,
          createWorkItem: durableAuthorityRepairWorkItem
        });
        const blocked = {
          ...admitted,
          state: 'BLOCKED' as const,
          revision: 2,
          startedAt: new Date('2026-09-01T00:02:00.000Z'),
          blocker: { type: 'lease' as const, leaseId: 'contract-lease' }
        };
        await fixture.store.persistRepairAttempt({ runId: 'contract-run', attempt: blocked });
        await fixture.store.persistLease({
          runId: 'contract-run',
          lease: {
            id: 'contract-lease',
            runId: 'contract-run',
            agentId: 'agent-1',
            taskId: 'task-1',
            resource: { type: 'project', projectId: 'project-1' },
            mode: 'exclusive',
            version: 1,
            state: 'RELEASED',
            acquiredAt: new Date('2026-09-01T00:00:00.000Z'),
            lastHeartbeatAt: new Date('2026-09-01T00:00:00.000Z'),
            releasedAt: new Date('2026-09-01T00:02:00.000Z')
          }
        });
        const resume = {
          runId: 'contract-run',
          attemptId: admitted.id,
          expectedRevision: 2,
          dispatch: {
            taskId: 'task-1',
            dispatchId: 'contract-resume',
            authorizedAt: '2026-09-01T00:03:00.000Z'
          }
        };
        const outcomes = await Promise.all([
          fixture.store.resumeRepairAttempt(resume),
          fixture.peer.resumeRepairAttempt(resume)
        ]);
        expect(outcomes.filter(({ status }) => status === 'resumed')).toHaveLength(1);
        expect(outcomes.filter(({ status }) => status === 'version-conflict')).toHaveLength(1);
        expect(await fixture.peer.recoverRepairResumeDispatches('contract-run')).toMatchObject([
          { repairAttemptId: admitted.id, repairRevision: 3, dispatchId: 'contract-resume' }
        ]);
        expect(await fixture.store.recoverRepairAttempts('contract-run')).toMatchObject([
          { attempt: { state: 'PREPARING', revision: 3 } }
        ]);
      } finally {
        await fixture.close();
      }
    });

    it('recovers exact review, verification, impact, and workspace evidence without replacement', async () => {
      const fixture = await create();
      try {
        await fixture.store.createRun(durableAuthorityRunRequest());
        const review = {
          runId: 'contract-run',
          taskId: 'task-1',
          iteration: 1,
          subject: reviewSubject,
          review: { recommendation: 'accept' as const, summary: 'Accepted.', findings: [] }
        };
        await fixture.store.persistReview(review);
        await fixture.store.persistReview(review);
        await expect(
          fixture.store.persistReview({
            ...review,
            subject: { ...reviewSubject, workspaceRevision: 2 }
          })
        ).rejects.toThrow();
        const evidencePayload = {
          id: 'contract-verification',
          runId: 'contract-run',
          taskId: 'task-1',
          attemptId: 'contract-builder',
          workspaceId: 'workspace-1',
          workspaceRevision: 1,
          workspaceChangeFingerprint: digest('c'),
          verificationPolicyFingerprint: digest('9'),
          status: 'passed' as const,
          verifiedAt: '2026-09-01T00:02:00.000Z'
        };
        const evidence = {
          ...evidencePayload,
          fingerprint: taskVerificationEvidenceFingerprint(evidencePayload)
        };
        await fixture.store.persistVerificationEvidence(evidence);
        await fixture.store.persistVerificationEvidence(evidence);
        await expect(
          fixture.store.persistVerificationEvidence({ ...evidence, id: 'changed' })
        ).rejects.toThrow();
        await fixture.store.persistImpact({
          runId: 'contract-run',
          taskId: 'task-1',
          impact: {
            predicted: {
              taskId: 'task-1',
              projectsRead: new Set(['project-1']),
              projectsWritten: new Set(['project-1']),
              explicitProjectsWritten: new Set(),
              filesRead: new Set(),
              filesWritten: new Set(),
              explicitFilesWritten: new Set(),
              globFilesWritten: new Set(),
              symbolDerivedFilesWritten: new Set(),
              symbolsRead: new Set(),
              symbolsWritten: new Set(),
              sharedResources: new Set(),
              sharedResourceAccesses: [],
              downstreamProjects: new Set(),
              riskSignals: []
            }
          }
        });
        await fixture.store.persistWorkspace({
          runId: 'contract-run',
          workspace: {
            ...durableAuthorityRunRequest().taskBindings[0].workspace,
            revision: 1,
            phase: 'INTEGRATION_BLOCKED',
            blocker: {
              type: 'rebase-conflict',
              detail: 'Integration requires an exact wake.',
              conflictPaths: ['src/index.ts']
            }
          }
        });
        await expect(fixture.peer.recoverReviews('contract-run')).resolves.toEqual([review]);
        await expect(fixture.peer.recoverVerificationEvidence('contract-run')).resolves.toEqual([
          evidence
        ]);
        const recovered = await fixture.peer.recoverRun('contract-run');
        expect(recovered?.impacts[0]?.impact.predicted.projectsWritten).toEqual(
          new Set(['project-1'])
        );
        expect(recovered?.workspaces).toMatchObject([
          { workspace: { id: 'workspace-1', phase: 'INTEGRATION_BLOCKED' } }
        ]);
      } finally {
        await fixture.close();
      }
    });

    it('serializes integration claims with cancellation and settles only the exact mutation', async () => {
      const fixture = await create();
      try {
        await fixture.store.createRun(durableAuthorityRunRequest());
        const claim = {
          runId: 'contract-run',
          taskId: 'task-1',
          workspaceId: 'workspace-1',
          outputAttemptId: 'contract-builder'
        };
        await fixture.store.claimIntegrationStart(claim);
        await expect(
          fixture.store.claimIntegrationStart({ ...claim, outputAttemptId: 'another-attempt' })
        ).rejects.toThrow();
        await expect(fixture.store.hasActiveIntegrationClaim('contract-run')).resolves.toBe(true);
        await expect(fixture.store.requestCancellation('contract-run')).resolves.toEqual({
          status: 'requested',
          state: 'CANCEL_REQUESTED'
        });
        await expect(fixture.store.hasActiveIntegrationClaim('contract-run')).resolves.toBe(true);
        await expect(
          fixture.store.settleIntegrationCancellation({
            ...claim,
            outputAttemptId: 'another-attempt',
            detail: 'External Git mutation stopped.'
          })
        ).rejects.toThrow();
        await fixture.store.settleIntegrationCancellation({
          ...claim,
          detail: 'External Git mutation stopped.'
        });
        await expect(fixture.store.finalizeCancellation('contract-run')).resolves.toEqual({
          status: 'cancelled',
          state: 'CANCELLED'
        });
        await expect(fixture.store.recoverRun('contract-run')).resolves.toMatchObject({
          run: { state: 'CANCELLED' }
        });
      } finally {
        await fixture.close();
      }
    });

    it('terminalizes only an active run and recovers its durable terminal state', async () => {
      const fixture = await create();
      try {
        await fixture.store.createRun(durableAuthorityRunRequest());
        await fixture.store.updateRunState('contract-run', 'COMPLETED');
        await expect(fixture.peer.recoverRun('contract-run')).resolves.toMatchObject({
          run: { state: 'COMPLETED' }
        });
        await expect(fixture.peer.requestCancellation('contract-run')).resolves.toEqual({
          status: 'terminal',
          state: 'COMPLETED'
        });
        await expect(fixture.peer.updateRunState('contract-run', 'FAILED')).rejects.toThrow();
        await expect(fixture.store.recoverRun('contract-run')).resolves.toMatchObject({
          run: { state: 'COMPLETED' }
        });
      } finally {
        await fixture.close();
      }
    });
  });
};
