# ADR-022: Durable Plan Artifact and Repository Snapshot Identity

## Status

Accepted. Stage 18 passed independent review and follow-up verification.

## Context

`PreparedOrchestrationPlan` is an in-memory analysis result. It previously had no durable identity and
did not state which exact repository bytes produced its Repository Facts. A Git commit alone is not
enough because planning may inspect tracked modifications and untracked, non-ignored files.

Human approval and runtime binding must never execute a different decision or repository state from
the one that was reviewed. This requires an immutable artifact before approval is introduced.

## Decision

Stage 18 introduces schema-versioned `PlanArtifact` revision records. Each artifact contains:

- source content and its fingerprint;
- repository identity, real root, base commit, dirty state, and working-tree content fingerprint;
- a canonical Repository Facts fingerprint;
- shared-resource and verification-policy fingerprints;
- JSON-safe task contracts, predicted impacts, hard/risk conflicts, schedule, execution preview, and
  semantic-review evidence;
- one fingerprint over the complete artifact payload.

The Git snapshot hashes tracked and untracked non-ignored entries using length-framed path, mode,
kind, and content evidence. Symlinks hash their link text and are not followed. The CLI captures a
snapshot before analysis and another after analysis; any difference rejects planning as a moving
repository instead of publishing mixed evidence.

Artifact schemas also validate cross-record identity: every task has exactly one predicted impact and
one execution-wave occurrence, dependency order and concurrency limits agree with the execution
preview, conflicts cite distinct known tasks without duplicate unordered pairs, semantic-review
citations are known, and hard/risk collections remain structurally separated. Array-shaped impact
evidence is normalized and then required to remain unique and canonically sorted.

`JsonFilePlanArtifactStore` publishes `<artifact-id>.r<revision>.json` atomically through a hard link.
An identical retry is idempotent. Existing content under the same artifact ID and revision cannot be
replaced.

## Boundaries

- A fingerprint detects content mismatch; it is not a cryptographic signature or user approval.
- Ignored files are excluded from the Git source snapshot. Repository Facts still bind ignored files
  that the analyzer intentionally indexes, but arbitrary ignored build/cache bytes are not authority.
- Repositories containing Git submodules fail closed because Stage 18 does not claim to fingerprint
  mutable nested worktrees.
- Repository paths that collide after Unicode NFD normalization and lowercase conversion fail closed so one
  artifact cannot describe different file identities on common case-sensitive and case-insensitive
  filesystems.
- Origin URL is the stable cross-clone repository identity. Without an origin, the real local root is
  an explicit fallback, so separate clones at different paths intentionally receive different IDs.
- Filesystem permissions can still delete an artifact. Cross-process authorization and signed audit
  storage remain future deployment concerns.
- Runtime binding must recapture the snapshot and facts, compare all binding fields, and fail closed.
  Stage 18 supplies `repositoryBindingMismatches` and tests it, but deliberately has no production
  caller because it does not start a run. Stage 19's `PlanExecutionBinder` must call it and reject any
  `repositoryId`, `baseCommit`, `workingTreeFingerprint`, or `factsFingerprint` mismatch before it
  creates a runtime request.
- Approval records are deliberately deferred to the next stage and must reference the exact
  `planFingerprint`, artifact ID, and revision.

## Consequences

`forge plan` now stores an immutable JSON artifact under `~/.forge/plans/<repository-id>` by default
and prints that artifact. A configured directory inside the analyzed repository, including through an
existing symlink ancestor, fails closed because storage must not invalidate its own snapshot. The
store re-resolves the destination before directory creation, after directory creation, and immediately
before the temporary-file write to detect an ancestor replaced between path selection and publication.
Temporary-file cleanup cannot replace an already selected
publication or immutability error. Planning remains non-executing. The infrastructure `persistence` package depends outward on
the provider-neutral planning artifact port; planning does not depend on filesystem persistence.
