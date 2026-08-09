# ADR-005: Explainable conflict scoring

## Status

Accepted

## Decision

Model conflict as a bounded 0–100 risk score composed from individually reported reasons. Keep
weights and action thresholds in configuration owned by the conflict engine. Structural hard
conflicts are a separate discriminated variant: they require at least one scheduling constraint and
may only recommend staggering or serialization. Risk conflicts cannot carry structural constraints.
Scheduler methods receive hard and risk conflicts as separate required inputs.
The score retained on a hard conflict is explanation metadata only; scheduler implementations must
not use it to filter, cap, or selectively enforce structural constraints.

## Consequences

Scheduling decisions are deterministic and inspectable. Weight changes do not alter domain types,
uncertain semantic escalation can be added without replacing reliable static rules, and an
implementation cannot accidentally receive hard constraints only as members of a scored list.
