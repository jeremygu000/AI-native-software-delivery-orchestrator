# ADR-007: SQLite and Drizzle persistence

## Status

Accepted

## Decision

Start with SQLite through Drizzle behind persistence repository interfaces. Persist runs, tasks,
dependencies, transitions, graph summaries, impacts, conflicts, waves, resources, and leases—not
complete ASTs.

## Consequences

Local operation and restart recovery stay simple. Repository interfaces and domain records must not
expose SQLite-specific types so PostgreSQL can be added later.
