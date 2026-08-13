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

The initial Stage 22 boundary deliberately does not dispatch repair. Existing execution persistence
assumes one agent-attempt lineage per task. Repair needs a separately modeled attempt lineage, budget,
re-verification, re-review, recovery behavior, and integration admission rule. It must not be added by
silently reusing or overwriting the builder attempt.

## Consequences

- Code review becomes durable, structured, provider-neutral evidence.
- A reviewer cannot mutate the repository or bypass verification and integration authority.
- Malformed review output fails before evidence persistence.
- Repair remains intentionally unavailable until its durable lifecycle is designed and reviewed.
