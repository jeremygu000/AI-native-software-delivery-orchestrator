# ADR-001: TypeScript and Node.js runtime

## Status

Accepted

## Decision

Use the TypeScript 7 native CLI for project builds and type checks, with strict settings, Node.js,
and ESM. The `@typescript/native` alias supplies the `tsc` 7 executable. Do not retain a second
TypeScript version for anticipated work. If the repository analyzer later requires a programmatic
API that TypeScript 7 cannot provide, add the compatibility package only to that workspace package
and remove it when the compatibility boundary is no longer required. Workspace packages declare
`type: module`, and provider-specific types stay out of the domain layer.

## Consequences

Application code is checked by a single TypeScript 7 toolchain. The repository avoids the version
ambiguity and maintenance cost of an unused compatibility compiler. A future analyzer may introduce
a package-local compatibility dependency only when an implemented use case proves it necessary.
Strictness catches invalid graph states early, while ESM avoids maintaining a second module format.
