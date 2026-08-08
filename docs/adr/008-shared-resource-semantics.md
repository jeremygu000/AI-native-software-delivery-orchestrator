# ADR-008: Shared-resource declarations

## Status

Accepted

## Decision

Keep both forms required by the task contract, with distinct meanings. A `shared-resource` selector
inside `expectedReads` or `expectedWrites` predicts static impact and retains read/write intent.
`sharedResources` declares a concurrency coordination requirement independent of predicted access.

At the analysis boundary, `collectSharedResourceIds` produces a stable, deduplicated union for the
conservative `TaskImpact.sharedResources` set. The detailed selectors remain available when a
future engine needs to distinguish read and write access.

## Consequences

Planners may express both static access and a global coordination rule without the conflict engine
silently ignoring either field. Explicit coordination declarations are sorted and deduplicated by
schema parsing. The registry, not task producers, remains the authority for whether a named
resource is exclusive, ordered, or producer-controlled.
