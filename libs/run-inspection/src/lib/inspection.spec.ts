import { describe, expect, it } from 'vitest';
import {
  buildRunInspection,
  observedState,
  type InspectionInput,
  type SetupObservation
} from './inspection.js';
import { isInspectionEnvironment, isRunInspection } from './response.js';

const runId = 'fe89c1bf-0ec8-4aee-80da-b14d2e0918fa';
export const preparingFixture = (): InspectionInput => ({
  environment: {
    id: 'fixture-environment',
    label: 'Neon comparison fixture',
    authorityMode: 'global',
    database: 'neondb',
    host: 'fixture.example',
    schema: 'forge_comparison_20261005',
    role: 'forge_runtime',
    taskQueue: 'forge-neon-comparison-deepseek',
    namespace: 'default',
    repository: '/fixture/groundgraph'
  },
  observedAt: '2026-10-05T00:00:00Z',
  identity: {
    approvalId: 'approval-1',
    artifactId: 'artifact-1',
    artifactRevision: 1,
    baseCommit: 'a'.repeat(40),
    repositoryRoot: '/fixture/groundgraph'
  },
  binding: { state: 'complete', fields: { scopeId: 'scope-1' } },
  run: {
    runId,
    state: 'ACTIVE',
    createdAt: '2026-10-05T00:00:00Z',
    correlation: { runId },
    tasks: [
      {
        id: 'improve-query-filter-limit-message',
        title: 'Improve query filter message',
        state: 'RUNNING',
        attempts: [
          {
            id: `launch:${runId}`,
            kind: 'builder',
            state: 'PREPARING',
            revision: 1,
            correlation: {
              runId,
              taskId: 'improve-query-filter-limit-message',
              attemptId: `launch:${runId}`,
              workspaceId: 'workspace-1'
            }
          }
        ],
        verification: [],
        reviews: []
      },
      {
        id: 'query-schema-limit-message-tests',
        title: 'Add query schema tests',
        state: 'PENDING',
        attempts: [],
        verification: [],
        reviews: []
      }
    ],
    leases: [],
    timeline: [
      {
        sequence: 1,
        occurredAt: '2026-10-05T00:00:00Z',
        type: 'run-started',
        correlation: { runId }
      }
    ]
  },
  setup: [],
  temporal: {
    state: 'unknown',
    fields: { workflowId: `forge-run:${runId}`, observation: 'not observed' }
  },
  git: [],
  local: [],
  sources: [
    {
      source: 'PostgreSQL durable authority',
      observedAt: '2026-10-05T00:00:00Z',
      status: 'observed',
      message: 'fixture'
    }
  ]
});
const node = (input: InspectionInput, suffix: string) =>
  buildRunInspection(input).nodes.find((row) => row.id.endsWith(suffix))!;
