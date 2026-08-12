# ADR-020: Autonomous planning boundary

## Status

Accepted.

## Context

The deterministic repository, impact, conflict, and scheduling engines previously required a human
or test fixture to supply `TaskContract[]`. The product needs to turn a user request or Markdown
specification into those contracts without allowing model output to become orchestration authority.
The planner also needs repository context without receiving unrestricted filesystem or shell tools.

## Decision

Add `libs/planning` as an application-layer package. It owns a provider-neutral `PlannerAgent` port,
a bounded revision loop, structured planning diagnostics, and composition of existing deterministic
engines. Planner output is `unknown` until `taskSpecificationSchema` accepts it.

Each proposal must pass, in order:

1. Task Contract schema validation.
2. Functional DAG validation.
3. Repository-backed package-script verification validation.
4. Predicted-impact calculation and repository/shared-resource selector resolution in one
   `TaskImpactAnalyzer` pass.
5. Pairwise conflict analysis with immediate hard/risk structural separation.
6. Scheduler initial-plan validation, including defensive DAG revalidation at the Scheduler boundary.

Failures in these checks may be returned to the planner for revision until the configured positive
attempt limit is exhausted. Exhaustion fails closed with the last structured diagnostics. Provider or
transport exceptions are not model-correctable output and propagate immediately.

Implement the first `PlannerAgent` adapter in `libs/agent-runtime` with Pi. An isolated Pi resource
loader performs no project/global resource discovery and returns only a fixed system prompt plus empty
resource collections. Pi starts with `noTools: "builtin"`, which disables Pi's built-in tools without
filtering out explicitly supplied custom tools. An explicit `tools` allowlist limits the registry to
the three planning tool names. The planner receives only paginated read-only queries over the
already-built `RepositoryGraph`. It has no filesystem mutation tool and no command tool during
planning. Pi SDK types stay in `agent-runtime`.

Expose the phase through `forge plan <specification.md>`. The command produces a prepared plan but
does not start runtime execution. Run identity, agent/workspace binding, leases, verification,
persistence, and Git integration remain runtime responsibilities.

## Consequences

- Model output cannot bypass Task Contract, graph, resource, conflict, or Scheduler validation.
- Planner revision is bounded and diagnostics are stable enough for tests and review.
- Repository discovery remains the source of selector truth; the model queries facts rather than the
  live filesystem.
- The deterministic planning package can use fake planners without installing or importing a provider
  SDK.
- The CLI accepts an optional JSON shared-resource registry through `--shared-resources`. Omitting it
  deliberately selects an empty registry; rejection output explains how to provide the policy.
- Command verification entries are structurally valid but are not yet mapped to runtime command-policy
  IDs or executed by `forge plan`.
- A prepared plan still needs run metadata and `RuntimeTaskBinding[]` before
  `OrchestrationRuntime.startRun()` can execute it.
