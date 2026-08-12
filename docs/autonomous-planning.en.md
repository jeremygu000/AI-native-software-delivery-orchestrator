# Autonomous Planning

## What this stage adds

Earlier stages could analyze a repository and execute already-defined tasks. They did not answer the
first product question: how does a plain-language request become a safe set of tasks?

Stage 16 adds that missing Plan phase. A planner model proposes tasks, but the model is not trusted to
decide whether its own answer is valid. Existing deterministic engines make that decision.

```text
human intent
    |
    v
planner proposal
    |
    v
deterministic validation and repository resolution
    |
    +---- invalid ----> structured feedback ----> planner revision
    |
    v
impact + conflicts + schedule preview
    |
    v
prepared plan (not execution yet)
```

## The trust boundary

`PlannerAgent.propose()` returns `unknown`. This is deliberate. A model response has the same trust
level as unvalidated network input. It cannot become a `TaskSpecification` merely because it looks
like JSON.

`AutonomousPlanPhase` accepts a proposal only after all of these checks succeed:

1. **JSON and Task Contract shape** — every required field, selector, dependency, and verification
   rule must satisfy the Zod schemas.
2. **Functional dependency graph** — dependencies must exist and tasks must not form a cycle.
3. **Verification references** — a package-script rule must name exactly one discovered project and
   a script that exists in that project's `package.json` facts.
4. **Impact and selector resolution** — one impact-analysis pass resolves project, file, glob,
   symbol, and shared-resource selectors while calculating predicted read/write scope. Exact
   selectors must resolve without zero or multiple matches. Globs may match many existing files.
5. **Pairwise conflict analysis** — one comparison pass classifies every task pair and immediately
   places the result into structurally separate hard or risk collections.
6. **Scheduler validation** — the resulting constraints must permit a complete initial plan. The
   Scheduler defensively validates the task DAG again at its own public boundary.

The phase returns structured diagnostics for correctable planner output. The next attempt receives
those diagnostics verbatim. `maxAttempts` is a positive bounded number; if every proposal is invalid,
the phase throws `AutonomousPlanningError` with the last diagnostics. Model transport or authentication
failure is different: it propagates immediately because asking the same model to rewrite an answer it
never produced would hide the real failure.

## How Pi inspects a repository

The Pi adapter lives in `libs/agent-runtime`, not in planning or domain. Its static resource loader
returns only the fixed planning system prompt and empty resource collections. It does not run Pi's
default project/global resource discovery, so project context files, extensions, skills, prompt
templates, themes, and appended system prompts cannot enter through that path. Pi sessions use
`noTools: "builtin"`: built-in filesystem and command tools start disabled while explicitly supplied
custom tools remain registrable. The same three names are also passed through Pi's explicit `tools`
allowlist, so unrelated extension/custom tools cannot enter the session registry.
The planning session receives only:

- `forge_projects` — pages discovered project identities and package facts;
- `forge_files` — pages files with optional project and path-prefix filters;
- `forge_symbols` — searches or pages symbols by query or file.

The tools query the immutable in-memory `RepositoryGraph`. They do not inspect an unanalysed live
filesystem, execute a command, or write a file. Pagination keeps a large repository from being copied
into one enormous prompt, while stable ID ordering makes repeated queries deterministic.

Pi-specific sessions, messages, tool definitions, and response extraction remain inside
`agent-runtime`. The `PlannerAgent` interface exposes none of them.

## What `forge plan` does

```sh
pnpm build
pnpm exec forge plan request.md --repository /path/to/repository --max-concurrency 2 \
  --shared-resources /path/to/shared-resources.json
```

The command:

1. reads the Markdown request;
2. builds the repository graph;
3. starts the configured Pi planning session;
4. allows up to three proposals by default;
5. prints JSON containing accepted tasks, predicted impacts, hard/risk conflicts, and an explanatory
   wave preview.

`--max-attempts` and `--max-concurrency` accept positive integers. The latter influences the schedule
preview; it does not start agents. `--shared-resources` is optional and loads the JSON policy consumed
by the deterministic impact and conflict engines. Without it, the registry is deliberately empty and
the CLI explains that named shared resources require a policy file.

The command currently uses Pi's configured model and authentication. Explicit model selection,
routing, and failover are not implemented.

## Why the output is not a running job

A safe plan still lacks execution-specific identity and resources:

- run ID and creation time;
- repository/integration ref identity;
- agent assignment;
- worktree request;
- canonical lease plan;
- command policy and execution profile.

Those belong to runtime binding, not planning. `forge plan` therefore stops before persistence,
workspace creation, lease acquisition, coding-agent dispatch, verification, commit, or Git integration.
This preserves the boundary between “is this plan valid?” and “is this concrete write authorized now?”

## Tested edge cases

Tests cover valid plans, fenced JSON, malformed JSON, invalid contracts, missing dependencies, cycles,
unresolved selectors, unknown shared resources, missing package scripts, hard/risk separation,
Scheduler rejection and revision, exhausted attempts, provider failure propagation, fact-tool
pagination, server-side limit clamping and filtering, symbol lookup, disabled built-in Pi tools,
missing/empty/error responses, policy-file loading, CLI serialization, CLI rejection diagnostics, and
invalid numeric options. A non-mocked Pi SDK integration test proves that the Stage 12–15 coding tools
and Stage 16 fact tools actually enter the live session registry while built-in `bash` remains absent.

## Known limitations

- Globs currently describe existing repository facts. A glob intended only for files that will be
  created later resolves to zero facts and is rejected; a future selector needs explicit
  “planned creation” semantics.
- Command verification is not executed and is not yet mapped to fixed runtime command-policy IDs.
- The Planner cannot start, resume, cancel, or inspect a runtime run.
- Planning output is not persisted.
- There is no human approval checkpoint or automated review-agent loop.
- Model routing, failover, token budgeting, and prompt-size telemetry are deferred.
