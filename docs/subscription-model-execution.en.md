# Pluggable Subscription-backed Model Execution Layer

GitHub Copilot subscription and Codex subscription are independent, equal-priority
providers. Copilot uses `github-copilot`; Codex uses `openai-codex` and the SDK's
dedicated Codex Responses transport, not GitHub routing. Claude subscription is a
future adapter, not implemented in this stage.

## Execution and authentication

The provider-neutral `ResolvedModelExecutionTarget` contains provider kind/identity,
model identity, reasoning effort, tool/context capabilities, transport and adapter
version. Its SHA256 fingerprint is checked at inference time and included in the
code-review policy, hence existing plan/approval/run policy fingerprints. Credentials
and account IDs are absent. Existing API-only policies remain byte-compatible when
they have no optional execution target.

Authentication is a separate host-only concern. Both subscription adapters use the
pinned Pi SDK OAuth implementations. Access-token expiration triggers refresh and
atomic credential replacement before inference. Cross-process refresh is serialized
by an exclusive private-directory lock; a stale lock is never deleted on a timeout.
If authorization is revoked, missing, malformed, or cannot refresh, execution fails
without falling back to an API key, another provider or interactive login.

The isolated SDK container retains no network, no host auth directory, no model
endpoint and no credentials. The existing host broker reconstructs enabled Forge
tool schemas and invokes the approved adapter. Provider continuation signatures are
kept only in bounded host memory, never in durable execution evidence. Refresh does
not change the semantic execution fingerprint or issue mutation authority.

## Explicit operator login

Build first with `pnpm build`. Choose a canonical absolute directory outside the
target repository, owned by the current user with mode 0700. In an interactive
terminal, authorize each provider independently:

Run these commands from the Forge repository root. Each login takes exactly two
arguments: the provider ID once, then the private directory.

```sh
mkdir -p "$HOME/.config/forge/subscription-auth"
chmod 700 "$HOME/.config/forge/subscription-auth"

node apps/temporal-worker/local/subscription-login.mjs openai-codex "$HOME/.config/forge/subscription-auth"
node apps/temporal-worker/local/subscription-login.mjs github-copilot "$HOME/.config/forge/subscription-auth"
```

For Codex, complete the displayed OpenAI browser login. The local callback can
complete authorization while `Authorization redirect URL:` is displayed; seeing
`Subscription authorization saved in the private host store.` means it succeeded.
Only paste a callback into your own interactive terminal if the helper actually
requires the manual fallback. Never send the redirect URL, code or credential file
to a chat, issue or log.

For Copilot, leave `GitHub Enterprise URL/domain` blank for github.com, open the
displayed device-login page, and enter the one-time code in that page. Enterprise
users must supply their own approved domain. Wait for the same saved-authorization
success message before starting inference.

Do not repeat the provider argument: `github-copilot github-copilot DIRECTORY` is
incorrect and can select a directory named `github-copilot` inside the repository.
The login commands above keep both credential files in the explicit private host
directory. They do not require a model API key and do not log access/refresh tokens.

The login helper displays the SDK's device/browser authorization instructions. It
does not import VS Code, Copilot CLI, Codex CLI or another application's sessions.
Do not put generated credential JSON or authorization redirects into Git or logs.
The SDK Copilot login can enable model policies on the account; complete this
operator flow only with the account owner's authorization.

Configure planning and the global worker with the same provider/model/reasoning:

```sh
export FORGE_SUBSCRIPTION_AUTH_DIRECTORY=/absolute/private/forge-auth
export FORGE_MODEL_REASONING_EFFORT=medium
export FORGE_WORKER_REVIEW_PROVIDER=github-copilot # or openai-codex
export FORGE_WORKER_REVIEW_MODEL=gpt-6.1-sol
```

Use the same identity with CLI `--review-provider` and `--review-model`. Global mode
still requires its existing PostgreSQL authority, signed workspace setup/handoff,
pinned SDK/Git images and approved resource boundaries. It does not require
`FORGE_MODEL_API_KEY` for these subscription providers. The legacy unisolated worker
does not accept subscription execution profiles. A changed reasoning effort,
provider, transport or capability creates a different approval fingerprint; approve
a new plan instead of changing a running task's target.

## Validation and comparison boundary

Automated tests use controlled credentials/providers for refresh, isolation and
profile rejection, plus the real planning SDK through the execution contract. This
does not establish actual subscription entitlement or GroundGraph completion.
Those require explicit operator login to both accounts and three separately approved
plans on the same clean GroundGraph baseline: DeepSeek, Copilot, Codex. Record
COMPLETED status, planning quality, tool/repair counts, latency, retry/replay and
provider-reported usage. Token counters and SDK price estimates are not subscription
credit balances; report unavailable credit/quota information as unavailable.

Both independently authorized accounts completed real `gpt-6.1-sol` / `medium`
readiness inference. Copilot's live catalogue advertises Responses, tool calls and
medium effort; Codex's dedicated Responses endpoint also completed the explicitly
named model. The pinned SDK catalogue predates this identity, so a separate explicit
descriptor preserves the exact model ID and each provider's own transport. The
272,000-token input budget is a conservative application limit; it is not a Codex
account quota claim. Subscription prices are not inferred from another model's API
prices. Earlier `gpt-5.x` / high plans are not approvals for the new profile.

The live local authority preflight currently rejects its historical migration ledger
because it installed the independently rejected version-14 checksum. No ledger was
rewritten and no historical owner was bypassed. Model readiness and genuine planning
are separate from a COMPLETED repository run; the same-baseline comparison remains
blocked until that deployment is independently reconciled.

No Temporal workflow, PostgreSQL migration, mutation fencing or recovery authority
is changed by this layer. Ollama/local and direct API execution can implement the
same adapter contract; deploying a specific local gateway remains separate.
