# ADR-004: TypeScript Compiler API strategy

## Status

Accepted

## Decision

Use the TypeScript Compiler API behind a repository-analyzer interface. Keep graph construction
independent of compiler node objects; optional conveniences such as ts-morph may not cross the
adapter boundary.

## Consequences

Semantic identity and references can use the compiler type checker without coupling the core graph
to one analyzer implementation. Other languages can add adapters later.
