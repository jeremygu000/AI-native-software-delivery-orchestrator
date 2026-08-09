# Repository guidelines

- Use pnpm workspaces for dependency installation and package linking.
- Use TypeScript project references and `tsc -b` for cross-package build order.
- Keep domain and engine libraries independent of repository-provider implementations.
- Keep package-manager-specific parsing inside repository-analysis providers; domain types must stay
  provider-neutral.
- Keep TypeScript 7 unstable API imports inside `libs/repository-analysis`; never expose compiler
  AST, project, checker, or symbol objects through domain contracts.
- Do not add barrel files or pass-through re-exports by default. Import from the defining module.
  Re-export only when it is necessary to define a package's deliberate public entry point, preserve
  an explicit compatibility boundary, or build a repository-analysis fixture that must verify
  re-export behavior. The necessity must be clear from the surrounding package boundary or test.
- Run `pnpm check` before committing. Run `pnpm build` when build configuration changes.
- Keep code, comments, commit messages, and documentation in English, except for the maintained
  Chinese training summary at `docs/progress-summary.zh.md`.
- Use strict TypeScript, ESM, Vitest, Oxlint, and Oxfmt.
- Do not add a task orchestrator unless an ADR reevaluation trigger is met.
- After completing each project stage, update both `docs/progress-summary.en.md` and
  `docs/progress-summary.zh.md`. Keep them synchronized and written as full onboarding material for
  a reader with no prior experience on this project. Explain what was built, why it was built, what
  was verified, what the stage enables, and what remains unimplemented without assuming technical
  background.
- Do not commit completed stage work unless the user explicitly asks for a commit. Leave the working
  tree available for an independent Claude review.
- Before handing off each completed stage, produce a self-contained review message that the user can
  send directly to Claude. It must state the intended scope, important architecture constraints,
  changed areas, verification already performed, known limitations, and specific review questions.
