# ADR-023: Plan Approval and Execution Binding

## Status

Accepted. Stage 19 passed independent review and follow-up verification.

## Context

A durable `PlanArtifact` proves what was planned, but it does not prove that a person approved that
exact decision or that the repository and authority policies still match when execution is requested.
Embedding `approved: true` in the artifact would mutate the reviewed record and would not identify the
actor, time, or exact revision. Reusing one approval for multiple runs would also make concurrent
execution ambiguous.

## Decision

Stage 19 introduces three separate, fingerprinted records:

- `PlanApproval` identifies one artifact ID, revision, and `planFingerprint`, plus a provider-neutral
  approving actor and timestamp.
- `PlanApprovalClaim` binds that approval to one stable run ID. Publication is atomic. A retry for the
  same run is idempotent; a different run is rejected.
- `PlanExecutionIntent` combines the verified artifact, approval, persisted claim, binding time, and
  a fingerprint over the complete record.

`PlanExecutionBinder` is the only production path that creates an execution intent. Before claiming
the approval it reloads and validates the artifact and approval, captures Git evidence, rebuilds
Repository Facts, captures Git evidence again, rejects a moving repository, compares repository ID,
physical repository root, base commit, working-tree fingerprint, dirty state, and facts fingerprint,
and compares current shared-resource and verification-policy fingerprints. Any mismatch fails before
the claim is written.

The CLI exposes `forge approve` and `forge bind`. It composes filesystem, Git, and repository-analysis
adapters but does not construct agent, workspace, lease, command, sandbox, model, or verification
bindings.

## Boundaries

- Approval is a local provider-neutral fact, not authentication, authorization policy, a signature,
  or proof of an external identity-provider decision.
- An execution intent is validated authority evidence, not `StartRuntimeRunRequest` and not proof that
  a run has started.
- `forge run` remains unavailable until a controlled runtime binding policy can supply deployment-
  specific runtime collaborators without hiding orchestration logic in the CLI.
- The JSON store provides atomic single-host filesystem publication, not distributed consensus or
  cross-host fencing.
- Same-run retry returns the original claim and timestamp. Cross-run replay is rejected even when the
  artifact and approval are otherwise unchanged.
- Fingerprints detect content changes and bind records to independently reloaded evidence; they are
  not HMACs or digital signatures. A person with direct write access to the JSON store can edit a
  record and recompute a self-consistent SHA-256 fingerprint. The current local threat model relies on
  filesystem access control plus mandatory binder cross-checks. Signed approvals or authenticated
  durable storage are required if the storage administrator is inside the adversary model.

## Consequences

The Plan-to-Run boundary is now explicit and reviewable:

```text
PlanArtifact -> PlanApproval -> repository/policy revalidation
             -> atomic PlanApprovalClaim -> PlanExecutionIntent
```

Runtime startup remains a later composition step. This prevents a reviewed plan from silently running
against different source bytes, facts, policies, or under a reused approval.

`PlanExecutionIntent` proves authority at binding time, not indefinitely. Stage 20 must revalidate
authority immediately before run creation and connect the approved source snapshot to an
orchestrator-owned integration checkout at the approved base commit. Task worktrees must derive from
that checkout. Simply parsing a stored intent and calling `startRun()` would leave an unguarded
bind-to-run time-of-check/time-of-use window.
