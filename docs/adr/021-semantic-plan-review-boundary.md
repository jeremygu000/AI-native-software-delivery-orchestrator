# ADR-021: Semantic plan review boundary

## Status

Accepted.

## Context

Deterministic planning proves that Task Contracts are structurally valid, repository selectors are
real, dependencies are acyclic, verification is authorized, conflicts are explainable, and the plan
is schedulable. Those checks cannot prove that a probabilistic Planner included every semantic
requirement from a user request. A structurally perfect plan may still omit login persistence,
logout, an error case, or another requested outcome.

## Decision

Add a provider-neutral `SemanticPlanReviewer` port to `libs/planning`. The reviewer receives the
original source, a deterministically valid Task Specification, and read-only Repository Facts. Its
untrusted output must map concrete requirements to known task IDs with one of three statuses:
`covered`, `missing`, or `ambiguous`. `covered` requires at least one task citation. The top-level
recommendation must be `accept` only when every item is covered, and `revise` otherwise.

A revise recommendation becomes stable `SEMANTIC_REQUIREMENT_GAP` diagnostics for the next Planner
attempt. It consumes the existing bounded planning-attempt budget. Invalid review JSON, duplicate
requirements, inconsistent status/recommendation combinations, unknown task IDs, and reviewer
infrastructure failures fail closed rather than being disguised as Planner mistakes.

After an accept recommendation, run the complete deterministic graph, verification, impact,
conflict, and Scheduler pipeline again from a schema-cloned Task Specification. Store the accepted
review on `PreparedOrchestrationPlan` as advisory evidence.

Implement the first adapter as `PiSemanticPlanReviewer` inside `libs/agent-runtime`. It runs in a new
one-response session and reuses the isolated planning gateway. Both Planner and Reviewer can query
four bounded in-memory tools: projects, files, symbols, and graph relationships. They receive no live
filesystem, mutation, or command capability. `forge plan` requires `--semantic-review`, explicitly
authorizing this additional model call to receive the specification and read-only facts.

## Consequences

- One model no longer proposes tasks and silently judges its own semantic completeness in one pass.
- Semantic coverage remains probabilistic and explainable; it is not misrepresented as deterministic
  proof.
- Reviewer acceptance cannot create a run, acquire a lease, bind a workspace, or authorize execution.
- Human approval and plan/repository fingerprints remain mandatory future Plan-to-Run work.
- The first Planner and Reviewer may use the same configured Pi provider, but use separate sessions
  and roles. Explicit model routing can assign different providers later without changing planning
  contracts.
- Reviewer output is not retried independently. Malformed output fails closed; future model routing
  may add bounded transport/output retry outside deterministic planning.
