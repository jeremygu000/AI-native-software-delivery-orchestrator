# Contribution Guide

Thank you for contributing to the AI-native software delivery orchestrator.

## Development workflow

1. Fork the repository and create a focused branch such as `feat/*`, `fix/*`, `docs/*`, or
   `chore/*`.
2. Keep commits small and avoid mixing unrelated changes in one pull request.
3. Add or update tests for behavior changes.
4. Run the required checks locally.
5. Open a pull request that explains the change, verification, risks, and compatibility impact.

## Local setup

The project requires Node.js 24 or newer and pnpm 11.

```bash
pnpm install
pnpm check
pnpm build
```

## Commit convention

Use Conventional Commits where practical:

- `feat: ...`
- `fix: ...`
- `docs: ...`
- `refactor: ...`
- `test: ...`
- `chore: ...`

## Development conventions

- Keep code, comments, commit messages, and repository documentation in English.
- Preserve the dependency direction described in `docs/architecture.md`.
- Keep repository facts, graph logic, scheduling constraints, leases, verification, and state
  transitions deterministic. An LLM must not become the source of truth for these concerns.
- Keep package-manager, compiler, Git, database, CLI, and model-provider details behind their
  adapter boundaries.
- Use ESM and `import type` for type-only imports.
- Do not add nonessential re-exports.
- Prefer tests before or alongside behavior changes.
- Do not introduce hard-coded absolute paths, credentials, tokens, or local-machine assumptions.
- Add configuration through explicit parameters or environment variables.
- Update architecture decisions and both progress summaries when a milestone changes project
  behavior or boundaries.

## Required checks

Run these commands before opening a pull request:

```bash
pnpm check
pnpm build
git diff --check
```

For repository-analysis changes, also build the CLI and analyze the fixture or this repository:

```bash
pnpm exec forge analyze .
```

## Pull-request checklist

- [ ] The change is focused and clearly explained.
- [ ] Tests were added or updated where behavior changed.
- [ ] `pnpm check` passes.
- [ ] `pnpm build` passes.
- [ ] `git diff --check` passes.
- [ ] Architecture and progress documentation were updated when relevant.
- [ ] No secrets, private paths, generated build output, or unrelated changes are included.
- [ ] Risks, compatibility impact, and intentionally deferred work are documented.

## Reporting issues

Please include:

- reproduction steps;
- expected and actual behavior;
- relevant sanitized logs;
- operating system, Node.js version, and pnpm version;
- a minimal repository fixture when the issue involves repository analysis.
