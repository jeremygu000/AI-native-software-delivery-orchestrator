# Durable Plan Artifact

This guide explains why a valid plan still cannot be executed safely until it is tied to an exact
repository state and stored as immutable evidence.

## 1. The problem: a correct plan can become stale

Suppose planning analyzes commit `abc123` and decides that two tasks can run in parallel. Ten minutes
later someone edits a package manifest, moves a file, or pulls commit `def456`. The old plan still
looks valid as JSON, but its impact and conflict conclusions describe a repository that no longer
exists.

```text
Repository at planning time          Repository at run time
---------------------------          ----------------------
HEAD abc123                           HEAD def456
file A -> file B                      file A -> file C
tasks A and B are independent         tasks A and B overlap

             old plan must not cross this boundary
```

Stage 18 solves the identity and durability part of this problem. It does not yet approve or execute
the artifact.

## 2. Prepared plan versus durable artifact

`PreparedOrchestrationPlan` remains an in-memory result used during the bounded Planner/Reviewer loop.
It contains Sets and has no durable repository identity.

`PlanArtifact` is the immutable, JSON-safe decision record:

```text
PreparedOrchestrationPlan
          +
Planning source
          +
Git repository snapshot
          +
Repository Facts fingerprint
          +
Policy fingerprints
          |
          v
   createPlanArtifact()
          |
          v
 immutable PlanArtifact revision
```

Keeping these concepts separate prevents “the Planner returned it” from becoming execution authority.

## 3. What the repository snapshot proves

The snapshot has five important fields:

```text
repositoryId             identifies the origin repository (or local root fallback)
repositoryRoot           canonical real filesystem root
baseCommit               committed Git base
workingTreeFingerprint   current tracked + untracked non-ignored content
dirty                    whether Git reports working-tree changes
```

`baseCommit` alone is insufficient. Two worktrees may have the same `HEAD` while one contains an
uncommitted edit. The working-tree fingerprint hashes paths, filesystem mode, entry kind, and bytes.
For a symlink, it hashes the link text rather than following the target.

Ignored cache/build files are intentionally excluded. They are not Git source state. If an ignored
file is intentionally indexed by the repository analyzer, its resulting Repository Facts still affect
the separate facts fingerprint.

## 4. Avoiding a mixed-state analysis

Reading a repository takes time. A file could change while TypeScript analysis is running. The CLI
therefore brackets analysis with two snapshots:

```text
snapshot A
    |
    v
RepositoryGraph analysis
    |
    v
snapshot B
    |
    +-- A == B --> artifact may be created
    |
    +-- A != B --> fail: retry planning
```

This is change detection, not a filesystem lock. A future product workflow should prefer an
orchestrator-owned immutable checkout for even stronger isolation.

## 5. Repository Facts fingerprint

The artifact normalizes and hashes:

- project identities, roots, manifests, dependencies, scripts, source roots, and tsconfigs;
- project dependency edges and their evidence sources;
- files and symbols;
- file dependencies and symbol references;
- repository diagnostics.

Maps and unordered collections are sorted with locale-independent comparison before hashing. The same
facts inserted into a Map in a different order therefore produce the same fingerprint.

## 6. Policy fingerprints

A plan can change even when source code does not. For example, changing a shared resource from
`ordered` to `exclusive` changes scheduling authority. Stage 18 therefore binds:

- the normalized shared-resource policy;
- the autonomous verification policy version/rules.

The artifact stores their fingerprints, not provider or Pi types.

## 7. Cross-record validation

Schema validation checks more than field types:

```text
Task IDs
  |-- exactly one predicted impact per task
  |-- exactly one execution-wave occurrence per task
  |-- every conflict endpoint must exist
  `-- every semantic-review citation must exist

hardConflicts -> hard only
riskConflicts -> none/soft only
wave indices  -> 0, 1, 2, ...
set-like JSON arrays -> sorted and unique
```

This prevents structurally valid JSON from hiding a broken plan relationship.

## 8. Fingerprint and integrity

`planFingerprint` covers the complete payload, including artifact ID, revision, creation time, source,
repository binding, policy fingerprints, tasks, impacts, conflicts, schedule, and semantic evidence.

Changing one field without recomputing the fingerprint fails parsing. This detects corruption and
accidental mutation. It is not a digital signature: a malicious writer with filesystem access could
replace both content and hash. Immutable storage and future approval/audit controls provide the next
layers.

## 9. Immutable file storage

By default `forge plan` stores:

```text
~/.forge/plans/<repository-id>/<artifact-id>.r1.json
```

The file adapter writes a unique temporary file and publishes it using an atomic hard link:

```text
temporary file --link--> final immutable revision
      |
      `-- removed after publish
```

If another process already published identical content, save is an idempotent success. Different
content under the same artifact ID and revision is rejected.

Use `--plan-directory <path>` to choose another artifact directory. The destination must remain
outside the analyzed repository; otherwise writing the artifact would invalidate its own snapshot.
Existing symlink ancestors are resolved before this boundary check. Save performs confinement checks
before directory creation, after directory creation, and immediately before the temporary-file write,
so replacing a previously missing ancestor with an in-repository symlink fails closed before
publication. If publication already has a primary error, a later temporary-file cleanup failure does
not hide that primary error. If cleanup is the only failure, it remains visible to the caller.

## 10. What Stage 18 does not authorize

A PlanArtifact still cannot:

- approve itself;
- create a run;
- create worktrees;
- acquire leases;
- dispatch agents;
- run verification;
- integrate Git work.

The next stage must create an approval record that references the exact artifact ID, revision, and
`planFingerprint`, then bind a still-matching repository snapshot into a canonical runtime request.

## 11. Current limitations

- Snapshot capture is local Git/filesystem infrastructure, not a distributed lock.
- Ignored arbitrary files are not hashed as source bytes. Repositories containing Git submodules fail
  closed until nested working-tree fingerprinting is implemented.
- Paths that collide after Unicode NFD normalization and lowercase conversion fail closed for portable
  identity. This is deliberately not described as full Unicode case folding.
- Origin URL provides cross-clone repository identity. Without an origin, identity falls back to the
  real local root, so clones at different paths intentionally receive different repository IDs.
- Equivalent SSH and HTTPS origin spellings are not normalized and therefore intentionally receive
  different fail-closed IDs. Distributed workers will need a provider-neutral canonical remote
  identity policy.
- Artifact files are immutable by application behavior, not protected from an OS-level administrator.
- Pathname rechecks mitigate ordinary symlink races but are not atomic directory-descriptor
  confinement against a hostile local process. That is outside the current single-user threat model.
- Fingerprints are content identities, not signatures.
- `repositoryBindingMismatches` is implemented and tested but has no production caller in Stage 18.
  Stage 19's `PlanExecutionBinder` must reject any `repositoryId`, `baseCommit`,
  `workingTreeFingerprint`, or `factsFingerprint` mismatch before creating a runtime request. Human
  approval and that mandatory binder call site remain Stage 19.
