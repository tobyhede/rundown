# 608 PR 12 — planning audit against PR 11 head

**Date:** 2026-08-01

**Status:** Preliminary planning record only. PR 11 is not merged. This file may
inform the post-merge PR 12 addendum, but it does not authorize an implementation
branch and does not supersede a later audit against merged `origin/main`.

**Read with:**

- `2026-07-23-608-controlled-rebuild.md`
- `2026-07-23-608-pr12-transactional-delegation-workflows.md`
- `2026-07-27-608-pr09-pr14-correction-ledger.md`

The correction ledger wins over the original PR 12 plan. This audit records the
additional drift introduced by PRs 10 and 11 and the design questions that must
be settled before PR 12's RED tests are written.

## Verified status

- PR 10 is merged as #668 at merge commit
  `1363724e7bb09409dcd9c334ef7789b31de408a7`.
- PR 11 is open as #669, non-draft and mergeable, at reviewed head
  `0d4971a0f8517cae9efbb24c49a17e16edc65f2d`.
- At this audit, Cloudflare Pages is green and CodeRabbit is pending. PR 11's
  final merge commit and final API surface are therefore not known.
- Tracker #648 is open but its top-level checklist is stale: it still names PR
  10 as next. The actual chain is 10 of 14 merged with PR 11 in progress.
- The root `main` checkout is stale and carries an unrelated
  `.serena/project.yml` edit. It is not a valid PR 12 branch source.

## Branch gate after PR 11 merges

Do not create the PR 12 implementation branch from this audit's detached
worktree, today's PR 11 head, PR 10's merge commit, or any salvage branch.

After #669 merges:

1. Fetch `origin/main`.
2. Record the #669 merge commit as `PR11_MERGE`.
3. Prove the final reviewed PR 11 head is an ancestor of `origin/main`.
4. Create the PR 12 branch from exactly `origin/main@PR11_MERGE`.
5. Prove `git merge-base PR12_HEAD origin/main` is `PR11_MERGE` before the first
   implementation commit.
6. Re-run the constructor, result-union, lock, and writer inventories below.
7. Write a new dated current-main addendum if the merged tree differs from this
   audit. Never edit this record to make it appear current.

## Binding corrections to the historical plan

The following historical PR 12 steps are already superseded:

- Do not introduce a structurally parallel `DelegationWorkflowResult<T>`.
  Reuse or derive from canonical `GuardedMutationResult<T>` and preserve each
  workflow's domain-specific variants.
- Multi-run workflows must also account for
  `aggregate_recovery_required`; they cannot pretend every ambiguous aggregate
  is the single-run `recovery_required` arm.
- Do not implement the linkage-cycle return, remove `OnLinkageCycle`, or repair
  collect ordering. PR #656 already landed those changes. Retain their tests as
  regression criteria and preserve byte-identical CLI rendering.
- Do not run the historical whole-file, unforced Stryker commands or delete the
  incremental report. Use `pnpm run test:mutate:changed`, then changed-line
  package-relative manual scopes with `--force` only when needed.
- Build core before CLI tests because CLI resolves `@rundown-org/core` through
  `dist`.
- The historical file allowlist is incomplete. Compiler/machine types, actors,
  the PR 11 runner, store/lease/result modules, construction seams, snapshots,
  and process fixtures are legitimate required surfaces.

## PR 11 facilities PR 12 must reuse

PR 11 establishes the execution and recovery protocol that PR 12 must extend,
not duplicate:

- `EffectfulActorMutationRunner.run` captures one exact state/authority pair,
  acquires execution ownership, prepares a non-persisting actor mutation, and
  commits through `RunbookStore.commitOwnedState`.
- `EffectfulActorMutationRunner.runAll` captures a dependency-ordered run set,
  supports optional external parents, uses
  `SqliteExecutionLeaseService.acquireAll`, and commits through one
  `RunbookStore.commitOwnedRunSet` transaction.
- `CoreEffectfulMutationExecutor.runAll` owns all-or-none acquisition,
  effect-start marking, pre-effect release, and abandonment to aggregate
  recovery.
- `RunbookStore.commitOwnedRunSet` classifies every member before the first
  write and can apply a pure session projection after all owned state writes.
