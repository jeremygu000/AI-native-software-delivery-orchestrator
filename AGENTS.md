# Repository guidelines

- Use pnpm workspaces for dependency installation and package linking.
- Use TypeScript project references and `tsc -b` for cross-package build order.
- Keep domain and engine libraries independent of repository-provider implementations.
- Nx types and commands may only appear in the future Nx project-graph adapter or isolated fixtures.
- Run `pnpm check` before committing. Run `pnpm build` when build configuration changes.
- Keep code, comments, commit messages, and documentation in English.
- Use strict TypeScript, ESM, Vitest, Oxlint, and Oxfmt.
- Do not add a task orchestrator unless an ADR reevaluation trigger is met.
