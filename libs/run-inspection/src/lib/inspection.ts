import type { ForgeRunReadModel } from '@ai-native-software-delivery-orchestrator/orchestration-runtime';

export type InspectionState = 'complete' | 'active' | 'pending' | 'failed' | 'unknown';
export type InspectionUnknownReason =
  | 'no-evidence'
  | 'conflicting-evidence'
  | 'no-current-workflow'
  | 'source-unavailable'
  | 'insufficient-evidence';
export type EvidenceSource =
  | 'PostgreSQL durable authority'
  | 'Temporal'
  | 'Git/worktree observation'
  | 'local operator evidence';
export type EvidenceFields = Readonly<Record<string, string | number | boolean | null>>;
export interface InspectionEnvironment {
  readonly id: string;
  readonly label: string;
  readonly authorityMode: 'global';
  readonly database: string;
  readonly host: string;
  readonly schema: string;
  readonly role: string;
  readonly taskQueue: string;
  readonly namespace: string;
  readonly repository: string;
}
export interface Evidence {
  readonly source: EvidenceSource;
  readonly observedAt: string;
  readonly fields: EvidenceFields;
}
export interface InspectionNode {
  readonly id: string;
  readonly label: string;
  readonly state: InspectionState;
  readonly unknownReason?: InspectionUnknownReason;
  readonly explanation: string;
  readonly taskId?: string;
  readonly evidence: readonly Evidence[];
}
export interface SourceObservation {
  readonly source: EvidenceSource;
  readonly observedAt: string;
  readonly status: 'observed' | 'unavailable';
  readonly message: string;
}
export interface SetupObservation {
  readonly taskId: string;
  readonly attemptId: string;
  readonly stage:
    | 'admission'
    | 'generation'
    | 'arming'
    | 'permit'
    | 'persistence'
    | 'attestation'
    | 'settlement'
    | 'child'
    | 'integration';
  readonly state: InspectionState;
  readonly fields: EvidenceFields;
}
export interface AuxiliaryObservation {
  readonly taskId?: string;
  readonly state: InspectionState;
  readonly fields: EvidenceFields;
}
export interface InspectionInput {
  readonly environment: InspectionEnvironment;
  readonly observedAt: string;
  readonly run: ForgeRunReadModel;
  readonly identity: EvidenceFields;
  readonly binding: AuxiliaryObservation;
  readonly setup: readonly SetupObservation[];
  readonly temporal: AuxiliaryObservation;
  readonly git: readonly AuxiliaryObservation[];
  readonly local: readonly AuxiliaryObservation[];
  readonly sources: readonly SourceObservation[];
}
export interface ForgeRunInspection {
  readonly version: 1;
  readonly environment: InspectionEnvironment;
  readonly runId: string;
  readonly refreshedAt: string;
  readonly tasks: readonly {
    readonly id: string;
    readonly title: string;
    readonly state: string;
  }[];
  readonly nodes: readonly InspectionNode[];
  readonly edges: readonly {
    readonly id: string;
    readonly source: string;
    readonly target: string;
  }[];
  readonly sources: readonly SourceObservation[];
}

/** Presentation of explicitly observed states, never an authority decision. */
export const observedState = (value: string): InspectionState => {
  if (['COMPLETED', 'INTEGRATED', 'RELEASED', 'passed', 'accept'].includes(value)) {
    return 'complete';
  }
  if (
    [
      'FAILED',
      'failed',
      'reject',
      'CANCELLED',
      'TERMINATED',
      'TIMED_OUT',
      'ABANDONED',
      'REVOKED'
    ].includes(value)
  ) {
    return 'failed';
  }
  if (
    ['ACTIVE', 'RUNNING', 'STARTING', 'VERIFYING', 'INTEGRATING', 'CANCEL_REQUESTED'].includes(
      value
    )
  ) {
    return 'active';
  }
  if (['PENDING', 'READY', 'PREPARING'].includes(value)) {
    return 'pending';
  }
  return 'unknown';
};