- `RunbookCompletionService.prepareChildCompletion` and
  `prepareManualCompletion` provide pure completion decisions for aggregate
  preparation.
- `RunbookActorService.prepareActorMutation` is the non-persisting XState
  transition seam.
- `SessionService.claimAndInitialLink` remains the PR 10 primitive for atomic
  initial child claim plus machine-derived parent linkage. PR 12 must preserve
  it rather than reproduce its storage protocol.

## Current defects on the PR 11 head

### Delegate fresh issue

`RunbookLifecycleCommandService.issueDelegation` still:

1. resolves the anchor before locking;
2. acquires `DelegationLock`;
3. revalidates a presented claim before the decisive writes;
4. calls pure `createDelegation` outside the machine;
5. supersedes an old completion in one durable operation; and
6. persists the issued substep in another durable operation.

Claim removal or rotation after the revalidation can still authorize both
writes. A failure between completion supersession and parent-state persistence
can delete the prior result without issuing the replacement token.

The CLI still constructs `DelegationLock` and injects
`persistIssuedSubstep`. Both are frontend shadow ownership and must disappear
from the migrated path.

### Delegate retry

Retry still performs three durable operations after the pure retry decision:

1. release a terminal linked child from session targeting;
2. supersede the pending completion row; and
3. persist the replacement parent substep/token.

The current ordering correctly makes a refused release a no-op, but it is not a
transaction. A crash can release the child while the parent still names the old
delegation, or remove the old outcome without persisting the replacement.

The existing claim-race tests inject during `DelegationLock.acquire`. They
prove the pre-write narrowing only. They do not place removal, rotation, or
token replacement between exact authority capture and the decisive SQL commit.

### Collect

`collectDelegationOutcomes` still combines several independent persistence
boundaries:

- authorization and presenter-liveness recording;
- one persisted `sendAndSync` per resolved completion;
- terminal reload and session release;
- parent/inline propagation; and
- re-entry frontier projection and consumption.

`CompletionLock` and `DelegationLock` serialize only subsets of those records.
They do not exclude session claim mutation and must not be held while acquiring
the PR 11 SQLite run-set lease.

### Abort

Abort remains the clearest frontend shadow workflow. The CLI owns token scan,
`DelegationLock`, locked reread, authorization, pure `abortDelegation`, parent
`manager.update`, linked-child cleanup, and output sequencing.

`AbortCommandService` owns authorization only. Force cleanup then performs
child release, optional child deletion, completion recording/supersession, and
parent cancellation through separate durable operations.

## Architecture required for PR 12

Delegate, collect, and abort change lifecycle, substeps, results, and action
dispatch. Their behavior must be represented by typed machine events and
machine-owned per-step substates. Category B/C actors perform machine-owned side
effects; runtime services and callables enter through compile-time-bound
`invoke.input` closures, while persisted context contains data only.

Repository code may:

- validate captured authority, claim generation, state version, execution
  identity, and exact operation coordinates;
- atomically persist prepared machine-derived states, completion projections,
  attempt phases, and session projections; and
- return canonical typed persistence outcomes.

Repository code must not inspect `SubstepState` to decide delegation behavior,
map one action to another, choose retry semantics, or infer lifecycle changes.

## Design decisions required before RED

### 1. Write-free delegate outcomes

Strong echo, invalid locator, policy refusal, and other preconditions must remain
write-free. The current PR 11 runner marks an effect started and expects one
prepared state per active target; representing echo as an unchanged state write
would bump state/version and falsely create durable effect evidence.

Choose and document one typed protocol before implementation:

- a pre-effect preparation result that can return a domain outcome without
  acquiring/committing; or
- a narrowly named delegation workflow runner that separates replay-safe
  preparation from the exact effect/commit boundary.

Do not encode no-op as a successful state write.

### 2. Token mint and committed-but-unobserved recovery

Manual fresh/retry token mint currently happens during service computation. A
plaintext token cannot be reconstructed from the persisted hash. The design
must answer:

- whether mint is replay-safe preparation or crosses the effect boundary;
- how retry after a committed-but-unobserved response returns the exact same
  command outcome without minting another token; and
