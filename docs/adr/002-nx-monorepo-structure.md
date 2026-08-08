# ADR-002: Nx monorepo with pnpm

## Status

Accepted (amends the initial npm preference)

## Decision

Use Nx for project/task graphs and pnpm workspaces for package management. Begin with a CLI,
domain library, and DAG library; add later libraries only when their behaviour exists.

## Consequences

This matches the surrounding APRA AMCOS ecosystem while retaining Nx graph integration. The
orchestrator itself remains able to analyze repositories using other package managers.
