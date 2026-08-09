# ADR-008: Shared-resource declarations

## Status

Accepted

## Decision

Keep both forms required by the task contract, with distinct meanings. A `shared-resource` selector
inside `expectedReads` or `expectedWrites` predicts static impact and retains read/write intent.
`sharedResources` declares a concurrency coordination requirement independent of predicted access.

At the analysis boundary, `collectSharedResourceIds` produces a stable, deduplicated union for the
conservative `TaskImpact.sharedResources` set. The detailed selectors remain available when a
future engine needs to distinguish read and write access. Predicted impact now normalizes those
details into `read`, `write`, and `coordinate` modes for every resource.

The registry is validated configuration. `exclusive` and `ordered` apply to every declared access;
`producer-controlled` allows concurrent readers but constrains writes and coordination requests.
Every explicitly named resource must resolve before task-impact analysis; unknown IDs fail with
structured evidence instead of weakening a likely hard policy because of a typo. The conflict
engine keeps a scored unknown-resource fallback only for manually constructed or old persisted
impacts that bypass this validation. File and path rules are resolved centrally, including
non-TypeScript files that do not appear in the semantic file graph and files reached through symbol
or whole-project selectors.

## Consequences

Planners may express both static access and a global coordination rule without the conflict engine
silently ignoring either field. Explicit coordination declarations are sorted and deduplicated by
schema parsing. The registry, not task producers, remains the authority for whether a named
resource is exclusive, ordered, or producer-controlled.