describe('Evidence-first run inspection', () => {
  it('validates the browser DTO without importing authority logic', () => {
    const input = preparingFixture();
    const result = buildRunInspection(input);
    expect(isInspectionEnvironment(input.environment)).toBe(true);
    expect(isRunInspection(result)).toBe(true);
    expect(isInspectionEnvironment({ ...input.environment, authorityMode: 'legacy' })).toBe(false);
    expect(isRunInspection({ ...result, version: 2 })).toBe(false);
    expect(
      isRunInspection({ ...result, nodes: [{ ...result.nodes[0], state: 'assumed-complete' }] })
    ).toBe(false);
    expect(
      isRunInspection({
        ...result,
        nodes: [
          {
            ...result.nodes[0],
            evidence: [{ source: 'external', observedAt: input.observedAt, fields: {} }]
          }
        ]
      })
    ).toBe(false);
    expect(isRunInspection({ ...result, tasks: [{ id: 1 }] })).toBe(false);
    expect(isRunInspection({ ...result, edges: [{ source: 'metadata' }] })).toBe(false);
    expect(
      isRunInspection({ ...result, sources: [{ source: 'Temporal', status: 'success' }] })
    ).toBe(false);
    expect(isRunInspection(null)).toBe(false);
  });
  it('represents the reported PREPARING regression without synthesizing setup failures', () => {
    const input = preparingFixture();
    const result = buildRunInspection(input);
    expect(result.runId).toBe(runId);
    expect(result.environment.schema).toBe('forge_comparison_20261005');
    expect(node(input, ':builder').state).toBe('pending');
    for (const suffix of [
      'admission',
      'generation',
      'arming',
      'permit',
      'worktree',
      'persistence',
      'attestation',
      'settlement',
      'child'
    ]) {
      expect(node(input, `:${suffix}`).state).toBe('unknown');
    }
    expect(node(input, ':leases').state).toBe('unknown');
    expect(node(input, 'metadata').state).toBe('complete');
    expect(node(input, 'terminal').state).toBe('active');
    expect(result.tasks[1]?.state).toBe('PENDING');
    expect(result.nodes.some((row) => row.state === 'failed')).toBe(false);
    expect(node(input, 'terminal').evidence.at(-1)?.fields.event).toBe('run-started');
  });
  it('shows successful setup and exact execution child only from direct evidence for each stage', () => {
    const input = preparingFixture();
    const setup: SetupObservation[] = (
      [
        'admission',
        'generation',
        'arming',
        'permit',
        'persistence',
        'attestation',
        'settlement',
        'child'
      ] as const
    ).map((stage) => ({
      taskId: input.run.tasks[0].id,
      attemptId: `launch:${runId}`,
      stage,
      state: 'complete',
      fields: {
        parentClaimId: 'parent-1',
        generationId: 'generation-1',
        childClaimId: 'execution-1'
      }
    }));
    const updated = {
      ...input,
      setup,
      git: [
        {
          taskId: input.run.tasks[0].id,
          state: 'complete' as const,
          fields: { workspaceId: 'workspace-1', workspacePath: '/worktree-1' }
        }
      ]
    };
    for (const suffix of [
      'admission',
      'generation',
      'arming',
      'permit',
      'worktree',
      'persistence',
      'attestation',
      'settlement',
      'child'
    ]) {
      expect(node(updated, `:${suffix}`).state).toBe('complete');
    }
    expect(node(updated, ':child').evidence[0]?.fields.childClaimId).toBe('execution-1');
  });
  it('does not backfill unobserved earlier phases from a committed handoff or local file', () => {
    const input = preparingFixture();
    const updated: InspectionInput = {
      ...input,
      setup: [
        {
          taskId: input.run.tasks[0].id,
          attemptId: `launch:${runId}`,
          stage: 'child',
          state: 'complete',
          fields: { childClaimId: 'execution-1' }
        }
      ],
      local: [
        { taskId: input.run.tasks[0].id, state: 'unknown', fields: { file: 'recovery.json' } }
      ]
    };
    expect(node(updated, ':child').state).toBe('complete');
    expect(node(updated, ':admission').state).toBe('unknown');
    expect(node(updated, ':attestation').state).toBe('unknown');
    expect(node(updated, ':attestation').evidence[0]?.source).toBe('local operator evidence');
  });
  it('keeps uncertain and conflicting evidence unknown', () => {
    const input = preparingFixture();
    const fact: SetupObservation = {
      taskId: input.run.tasks[0].id,
      attemptId: `launch:${runId}`,
      stage: 'permit',
      state: 'active',
      fields: { permitId: 'permit-1', completed: false }
    };
    const updated = { ...input, setup: [fact, { ...fact, state: 'complete' as const }] };
    expect(node(updated, ':permit').state).toBe('unknown');
    expect(node(updated, ':settlement').state).toBe('unknown');
    expect(node(updated, ':permit').evidence).toHaveLength(2);
  });
  it('maps a failed builder from its durable attempt without failing every other node', () => {
    const input = preparingFixture();
    const task = input.run.tasks[0];
    const updated = {
      ...input,
      run: {
        ...input.run,
        tasks: [
          {
            ...task,
            attempts: [
              { ...task.attempts[0], state: 'FAILED', failure: { type: 'execution-failed' } }
            ]
          }
        ]
      }
    };
    expect(node(updated, ':builder').state).toBe('failed');
    expect(node(updated, ':verification').state).toBe('unknown');
  });
  it('represents completed outcomes independently of current missing worktrees', () => {
    const input = preparingFixture();
    const task = input.run.tasks[0];
    const updated: InspectionInput = {
      ...input,
      run: {
        ...input.run,
        state: 'COMPLETED',
        tasks: [
          {
            ...task,
            state: 'COMPLETED',
            attempts: [{ ...task.attempts[0], state: 'COMPLETED' }],
            verification: [
              {
                id: 'verification-1',
                status: 'passed',
                verifiedAt: input.observedAt,
                fingerprint: 'fingerprint-1',
                correlation: { runId }
              }
            ],
            reviews: [
              {
                iteration: 1,
                recommendation: 'accept',
                summary: 'Accepted',
                correlation: { runId }
              }
            ]
          }
        ]
      },
      setup: [
        {
          taskId: task.id,
          attemptId: task.attempts[0].id,
          stage: 'integration',
          state: 'complete',
          fields: { integrationCommit: 'b'.repeat(40) }
        }
      ]
    };
    for (const suffix of ['terminal', ':builder', ':verification', ':review', ':integration']) {
      expect(node(updated, suffix).state).toBe('complete');
    }
    expect(node(updated, ':worktree').state).toBe('unknown');
  });
  it('retains leases, repair attempts, source timestamps and task grouping', () => {
    const input = preparingFixture();
    const task = input.run.tasks[0];
    const updated: InspectionInput = {
      ...input,
      sources: [
        ...input.sources,
        {
          source: 'Temporal',
          observedAt: '2026-10-05T00:00:02Z',
          status: 'observed',
          message: 'Observed'
        }
      ],
      temporal: { state: 'active', fields: { workflowRunId: 'workflow-1' } },
      run: {
        ...input.run,
        tasks: [
          {
            ...task,
            attempts: [
              ...task.attempts,
              {
                id: 'repair-1',
                kind: 'repair',
                state: 'UNKNOWN',
                revision: 2,
                correlation: { runId }
              }
            ]
          }
        ],
        leases: [
          {
            id: 'lease-1',
            taskId: task.id,
            agentId: 'agent-1',
            resource: { type: 'repository' },
            state: 'ACTIVE',
            acquiredAt: input.observedAt,
            lastHeartbeatAt: input.observedAt,
            correlation: { runId }
          }
        ]
      }
    };
    expect(node(updated, ':leases').state).toBe('active');
    expect(node(updated, ':repair').state).toBe('unknown');
    expect(node(updated, 'temporal').evidence[0]?.observedAt).toBe('2026-10-05T00:00:02Z');
    const result = buildRunInspection(updated);
    const ids = new Set(result.nodes.map((row) => row.id));
    expect(ids.size).toBe(result.nodes.length);
    expect(result.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target))).toBe(true);
  });
  it.each([
    ['FAILED', 'failed'],
    ['CANCELLED', 'failed'],
    ['TERMINATED', 'failed'],
    ['TIMED_OUT', 'failed'],
    ['RELEASED', 'complete'],
    ['STARTING', 'active'],
    ['READY', 'pending'],
    ['BLOCKED', 'unknown'],
    ['STALE', 'unknown']
  ])('maps recorded %s to %s conservatively', (recorded, expected) =>
    expect(observedState(recorded)).toBe(expected)
  );
});
