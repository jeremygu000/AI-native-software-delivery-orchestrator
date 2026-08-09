# ADR-004: TypeScript Compiler API strategy

## Status

Accepted

## Decision

Use the pinned TypeScript 7 native API (`@typescript/native/unstable/sync` and
`@typescript/native/unstable/ast`) behind the repository-analysis boundary. Keep graph construction
independent of compiler node objects; native projects, AST nodes, symbols, and checker objects must
not cross that boundary. Do not add TypeScript 6 as a second compiler solely to obtain its stable
Compiler API.

The unstable import path is accepted as a deliberately narrow compatibility risk. It is isolated to
one package, covered by fixture and real-repository tests, and must be reevaluated when TypeScript 7
publishes a stable programmatic API. A convenience wrapper such as ts-morph may not cross the same
boundary and is not currently required.

TypeScript configuration discovery reads JSONC project-reference metadata and follows references
recursively before opening native projects. Native config diagnostics remain authoritative after
discovery. Empty solution projects are warnings in the provider-neutral repository diagnostics;
malformed JSONC, invalid reference shapes, missing targets, and reference paths outside the
repository fail with `INVALID_TYPESCRIPT_CONFIGURATION`.

## Consequences

Semantic identity and references can use the compiler type checker without coupling the core graph
to one analyzer implementation. Real `tsconfig.json` resolution supports path aliases and shared
source relationships that package manifests cannot express. Other languages can add adapters later.

The cost is reliance on a currently unstable TypeScript 7 surface. Pinning the exact version and
keeping all native objects private limits upgrade impact to `repository-analysis`. The workspace
continues to have one TypeScript version and one source of semantic truth.
