# ADR-010: pnpm project graph provider

## Status

Accepted

## Context

The orchestrator needs real repository facts before it can analyze files, symbols, task impact, or
conflicts. The current product and repository use pnpm workspaces. Implementing adapters for other
tools without an active supported-repository requirement would add fixtures and contracts that no
current workflow can validate end to end.

## Decision

Keep the `ProjectGraphProvider` port in the domain layer and implement the first provider in
`repository-analysis` for pnpm workspaces. The provider reads `pnpm-workspace.yaml`, discovers the
root and matched package manifests, and maps local package dependencies into `RepositoryGraph`.

Package names are stable project IDs. Project roots and source roots are repository-relative,
portable paths. A dependency edge points from the package declaring the dependency to the local
package it depends on. External packages are not project nodes. Explicit `workspace:` references
to missing packages, duplicate package names, malformed configuration, invalid manifests,
self-dependencies, and paths escaping the repository are structured errors.

The provider itself discovers projects only; the subsequent TypeScript analyzer enriches its graph
with files, symbols, and semantic dependencies. Additional providers require a concrete product use
case and must remain outside the domain layer.

Use `yaml` rather than a hand-written parser because pnpm workspace files are YAML and require
correct handling of quoting and collection syntax. Use `tinyglobby` for workspace inclusion and
exclusion patterns because pnpm patterns are glob-based and filesystem discovery must remain
deterministic. Both dependencies are confined to `repository-analysis` and do not cross the
provider-neutral domain boundary.

## Consequences

`forge analyze <repository>` can inspect a real pnpm workspace and emit a deterministic JSON
repository graph. The current repository and dedicated fixtures provide end-to-end validation. The
design retains a small provider boundary without carrying an unused tool-specific adapter or
dependency.
