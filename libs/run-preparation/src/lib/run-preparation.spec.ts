import type {
  RecoveredRuntimeRun,
  StartRuntimeRunRequest
} from '@ai-native-software-delivery-orchestrator/orchestration-runtime';
import { taskLeasePlanFromPredictedImpact } from '@ai-native-software-delivery-orchestrator/domain';
import {
  createPlanApproval,
  createPlanApprovalClaim,
  createPlanArtifact,
  fingerprintPlanValue,
  parsePlanArtifact,
  parsePlanExecutionIntent,
  type PlanExecutionIntent
} from '@ai-native-software-delivery-orchestrator/planning';
import { describe, expect, it, vi } from 'vitest';

import {
  RunPreparation,
  RunPreparationError,
  type IntegrationCheckout
} from './run-preparation.js';
import { LocalRuntimeBindingPolicy } from './local-runtime-binding-policy.js';

const intent = (dirty = false): PlanExecutionIntent => {
  const artifact = createPlanArtifact({
    artifactId: 'plan-1',
    revision: 1,
    createdAt: '2026-08-12T00:00:00.000Z',
    source: { type: 'user-request', content: 'Change A.' },
    repository: {
      repositoryPath: '/source',
      projects: new Map(),
      projectDependencies: [],
      files: new Map(),
      symbols: new Map(),
      fileDependencies: [],
      symbolReferences: [],
      diagnostics: []
    },
    repositorySnapshot: {
      repositoryId: `sha256:${'2'.repeat(64)}`,
      repositoryRoot: '/source',
      baseCommit: '3'.repeat(40),
      workingTreeFingerprint: `sha256:${'4'.repeat(64)}`,
      dirty
    },
    sharedResourcePolicy: [],
    verificationPolicy: { version: 1 },
    codeReviewPolicy: {
      version: 1,
      reviewer: {
        implementation: 'test',
        agentBackend: 'pi',
        model: { provider: 'test', id: 'test' },
        toolProfile: 'workspace-read-only-v1',
        outputSchemaVersion: 1,
        promptVersion: 'v1'
      }
    },
    preparedPlan: {
      attempts: 1,
      specification: {
        tasks: [
          {
            id: 'task-a',
            title: 'Change A',
            goal: 'Change A safely',
            dependencies: [],
            expectedReads: [],
            expectedWrites: [{ type: 'project', value: 'core' }],
            sharedResources: [],
            verification: [{ type: 'package-script', packageName: 'core', script: 'test' }]
          }
        ]
      },
      impacts: [
        {
          taskId: 'task-a',
          projectsRead: new Set(),
          projectsWritten: new Set(['core']),
          explicitProjectsWritten: new Set(['core']),
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
      ],
      hardConflicts: [],
      riskConflicts: [],
      executionPlan: { waves: [{ index: 0, taskIds: ['task-a'] }] },
      schedule: { maxConcurrency: 1 },
      semanticReview: {
        recommendation: 'accept',
        summary: 'Covered.',
        requirements: [
          {
            requirement: 'Change A.',
            status: 'covered',
            taskIds: ['task-a'],
            detail: 'Covered.'
          }
        ]
      }
    }
  });
  const approval = createPlanApproval({
    approvalId: 'approval-1',
    artifact,
    approvedBy: 'reviewer',
    approvedAt: '2026-08-12T01:00:00.000Z'
  });
  const approvalClaim = createPlanApprovalClaim({
    approval,
    runId: 'run-1',
    claimedAt: '2026-08-13T00:00:00.000Z'
  });
  const payload = {
    schemaVersion: 1,
    runId: 'run-1',
    boundAt: '2026-08-13T00:00:00.000Z',
    artifact,
    approval,
    approvalClaim
  } as const;
  return parsePlanExecutionIntent({
    ...payload,
    executionFingerprint: fingerprintPlanValue(payload)
  });
};

const intentWithConflict = (severity: 'hard' | 'soft'): PlanExecutionIntent => {
  const base = intent();
  const taskB = {
    ...base.artifact.decision.specification.tasks[0],
    id: 'task-b',
    title: 'Change B',
    goal: 'Change B safely'
  };
  const impactB = {
    ...base.artifact.decision.impacts[0],
    taskId: 'task-b',
    projectsWritten: [],
    explicitProjectsWritten: []
  };
  const conflict =
    severity === 'hard'
      ? {
          taskA: 'task-a',
          taskB: 'task-b',
          score: 100,
          reasons: [
            {
              type: 'same-file' as const,
              score: 100,
              detail: 'Same file.',
              resourceIds: ['core:a']
            }
          ],
          severity: 'hard' as const,
          constraints: [
            { type: 'exclusive-resource' as const, detail: 'Serialize.', resourceIds: ['core:a'] }
          ],
          recommendedAction: 'serialize' as const
        }
      : {
          taskA: 'task-a',
          taskB: 'task-b',
          score: 25,
          reasons: [
            {
              type: 'same-project' as const,
              score: 25,
              detail: 'Same project.',
              resourceIds: ['core']
            }
          ],
          severity: 'soft' as const,
          constraints: [] as const,
          recommendedAction: 'guarded-parallel' as const
        };
  const { planFingerprint: _planFingerprint, ...artifactPayload } = base.artifact;
  const artifact = parsePlanArtifact({
    ...artifactPayload,
    decision: {
      ...base.artifact.decision,
      specification: {
        tasks: [...base.artifact.decision.specification.tasks, taskB]
      },
      impacts: [...base.artifact.decision.impacts, impactB],
      hardConflicts: severity === 'hard' ? [conflict] : [],
      riskConflicts: severity === 'soft' ? [conflict] : [],
      executionPlan: { waves: [{ index: 0, taskIds: ['task-a', 'task-b'] }] },
      schedule: { maxConcurrency: 2 },
      semanticReview: {
        ...base.artifact.decision.semanticReview,
        requirements: [
          {
            requirement: 'Change A and B.',
            status: 'covered' as const,
            taskIds: ['task-a', 'task-b'],
            detail: 'Covered.'
          }
        ]
      }
    },
    planFingerprint: fingerprintPlanValue({
      ...artifactPayload,
      decision: {
        ...base.artifact.decision,
        specification: { tasks: [...base.artifact.decision.specification.tasks, taskB] },
        impacts: [...base.artifact.decision.impacts, impactB],
        hardConflicts: severity === 'hard' ? [conflict] : [],
        riskConflicts: severity === 'soft' ? [conflict] : [],
        executionPlan: { waves: [{ index: 0, taskIds: ['task-a', 'task-b'] }] },
        schedule: { maxConcurrency: 2 },
        semanticReview: {
          ...base.artifact.decision.semanticReview,
          requirements: [
            {
              requirement: 'Change A and B.',
              status: 'covered' as const,
              taskIds: ['task-a', 'task-b'],
              detail: 'Covered.'
            }
          ]
        }
      }
    })
  });
  const approval = createPlanApproval({
    approvalId: 'approval-1',
    artifact,
    approvedBy: 'reviewer',
    approvedAt: '2026-08-12T01:00:00.000Z'
  });
  const approvalClaim = createPlanApprovalClaim({
    approval,
    runId: 'run-1',
    claimedAt: '2026-08-13T00:00:00.000Z'
  });
  const payload = {
    schemaVersion: 1 as const,
    runId: 'run-1',
    boundAt: approvalClaim.claimedAt,
    artifact,
    approval,
    approvalClaim
  };
  return parsePlanExecutionIntent({
    ...payload,
    executionFingerprint: fingerprintPlanValue(payload)
  });
};

const runtimeRequest = (authority: PlanExecutionIntent): StartRuntimeRunRequest => ({
  run: {
    id: authority.runId,
    repositoryId: authority.artifact.repository.repositoryId,
    state: 'ACTIVE',
    createdAt: authority.boundAt,
    authority: {
      artifactId: authority.artifact.artifactId,
      artifactRevision: authority.artifact.revision,
      approvalId: authority.approval.approvalId,
      planFingerprint: authority.artifact.planFingerprint,
      approvalFingerprint: authority.approval.approvalFingerprint,
      claimFingerprint: authority.approvalClaim.claimFingerprint,
      executionFingerprint: authority.executionFingerprint,
      repositoryRoot: authority.artifact.repository.repositoryRoot,
      baseCommit: authority.artifact.repository.baseCommit,
      workingTreeFingerprint: authority.artifact.repository.workingTreeFingerprint,
      repositoryFactsFingerprint: authority.artifact.repository.factsFingerprint,
      sharedResourcePolicyFingerprint: authority.artifact.authority.sharedResourcePolicyFingerprint,
      verificationPolicyFingerprint: authority.artifact.authority.verificationPolicyFingerprint,
      codeReviewPolicyFingerprint: authority.artifact.authority.codeReviewPolicyFingerprint
    }
  },
  tasks: authority.artifact.decision.specification.tasks,
  hardConflicts: [],
  riskConflicts: [],
  scheduleOptions: authority.artifact.decision.schedule,
  taskBindings: authority.artifact.decision.impacts.map((serialized) => {
    const predicted = {
      ...serialized,
      projectsRead: new Set(serialized.projectsRead),
      projectsWritten: new Set(serialized.projectsWritten),
      explicitProjectsWritten: new Set(serialized.explicitProjectsWritten),
      filesRead: new Set(serialized.filesRead),
      filesWritten: new Set(serialized.filesWritten),
      explicitFilesWritten: new Set(serialized.explicitFilesWritten),
      globFilesWritten: new Set(serialized.globFilesWritten),
      symbolDerivedFilesWritten: new Set(serialized.symbolDerivedFilesWritten),
      symbolsRead: new Set(serialized.symbolsRead),
      symbolsWritten: new Set(serialized.symbolsWritten),
      sharedResources: new Set(serialized.sharedResources),
      downstreamProjects: new Set(serialized.downstreamProjects)
    };
    return {
      taskId: serialized.taskId,
      agentId: 'agent-task-a',
      leasePlan: taskLeasePlanFromPredictedImpact(predicted),
      impact: { predicted },
      workspace: {
        id: 'workspace-task-a',
        runId: authority.runId,
        taskId: serialized.taskId,
        integrationRepositoryPath: '/integration',
        workspacePath: '/runs/run-1/tasks/task-a',
        branchName: 'forge/task/run-1/task-a',
        baseRef: authority.artifact.repository.baseCommit,
        integrationRef: 'forge/integration/run-1'
      }
    };
  })
});

const recovered = (request: StartRuntimeRunRequest): RecoveredRuntimeRun => ({
  run: request.run,
  snapshot: { taskStates: [], runtimeBlocks: [] },
  workspaces: [],
  leases: [],
  attempts: []
});

const setup = (authority = intent()) => {
  const checkout: IntegrationCheckout = {
    repositoryPath: '/integration',
    baseCommit: authority.artifact.repository.baseCommit,
    integrationRef: 'forge/integration/run-1'
  };
  const revalidate = vi.fn(async () => authority);
  const provision = vi.fn(async () => checkout);
  const bind = vi.fn(async () => runtimeRequest(authority));
  const startOrResumeRun = vi.fn(async (request: StartRuntimeRunRequest) => recovered(request));
  return {
    service: new RunPreparation({
      authority: { revalidate },
      checkouts: { provision },
      bindings: { bind },
      runtime: { startOrResumeRun }
    }),
    revalidate,
    provision,
    bind,
    start: startOrResumeRun,
    checkout
  };
};

describe('RunPreparation', () => {
  it('revalidates authority before provisioning and starts only the matching runtime request', async () => {
    const authority = intent();
    const fixture = setup(authority);

    await expect(fixture.service.start(authority)).resolves.toMatchObject({
      run: { id: 'run-1' }
    });
    expect(fixture.revalidate).toHaveBeenCalledBefore(fixture.provision);
    expect(fixture.provision).toHaveBeenCalledWith({
      runId: 'run-1',
      sourceRepositoryPath: '/source',
      baseCommit: '3'.repeat(40)
    });
    expect(fixture.bind).toHaveBeenCalledWith({ intent: authority, checkout: fixture.checkout });
    expect(fixture.start).toHaveBeenCalledOnce();
  });

  it('rejects stale authority before provisioning any checkout', async () => {
    const authority = intent();
    const fixture = setup(intent(true));

    await expect(fixture.service.start(authority)).rejects.toThrow(
      'Execution authority changed during run preparation'
    );
    expect(fixture.provision).not.toHaveBeenCalled();
  });

  it('rejects dirty approved snapshots until exact materialization exists', async () => {
    const authority = intent(true);
    const fixture = setup(authority);

    await expect(fixture.service.start(authority)).rejects.toThrow(
      'Dirty PlanArtifacts cannot run'
    );
    expect(fixture.provision).not.toHaveBeenCalled();
  });

  it('rejects a checkout at the wrong commit before runtime binding', async () => {
    const authority = intent();
    const fixture = setup(authority);
    fixture.provision.mockResolvedValue({
      ...fixture.checkout,
      baseCommit: 'd'.repeat(40)
    });

    await expect(fixture.service.start(authority)).rejects.toThrow(
      'Integration checkout does not match the approved base commit'
    );
    expect(fixture.bind).not.toHaveBeenCalled();
  });

  it.each([
    ['run ID', { run: { id: 'run-2' } }],
    ['repository ID', { run: { repositoryId: `sha256:${'e'.repeat(64)}` } }]
  ])('rejects a runtime request with mismatched %s', async (_name, override) => {
    const authority = intent();
    const fixture = setup(authority);
    fixture.bind.mockResolvedValue({
      ...runtimeRequest(authority),
      run: { ...runtimeRequest(authority).run, ...override.run }
    });

    await expect(fixture.service.start(authority)).rejects.toBeInstanceOf(RunPreparationError);
    expect(fixture.start).not.toHaveBeenCalled();
  });

  it('rejects a binding that drops approved task and impact evidence', async () => {
    const authority = intent();
    const fixture = setup(authority);
    fixture.bind.mockResolvedValue({ ...runtimeRequest(authority), tasks: [], taskBindings: [] });

    await expect(fixture.service.start(authority)).rejects.toThrow(
      'Runtime task contracts do not match approved execution authority'
    );
    expect(fixture.start).not.toHaveBeenCalled();
  });

  it('rejects mismatched durable authority and workspace checkout bindings', async () => {
    const authority = intent();
    const authorityFixture = setup(authority);
    const validRequest = runtimeRequest(authority);
    authorityFixture.bind.mockResolvedValue({
      ...validRequest,
      run: {
        ...validRequest.run,
        authority: {
          ...validRequest.run.authority,
          approvalFingerprint: `sha256:${'f'.repeat(64)}`
        }
      }
    });
    await expect(authorityFixture.service.start(authority)).rejects.toThrow(
      'Runtime durable authority does not match execution intent'
    );

    const workspaceFixture = setup(authority);
    workspaceFixture.bind.mockResolvedValue({
      ...validRequest,
      taskBindings: validRequest.taskBindings.map((binding) => ({
        ...binding,
        workspace: { ...binding.workspace, integrationRepositoryPath: '/source' }
      }))
    });
    await expect(workspaceFixture.service.start(authority)).rejects.toThrow(
      'Runtime workspace escapes approved checkout'
    );
    expect(authorityFixture.start).not.toHaveBeenCalled();
    expect(workspaceFixture.start).not.toHaveBeenCalled();
  });

  it('rejects missing impact, lease-plan drift, and runtime-impact drift', async () => {
    const authority = intent();
    const validRequest = runtimeRequest(authority);

    const missingImpact = setup(authority);
    missingImpact.bind.mockResolvedValue({
      ...validRequest,
      taskBindings: validRequest.taskBindings.map((binding) => ({ ...binding, impact: undefined }))
    });
    await expect(missingImpact.service.start(authority)).rejects.toThrow(
      'Runtime binding lacks approved impact'
    );

    const leaseDrift = setup(authority);
    leaseDrift.bind.mockResolvedValue({
      ...validRequest,
      taskBindings: validRequest.taskBindings.map((binding) => ({
        ...binding,
        leasePlan: { ...binding.leasePlan, predictedResources: [] }
      }))
    });
    await expect(leaseDrift.service.start(authority)).rejects.toThrow(
      'Runtime lease plan does not match approved impact'
    );

    const impactDrift = setup(authority);
    impactDrift.bind.mockResolvedValue({
      ...validRequest,
      taskBindings: validRequest.taskBindings.map((binding) => ({
        ...binding,
        impact: {
          predicted: { ...binding.impact!.predicted, projectsRead: new Set(['unexpected']) }
        }
      }))
    });
    await expect(impactDrift.service.start(authority)).rejects.toThrow(
      'Runtime impact does not match approved impact'
    );
  });

  it('checks conflict, schedule, and binding collections independently', async () => {
    for (const severity of ['hard', 'soft'] as const) {
      const authority = intentWithConflict(severity);
      const fixture = setup(authority);
      fixture.bind.mockResolvedValue(runtimeRequest(authority));
      await expect(fixture.service.start(authority)).rejects.toThrow(
        `Runtime ${severity === 'hard' ? 'hard' : 'risk'} conflicts do not match`
      );
    }
    const authority = intent();
    const scheduleFixture = setup(authority);
    scheduleFixture.bind.mockResolvedValue({
      ...runtimeRequest(authority),
      scheduleOptions: { maxConcurrency: 2 }
    });
    await expect(scheduleFixture.service.start(authority)).rejects.toThrow(
      'Runtime schedule options do not match'
    );

    const bindingFixture = setup(authority);
    const validRequest = runtimeRequest(authority);
    bindingFixture.bind.mockResolvedValue({
      ...validRequest,
      taskBindings: [...validRequest.taskBindings, validRequest.taskBindings[0]]
    });
    await expect(bindingFixture.service.start(authority)).rejects.toThrow(
      'Runtime task bindings do not match approved tasks'
    );
  });
});

describe('LocalRuntimeBindingPolicy', () => {
  it('derives tasks, impacts, leases, workspace identity, and durable authority from the intent', async () => {
    const authority = intent();
    const request = await new LocalRuntimeBindingPolicy({ workspaceRoot: '/runs' }).bind({
      intent: authority,
      checkout: {
        repositoryPath: '/runs/run-1/integration',
        baseCommit: authority.artifact.repository.baseCommit,
        integrationRef: 'forge/integration/run-1'
      }
    });

    expect(request.tasks).toEqual(authority.artifact.decision.specification.tasks);
    expect(request.run.authority).toMatchObject({
      executionFingerprint: authority.executionFingerprint,
      planFingerprint: authority.artifact.planFingerprint,
      approvalFingerprint: authority.approval.approvalFingerprint,
      claimFingerprint: authority.approvalClaim.claimFingerprint
    });
    expect(request.taskBindings).toHaveLength(1);
    expect(request.taskBindings[0]).toMatchObject({
      taskId: 'task-a',
      leasePlan: {
        taskId: 'task-a',
        predictedResources: [{ type: 'project', projectId: 'core' }],
        source: 'predicted-impact'
      },
      workspace: {
        runId: 'run-1',
        taskId: 'task-a',
        integrationRepositoryPath: '/runs/run-1/integration',
        baseRef: authority.artifact.repository.baseCommit,
        integrationRef: 'forge/integration/run-1'
      }
    });
  });

  it.each(['hard', 'soft'] as const)(
    'preserves %s conflict contracts and optional command authority',
    async (severity) => {
      const authority = intentWithConflict(severity);
      const commandPolicy = {
        commands: [
          {
            id: 'check',
            executable: 'pnpm',
            args: ['test'],
            effect: 'validation' as const,
            timeoutMs: 30_000,
            maxOutputBytes: 10_000
          }
        ],
        environment: {}
      };
      const request = await new LocalRuntimeBindingPolicy({
        workspaceRoot: '/runs',
        commandPolicy,
        trustedCommandPath: '/trusted/bin'
      }).bind({
        intent: authority,
        checkout: {
          repositoryPath: '/runs/run-1/integration',
          baseCommit: authority.artifact.repository.baseCommit,
          integrationRef: 'forge/integration/run-1'
        }
      });

      expect(request.hardConflicts).toHaveLength(severity === 'hard' ? 1 : 0);
      expect(request.riskConflicts).toHaveLength(severity === 'soft' ? 1 : 0);
      expect(request.taskBindings).toHaveLength(2);
      expect(request.taskBindings[0]).toMatchObject({
        commandPolicy,
        trustedCommandPath: '/trusted/bin'
      });
      expect(request.taskBindings[1]?.leasePlan.predictedResources).toEqual([]);
    }
  );

  it('fails closed when a caller bypasses validated artifact collections', async () => {
    const authority = intent();
    const policy = new LocalRuntimeBindingPolicy({ workspaceRoot: '/runs' });
    const checkout = {
      repositoryPath: '/runs/run-1/integration',
      baseCommit: authority.artifact.repository.baseCommit,
      integrationRef: 'forge/integration/run-1'
    };

    await expect(
      policy.bind({
        intent: {
          ...authority,
          artifact: {
            ...authority.artifact,
            decision: { ...authority.artifact.decision, impacts: [] }
          }
        },
        checkout
      })
    ).rejects.toThrow('missing impact evidence');
    await expect(
      policy.bind({
        intent: {
          ...authority,
          artifact: {
            ...authority.artifact,
            decision: {
              ...authority.artifact.decision,
              hardConflicts: [
                {
                  taskA: 'task-a',
                  taskB: 'task-b',
                  score: 1,
                  reasons: [],
                  severity: 'soft',
                  constraints: [],
                  recommendedAction: 'parallel'
                }
              ]
            }
          }
        },
        checkout
      })
    ).rejects.toThrow('hard-conflict collection contains a risk conflict');
    await expect(
      policy.bind({
        intent: {
          ...authority,
          artifact: {
            ...authority.artifact,
            decision: {
              ...authority.artifact.decision,
              riskConflicts: [
                {
                  taskA: 'task-a',
                  taskB: 'task-b',
                  score: 100,
                  reasons: [],
                  severity: 'hard',
                  constraints: [
                    { type: 'exclusive-resource', detail: 'Serialize.', resourceIds: ['core'] }
                  ],
                  recommendedAction: 'serialize'
                }
              ]
            }
          }
        },
        checkout
      })
    ).rejects.toThrow('risk-conflict collection contains a hard conflict');
  });
});
