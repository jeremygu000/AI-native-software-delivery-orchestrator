# ADR-025: Task code review evidence boundary

## Status

Accepted.

## Context

Stage 21 verifies that task changes are lease-authorized and compatible with predicted impact, but a
passing deterministic command does not establish that an implementation is semantically reasonable. A
reviewer must remain advisory: it cannot mutate a task workspace, approve integration, or start repair.

## Decision

Add provider-neutral `TaskCodeReviewer`, structured `TaskCodeReview`, and `TaskCodeReviewStore` contracts
to `domain`. A finding must have a stable ID, severity, at least one affected file ID, description, and an
optional requirement reference. The review parser rejects malformed JSON, duplicate finding IDs, acceptance
with findings, and repair recommendations without findings.

`TaskCodeReviewCollector` in `orchestration-runtime` invokes the reviewer, parses the untrusted output,
and persists it by run, task, and iteration. The SQLite store accepts only an exact idempotent retry for
the same task iteration. `PiTaskCodeReviewer` creates an isolated Pi session whose configured and defined
custom tool sets contain only `forge_read`, `forge_list`, and `forge_find`; it exposes neither write nor
command tools. A real Pi SDK regression test verifies this active tool boundary.

Every new review record also requires a subject binding: builder-attempt ID, workspace ID and revision,
workspace-change fingerprint, observed-impact fingerprint, and verification fingerprint. The store treats
any subject change at the same run/task/iteration as different evidence and fails closed. The collector
rejects finding file and symbol IDs that do not exist in its approved repository facts. A review record is
not yet an integration admission decision; before repair or integration can use it, the composition layer
must produce the exact workspace-change and verification evidence fingerprints from durable Git and
verification results.

The initial Stage 22 boundary deliberately does not dispatch repair. Existing execution persistence
assumes one agent-attempt lineage per task. Repair needs a separately modeled attempt lineage, budget,
re-verification, re-review, recovery behavior, and integration admission rule. It must not be added by
silently reusing or overwriting the builder attempt.

The next increment adds a separate revisioned `TaskRepairAttempt` lineage with a parent review iteration
and subject, plus a deterministic repair budget coordinator. It still does not dispatch a coding agent.
`assertTaskReviewIntegrationAdmission` admits only an `accept` review whose full subject exactly matches
the current output; legacy, repair, and stale review evidence fail closed. A later composition increment
must create durable workspace-change and verification evidence before invoking this gate around integration.

Repair admission is durable and idempotent. One exact parent review iteration and subject can admit only
one logical repair attempt: a retry returns the existing record. SQLite performs existing-admission lookup,
task budget check, repair-iteration allocation, and insert in one serialized transaction. Subsequent
attempt revisions may update lifecycle evidence only; builder/repair lineage, agent, workspace, parent
review subject, and repair iteration are immutable.

Verification now has its own durable evidence record. A passed record binds run/task/attempt identity,
workspace ID and revision, exact worktree content fingerprint, verification policy fingerprint, verified-at
time, and a self fingerprint. It is exact-idempotent by run and attempt. `TaskVerificationEvidenceFactory`
accepts an actual `RepositorySnapshot` rather than inventing content identity. Repair dispatch remains
locked until the runtime persists this evidence after verification and supplies its fingerprint when it
constructs a new review subject.

The verification fingerprint is an integrity field, not caller-supplied opaque text. Domain helpers
recompute it from the complete payload at both persistence write and recovery boundaries; a schema-shaped
but forged fingerprint fails closed. The factory also requires a completed attempt whose run, task, and
workspace identities match the workspace, and requires the snapshot root to be that workspace path.

`RepairExecutionCoordinator` composes the repair attempt with the existing controlled `AgentRunner`,
Stage 21 impact reconciler, verifier, snapshot provider, verification evidence store, and read-only review
collector. It persists `STARTING` before external dispatch, moves to `RUNNING` only after `onStarted`, and
records `UNKNOWN` without releasing leases if a post-start runner failure leaves workspace mutation
uncertain. A completed repair must reconcile, pass verification, persist new exact verification evidence,
construct a subject whose output attempt is the repair attempt, and collect a new review. This coordinator
does not yet automatically integrate output; a composition root must still invoke exact review admission.

Repair lease contention has its own durable semantics. A started repair that reports a dynamic lease block
persists `BLOCKED` with the conflicting lease ID, releases its currently held leases, and emits a
`RepairRuntimeFeedback` event instead of consuming repair budget as a failure. A compare-and-swap resume
operation returns the same repair attempt to `PREPARING` only when its expected revision still matches.
Repair feedback can be connected to the scheduler conflict/blocker loop by a composition root, but repair
is not yet a scheduler-visible task phase in the main runtime snapshot.

The builder runtime and repair coordinator currently retain separate lease-release implementations. This is
intentional temporary duplication: their evidence and scheduler contracts differ today (builder release
can emit task scheduler events while repair release reports through repair feedback). The next composition
increment must evaluate a shared release primitive only after it establishes the repair-visible scheduler
view and durable resume path; extracting one earlier could erase meaningful contract differences.

The final composition must keep repair attempts out of the original task-state snapshot. It should maintain
a parallel repair view, resume `BLOCKED` repair attempts with compare-and-swap when their blocker lease is
released, and reconstruct that view during recovery. It must not represent repair as a synthetic builder
task transition.

Automated code review has an independent semantic authority policy. Its fingerprint covers reviewer
implementation, agent backend, provider/model identity, read-only tool profile, output schema version, and prompt
version; it excludes session IDs, timestamps, temporary paths, and other incidental runtime values. Plan
artifacts, execution binding, durable run authority, and local runtime startup all bind and revalidate
this `codeReviewPolicyFingerprint` separately from verification policy. The Pi reviewer resolves the
approved provider and model ID through Pi's model registry and passes that exact SDK model to its session;
an unavailable approved model fails closed rather than falling back to Pi settings. Review/repair
composition must fail closed when that policy drifts.

## Consequences

- Code review becomes durable, structured, provider-neutral evidence.
- A reviewer cannot mutate the repository or bypass verification and integration authority.
- Malformed review output fails before evidence persistence.
- Repair remains intentionally unavailable until its durable lifecycle is designed and reviewed.
