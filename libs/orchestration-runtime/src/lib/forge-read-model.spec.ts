import type { ForgeReadModelPersistence } from './forge-read-model.js';
import { describe, expect, it } from 'vitest';

import { ForgeReadModel } from './forge-read-model.js';

const digest = (value: string): string => `sha256:${value.repeat(64).slice(0, 64)}`;

describe('ForgeReadModel', () => {
  it('projects durable authority into provider-neutral summaries and correlations', async () => {
    const persistence: ForgeReadModelPersistence = {
      recoverRun: async () => ({
        run: {
          id: 'run-1',
          repositoryId: 'repository-1',
          state: 'ACTIVE' as const,
          createdAt: '2026-09-22T00:00:00.000Z',
          authority: {
            artifactId: 'artifact-1',
            artifactRevision: 1,
            approvalId: 'approval-1',
            planFingerprint: digest('1'),
            approvalFingerprint: digest('2'),
            claimFingerprint: digest('3'),
            executionFingerprint: digest('4'),
            repositoryRoot: '/repo',
            baseCommit: 'a'.repeat(40),
            workingTreeFingerprint: digest('5'),
            repositoryFactsFingerprint: digest('6'),
            sharedResourcePolicyFingerprint: digest('7'),
            verificationPolicyFingerprint: digest('8'),
            codeReviewPolicyFingerprint: digest('9')
          }
        },
        tasks: [
          {
            id: 'task-1',
            title: 'Ship read model',
            goal: 'Ship it',
            dependencies: [],
            expectedReads: [],
            expectedWrites: [],
            sharedResources: [],
            verification: []
          }
        ],
        taskBindings: [],
        hardConflicts: [],
        riskConflicts: [],
        scheduleOptions: { maxConcurrency: 1 },
        impacts: [],
        conflicts: [],
        leases: [
          {
            runId: 'run-1',
            lease: {
              id: 'lease-1',
              runId: 'run-1',
              taskId: 'task-1',
              agentId: 'agent-1',
              resource: {
                type: 'symbol' as const,
                projectId: 'project-1',
                fileId: 'src/read.ts',
                symbolId: 'readModel',
                ancestorSymbolIds: ['parentSymbol']
              },
              mode: 'exclusive' as const,
              version: 1,
              state: 'ACTIVE' as const,
              acquiredAt: new Date('2026-09-22T00:00:01.000Z'),
              lastHeartbeatAt: new Date('2026-09-22T00:00:02.000Z')
            }
          }
        ],
        workspaces: [],
        events: [
          {
            runId: 'run-1',
            sequence: 1,
            occurredAt: '2026-09-22T00:00:00.000Z',
            event: { type: 'run-started' as const }
          },
          {
            runId: 'run-1',
            sequence: 2,
            occurredAt: '2026-09-22T00:01:00.000Z',
            event: { type: 'lease-blocked' as const, taskId: 'task-1', leaseId: 'lease-1' }
          }
        ],
        transitions: [
          {
            runId: 'run-1',
            sequence: 2,
            taskId: 'task-1',
            fromState: 'RUNNING' as const,
            toState: 'BLOCKED' as const
          }
        ],
        decisions: [
          {
            runId: 'run-1',
            sequence: 2,
            inputSnapshot: { taskStates: [], runtimeBlocks: [] },
            decision: {
              taskDecisions: [
                {
                  taskId: 'task-1',
                  action: 'block' as const,
                  fromState: 'RUNNING' as const,
                  toState: 'BLOCKED' as const,
                  reasons: [
                    {
                      type: 'runtime-blocked' as const,
                      blockers: [
                        { type: 'lease' as const, leaseId: 'lease-1' },
                        { type: 'runtime-conflict' as const, conflictId: 'conflict-1' }
                      ]
                    }
                  ]
                }
              ]
            }
          }
        ],
        attempts: [
          {
            runId: 'run-1',
            attempt: {
              id: 'attempt-1',
              runId: 'run-1',
              taskId: 'task-1',
              agentId: 'agent-1',
              workspaceId: 'workspace-1',
              leasePlanFingerprint: digest('a'),
              state: 'COMPLETED' as const,
              revision: 3,
              startedAt: new Date('2026-09-22T00:00:01.000Z'),
              completedAt: new Date('2026-09-22T00:00:02.000Z')
            }
          }
        ]
      }),
      recoverReviews: async () => [
        {
          runId: 'run-1',
          taskId: 'task-1',
          iteration: 1,
          subject: {
            builderAttemptId: 'attempt-1',
            outputAttemptId: 'attempt-1',
            workspaceId: 'workspace-1',
            workspaceRevision: 1,
            workspaceChangeFingerprint: digest('b'),
            impactFingerprint: digest('c'),
            verificationFingerprint: digest('d')
          },
          review: {
            recommendation: 'repair' as const,
            summary: 'Repair required',
            findings: [
              {
                id: 'finding-1',
                severity: 'medium' as const,
                fileIds: ['src/read.ts'],
                symbolIds: [],
                description: 'Add the read model.'
              }
            ]
          }
        },
        {
          runId: 'run-1',
          taskId: 'task-1',
          iteration: 2,
          subject: {
            builderAttemptId: 'attempt-1',
            outputAttemptId: 'repair-1',
            workspaceId: 'workspace-1',
            workspaceRevision: 2,
            workspaceChangeFingerprint: digest('f'),
            impactFingerprint: digest('c'),
            verificationFingerprint: digest('g')
          },
          review: {
            recommendation: 'accept' as const,
            summary: 'Repair accepted',
            findings: []
          }
        }
      ],
      recoverRepairAttempts: async () => [
        {
          runId: 'run-1',
          attempt: {
            id: 'repair-1',
            runId: 'run-1',
            taskId: 'task-1',
            agentId: 'agent-1',
            workspaceId: 'workspace-1',
            parentReviewIteration: 1,
            parentReviewSubject: {
              builderAttemptId: 'attempt-1',
              outputAttemptId: 'attempt-1',
              workspaceId: 'workspace-1',
              workspaceRevision: 1,
              workspaceChangeFingerprint: digest('b'),
              impactFingerprint: digest('c'),
              verificationFingerprint: digest('d')
            },
            repairIteration: 1,
            state: 'COMPLETED' as const,
            revision: 2,
            startedAt: new Date('2026-09-22T00:00:03.000Z'),
            completedAt: new Date('2026-09-22T00:00:04.000Z')
          }
        }
      ],
      recoverVerificationEvidence: async () => [
        {
          id: 'verification-1',
          runId: 'run-1',
          taskId: 'task-1',
          attemptId: 'attempt-1',
          workspaceId: 'workspace-1',
          workspaceRevision: 1,
          workspaceChangeFingerprint: digest('b'),
          verificationPolicyFingerprint: digest('e'),
          status: 'passed' as const,
          verifiedAt: '2026-09-22T00:00:02.000Z',
          fingerprint: digest('d')
        },
        {
          id: 'verification-2',
          runId: 'run-1',
          taskId: 'task-1',
          attemptId: 'repair-1',
          workspaceId: 'workspace-1',
          workspaceRevision: 2,
          workspaceChangeFingerprint: digest('f'),
          verificationPolicyFingerprint: digest('e'),
          status: 'passed' as const,
          verifiedAt: '2026-09-22T00:00:04.000Z',
          fingerprint: digest('g')
        }
      ]
    };

    const result = await new ForgeReadModel({
      persistence,
      workflowId: (runId) => `forge-run:${runId}`
    }).read('run-1');

    expect(result).toMatchObject({
      correlation: { runId: 'run-1', workflowId: 'forge-run:run-1' },
      leases: [
        {
          id: 'lease-1',
          taskId: 'task-1',
          state: 'ACTIVE',
          resource: {
            type: 'symbol',
            projectId: 'project-1',
            fileId: 'src/read.ts',
            symbolId: 'readModel',
            ancestorSymbolIds: ['parentSymbol']
          },
          correlation: { taskId: 'task-1', activity: 'reevaluate-run' }
        }
      ],
      tasks: [
        {
          id: 'task-1',
          state: 'BLOCKED',
          currentBlockingReason: {
            type: 'runtime-blocked',
            blockers: [
              { type: 'lease', leaseId: 'lease-1' },
              { type: 'runtime-conflict', conflictId: 'conflict-1' }
            ]
          },
          attempts: [
            {
              id: 'attempt-1',
              kind: 'builder',
              correlation: {
                attemptId: 'attempt-1',
                workspaceId: 'workspace-1',
                activity: 'execute-builder'
              }
            },
            {
              id: 'repair-1',
              kind: 'repair',
              correlation: {
                attemptId: 'attempt-1',
                repairAttemptId: 'repair-1',
                workspaceId: 'workspace-1',
                activity: 'execute-repair'
              }
            }
          ],
          verification: [
            {
              id: 'verification-1',
              correlation: { attemptId: 'attempt-1', activity: 'evaluate-output' }
            },
            {
              id: 'verification-2',
              correlation: {
                attemptId: 'attempt-1',
                repairAttemptId: 'repair-1',
                activity: 'evaluate-output'
              }
            }
          ],
          reviews: [
            {
              iteration: 1,
              recommendation: 'repair',
              correlation: {
                attemptId: 'attempt-1',
                workspaceId: 'workspace-1',
                activity: 'evaluate-output'
              }
            },
            {
              iteration: 2,
              recommendation: 'accept',
              correlation: {
                attemptId: 'attempt-1',
                repairAttemptId: 'repair-1',
                workspaceId: 'workspace-1',
                activity: 'evaluate-output'
              }
            }
          ]
        }
      ]
    });
    expect(result?.timeline).toContainEqual(
      expect.objectContaining({ sequence: 2, type: 'lease-blocked', detail: 'leaseId=lease-1' })
    );
  });
});
