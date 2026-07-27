# 608 remaining-plan correction ledger — PR 9 through PR 14

**Amends:** the write-once plans for [PR 9](2026-07-23-608-pr09-typed-session-refusals.md), [PR 10](2026-07-23-608-pr10-atomic-claim-and-initial-link.md), [PR 11](2026-07-23-608-pr11-lifecycle-execution-fencing.md), [PR 12](2026-07-23-608-pr12-transactional-delegation-workflows.md), [PR 13](2026-07-23-608-pr13-single-store-cutover.md), and [PR 14](2026-07-23-608-pr14-webcontainer-schemas-docs-release.md). Read the relevant dated plan first, then this ledger. Where they disagree, this ledger wins until a PR-specific addendum supersedes it.

**Tracked in:** [#648](https://github.com/tobyhede/rundown/issues/648).

**Status at audit:** PRs 1–7 are merged. PR 7 is #655 at `c51ff24f39db0012b4ab26bb9bfbca973ad30d7e`. PR #656 separately landed linkage-cycle trip return and removed `OnLinkageCycle` before PR 12.

## Sequence

The dependency sequence remains:

```text
PR 8 → PR 9 → PR 10 → PR 11 → PR 12 → PR 13 → PR 14
```

Keep implementation PRs serial. Test design, inventories, and PR-specific addendum drafting may happen in parallel, but no later implementation branch may become an independent merge candidate.

## Global corrections for PR 9–14

### Mutation testing

Every historical whole-file Stryker command in these plans is superseded by current repository policy. Use this first:

```bash
pnpm run test:mutate:changed
```

Optionally narrow with `--package core` or `--package cli`, and use `--related-tests` when the broader question is required. A manual source scope must use package-relative changed-line ranges and `--force`. Unscoped mutation, large whole-file campaigns, and zero-instrumentation success are forbidden. Record in-scope survivors and `NoCoverage` mutants rather than treating aggregate percentage as the decision.

PR 14 must not run the historical unscoped eight-hour `pnpm run test:mutate` command.

### Build ordering

After a PR changes core behavior, types, or exports, run:

```bash
pnpm run build
```

before CLI tests that resolve `@rundown-org/core` through `dist`. PR 9, PR 10, PR 12, PR 13, and PR 14 must add this ordering explicitly; PR 11 must build before, not after, its CLI GREEN run.

### Result and wire-code ownership

- Reuse or alias the canonical `GuardedMutationResult<T>` in `packages/core/src/runbook/storage/mutation-result.ts`; do not create parallel unions with the same transaction-level meaning.
- Internal discriminants remain lowercase snake case or the existing internal spelling.
- Public CLI symbolic codes are uppercase `SCREAMING_SNAKE_CASE` and belong in `CLISymbolicErrorCodeValues`.
- `RundownErrorCodeValues` contains RD-NNN factory codes; do not add lowercase result names to it.
- Register a public code in the first PR that can emit it. PR 9 owns `EXECUTION_IN_PROGRESS` and `RECOVERY_REQUIRED`. PR 11 owns `CLAIM_SUPERSEDED` and `CONCURRENT_MODIFICATION` if that is their first public emission.
- Map missing runs contextually to an existing code such as `RUN_TARGET_UNAVAILABLE`, `CLAIMED_RUNBOOK_UNAVAILABLE`, or `NO_ACTIVE_RUNBOOK`. If a post-resolution disappearance requires a new contract, define a precise uppercase code such as `RUN_STATE_MISSING`; never emit generic lowercase `missing`.

### Evidence quality

Every affected mutation path needs a deterministic claim removal or rotation interleave between capture and decisive commit. Static result mapping and happy-path process overlap are not substitutes.

## PR 9 corrections — typed refusals and claim-aware stash

Keep the dated plan's uppercase wire codes and reject the salvage helper's lowercase wire values. Register both codes and their JSON schema coverage in PR 9 rather than deferring schema validity to PR 14.

Add atomic claim-aware stash to PR 9:

- pass the presented claim lookup key and captured generation/authority into core;
- verify that exact bearer inside the same SQLite transaction that changes the stash slot/session targeting;
- refuse a rotated, removed, superseded, or mismatched bearer with a typed result;
- retain the existing bare/non-claim stash behavior;
- add a deterministic rotation interleave where the old bearer resolves, a replacement is minted for the same run, and the old bearer then attempts to stash.

This closes the gap explicitly documented in #608 as “safe by coverage, not by design.” If implementation proves it cannot fit PR 9 without obscuring the typed-refusal slice, stop and split a linked blocking issue; #608 must then narrow its closure guarantee explicitly.

## PR 10 corrections — machine-derived atomic initial linkage

Do not replay `1cd2b38c0`'s architecture as written. `RunbookStore` must not inspect `SubstepState`, decide delegation transitions, rewrite `substepStates`, or patch persisted XState context.

The corrected flow is:

1. A typed XState event/transition computes the next parent snapshot.
2. A core-owned actor/service supplies runtime dependencies through constructor or `invoke.input` closures.
3. One store transaction validates captured authority/CAS and persists the machine-derived parent snapshot plus the initial child claim.
4. The store reports typed persistence outcomes but does not interpret runbook behavior.

Expand the allowlist to the compiler, machine types, actor service, new or amended actor files under `packages/core/src/runbook/actors/`, snapshot tests, and the required CLI wiring/test files.

Do not use `SELECT claim_generation … ?? 0`. A missing child is a typed refusal and no claim insertion is attempted. Preserve `parent-concurrent-modification` as `concurrent_modification`; do not map it to `delegation-already-claimed`.

The SQLite schema may advance from version 2 to version 3 when the database shape changes. That is distinct from persisted `RunbookState.schemaVersion`, which remains exactly `1` and is never migrated or hydrated.

Add tests proving persisted machine context contains data only: no functions, store/service instances, or process-local `cwd`.

## PR 11 corrections — lifecycle fencing

Expand the file list to every construction and wiring surface, including `packages/cli/src/helpers/lifecycle-seam-factory.ts` or its then-current replacement. Inventory constructors immediately before implementation rather than assuming the dated list is complete.

Replace the impossible “after commit/before clear” crash boundary. `commitOwnedState` writes the next state and clears ownership in one SQL statement/transaction. Test the real boundaries:

1. crash after `claimed`, before the effect starts;
2. crash after `effect_started`, before the transaction commits;
3. the database transaction commits, then the process dies before the caller observes or returns the result.

The third boundary must prove retry observes the durable committed attempt and does not repeat the effect.

Do not prove five workflows with two concurrent `pass` processes. Cover each distinct effect class across pass, fail, goto, complete, and stop, including claim-authenticated and bare parent forms. Complete and stop may traverse multiple runs; define either an aggregate run-set lease/commit protocol or an explicit resumable cleanup workflow for terminal propagation, session release, and completion reporting.

Map every `ExecutionRecoveryService.recover()` outcome exhaustively: `recovered`, `missing`, `not_pending`, and `superseded`. Do not assert that every recovery request succeeds.

## PR 12 corrections — XState-owned transactional delegation workflows

The dated allowlist is incomplete. Add, as required by the final design:

- `packages/core/src/runbook/storage/runbook-store.ts`;
- `packages/core/src/runbook/storage/execution-lease.ts`;
- the canonical mutation-result module;
- compiler and machine type files;
- Category B/C actor files under `packages/core/src/runbook/actors/`;
- construction/wiring files and snapshot tests.

Delegate, collect, and abort change lifecycle, substeps, results, and action dispatch. Represent that behavior with typed machine events and per-step substates. Category B/C side effects execute through core actors; runtime references flow through `invoke.input`, while persisted context contains data only. Repository methods atomically persist validated machine-derived data and do not decide lifecycle behavior.

Reuse `SqliteExecutionLeaseService.acquireAll` and the canonical `GuardedMutationResult<T>`. Define the aggregate lease/commit or recoverable protocol for multi-run workflows before implementation.

PR #656 already returns the linkage-cycle trip, removes `OnLinkageCycle`, preserves CLI rendering, and fixes collect ordering. Remove those implementation steps from PR 12 and retain their tests as regression criteria. Do not redeclare or reshape the merged propagation result.

Add deterministic interleaves for collect, abort, delegate fresh, and delegate retry, including claim removal, token replacement, and parent-claim revocation between capture and commit.

## PR 13 corrections — one opener and precise legacy removal

Do not introduce a standalone opener that bypasses `storage/store-registry.ts`. Put legacy-state refusal before database creation in the registry's sole authoritative open path, and add `store-registry.ts` plus its tests to the file allowlist.

Generate the production and test constructor inventories immediately before implementation. Assert one registry/store graph per project and explicitly list permitted test fixtures.

Replace the broad residual search. Legitimate references remain:

- plugin-local `PluginSessionLock`;
- `.rundown/runs/<id>/outputs` artifact directories;
- explicit legacy-refusal fixtures.

Search instead for exact deleted core domain-lock imports/types and legacy JSON authority reads/writes. The gate must distinguish execution authority from plugin locking and output storage.

Assign `statePath` removal once. If PR 13 owns it, update the event types, schemas, CLI renderers, snapshots, tests, and docs together; PR 14 then verifies parity rather than repairing an intermediate broken contract.

## PR 14 corrections — release proof, not speculative repair

Do not assume the built snapshot lacks sql.js. The current snapshot builder already installs the dependency graph, locates sql.js, prunes unused variants, and fails if the runtime is absent.

Retain a real offline proof that opens the built snapshot and exercises the JS/WASM runtime through run, pass, fail, and goto. Inspect the produced snapshot before choosing any implementation change. The awaited probe output drain is already on `main`; preserve or add an adapted regression test rather than reimplementing it.

Audit symbolic error-code and schema parity after earlier PRs registered their own codes. Do not add lowercase result discriminants to either public code registry.

Release evidence includes `pnpm run verify`, the appropriate complete test/scenario gates, changed-scope mutation evidence, WebContainer/offline snapshot proof, schema validation, documentation parity, and the seven-path traceability matrix below. It excludes the forbidden unscoped mutation campaign.

## Seven-path closure matrix

| Original path | Closing PR | Required deterministic evidence |
| --- | --- | --- |
| `goto` | PR 11 | Claim rotation/removal between capture and guarded commit; no effect or state commit under stale authority. |
| `collect` | PR 12 | Bearer revocation between authorization and aggregate commit; no partial completion drain, claim update, or parent transition. |
| `pass` / `fail --claim-id` | PR 11 | Both commands, with removal and replacement interleaves; exactly one effect/commit. |
| `complete` / `stop --claim-id` | PR 11 | Terminal cascades under multi-run ownership; no partial release/reporting and no repeated effect after committed-but-unobserved return. |
| `abort` | PR 12 | Claim removal/rotation during the transaction window; no partial child/parent/session mutation. |
| `delegate` fresh/retry | PR 12, using PR 10 | Initial claim/link atomicity plus retry token replacement and parent-claim revocation interleaves. |
| Bare/`--run` pass/fail | PR 7 + PR 11 | PR 7's decisive open-child guard remains; PR 11 adds execution fencing and captured-generation CAS proof. |

PR 10 supplies the atomic initial claim/link primitive; it does not replace PR 12's delegate-row race tests.

## Required tracking outside the 14-PR chain

File a separate nonblocking issue to make transaction-local delegation liveness checks semantically equivalent to `classifyDelegationLiveness`, including cursor, cancellation, token replacement, frame-entry identity, missing-substep, and terminal cases. This is correctness work, but the current divergence is refusal-biased and does not permit stale mutation authority.