export function buildRunInspection(input: InspectionInput): ForgeRunInspection {
  const nodes: InspectionNode[] = [];
  const edges: { id: string; source: string; target: string }[] = [];
  const evidence = (source: EvidenceSource, fields: EvidenceFields): Evidence => ({
    source,
    observedAt: input.sources.find((row) => row.source === source)?.observedAt ?? input.observedAt,
    fields
  });
  const add = (
    id: string,
    label: string,
    state: InspectionState,
    entries: Evidence[],
    taskId?: string,
    explanation = 'State is based only on the evidence listed for this node.',
    unknownReason?: InspectionUnknownReason
  ) => {
    nodes.push({
      id,
      label,
      state,
      taskId,
      evidence: entries,
      explanation,
      ...(state === 'unknown' && {
        unknownReason:
          unknownReason ?? (entries.length === 0 ? 'no-evidence' : 'insufficient-evidence')
      })
    });
    return id;
  };
  const link = (source: string, target: string) =>
    edges.push({ id: `${source}->${target}`, source, target });
  const pg = (fields: EvidenceFields) => evidence('PostgreSQL durable authority', fields);
  add(
    'approval',
    'Plan approval',
    typeof input.identity.approvalId === 'string' ? 'complete' : 'unknown',
    [pg(input.identity)]
  );
  add('binding', 'Repository binding', input.binding.state, [pg(input.binding.fields)]);
  add('metadata', 'Run metadata', 'complete', [
    pg({ runId: input.run.runId, state: input.run.state, createdAt: input.run.createdAt })
  ]);
  link('approval', 'binding');
  link('binding', 'metadata');
  const temporalSource = input.sources.find((row) => row.source === 'Temporal');
  add(
    'temporal',
    'Temporal workflow',
    input.temporal.state,
    [evidence('Temporal', input.temporal.fields)],
    undefined,
    input.temporal.fields.lookupResult === 'not-found'
      ? 'No current workflow record in the selected namespace; this does not prove it never existed.'
      : temporalSource?.status === 'unavailable'
        ? 'Temporal observation is unavailable in the selected environment.'
        : undefined,
    input.temporal.fields.lookupResult === 'not-found'
      ? 'no-current-workflow'
      : temporalSource?.status === 'unavailable'
        ? 'source-unavailable'
        : undefined
  );
  link('metadata', 'temporal');
  const stages = [
    ['admission', 'Setup admission'],
    ['generation', 'Generation issued'],
    ['arming', 'Workspace armed'],
    ['permit', 'Git permit'],
    ['worktree', 'Worktree observed'],
    ['persistence', 'Workspace persisted'],
    ['attestation', 'Recovery attestation'],
    ['settlement', 'Setup settled'],
    ['child', 'Execution-child handoff']
  ] as const;
  for (const task of input.run.tasks) {
    const attempts = task.attempts.filter((attempt) => attempt.kind === 'builder');
    // Even a task without an attempt gets a visible unobserved setup lane.
    for (const attempt of attempts.length === 0 ? [undefined] : attempts) {
      let previous = 'metadata';
      for (const [stage, label] of stages) {
        const matches = input.setup.filter(
          (row) => row.taskId === task.id && row.attemptId === attempt?.id && row.stage === stage
        );
        const git =
          stage === 'worktree'
            ? input.git.filter(
                (row) =>
                  row.taskId === task.id &&
                  row.fields.workspaceId === attempt?.correlation.workspaceId
              )
            : [];
        const entries = [
          ...matches.map((row) => pg(row.fields)),
          ...git.map((row) => evidence('Git/worktree observation', row.fields))
        ];
        if (stage === 'attestation') {
          entries.push(
            ...input.local
              .filter((row) => row.taskId === task.id)
              .map((row) => evidence('local operator evidence', row.fields))
          );
        }
        const states = [...matches, ...git].map((row) => row.state);
        const state =
          states.length > 0 && states.every((value) => value === states[0]) ? states[0] : 'unknown';
        const sourceUnavailable =
          (stage === 'worktree' &&
            input.sources.some(
              (source) =>
                source.source === 'Git/worktree observation' && source.status === 'unavailable'
            )) ||
          (stage === 'attestation' &&
            input.sources.some(
              (source) =>
                source.source === 'local operator evidence' && source.status === 'unavailable'
            ));
        const unknownReason =
          states.length > 1 && !states.every((value) => value === states[0])
            ? 'conflicting-evidence'
            : entries.length === 0 && sourceUnavailable
              ? 'source-unavailable'
              : undefined;
        const id = `${task.id}:${attempt?.id ?? 'unobserved'}:${stage}`;
        add(
          id,
          label,
          state,
          entries,
          task.id,
          state === 'unknown'
            ? unknownReason === 'conflicting-evidence'
              ? 'Observed stage states conflict; no single outcome is established.'
              : unknownReason === 'source-unavailable'
                ? 'The relevant observation source is unavailable.'
                : entries.length === 0
                  ? 'No evidence observed. This does not prove failure or historical non-occurrence.'
                  : 'Observed evidence does not establish an outcome.'
            : undefined,
          unknownReason
        );
        link(previous, id);
        previous = id;
      }
      const id = `${task.id}:${attempt?.id ?? 'unobserved'}:builder`;
      add(
        id,
        'Builder attempt',
        attempt === undefined ? 'unknown' : observedState(attempt.state),
        [
          pg({
            taskId: task.id,
            taskState: task.state,
            attemptId: attempt?.id ?? null,
            attemptState: attempt?.state ?? 'not observed',
            revision: attempt?.revision ?? null,
            workspaceId: attempt?.correlation.workspaceId ?? null,
            failureType: attempt?.failure?.type ?? null
          })
        ],
        task.id
      );
      link(previous, id);
      link('temporal', id);
    }
    for (const attempt of task.attempts.filter((row) => row.kind === 'repair')) {
      add(
        `${task.id}:${attempt.id}:repair`,
        'Repair attempt',
        observedState(attempt.state),
        [
          pg({
            attemptId: attempt.id,
            revision: attempt.revision,
            state: attempt.state,
            workspaceId: attempt.correlation.workspaceId ?? null
          })
        ],
        task.id
      );
    }
    const leases = input.run.leases.filter((row) => row.taskId === task.id);
    add(
      `${task.id}:leases`,
      'Leases',
      leases.some((row) => row.state === 'ACTIVE')
        ? 'active'
        : leases.length > 0 && leases.every((row) => row.state === 'RELEASED')
          ? 'complete'
          : 'unknown',
      leases.map((row) =>
        pg({
          leaseId: row.id,
          state: row.state,
          attemptId: row.correlation.attemptId ?? null,
          acquiredAt: row.acquiredAt,
          lastHeartbeatAt: row.lastHeartbeatAt
        })
      ),
      task.id,
      leases.length === 0
        ? 'No leases observed. This is not proof that a lease never existed.'
        : undefined
    );
    const verification = task.verification.at(-1);
    add(
      `${task.id}:verification`,
      'Verification',
      verification === undefined ? 'unknown' : observedState(verification.status),
      task.verification.map((row) =>
        pg({
          id: row.id,
          status: row.status,
          verifiedAt: row.verifiedAt,
          fingerprint: row.fingerprint,
          attemptId: row.correlation.attemptId ?? null
        })
      ),
      task.id
    );
    const review = task.reviews.at(-1);
    add(
      `${task.id}:review`,
      'Review',
      review === undefined ? 'unknown' : observedState(review.recommendation),
      task.reviews.map((row) =>
        pg({
          iteration: row.iteration,
          recommendation: row.recommendation,
          attemptId: row.correlation.attemptId ?? null
        })
      ),
      task.id
    );
    const integration = input.setup.filter(
      (row) => row.taskId === task.id && row.stage === 'integration'
    );
    add(
      `${task.id}:integration`,
      'Integration',
      integration.length === 1 ? integration[0].state : 'unknown',
      integration.map((row) => pg(row.fields)),
      task.id
    );
    const latestBuilder = attempts.at(-1);
    let previous = `${task.id}:${latestBuilder?.id ?? 'unobserved'}:builder`;
    for (const suffix of [
      'leases',
      ...task.attempts.filter((row) => row.kind === 'repair').map((row) => `${row.id}:repair`),
      'verification',
      'review',
      'integration'
    ]) {
      const next = `${task.id}:${suffix}`;
      link(previous, next);
      previous = next;
    }
    link(previous, 'terminal');
  }
  add(
    'terminal',
    'Terminal run state',
    ['COMPLETED', 'FAILED', 'CANCELLED'].includes(input.run.state)
      ? observedState(input.run.state)
      : 'active',
    [
      pg({ runId: input.run.runId, state: input.run.state }),
      ...input.run.timeline.map((row) =>
        pg({
          sequence: row.sequence,
          occurredAt: row.occurredAt,
          event: row.type,
          taskId: row.correlation.taskId ?? null,
          attemptId: row.correlation.attemptId ?? null
        })
      )
    ]
  );
  return {
    version: 1,
    environment: input.environment,
    runId: input.run.runId,
    refreshedAt: input.observedAt,
    tasks: input.run.tasks.map(({ id, title, state }) => ({ id, title, state })),
    nodes,
    edges,
    sources: input.sources
  };
}
