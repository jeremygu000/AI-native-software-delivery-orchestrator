# ADR-006: Hierarchical exclusive write leases

## Status

Accepted

## Decision

Every runtime write must acquire an exclusive lease for a project, file, symbol, or shared resource.
Containment is explicit: broader resources conflict with descendants, while sibling symbols may be
leased independently.

## Consequences

Unexpected writes block before merge time. Phase 1 uses safe blocking and release; queuing,
workspace rebasing, and task resumption remain higher-level orchestration behaviours.
