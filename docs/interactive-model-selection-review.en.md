# Review request: Interactive Model Selection CLI

Please review the Interactive Model Selection CLI increment against accepted baseline
`6db6741075a2455e8f5fe9494e386874a8331120` on `m4/postgres-durable-authority`.
The prior PostgreSQL/shared-database stage and owner-membership correction are
accepted. This stage is a canonical execution-profile picker, with no live Neon
operation or further database infrastructure.

## Intended scope

- `forge model list`: first-class validated Copilot/Codex/DeepSeek profiles, with
  local Forge auth status only, no inference or external credential discovery.
- `forge model login <provider>`: existing private-store operator OAuth flow;
  DeepSeek gives private API-key instructions.
- `forge model select`: profile, confirmation/change, existing canonical target JSON;
  no persisted selection, fallback, new provider system or per-role editor.
- `forge plan`: complete explicit flags keep current automation; incomplete flags
  invoke picker in a TTY or fail before planning otherwise. Partial flags constrain
  selection. Existing --semantic-review authorization remains mandatory.
- Optional --reasoning-effort on plan/bind/run repeats the selected target through
  existing validation without changing ambient process environment or worker setup.

## Architecture constraints and compatibility boundary

Provider metadata and pinned model resolution remain in agent-runtime. The CLI
uses the existing PiCodeReviewModelResolver with an in-memory registry, subscription
resolver and API/subscription adapters. No domain, authority, Temporal, workflow
patch, provider transport or worker validation changes are made. No persistence or
configuration registry is added. Invalid combinations are checked by authoritative
resolution after selection.

Both input methods enter the same CLI policy function. Subscription target and
policy fingerprints retain their existing representation. Direct-API DeepSeek
keeps its existing provider/model policy shape and fixed-high transport. Its
canonical target is inspected via the existing API adapter by model-select, but
is not newly embedded in the plan policy; preserving this shape avoids altering
accepted approvals or the unchanged worker policy matcher. Plan artifacts continue
binding the policy fingerprint. There is no claim that old artifacts contained a
full target JSON. Workers must still be configured for the exact profile; the CLI
does not modify a running worker or silently adjust its reasoning effort.

Ready is configuration presence, including an expired valid subscription record
whose refresh is deferred to execution. Private-store inspection has no mkdir,
repair, save or refresh. OAuth is explicitly initiated by login, uses the accepted
lock/store, sanitizes provider error diagnostics, and checks cancellation before
saving a returned credential. Model selection cancellation occurs before planning
and produces no artifact/approval/run/target preference.

## Changed areas

- apps/cli/src/app.ts: command routing and optional plan picker/effort inputs.
- apps/cli/src/model-selection.ts: terminal lifecycle, auth display, selection and
  existing-login wrapper; main.ts renders known picker errors without stack traces.
- apps/cli/src/review-policy.ts: shared existing policy path for both input methods.
- agent-runtime model-execution-deployment.ts: three profile descriptors and pinned
  resolution/auth-inspection helpers, deliberately exposed at its package boundary.
- subscription-credential-store.ts: nonmutating inspection sharing existing private
  record checks; subscription-login.ts: do not save after abort.
- The existing local comparison wrapper consumes the same default metadata; its
  aliases, explicit flags, credential stripping and deployment flow stay intact.
- CLI/login and cutover-boundary regressions, README, usage guide and synchronized progress summaries.

## Verification

Targeted CLI/auth tests, TypeScript, type-aware lint and build have passed. Tests
compare all three input paths, canonical subscription targets, real policy/artifact
fingerprints and real approval fingerprints using fixed fixture identities/times.
They exercise list with network requests prohibited, auth configuration/malformed
records/private permissions, missing-directory noncreation, no fallback, invalid
pair/effort, non-TTY/partial flags, confirmation/change and cancellation cleanup.
The existing CLI consent/bind/run tests remain in the targeted run.

A compiled CLI PTY smoke confirmed profile display/confirmation and target JSON
exit 0. Ctrl-C in plan exits 130 and leaves no artifact directory. Non-TTY missing
flags exit 1 before reading a nonexistent specification. An initially idle stdin
hang found during smoke was fixed and added to regression. No inference or actual
OAuth is used in these smoke checks. The cutover-boundary regression now checks the resolver in its extracted CLI/provider modules instead of requiring its old placement in app.ts. It preserves the existing legacy-route constraints. Final pnpm build and full image-enabled pnpm check pass with the authority fixture on PG18: 102 files / 1071 tests, no skips. Coverage is 90.84% statements, 85.91% branches, 94.54% functions and 90.73% lines, above unchanged gates. Formatting, TypeScript, type-aware lint and git diff --check pass. The existing compiled CLI/worker, Temporal, PostgreSQL and provider-contract regressions pass in this full gate.

## Limitations and review questions

Live Neon preparation, actual OAuth, subscription/provider comparison and traced
GroundGraph E2E remain outside this increment. The first picker offers complete
validated defaults only; there is no customization or per-role editor. Existing
local comparison wrappers still supply their own explicit deployment flags.

1. Do both input paths preserve canonical target/policy/artifact/approval identity,
   including the existing direct-API versus subscription policy representation?
2. Are partial flags, incomplete non-TTY calls, missing/invalid auth and cancellation
   rejected without overwriting input, fallback or planning side effects?
3. Does terminal cleanup restore cursor/raw mode/input activity on confirm and
   cancellation, especially initially idle stdin and Ctrl-C at confirmation?
4. Does list read only the explicit Forge store without creating files, refreshing,
   inference, external auth discovery or secret-bearing output?
5. Is login solely a wrapper around accepted auth, with sanitized failures and no
   credential save after abort? Do unchanged approval/run/worker guards remain intact?
