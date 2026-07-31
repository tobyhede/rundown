# 608 Controlled Rebuild — PR 10 current-main adaptations

**Amends:** [2026-07-23-608-pr10-atomic-claim-and-initial-link.md](2026-07-23-608-pr10-atomic-claim-and-initial-link.md).
That plan is write-once and unchanged; read it first, then apply the deltas below.
Where the two disagree, this addendum wins. It also applies the PR 10 section of
[2026-07-27-608-pr09-pr14-correction-ledger.md](2026-07-27-608-pr09-pr14-correction-ledger.md).

**Base:** `origin/main` at `03c11cfb3fbcf2ba76cf0bda71acfb87dc515337`
(PR 9, #667, merged). Branch:
`issue-608/pr10-atomic-claim-link`.

**Goal remains:** the first delegated-child claim and the machine-derived parent
link commit together or not at all, and the CLI performs no shadow parent-state
write.

This addendum is the immutable implementation and review inventory for PR 10.
Record later discoveries in a new addendum or the PR; do not rewrite this file.

## Delta 1 — do not replay the salvage architecture

The six salvage commits remain evidence only:

```text
0789b22d9 1cd2b38c0 56a23d4be 0066a614d 88ec8a832 0bf8674ab
```

Do not cherry-pick them. A current-main three-way audit found conflicts in the
completion, session, driver-contract, property, store, guarded-parent, and CLI
claim suites. More importantly, `1cd2b38c0` and `0066a614d` put runbook behavior
in `RunbookStore`: the store located a `SubstepState`, chose the delegation
transition, rewrote `substepStates`, and patched `snapshot.context`. That design
is superseded even where its patch applies textually.

Selective salvage rules:

- Port behavioral invariants, not implementation structure: all-or-none commit,
  idempotence, terminal evidence, parent deletion, exact-coordinate rollback,
  and exactly one invalidation-generation bump.
- Reuse current-main classifier, execution-identity, linkage-version, typed
  refusal, and terminal-claim fixtures. Do not duplicate `0bf8674ab` coverage
  already present under `classifyCommitRow delegated-parent liveness` and
  `classifyCommitRow execution identity`.
- Preserve `parent-concurrent-modification` semantically as the canonical
  `concurrent_modification` transaction result. Never collapse it into
  `delegation-already-claimed`.
- Never use `SELECT claim_generation ... ?? 0`. A missing child is a typed
  refusal and no claim row is inserted.

## Delta 2 — corrected ownership and data flow

The state machine owns the link transition. Storage owns only validation and
atomic persistence.

```text
claimAndLaunch
  -> core actor service derives next parent snapshot with a typed machine event
  -> SessionService.claimAndInitialLink receives validated data
  -> one RunbookStore transaction rechecks authority/CAS
  -> transaction persists supplied parent state/snapshot + initial child claim
```

The implementation must have these boundaries:

1. **Typed XState transition.** Add a typed event for linking the initial
   delegated child at an exact parent step id, frame key, entry, and token hash.
   The transition updates the matching delegation in machine context and no
   other same-id/different-frame or same-frame/different-id entry. The machine,
   not SQL or the CLI, produces the next parent snapshot.
2. **Read-only derivation seam.** `RunbookActorService` reconstructs the parent
   actor with its normal compile-time runtime dependencies, sends the typed
   event in memory, and returns the next persistable parent state/snapshot plus
   the captured base version required for CAS. Derivation does not independently
   persist the parent.
3. **Atomic session mutation.** `SessionService.claimAndInitialLink` accepts the
   child id, exact delegation linkage, and machine-derived parent state/snapshot.
   It delegates one short transaction to the store. The transaction validates
   the child exists, the parent and delegation coordinates remain live, the
   captured parent state/linkage version still matches, and the initial claim is
   still admissible. It then inserts the claim and persists the supplied parent
   state/snapshot together.
4. **Typed persistence only.** `RunbookStore` may compare ids, versions,
   lifecycle, claim state, and linkage coordinates. It must not import or inspect
   `SubstepState`, select an XState event, change lifecycle, derive a transition,
   rewrite `substepStates`, or patch snapshot context. It returns the canonical
   `GuardedMutationResult<T>`/existing aliases and exact domain outcomes.
5. **Frontend cleanup.** `claimAndLaunch` uses the derivation seam and calls the
   atomic session operation once for orphan adoption, an existing unlinked
   session claim, and a fresh child. Delete
   `updateStepDelegationChildRunId` and every `manager.update` shadow link/clear.
   Launch cleanup uses the exact-coordinate core rollback operation; it never
   reconstructs a parent patch in the CLI.

If current XState synchronization makes step 2 require a small Category B actor,
place it under `packages/core/src/runbook/actors/` with typed data-only input and
output. Runtime references must enter through the compiler's `invoke.input`
closure or actor-service construction, never through persisted context.

## Delta 3 — persistence invariants

The decisive store transaction must prove all of the following:

- claim insertion and the supplied parent snapshot are all-or-none;
- the child run exists before insertion;
- missing child, missing parent, terminal parent, removed/reissued delegation,
  wrong step/frame/entry/token, occupied link, and stale state/linkage version
  perform no write;
- identical replay is idempotent and does not rotate the bearer or increment the
  child generation;
- a different child in the link slot is `concurrent_modification`;
- rollback matches child, parent, step, frame, entry, and token, so a stale
  cleanup cannot remove a newer claim or clear a newer link;
- terminal children remain resolvable as terminal evidence;
- retry/token replacement, cancellation, parent deletion/terminalization, and
  unrelated parent cursor/substep advance supersede mutation authority;
- each logical invalidation bumps generation exactly once.

SQLite `SCHEMA_VERSION` may move from 2 to 3 only if the database shape changes.
Do not bump it merely for changed transaction behavior. Persisted
`RunbookState.schemaVersion` remains exactly 1; add no migration, hydration,
fallback parser, or compatibility shim.

## Delta 4 — runtime-reference proof

Add a serialization test for this path, not only for command execution. After
deriving and persisting an initial link, serialize both persisted state and
snapshot and prove they contain data only:

- no function values;
- no store, state-manager, session-service, or actor-service instance;
- no resolver/helper callable;
- no process-local `cwd`;
- no actor reference.

The assertion should inspect values recursively where practical; a string-only
name check is supplementary evidence, not the sole proof. Re-open the run from
the persisted snapshot and assert the exact child link remains present.

## Delta 5 — review file inventory

The old plan's allowlist is expanded for the corrected architecture. Every
changed path must be in this inventory. A listed path is permission to change it
when required, not a requirement to touch it.

### Production core

- `packages/core/src/runbook/compiler.ts`
- `packages/core/src/runbook/actor-service.ts`
- `packages/core/src/runbook/types.ts`
- `packages/core/src/runbook/claim-id.ts`
- `packages/core/src/runbook/session-service.ts`
- `packages/core/src/runbook/index.ts`
- `packages/core/src/runbook/actors/*delegation*.ts` — only a focused new or
  amended actor required by the final machine wiring
- `packages/core/src/runbook/storage/mutation-result.ts`
- `packages/core/src/runbook/storage/runbook-store.ts`
- `packages/core/src/runbook/storage/schema.ts` — only if database shape changes

### Production CLI

- `packages/cli/src/helpers/runbook-pipeline.ts`

### Core tests

- `packages/core/__tests__/runbook/compiler.test.ts`
- `packages/core/__tests__/runbook/actor-service.test.ts`
- `packages/core/__tests__/runbook/actors/*delegation*.test.ts`
- `packages/core/__tests__/runbook/session-service.test.ts`
- `packages/core/__tests__/runbook/completion-service.test.ts`
- `packages/core/__tests__/runbook/storage/runbook-store.test.ts`
- `packages/core/__tests__/runbook/storage/runbook-store.properties.test.ts`
- `packages/core/__tests__/runbook/storage/driver-contract.test.ts`
- `packages/core/__tests__/runbook/storage/delegated-claim-invalidation.integration.test.ts`
- `packages/core/__tests__/runbook/storage/delegated-parent-authority.test.ts`
- `packages/core/__tests__/runbook/storage/guarded-parent-advance.test.ts`

### CLI tests and scenario fixture

- `packages/cli/__tests__/helpers/claim-and-launch.test.ts`
- `packages/cli/__tests__/helpers/runbook-pipeline.test.ts`
- `runbooks/delegation/delegate-claim-superseded.runbook.md`

### Plan/tracking

- `docs/superpowers/plans/2026-07-30-608-pr10-addendum-current-main-adaptations.md`

Adding another path is a stop-and-review event. Document why the architecture
requires it before editing that path.

## Delta 6 — revised implementation sequence

- [ ] Inventory the current compiler event union, delegation actions,
      actor-service snapshot synchronization, `SessionService` claim entry
      points, and every CLI parent-link write.
- [ ] Add RED machine tests for exact-coordinate linking and data-only persisted
      context.
- [ ] Implement the typed machine transition and read-only actor-service
      derivation seam.
- [ ] Add RED store/session tests for all-or-none persistence, child-missing,
      stale CAS/linkage, occupied link, replay, terminal evidence, and exact
      rollback.
- [ ] Implement the short transaction using the canonical guarded result type.
      Keep all runbook interpretation above storage.
- [ ] Adapt `claimAndLaunch` for already-linked, orphan, existing-session, and
      fresh-child paths; remove every shadow parent write.
- [ ] Port only the still-relevant salvage regressions: invalidation paths,
      parent deletion, terminal retention, and single generation bump.
- [ ] Run focused core tests.
- [ ] Build core before running CLI tests.
- [ ] Run changed-scope mutation testing and resolve every in-scope survivor or
      `NoCoverage` mutant.
- [ ] Run the full pre-PR gate.

## Delta 7 — focused test gates

Core machine and transaction tests:

```bash
pnpm --filter @rundown-org/core exec jest \
  __tests__/runbook/compiler.test.ts \
  __tests__/runbook/actor-service.test.ts \
  __tests__/runbook/session-service.test.ts \
  __tests__/runbook/completion-service.test.ts \
  __tests__/runbook/storage/runbook-store.test.ts \
  __tests__/runbook/storage/runbook-store.properties.test.ts \
  __tests__/runbook/storage/delegated-claim-invalidation.integration.test.ts \
  __tests__/runbook/storage/delegated-parent-authority.test.ts \
  __tests__/runbook/storage/guarded-parent-advance.test.ts
```

Include the focused actor test path in that command if one is created. Include
`driver-contract.test.ts` when the SQLite schema changes.

Build before CLI GREEN:

```bash
pnpm run build
pnpm --filter @rundown-org/cli exec jest \
  __tests__/helpers/claim-and-launch.test.ts \
  __tests__/helpers/runbook-pipeline.test.ts
```

The CLI assertions must prove the atomic operation is called exactly once and
`manager.update` is not used to link or clear the parent. Initialization failure
must roll back by exact coordinates, delete the fresh child, and never start the
execution loop.

## Delta 8 — mutation and final gates

The historical whole-file Stryker command is forbidden. Run repository policy
first:

```bash
pnpm run test:mutate:changed --package core
```

If CLI source changes are included in the final diff, also run:

```bash
pnpm run test:mutate:changed --package cli
```

Use `--related-tests` when the dedicated-test tier reports a survivor whose
behavior crosses the machine/service/store seam. A manual campaign is permitted
only for a scope the diff cannot express: use package-relative changed-line
ranges, the dedicated tests, and `--force`. Confirm non-zero instrumentation and
record every in-scope `Survived` and `NoCoverage` mutant. Never judge this slice
by aggregate percentage.

Final gate:

```bash
pnpm run verify
```

`verify` must pass immediately before push. All GitHub checks must be green
before merge.

## Mandatory review checkpoint

Before opening PR 10, review the final diff against these questions:

- Is the next parent snapshot produced only by XState?
- Does storage accept machine-derived data without interpreting runbook state?
- Can any failure persist only the claim or only the link?
- Is missing child a typed no-write refusal?
- Does occupied-link CAS remain `concurrent_modification`?
- Are terminal evidence and exactly-one generation bump preserved?
- Can stale rollback affect a replacement token or child?
- Does the CLI contain zero shadow parent link/clear writes?
- Does persisted context contain data only?
- Were core build ordering, changed-scope mutation, and `pnpm run verify`
  recorded in the PR evidence?

PR 10 supplies only the atomic initial claim/link primitive. Delegate fresh/retry
row races, parent-claim revocation interleaves, and aggregate delegate workflow
transactions remain PR 12 work.
