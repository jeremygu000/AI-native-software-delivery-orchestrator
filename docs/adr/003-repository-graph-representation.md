# ADR-003: In-memory repository graph

## Status

Accepted

## Decision

Represent projects, files, and symbols as keyed maps with explicit edge collections. Persist only
facts needed for orchestration and recovery; do not introduce a graph database or store raw ASTs.

## Consequences

Queries remain deterministic and easy to test. Stable IDs enable persisted references, while an
incremental analysis request keeps full rescans from becoming an architectural assumption.
