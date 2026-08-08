# ADR-001: TypeScript and Node.js runtime

## Status

Accepted

## Decision

Use the TypeScript 7 native CLI for project builds and type checks, with strict settings, Node.js,
and ESM. Because TypeScript 7 does not yet expose the stable programmatic API required by the
future repository analyzer, retain the official TypeScript 6 compatibility package under the
`typescript` alias. The
`@typescript/native` alias supplies the `tsc` 7 executable. Workspace packages declare
`type: module`, and provider-specific types stay out of the domain layer.

## Consequences

Application code is checked by TypeScript 7. The future repository analyzer initially uses the
TypeScript 6 programmatic API and can move to TypeScript 7 when that API becomes stable. Strictness
catches invalid graph states early, while ESM avoids maintaining a second module format.
