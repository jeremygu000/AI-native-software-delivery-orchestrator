# Interactive Model Selection CLI

Forge offers a terminal picker for the same execution profiles used by the accepted
provider comparison. A profile combines provider, model and reasoning effort; it
is an input to existing model resolution, rather than a saved preference. This
stage does not modify Temporal, PostgreSQL authority, provider adapters, approval
rules or worker target validation.

## Commands

Build once with `pnpm build`. Use `pnpm exec forge` directly, or `pnpm local:forge`
when using the existing local private-environment wrapper.

```sh
pnpm exec forge model list
pnpm exec forge model login github-copilot
pnpm exec forge model login openai-codex
pnpm exec forge model select
pnpm exec forge plan request.md --repository . --semantic-review
```

`model list` lists only these validated profiles:

| Provider       | Canonical ID   | Model          | Reasoning | Authentication           |
| -------------- | -------------- | -------------- | --------- | ------------------------ |
| GitHub Copilot | github-copilot | gpt-6.1-sol    | medium    | Forge subscription store |
| OpenAI Codex   | openai-codex   | gpt-6.1-sol    | medium    | Forge subscription store |
| DeepSeek       | deepseek       | deepseek-flash | high      | FORGE_MODEL_API_KEY      |

`ready` means a private Forge credential record or API key is configured. It does
not prove account access, current quota or successful remote authentication. A
valid expired subscription record still counts as configured; refresh remains in
the existing execution adapter. `not-configured` means configuration is absent;
`invalid` means a subscription record or its private directory/file checks failed.
Inspection never creates the auth directory, modifies files, refreshes credentials
or sends a model request. It does not discover VS Code, Copilot CLI, Codex CLI or
SDK filesystem credentials. The existing comparison wrapper consumes the same default-profile metadata. Model metadata comes from the existing pinned resolver
using an in-memory registry and the approved live-model descriptors.

For subscriptions, explicitly set `FORGE_SUBSCRIPTION_AUTH_DIRECTORY` to a canonical
absolute host directory private to the current user. `model login` wraps the
existing browser/device authorization and private-store lock/save flow. Nothing
logs credential records or provider error bodies. This is explicit operator login;
no selection command automatically logs in or falls back to another provider.
`forge model login deepseek` explains private API-key configuration and runs no
OAuth flow. Existing local login commands remain available.

## Selection and planning

Use Up/Down and Enter to choose the entire profile. Forge displays provider, model,
reasoning effort, transport and local authentication status, then offers Continue
or Change selection. An unconfigured selection stops with the relevant login/key
setup instruction. Esc or Ctrl-C cancels; Ctrl-C exits 130 and never selects the
highlighted item. EOF also cancels. Terminal raw mode, cursor and input activity are
restored, including when stdin was initially idle.

`model select` writes the existing `ResolvedModelExecutionTarget` JSON to stdout,
including its fingerprint; the menu uses stderr. It does not save a preference,
plan, approval or run. Each `plan` invocation makes its own selection.

Planning retains the existing explicit `--semantic-review` authorization. With
that authorization and missing provider or model, an interactive stdin and menu
terminal enter the picker. Partial flags filter the available validated profiles;
they are never silently overwritten. A conflicting partial provider/model/effort
combination is rejected.

In non-interactive mode, missing provider or model stops before planning:

```text
Model provider/model are required in non-interactive mode.
Pass --review-provider and --review-model explicitly.
```

Existing complete explicit flags skip the picker, including in a terminal. Without
an effort flag they keep the existing `FORGE_MODEL_REASONING_EFFORT`/resolver
behavior. The new `--reasoning-effort` flag explicitly selects effort for `plan`,
`bind` and `run`, without mutating the process environment:

```sh
pnpm exec forge plan request.md --semantic-review \
  --review-provider github-copilot --review-model gpt-6.1-sol --reasoning-effort medium
pnpm exec forge bind ARTIFACT_ID --approval APPROVAL_ID --run-id RUN_ID \
  --review-provider github-copilot --review-model gpt-6.1-sol --reasoning-effort medium
pnpm exec forge run ARTIFACT_ID --approval APPROVAL_ID --run-id RUN_ID \
  --review-provider github-copilot --review-model gpt-6.1-sol --reasoning-effort medium
```

Configure the worker for that same provider/model/effort using its existing
`FORGE_WORKER_REVIEW_PROVIDER`, `FORGE_WORKER_REVIEW_MODEL` and
`FORGE_MODEL_REASONING_EFFORT`. The picker does not reconfigure a running worker.
Existing mismatch rejection still applies. There is one profile for model roles;
this stage has no per-role editor or runtime model switching.

Both input methods enter the same CLI policy resolver, existing provider adapter
validation and policy fingerprint. Subscription targets retain their established
fingerprinted policy representation. DeepSeek remains the accepted fixed-high
direct-API path, whose policy binds provider/model without embedding an execution
target. `model select` can inspect its target through the existing API adapter;
this does not change its persisted policy shape or introduce a worker rollout.
Plan artifacts continue storing the policy fingerprint, rather than a new profile
record. No approval or persistence schema changes are needed.

## Verification and limits

CLI regressions compare interactive and explicit requests for all three profiles,
then use the real policy, artifact and approval constructors with fixed fixture
identities/times to check equal fingerprints. They cover missing/invalid private
credentials, no network inference for list, partial flags, non-TTY failure,
unchanged complete flags, no fallback, authoritative invalid-pair/effort rejection,
Change selection, cancellation before planning/approval/run and terminal cleanup.
Login regressions also reject saving credentials after authorization is cancelled.

Compiled CLI terminal smoke checks confirm profile output exits 0, Ctrl-C during
plan exits 130 with no artifact directory, and incomplete non-TTY planning exits 1.
The smoke uses a dummy API-key presence marker and sends no inference request. This
stage does not repeat the provider comparison or perform live OAuth/Neon operations.
Live Neon schema preparation and traced GroundGraph E2E remain a later stage.

Final `pnpm build` and full image-enabled `pnpm check` pass with the authority fixture
on PG18: 102 files / 1071 tests, no skips. Coverage is 90.84% statements, 85.91%
branches, 94.54% functions and 90.73% lines, above unchanged thresholds.
