# Semantic Plan Review

## Why this stage exists

Stage 16 can prove that a proposed plan is structurally safe to analyze and schedule. It cannot prove
that the plan includes everything the user asked for.

Suppose the request says:

```text
Add Google login, persist the user profile, add logout, and add tests.
```

A Planner might return one valid task for the login button and omit persistence and logout. The task
can still have a valid ID, a real file selector, an acyclic dependency graph, and a real test script.
All deterministic checks would correctly say “this task is valid,” but that is different from saying
“this plan covers the request.”

Stage 17 adds a second semantic role to reduce that omission risk.

## The complete boundary

```text
User request / Markdown specification
                  |
                  v
            Planner proposal
             (untrusted)
                  |
                  v
     deterministic validation and analysis
     schema -> DAG -> verification -> impact
             -> conflicts -> Scheduler
                  |
          invalid | valid
          +-------+---------+
          |                 v
          |        Semantic Plan Reviewer
          |             (untrusted)
          |                 |
          |       revise    | accept recommendation
          |          +------+------+
          |          |             v
          +----------+     full deterministic
          Planner          revalidation
          revision              |
                               v
                    PreparedOrchestrationPlan
                    (still not execution authority)
```

The two checks answer different questions:

| Component              | Question                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| Deterministic pipeline | Are the contracts, selectors, dependency graph, verification, conflicts, and schedule valid? |
| Semantic Reviewer      | Does the proposed task set appear to cover each requirement in the source?                   |
| Future human approval  | May this exact reviewed plan execute against this exact repository snapshot?                 |

The Reviewer cannot replace either deterministic validation or human approval.

## Provider-neutral contract

`libs/planning/src/lib/semantic-plan-review.ts` defines `SemanticPlanReviewer`:

```ts
interface SemanticPlanReviewer {
  review(request: SemanticPlanReviewRequest): Promise<unknown>;
}
```

Returning `unknown` is deliberate. A provider adapter cannot make its own model response trusted by
claiming that it already has a TypeScript type.

The response must contain:

```json
{
  "recommendation": "accept",
  "summary": "Every requested outcome is represented.",
  "requirements": [
    {
      "requirement": "Add logout",
      "status": "covered",
      "taskIds": ["auth-logout"],
      "detail": "auth-logout implements and tests logout."
    }
  ]
}
```

Each item has one of three statuses:

- `covered`: at least one known task ID must be cited;
- `missing`: the plan contains no sufficient task;
- `ambiguous`: the plan or source is too unclear to claim coverage.

`accept` is structurally legal only when every requirement is `covered`. `revise` must contain at
least one `missing` or `ambiguous` item. Requirement text is unique case-insensitively, task IDs are
deduplicated and sorted, and unknown task IDs fail closed.

These rules do not make the semantic judgment deterministic. They make the judgment structured,
inspectable, and difficult to contradict internally.

## How revision works

A missing or ambiguous item becomes a `SEMANTIC_REQUIREMENT_GAP` planning diagnostic:

```json
{
  "code": "SEMANTIC_REQUIREMENT_GAP",
  "requirement": "Persist the user profile",
  "status": "missing",
  "detail": "No task owns profile persistence or its verification."
}
```

The next Planner attempt receives that diagnostic. Reviewer revision consumes the same positive
`maxAttempts` budget as every other planning correction. Therefore a Planner and Reviewer cannot
argue forever. If the final attempt still has a semantic gap, `AutonomousPlanningError` contains the
last gaps and the phase fails closed.

Malformed Reviewer JSON is different. The Planner cannot repair a Reviewer transport or formatting
failure, so `SemanticPlanReviewError` propagates immediately. Provider failures also propagate
unchanged rather than being misclassified as plan defects.

## Why validation runs twice

The first deterministic pass ensures the Reviewer sees only a valid candidate. After an `accept`
recommendation, the phase schema-clones the Task Specification and repeats:

```text
Task Contract validation
functional DAG validation
verification authority validation
repository selector and impact analysis
hard/risk conflict analysis
Scheduler validation
```

This creates an explicit trust boundary after probabilistic review. Tests even use an adversarial fake
Reviewer that mutates the in-memory specification; the second pass detects the new missing dependency
and refuses to return that candidate.

## Read-only Repository Facts

`PiSemanticPlanReviewer` lives in `libs/agent-runtime`. Pi SDK types do not enter planning contracts.
The Reviewer gets a new one-response session and only these tools:

- `forge_projects`;
- `forge_files`;
- `forge_symbols`;
- `forge_relationships`.

`forge_relationships` queries existing `RepositoryGraph` edges at project, file, or symbol level. It
can filter incoming, outgoing, or either direction and caps every page at 500 edges even if a caller
bypasses the tool schema. This lets the Reviewer inspect facts such as “the API imports this domain
file” without receiving shell or live-filesystem access.

Every tool reads the already-built in-memory graph. None can mutate a worktree or execute a command.
The session is disposed after success and failure. If both the provider operation and disposal fail,
the original provider failure remains the primary diagnostic.

## Explicit data-egress consent

The CLI form is:

```sh
forge plan request.md --repository . --semantic-review
```

`--semantic-review` is mandatory. It explicitly authorizes the independent Pi review call to receive
the specification and read-only repository facts. Without the flag Commander rejects the command
before the planning composition root runs.

No live model smoke test is implied by the automated tests. Running the command against a private
repository still requires the operator to understand the configured model destination.

## What the result means

`PreparedOrchestrationPlan.semanticReview` preserves the accepted recommendation and requirement map.
This is useful evidence for a human and for a future audit trail. It does not grant any capability.

The result still lacks:

- a human approval record;
- plan and repository-snapshot fingerprints;
- run and agent identities;
- worktree bindings;
- canonical lease plans and command policy;
- durable planning history.

Those belong to the Plan-to-Run binding and approval stage.

## Tested failure boundaries

Tests cover:

- accepted requirement maps;
- missing and ambiguous requirement revision;
- exhausted semantic revision budget;
- malformed JSON and non-object output;
- duplicate requirements;
- inconsistent recommendation and item statuses;
- covered requirements without task citations;
- unknown task citations;
- Reviewer infrastructure failure propagation;
- post-review deterministic revalidation;
- relationship direction, stable identity, sources, pagination, and server-side caps;
- explicit CLI consent;
- preservation of primary provider failures when disposal also fails.

## Known limitations

- A model may fail to identify a requirement in the source. The structured map reduces and exposes
  omission risk; it cannot mathematically prove natural-language completeness.
- Planner and Reviewer currently use separate sessions but may use the same configured Pi provider.
  Future model routing can choose a different reviewer model.
- Malformed Reviewer output is not retried independently.
- Review evidence is not yet durable and is not cryptographically bound to a repository snapshot.
- There is still no execution approval or `forge run` command.
