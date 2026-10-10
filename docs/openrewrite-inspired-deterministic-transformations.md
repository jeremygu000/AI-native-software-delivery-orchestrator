# Deterministic Code Transformations — OpenRewrite-Inspired Design Note

> Status: Proposal / research note only. Not an accepted ADR, committed implementation milestone, or authorization to expand Forge v1 scope.
>
> Target: `product/forge-v1` | Updated: 2026-10-11

## Executive summary

OpenRewrite demonstrates the value of separating **what should change** from **how repeatable changes are applied**. Its lossless syntax representation, type-aware visitor model, composable recipes, and reviewable diffs are useful design references. **Do not introduce OpenRewrite itself, a new LST framework, or a general-purpose transformation subsystem into Forge v1.**

The orchestrator should continue to use AI for intent interpretation, planning, code changes that require reasoning, and independent semantic review; deterministic repository facts, constraints, and verification remain authoritative. If repetitive TypeScript refactoring becomes a demonstrated product need, evaluate a small, opt-in, bounded transformation adapter. Preserve the existing Plan → explicit approval → controlled execution → verification/review → integration path.

## 1. What OpenRewrite actually contributes

The OpenRewrite model is approximately:

```text
source code → parser/type attribution → lossless semantic tree
           → recipe/visitor → changed tree → printer → minimal diff
```

- **Lossless representation:** syntax nodes retain comments and whitespace so unaffected source does not need wholesale reformatting.
- **Semantic matching:** where language support includes type attribution, matching can target a particular declaration or method signature, not just identical text.
- **Recipe composition:** a broad migration consists of small transformations with explicit preconditions.
- **Repeatability:** recipes should converge; rerunning a completed migration should normally produce no further edits.
- **Inspectability:** a deterministic, scoped transformation provides a diff and machine-verifiable evidence, not an opaque claimed success.

These are reference principles, not guarantees. A matching parser cannot prove application-level behavior; compilation, tests, and independent review still matter. OpenRewrite's richest open-source migration ecosystem is Java/JVM-oriented. Other language support and usage licenses should be verified separately before adoption.

References:
- https://github.com/openrewrite/rewrite
- https://docs.openrewrite.org/concepts-and-explanations/lossless-semantic-trees
- https://docs.openrewrite.org/concepts-and-explanations/recipes
- https://docs.openrewrite.org/reference/rewrite-module-architecture

## 2. Fit with Forge v1

The repository already has a TypeScript-aware `repository-analysis` boundary that extracts imports, declarations, symbols, and project dependencies. That is a **read-only facts capability**, not a source transformation engine. Do not conflate the Repository Knowledge Graph with a mutable LST.

| Existing responsibility | Treatment of a future transformation capability |
| --- | --- |
| Plan and semantic plan review | May propose an *eligible* transformation, but cannot authorize execution |
| Repository facts / symbol analysis | Reuse for preconditions, affected-file discovery, and impact estimation |
| Explicit plan approval | Remains mandatory; no implicit approval by a recipe match |
| Controlled coding execution | Potentially invokes an allowlisted transformation adapter in an isolated task worktree |
| Worktree and integration | Continue to own filesystem isolation and Git integration |
| Verification / independent review | Must validate changed output; recipe success is not verification success |
| RunView and read-only UI | Could display transformation evidence in a later product slice; browser stays GET-only |

**No changes are proposed now** to scheduler, task lifecycle, plan approval, executor, provider routing, worktree ownership, verification, integration, TUI, or web actions. Existing task/run contracts should not gain speculative fields.

## 3. Proposed bounded execution model (future only)

```text
User request
  → AI planner + Repository Facts
  → proposed plan (may identify deterministic transform candidate)
  → explicit human approval
  → existing isolated task worktree
       → allowlisted transformation adapter [optional]
       → typed output evidence + diff
       → existing build/tests and independent output review
  → existing integration decision
```

A candidate adapter must:
1. Accept a **versioned recipe ID**, parameters, permitted repository-relative files, and immutable baseline evidence.
2. Check parser/type-information availability, symbol identity, scope, and preconditions; fail closed when ambiguous.
3. Produce file changes **only inside the existing controlled worktree and allowed scope**; no remote writes, unapproved commands, or browser mutations.
4. Emit a structured result: recipe/version, matched symbols, affected paths, applied/skipped counts, diagnostics, baseline and final hashes, and actual diff.
5. Refuse partial success unless the task explicitly permits a well-defined atomic unit. Failed transforms must not be silently reported as completed.
6. Preserve comments/formatting where practical; explicitly measure unexpected churn.
7. Support a second-run idempotence test: reapply on the result and expect an empty diff.
8. Pass normal verification and independent review; never self-certify business correctness.

