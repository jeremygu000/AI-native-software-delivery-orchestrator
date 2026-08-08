# ADR-002: Nx monorepo with pnpm

## Status

Superseded by ADR-009

## Decision

The initial implementation used Nx for project/task graphs and pnpm workspaces for package
management. It began with a CLI, domain library, and DAG library.

## Consequences

This decision provided early dogfooding but coupled a three-package repository to Nx plugins,
project files, target inference, and sync generators. ADR-009 records the evidence-based revision.
