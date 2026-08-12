# Plan Approval and Execution Binding

## 1. Why this stage exists

Stage 18 made a plan durable. That answers, “What exactly did the planner decide?” It does not answer
three other questions:

1. Did a person approve this exact artifact revision?
2. Does the repository still contain the same source and Repository Facts?
3. Is the approval already being used by another run?

Stage 19 answers those questions before runtime-specific bindings are allowed to exist.

```text
untrusted request
      |
      v
validated PlanArtifact       human decision
      |                            |
      +----------------------------+
                   |
                   v
             PlanApproval
                   |
                   v
       reload + integrity validation
                   |
       +-----------+-----------+
       |                       |
       v                       v
 Git snapshot before     current policies
       |
 RepositoryGraph rebuild
       |
 Git snapshot after
       |
 reject movement or mismatch
       |
 atomic single-run claim
       |
       v
        PlanExecutionIntent
       (not a running process)
```

## 2. The records are deliberately separate

### PlanArtifact

The artifact remains the immutable planning decision. Approval never edits it. Its fingerprint covers
the request, repository evidence, policies, Task Contracts, predicted impact, conflicts, schedule,
and semantic-review evidence.

### PlanApproval

An approval records:

- a stable `approvalId`;
- the exact artifact ID and revision;
- the exact `planFingerprint`;
- a provider-neutral `approvedBy` string;
- `approvedAt`; and
- an `approvalFingerprint` over the approval payload.

The timestamp may not precede artifact creation. The actor field deliberately contains no GitHub,
Jira, SSO, or other provider type. A later adapter may derive this value from an authenticated
provider, but core planning contracts remain provider-neutral.

### PlanApprovalClaim

An approval is claimed for one `runId` only after all binding checks pass. Claim publication uses an
atomic hard link:

```text
no claim exists + run-A request -> publish run-A claim -> success
run-A retry                    -> return original claim -> success
run-B request                  -> existing run-A claim -> reject
run-A and run-B concurrently   -> exactly one publishes -> other rejects
```

The same-run retry returns the original claim, including its original `claimedAt`. This makes the
result stable across process retries.

### PlanExecutionIntent

The intent packages the artifact, approval, persisted claim, run ID, binding time, and a full-record
fingerprint. Parsing validates every nested record's own fingerprint as well as cross-record identity
and the outer fingerprint.

It is important to read the name precisely: an execution intent is not a running orchestration. It
does not contain `AgentRunner`, workspace, Write Guard, command policy, sandbox, model, verification,
or Git-integration implementations.

## 3. What the binder checks

`PlanExecutionBinder.bind()` performs the checks in this order:

```text
1. Load exact artifact revision and approval
2. Validate both fingerprints and approval-to-artifact identity
3. Capture repository snapshot A
4. Rebuild RepositoryGraph
5. Capture repository snapshot B
6. Require snapshot A == snapshot B
7. Compare artifact repository authority:
   - repositoryId
   - physical repositoryRoot
   - baseCommit
   - workingTreeFingerprint
   - dirty state
   - Repository Facts fingerprint
8. Compare current authority policies:
   - shared-resource policy fingerprint
   - verification policy fingerprint
9. Atomically claim the approval for runId
10. Return a fingerprinted PlanExecutionIntent
```

The claim is intentionally last. A failed or moving repository must not consume approval authority.

## 4. Predicted facts versus current facts

The artifact contains the Repository Facts used to predict impact and conflicts. At bind time, the
analyzer runs again. A matching Git commit is insufficient because tracked modifications and
untracked source may have changed. A matching working-tree fingerprint is also not substituted for
facts comparison: both source identity and the canonical graph must agree.

This is conservative. If the repository or relevant policy changed, the safe workflow is to create
and approve a new artifact rather than silently reinterpret the old one.

## 5. CLI workflow

After `forge plan` creates an artifact, a local workflow is:

```sh
forge approve <artifact-id> \
  --revision 1 \
  --approved-by reviewer@example.com \
  --approval-id approval-123 \
  --repository .

forge bind <artifact-id> \
  --revision 1 \
  --approval approval-123 \
  --run-id run-123 \
  --repository .
```

If planning used a shared-resource registry, binding must receive the same current policy with
`--shared-resources`. A custom artifact directory must be repeated with `--plan-directory`.

Binding failures use `BINDING_REJECTED` and list deterministic mismatch identifiers. Missing or
corrupt storage and configuration errors continue to propagate as infrastructure failures.

## 6. Concurrency and failure behavior

Approval and claim files use immutable atomic publication. Simultaneous claim attempts cannot both
win for different run IDs on the supported local filesystem. Validation happens before publication,
and filename/payload disagreement, invalid IDs, corrupt JSON, fingerprint mismatch, and storage inside
the analyzed repository fail closed.

This is a local single-host guarantee. It is not a database transaction spanning hosts, distributed
lock, or cross-process lease fence for the later runtime.

SHA-256 fingerprints are integrity links, not signatures. Someone who can directly rewrite the JSON
store can also recompute a self-consistent fingerprint. The binder still detects an approval changed
to reference a different real artifact because it independently reloads and compares that artifact,
but the current local design does not authenticate the approving actor against a hostile storage
administrator. That requires signed approval or authenticated durable storage in a later deployment
profile.

## 7. Package boundaries

```text
domain
   ^
planning  <--- repository facts/snapshot ports
   ^
persistence  (JSON approval and claim adapter)
   ^
CLI  (composition and JSON I/O only)
```

The planning package owns provider-neutral records and binder policy. Persistence owns filesystem
mechanics. The CLI wires Git and RepositoryGraph adapters. Provider, Jira, Pi, Docker, workspace, and
runtime types do not leak into these contracts.

## 8. What remains deferred

Stage 19 deliberately does not implement:

- `forge run`, status, resume, or cancel;
- automatic conversion to `StartRuntimeRunRequest`;
- authenticated external approval providers or signed approvals;
- distributed approval claiming;
- runtime worktree/agent/lease/model policy selection;
- cross-process runtime lease fencing;
- GitHub issue, webhook, PR, or Jira workflows.

The next stage should define a controlled runtime binding policy and application service that consumes
a verified `PlanExecutionIntent`, constructs the existing runtime request, persists the start, and
supports recovery without moving those choices into the CLI.
