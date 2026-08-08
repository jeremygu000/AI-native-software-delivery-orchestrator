# ADR-006: Hierarchical exclusive write leases

## Status

Accepted

## Decision

Every runtime write must acquire an exclusive lease for a project, file, symbol, or shared resource.
Containment is explicit: broader resources conflict with descendants, while sibling symbols may be
leased independently. Repository resources carry a complete project/file/symbol lineage so a lease
can be evaluated after persistence without loading a separate repository graph.

Leases are scoped to a run, expire, and carry a monotonic version. Renewal uses an expected version
to prevent stale workers from extending a replaced lease. Releasing an unknown lease returns
`not-found` rather than failing, making cleanup idempotent during recovery.

## Consequences

Unexpected writes block before merge time, and old runs cannot collide solely because they reused
task or agent IDs. Resource identities must be resolved and validated against the repository graph
before acquisition. Phase 1 uses safe blocking, renewal, expiry, and release; queuing, workspace
rebasing, and task resumption remain higher-level orchestration behaviours.