The precise adapter interface and evidence schema should be designed only after a narrowly scoped proof of concept, not added as unconsumed abstractions.

## 4. Candidate technology comparison

| Tool | Strength | Limitation / caution |
| --- | --- | --- |
| TypeScript Compiler API / ts-morph | TypeScript symbols, type checker and cross-file context; fits TS-first repos | Printing and edit scope need careful diff control; ts-morph is an additional dependency |
| jscodeshift / recast | Established codemod ecosystem, generally preserves existing formatting well | Type-level matching is not its default strength |
| ast-grep | Fast declarative structural matching across languages | Structural matches alone do not guarantee TypeScript symbol identity or business correctness |
| OpenRewrite | Strong reference architecture for recipes, visitors, lossless trees and large migrations | Java/JVM focus and non-uniform language module maturity/licensing; avoid direct dependency absent proof |

**First candidate for a TS-native proof of concept:** leverage the pinned TypeScript compiler already used inside `repository-analysis`, with a narrow transformation adapter and golden diff tests. Compare `ts-morph` only if the direct compiler API is impractically complex. Do not leak compiler AST nodes across domain boundaries. A transform may use the existing facts graph for discovery, but should recheck facts against its exact worktree revision before mutation.

## 5. Good and bad initial recipe candidates

Suitable:
- Precisely rename a known imported API or exported symbol and update its verified references.
- Replace an obsolete function call when the full symbol resolves and the new API is equivalent by an explicit contract.
- Migrate a known configuration key with schema/fixture validation.

Not suitable as a first deterministic recipe:
- Broad Next.js architecture rewrites (SSR vs client rendering, target personalization, caching).
- GraphQL schema redesign across producers and consumers without comprehensive semantic constraints.
- Domain behavior changes that require design reasoning.
- Unbounded AI-generated scripts applied directly to a production repository.

## 6. Recommended first POC, only after prioritization

**Goal:** demonstrate that a small codemod is more reliable and cheaper to review than an unconstrained coding agent for one recurring TypeScript change.

**Fixture:** minimal pnpm TypeScript workspace with two packages, same-named but unrelated functions, aliased imports, comments and custom whitespace.

**Scenario:** rename one fully qualified API usage and its imports across files while leaving same-spelled unrelated symbols untouched.

**Acceptance criteria:**
- Scoped targets only; no out-of-scope file edits.
- Correct symbol resolution, including aliases; ambiguous/missing type information causes an explicit failure.
- Golden input/output and diff tests, including comments and whitespace.
- Second run produces zero additional changes.
- Invalid recipe parameters and outdated baseline fail closed.
- Normal typecheck, lint, and unit tests pass.
- Independent reviewer sees the exact changed files, matched symbols, preconditions, and verification results.
- Compare effort, diff size, and failure modes against a Pi coding-agent implementation on the same fixture.

**Stop/go:** do not generalize into a recipe registry or new package until the POC establishes repeated product value and an appropriate safety/ownership boundary.

## 7. Product sequencing and non-goals

**Now:** keep this note as research only. Finish current Forge v1 product acceptance and keep the approved Plan, run, worktree, verification, review, integration, TUI and GET-only web surface unchanged.

**Later, if justified:** implement one opt-in deterministic codemod behind the existing controlled execution path, with tests and review. Consider recipe composition only after a second independent transformation use case appears.

**Explicit non-goals:** OpenRewrite runtime integration, Java migration product, arbitrary-language LST, AI-authored executable recipe DSL, new scheduler/authority model, auto-repair or retry/resume mechanics, implicit approvals, and browser write actions.

## 8. Risks and decision questions

- **Type fidelity:** will the chosen parser know the precise referenced symbol in real project configurations?
- **Printer churn:** can the tool keep diffs local rather than reformat unrelated code?
- **Repository consistency:** how will it detect a changed worktree baseline before applying a transform?
- **Security:** which exact edit scope is enforced by the existing controlled tool boundary?
- **Licensing:** are library/runtime and recipe licenses compatible with intended distribution and commercial use?
- **Product ROI:** what migration occurs often enough to justify a distinct deterministic engine rather than existing Pi-assisted coding and independent review?

## Recommendation

**Adopt the architecture principle, not the framework.** Keep the agent-centered Forge v1 workflow. Use deterministic AST/type-aware transformations selectively when a clearly bounded, repeated task demands precision, repeatability, and low-diff evidence. No implementation work should start solely because this note exists.