- how recovery avoids committing a parent snapshot whose caller can never
  receive its bearer token.

The chosen answer must be pinned at all three PR 11 crash boundaries.

### 3. Atomic force-abort deletion

Active force-abort currently deletes child run state. The SQLite schema cascades
run deletion into claims, completions, and `execution_attempts`. Deleting a child
owned by the PR 11 fence therefore removes the exact attempt row used to prove a
committed result and reconcile committed-but-unobserved retry.

Choose one recoverable protocol before implementation:

- retain a stopped/aborted child as terminal evidence and defer physical prune;
- add an explicit durable tombstone/workflow receipt whose execution identity
  survives child deletion; or
- add a repository-owned delete commit with equivalent exact-attempt proof.

Appending `deleteRun` after an owned commit is forbidden because it restores the
partial-write window PR 12 exists to remove.

### 4. Aggregate domain results

Define operation-specific unions before changing call sites:

- collection keeps its existing readiness/policy/result variants plus canonical
  single-run and aggregate transaction refusals;
- abort keeps token/policy/domain variants plus canonical transaction refusals;
- delegation keeps existing issuance/echo/conflict variants plus canonical
  transaction refusals.

Map `claim_superseded`, `concurrent_modification`,
`execution_in_progress`, `recovery_required`,
`aggregate_recovery_required`, and `missing` exhaustively in one core/frontend
boundary. Preserve JSON/text parity and never echo bearer secrets.

## Proposed implementation sequence after merge

### Task 0 — final base and inventory gate

- Branch only after #669 merges, using the branch gate above.
- Re-run exact production constructor and direct-writer inventories.
- Record the final changed-file allowlist in a new dated addendum.
- Run focused delegate/collect/abort tests as a green baseline.

### Task 1 — settle protocols and result surfaces

- Decide the write-free preparation, token recovery, and abort deletion
  protocols above.
- Reuse `GuardedMutationResult<T>` and aggregate recovery types.
- Narrow collection and abort result unions without changing existing wire
  behavior.
- Add JSON and `--text` characterization for every new transaction refusal.

### Task 2 — machine preparation and actor foundation

- Add typed manual issue, retry, collect, and abort events.
- Add transient per-leaf workflow substates and Category B/C actors.
- Route runtime resolvers through `invoke.input`; add snapshot tests proving no
  functions, services, store references, or `cwd` persist.
- Extend the PR 11 runner/store protocol only where the decided designs require
  it; keep repositories behavior-blind.

### Task 3 — abort vertical slice

- Move token revalidation, cancellation, child terminalization/deletion policy,
  stale-outcome supersession, parent report, and session release into one
  core-owned fenced workflow.
- Make the CLI parse/call/render only.
- Remove CLI `DelegationLock`, `manager.update`, direct `abortDelegation`, and
  lifecycle cleanup orchestration from this path.

Abort is first because it has the smallest domain result surface, but Task 3
must not start until the deletion protocol is decided.

### Task 4 — delegate fresh and retry

- Fresh issue: capture exact parent authority, prepare the machine-derived
  issuance, and atomically commit completion supersession plus parent token
  state.
- Retry without a linked child: use the same single-parent protocol.
- Retry with a terminal linked child: acquire the required parent/child set,
  prepare the parent retry, and atomically commit completion supersession,
  parent replacement, and child session release.
- Preserve PR 10 `claimAndInitialLink` unchanged and prove a newly issued token
  still claims/links atomically.
- Remove CLI/core `DelegationLock` persistence injection only after both paths
  are green.

### Task 5 — collect single-run and aggregate terminal paths

- Re-evaluate readiness, frame, and authorization gates against the exact
  captured state.
- Prepare all `APPLY_CURRENT_RESOLVED_COMPLETION` transitions in memory and
  commit the target once, including frontier consumption.
- For terminal collection, pre-walk the affected inline/delegating set, prepare
  every target/parent state, and commit states, reports, completions, and session
  releases through one `commitOwnedRunSet` transaction.
- Emit observations and render linkage-cycle/depth results only after commit.
- Preserve PR #656 result shapes and output byte-for-byte.

