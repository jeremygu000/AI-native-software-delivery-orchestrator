# Forge Run Inspector: first vertical slice

Baseline: `09af2c13a79185671f93936bbdcffd3ef6381195`.

## Sources and boundary

One local app, `apps/run-inspector`, serves a React/React Flow view and a GET-only API on loopback. An explicitly named private environment file selects PostgreSQL; repository, queue and environment label are mandatory. Existing authority fingerprint validation and verified TLS remain in force. There is no fallback environment, credential discovery, mutation endpoint or operator credential requirement.

The backend reuses `ForgeReadModel` and the existing PostgreSQL recovery readers through a new read-only connection entry. Supplemental SELECTs observe global bindings, claims, phases, generations and permit lineages in a read-only transaction. They do not call recovery methods that acquire authority locks. Temporal describe/history queries observe the configured namespace and queue. Git worktree listing observes only the configured repository. Exact run/task-scoped operator files are observed only at the explicitly selected operator root; no broad filesystem search or private-key reading occurs.

## Presentation DTO

`libs/run-inspection` owns `inspectRun` and the evidence/state projection. React Flow is required for the primary graph; tables are only for evidence details.

`ForgeRunInspection` contains version, environment identity/badge, run ID, refresh timestamp, task groups, graph nodes/edges and source observations. Each node has a stable ID, label, task/attempt identity where applicable, state, explanation and evidence entries. Evidence entries carry source, observation time and allowlisted identifiers/state fields. Secrets, completion verifiers, signed envelopes and provider diagnostics never enter the browser DTO.

## Mapping

The graph includes approval, binding, run metadata, per-task setup admission, generation, arming, permit, worktree observation, workspace persistence, recovery attestation, settlement, execution child, builder/repair attempts, leases, verification, review, integration, Temporal and terminal run state. Edges show lifecycle organization, not a proof that every preceding operation occurred. COMPLETE requires direct evidence for that node; ACTIVE and FAILED require explicit durable/provider states. PENDING is used for a directly recorded pending task/attempt, not unobserved setup. Missing or contradictory setup evidence and unavailable observations are UNKNOWN. A later child never retrospectively completes earlier setup nodes. A current missing worktree cannot erase historical integration or prove that creation never happened.

The reported `fe89c1bf-0ec8-4aee-80da-b14d2e0918fa` regression is represented by ACTIVE run metadata, a PREPARING builder attempt, a recorded PENDING second task, no leases and UNKNOWN setup/worktree/local evidence. The semantic fixture is labelled separately from the subsequent GET-only live Neon read: that read returned HTTP 200, ACTIVE run metadata, RUNNING/PENDING task states and UNKNOWN setup admission in the explicitly selected schema. Temporal observation was unavailable at that time and was kept UNKNOWN.

## Local usage and UI

Build with `pnpm build`, then run `pnpm inspector --deployment-env-file .env.local --env-file .local/neon-comparison.env --repository .local/neon-comparison-deepseek --task-queue forge-neon-comparison-deepseek --label "Neon comparison"`. The optional, explicitly named deployment file supplies only backend selection and Temporal transport/namespace. Authority URL, schema, role and identity must come from the selected authority file; neither shell nor another file can fill them. The environment is fixed for that process. The browser has run ID lookup, manual/optional refresh, task filtering, graph overview, selectable evidence and copyable IDs. No recovery, retry, cancel, settlement, Git or database mutation control exists. Partial-source failures are visible and retain UNKNOWN, rather than hiding missing sources. Observations across PostgreSQL, Temporal, Git and files are timestamped separately and are not an atomic authority decision.
