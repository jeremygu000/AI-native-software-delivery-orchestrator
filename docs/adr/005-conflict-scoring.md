# ADR-005: Explainable conflict scoring

## Status

Accepted

## Decision

Model conflict as a bounded 0–100 risk score composed from individually reported reasons. Keep
weights and action thresholds in configuration owned by the conflict engine.

## Consequences

Scheduling decisions are deterministic and inspectable. Weight changes do not alter domain types,
and uncertain semantic escalation can be added without replacing reliable static rules.