### Task 6 — remove migrated shadow seams

- Remove migrated `DelegationLock` / `CompletionLock` spans and unlocked helper
  variants only when no production caller remains.
- Remove CLI state/session writes for delegate, collect, and abort.
- Update lifecycle-seam and command constructors structurally; do not construct
  real core services from mocked modules in CLI tests.
- Leave unrelated residual locks for PR 13's audited production transition.

### Task 7 — full validation and review

- Run focused core suites after each slice.
- Run `pnpm run build` before focused CLI suites.
- Run all listed delegation scenarios and `pnpm run test:scenarios:all`.
- Run `pnpm run test:mutate:changed` per changed package; use
  `--related-tests` when integration coverage is the relevant question.
- Require non-zero instrumentation and disposition every in-scope Survived or
  NoCoverage mutant. Manual scopes are changed-line, package-relative, and
  forced.
- Run `pnpm run verify` immediately before every push.
- Perform the mandatory transaction-boundary/lock/shadow-write review before
  marking the PR ready.

## Deterministic evidence matrix

| Workflow | Required interleave or fault | Required invariant |
| --- | --- | --- |
| Delegate fresh | parent bearer removed or rotated after capture | no completion removal and no issued token/state |
| Delegate fresh race | two issuers target the same exact coordinate | one winner or contractually exact write-free echo; no orphan token |
| Delegate retry | old token replaced after scan/capture | replacement is never retried or overwritten |
| Delegate retry | terminal child release fault | child targeting, pending outcome, and parent token all unchanged |
| Delegate retry | concurrent collect at the old frontier | collect cannot consume a row between release/supersede/reissue |
| Collect | bearer removed/replaced after authorization | no completion drain, parent transition, release, or report |
| Collect | fault after each prepared completion | target state and completion rows remain wholly unchanged |
| Collect terminal | parent capture/commit refusal | child release and parent report both roll back |
| Abort | bearer removed/rotated after authorization | no cancellation, child mutation, release, or completion row |
| Abort | token or child link replaced after scan | newer delegation is untouched |
| Force abort | fault at child terminal/delete boundary | parent, child, claim/session, and outcome rows agree atomically |
| Every effectful workflow | claimed, effect-started, committed-unobserved crashes | exact recovery result; no repeated effect |

Add the planned process fixture and IPC barriers for overlapping fresh issues,
retries, collects, and aborts. Unit call-count assertions or races injected only
during domain-lock acquisition do not satisfy this matrix.

## Provisional file inventory

The final post-merge addendum must regenerate this inventory. Expected surfaces
include:

- Core workflow/services: `lifecycle-command-service.ts`,
  `collection-service.ts`, `completion-service.ts`,
  `abort-command-service.ts`, `actor-service.ts`, `compiler.ts`, machine/event
  types, and new actor files.
- Core transaction protocol: `effectful-actor-mutation-runner.ts`,
  `effectful-mutation-executor.ts`, `storage/execution-lease.ts`,
  `storage/runbook-store.ts`, `storage/mutation-result.ts`, and barrel exports.
- CLI: `commands/delegate.ts`, `commands/collect.ts`, `commands/abort.ts`, their
  construction seams, `helpers/runbook-pipeline.ts`,
  `helpers/delegation-completion.ts`, and result renderers actually changed.
- Tests: compiler/actor snapshots, workflow service suites, store/lease/runner
  suites, CLI JSON/text command suites, scenario regressions, and the new
  multi-record process fixture/protocol.

Unexpected production paths remain a stop-and-review event. The post-merge
addendum must explain every addition instead of silently widening scope.

## Stop conditions

Stop and raise the design question rather than implementing if:

- PR 11 changes after this audited head and the effectful runner/commit contract
  is materially different;
- write-free echo or committed-token recovery still relies on an unchanged
  state write or minting a replacement token;
- force-abort still requires an unfenced delete after the owned transaction;
- a repository method must inspect runbook substeps to choose behavior;
- a frontend retains a state/session write for a migrated workflow;
- a migrated domain lock must be held while waiting for a SQLite execution
  lease; or
- an aggregate workflow erases its domain-specific result variants.

