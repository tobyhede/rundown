# 608 PR 7 addendum — adaptations to current `main`

**Amends:** [2026-07-23-608-pr07-atomic-parent-advance.md](2026-07-23-608-pr07-atomic-parent-advance.md). That plan is write-once and unchanged; read it first, then apply the deltas below. Where the two disagree, this file wins.

**Tracked in:** [#648](https://github.com/tobyhede/rundown/issues/648).

**Why this exists:** PR 7's plan was written against the salvage history, where `0f896b8b6` sits directly on top of PR 6's `68bdbf62c`. PR 6 (#652) did not land as a pure replay — five conflict resolutions, the R2 terminal-retention correction, and nine review-driven deltas — so the six owned commits no longer apply verbatim. A full trial replay of `0f896b8b6 03d9144a1 63f469945 e21dab179 ee650ce7c 70a7082ec` onto #652's head (`97c124d98`) produced **six conflict hunks across five files and zero failing tests**.

Compared with PR 6 this is an easy replay: every conflict is a mechanical union, no owned commit inverts a `main` assertion that must be restored, and no production behaviour needed correcting to make the suites green. The substantive work is not in the replay — it is in Delta 5, a coverage hole the replay cannot reveal because every suite passes with the branch deleted.

**Base.** PR 7 branches from `origin/main` *after* #652 merges. This trial used #652's head (`97c124d98`). At trial time `origin/main` was `b848967ec` (the #650 merge), which #652 does not contain; `git diff 97c124d98...b848967ec` touches only `execution-lease*` paths, disjoint from PR 7's 13-path allowlist, so the eventual merge commit changes nothing below. Re-derive the SHA at branch time.

## Delta 1 — six conflict hunks, all mechanical unions

| Commit | File | Hunk | Resolution |
| --- | --- | --- | --- |
| `0f896b8b6` | `core/src/runbook/storage/runbook-store.ts` | import block | Union. `HEAD` carries `assertDelegationTokenHash`, `getErrorMessage`, `logger`, and `{ assertFrameKey, classifyDelegationLiveness }` from `targeting.js` (PR 5 / PR 6); the incoming side adds `findSubstepState` and `linkageMatchesClaim` to that same specifier. Merge into one multi-line import. |
| `0f896b8b6` | same | `mutateState` TSDoc | Union. Keep `HEAD`'s `@param build` / `@param options.attempts` wording (PR 4 added the per-attempt side-effect constraint); add the incoming `@param options.guard` and widen `@param options` to "attempt budget (default 8) and parent-advance guard". Taking the incoming side whole drops the retry side-effect warning. |
| `03d9144a1` | `core/src/runbook/state.ts` | type-import list | Union. `HEAD` imports `PresentedClaim`; incoming adds `ParentAdvanceGuard`. Keep both. |
| `e21dab179` | `core/src/runbook/session-service.ts` | import block | Union, with a type→value promotion. `HEAD` has `import type { SessionMutationTxn }` plus `import type { SyncWork }` (PR 5). Incoming needs the *values* `parentAdvanceGuard` and `isOpenDelegatedChildrenError`, so the store import becomes a value import carrying `type ParentAdvanceGuard, type SessionMutationTxn`; the `SyncWork` type import stays as its own line. |
| `e21dab179` | `core/__tests__/runbook/lifecycle-command-service.test.ts` | helper import | Union. `HEAD` imports `patchPersistedClaim` from `src/testing/session-fixtures.js` (PR 6's fixture promotion); incoming adds `seedLiveDelegation` to the `claim-test-helpers.js` specifier. Keep both. |
| `ee650ce7c` | `core/__tests__/runbook/session-service.process.test.ts` | helper block | Additive, not competing. `HEAD` defines `expectOverlap` (the sensitivity witness); the incoming side defines `childExit`, `collect`, and `waitForFile`. Keep all four — the sides collide only because both append at the same offset. |

After resolution: `git diff --name-only --diff-filter=U` empty, `git diff --check <recorded-base>` exit 0, and `comm -3` reports exactly one addition against the 13 derived paths — `cspell-dictionary.txt` (Delta 2) — with zero allowlisted-but-unchanged. Name the base in both commands: at this point the cherry-picks are `--no-commit`, so the work is **staged**, and a bare `git diff --check` / `git diff --name-only` inspects unstaged changes only and reports a false clean. `tsc --noEmit` on `@rundown-org/core` is clean with no further edits — PR 4's and PR 6's `SqlReadTransaction` widening problem does not recur here.

## Delta 2 — `cspell-dictionary.txt` allowlist expansion (stop-and-review)

`verify` fails at `check:spell` on work the replay itself brings in:

```text
packages/core/__tests__/runbook/lifecycle-command-service.test.ts:2299:42 - Unknown word (aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac)
packages/core/__tests__/runbook/lifecycle-command-service.test.ts:2340:42 - Unknown word (aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad)
```

`e21dab179`'s two production-path regression tests mint child run ids `rd_a{31}c` and `rd_a{31}d`. `cspell-dictionary.txt` already carries `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab` from an earlier PR that hit the same wall, so appending the two literals is the established remedy; the file is append-ordered, not sorted. Same class as PR 6's Delta 6. The path is **not** in PR 7's derived allowlist, so `comm -3` reports it — expected, and recorded here rather than added silently.

## Delta 3 — the plan's scoped Stryker command needs replacing

Two independent problems, both fatal to the gate as written.

**1. Whole-file `--mutate` on `runbook-store.ts` does not finish.** The plan asks for `--mutate 'src/runbook/storage/runbook-store.ts,src/runbook/state.ts'`. `runbook-store.ts` is now 2006 lines. `CLAUDE.md` — updated *after* this plan was written — records the measurement directly: "`runbook-store.ts` is ~1450 lines, so mutating it whole to cover a ~280-line change ran 17+ minutes without finishing", and instructs scoping to changed lines via `file:start-end`. It is longer now, and PR 7's change to it is ~140 lines.

**2. The scope misses five of the seven changed production files.** PR 7 touches `runbook-store.ts`, `state.ts`, `session-service.ts`, `actor-service.ts`, `completion-service.ts`, `lifecycle-command-service.ts`, and `targeting.ts`. The plan mutates the first two. Left unmutated:

- **`session-service.ts`** — `runGuardedParentAdvance`'s `try`/`catch` around `advance(guard)` and the conversion of `OpenDelegatedChildrenError` into the `open_delegated_children` refusal. That is the PR's headline behaviour, and no mutant of it is generated.
- **`actor-service.ts` / `completion-service.ts` / `lifecycle-command-service.ts`** — the guard-forwarding chain. `e21dab179`'s two regression tests exist precisely to prove "fails if any layer drops the guard"; the gate never mutates the layers they cover.

`--testFiles` likewise omits `session-service.test.ts` and `lifecycle-command-service.test.ts`, where the killing tests for those paths live. That is the exact selection trap PR 6 documented when `runbook-store.ts` mutants reported `Ran 0.00 tests per mutant` and Stryker recorded them as `survived` rather than `no coverage`.

**Replacement.** Derive ranges from `git diff -U0 <base>...HEAD -- <file> | grep -E '^@@'` at implementation time — name the base explicitly, because a bare `git diff -U0 <file>` sees only the working tree and index, so once the work is committed or rebased it reports nothing. Empty ranges do not error: Stryker resolves them to `Instrumented 0 source file(s)` and exits 0, which is the same gate-that-cannot-fail this section exists to warn about. Then run (single line, no `--` separator, package-relative):

```bash
rm -f packages/core/reports/stryker-incremental.json
corepack pnpm --filter @rundown-org/core exec stryker run \
  --mutate 'src/runbook/storage/runbook-store.ts:88-138,src/runbook/storage/runbook-store.ts:926-960,src/runbook/storage/runbook-store.ts:1172-1200,src/runbook/storage/runbook-store.ts:1521-1570,src/runbook/session-service.ts:1035-1055' \
  --testFiles '__tests__/runbook/storage/guarded-parent-advance.test.ts,__tests__/runbook/storage/runbook-store.test.ts,__tests__/runbook/state.test.ts,__tests__/runbook/session-service.test.ts,__tests__/runbook/lifecycle-command-service.test.ts'
```

and a **second run over the guard-forwarding chain**, whose ranges and test files are given below rather than left to the reader — the forwarding chain is the half of the change the first command does not touch at all, so "a second run over the ranges" is not a procedure anyone can follow:

```bash
rm -f packages/core/reports/stryker-incremental.json
corepack pnpm --filter @rundown-org/core exec stryker run \
  --mutate 'src/runbook/state.ts:605-785,src/runbook/actor-service.ts:276-290,src/runbook/actor-service.ts:983-996,src/runbook/actor-service.ts:1281-1300,src/runbook/actor-service.ts:1395-1415,src/runbook/completion-service.ts:473-512,src/runbook/completion-service.ts:555-580,src/runbook/lifecycle-command-service.ts:2340-2375,src/runbook/lifecycle-command-service.ts:2648-2672' \
  --testFiles '__tests__/runbook/state.test.ts,__tests__/runbook/actor-service.test.ts,__tests__/runbook/completion-service.test.ts,__tests__/runbook/lifecycle-command-service.test.ts,__tests__/runbook/session-service.test.ts,__tests__/runbook/storage/guarded-parent-advance.test.ts'
```

Re-derive every range at implementation time with the `<base>...HEAD` form above; the literals here are the ones this PR used and will drift. Before trusting any score, check **both** pre-trust lines: `Instrumented N source file(s)` with `N > 0`, and `Ran N tests per mutant` with `N > 0.00`. Judge on survivors in the changed lines, never the aggregate — the `break: 70` threshold is project-wide and meaningless under line scoping.

This command was run in trial: 3m42s, `Ran 12.93 tests per mutant`, 75 killed / 1 timeout / 22 survived / 5 no-coverage, aggregate 73.79. The aggregate is noise; the survivors are the finding, and they are enumerated in Delta 5. Adding `session-service.ts` to the scope is what surfaced the fifth gap there — the plan's scope would not have.

## Delta 4 — do NOT apply PR 6's "restore `main`'s assertion" heuristic here

`e21dab179` rewrites `session-service.test.ts` › `does not let a claim that interleaves with the guarded advance wedge the parent` into `refuses the guarded advance when a claim commits inside the window, preserving the bearer`, inverting `main`'s assertion from `{ kind: 'advanced' }` to `open_delegated_children`.

PR 6's addendum established a reflex: three owned commits rewrote `main` assertions to match uncorrected behaviour, and all three were restored. **That reflex is wrong here.** This inversion *is* PR 7's goal. `main`'s assertion encodes the pre-atomic contract — a claim landing in the window succeeds, and the orphan claim recovers by not counting as open — and the plan's stated purpose is to replace it with claim-first ⇒ advance refused. Keep the rewrite.

One property is deliberately given up along with it. The old test ended:

```ts
// Therefore the next bare parent advance is not wedged by the orphan.
const next = await sessionService.runGuardedParentAdvance(parent.id, async () => 'again');
expect(next).toEqual({ kind: 'advanced', value: 'again' });
```

Under the new contract the next bare advance is refused too, until the child terminalizes or the claim is released. That is intended, and it is exactly why Delta 5's terminal-child skip is load-bearing: the terminal transition is the escape hatch. Say so in the PR description so the deletion reads as intent rather than an accidental drop.

## Delta 5 — the guard's filter chain is almost entirely unpinned (the substantive finding)

`openDelegatedChildrenFor` decides which claims block a parent advance through a four-test filter chain. The replay's two new store tests cover one of the four. Verified by hand-mutation against the full core suite (4,635 tests) — and, for the first row, the full CLI suite (3,116 tests) as well:

| Mutation | Core suite | CLI suite |
| --- | --- | --- |
| Whole guard block removed from `writeStateAtVersion` (control) | **7 tests fail, 5 suites** | — |
| `parentSubstep?.status === 'done'` skip removed | **2 tests fail** | — |
| Terminal-child skip (`completed`/`stopped`) removed | passes | passes |
| `linkageMatchesClaim(child.parentLinkage, claim)` skip removed | passes | — |
| `!claim.delegation` (run-control claim) skip removed | passes | — |
| `guard.parentRunId !== runId` misapplication throw removed | passes | — |

The plan's own gate criterion — "removing the in-transaction query or its decisive-write predicate is killed" — **is** satisfied by the control row. The gap is one level down, in which claims the predicate counts.

**The terminal-child skip is the one that matters, and it is the one PR 6 changed the meaning of.** PR 6's R2 terminal-retention correction keeps a completed or stopped child's claim `active` rather than tombstoning it, because that row is the terminal evidence `rd pass`/`rd fail` resolve to report `already-resolved` or `DELEGATION_RESULT_CONFLICT`. `0f896b8b6` was written before that correction existed. Post-PR 6, this skip is the only thing preventing a parent from being permanently blocked behind a completed child — and nothing in 7,751 tests holds it.

`guarded-parent-advance.test.ts` looks like it covers this. Its second case (`commits a guarded write when the delegated substep is already resolved`) leaves the child non-terminal and short-circuits at the substep-`done` check before the lifecycle test is reached. Same pattern PR 6's mutation pass caught in `supersededStashedClaim`: a test that verifies something adjacent to what its name claims.

### Confirmed by the Delta 3 replacement Stryker run

The scoped run reproduces every row above independently, at `Ran 12.93 tests per mutant` — a trustworthy run, unlike the `0.00` false negative PR 6 documented. Survivors cluster exactly on the uncovered skips:

| Line | Survived / no-cov | What it is |
| --- | --- | --- |
| `runbook-store.ts:1552` | **9** | Terminal-child skip. Every operand, both string literals, and the whole block. |
| `runbook-store.ts:1188`, `:1190` | 3 | `guard.parentRunId !== runId` misapplication throw and its message. |
| `runbook-store.ts:1548` | 2 | `!claim.delegation` run-control-claim skip. |
| `runbook-store.ts:1555` | 2 | `linkageMatchesClaim` skip. |
| `runbook-store.ts:1563` | 1 | `parentSubstep?.` optional chain — the `=== 'done'` comparison is killed, the chain is not. Needs a claim whose parent substep is absent. |
| `runbook-store.ts:1540` | 2 | `parent?.substepStates ?? []` — the parent-unreadable path. |
| `session-service.ts:1049` | 1 | **See below.** |

### The fifth gap, which hand-mutation missed

`session-service.ts:1049` — `if (isOpenDelegatedChildrenError(error))` mutated to `if (true)` **survives**. Nothing anywhere pins the rethrow the line below it, whose own comment reads `throw error; // never mask a non-guard failure`.

With that condition always true, any failure raised inside the decisive advance write — a Zod rejection on corrupt state, a driver error, a bug in `sendAndSync` — is swallowed and reported to the caller as `open_delegated_children`: a refusal naming a cause that did not occur, against a claim list read off an unrelated error object. That is the masking class this repo treats as a defect in its own right (RD-102), and it is the only survivor in `session-service.ts`, which otherwise scores 94.12.

Worth noting the plan's mutation scope would never have surfaced this: `session-service.ts` is not in the plan's `--mutate` list at all (Delta 3, point 2). It appears here only because the replacement command adds it.

**Close all five before merge.** (Implementation outcome, per Delta 8: four of the five were genuine gaps and are closed; the `!claim.delegation` skip turned out to be an equivalent mutant, kept as contract coverage rather than a kill. A sixth test closes the `parentSubstep?.` chain from the survivor table below. Six tests, five gaps.) The terminal-child case needs a test in its own right — a completed child whose parent substep is *not* `done`, asserting the advance commits — since that is the state the retention latch now produces and the one a real `rd pass --claim-id` on a child leaves behind. The `session-service.ts:1049` case needs an advance callback that throws something other than `OpenDelegatedChildrenError`, asserting it propagates unchanged.

## Delta 6 — two predicates now answer "is this delegated child in flight"

`openDelegatedChildrenFor` (this PR, `runbook-store.ts`) mirrors `listOpenClaimsForParent` (`session-service.ts`): child non-terminal, `linkageMatchesClaim`, parent substep not `done`. PR 6 introduced `classifyDelegationLiveness` (`targeting.ts`) as "the single source of truth shared by the claim-side refusal and the parent-commit invalidation hook", and `invalidateClosedDelegatedClaims` sits ~50 lines below the new predicate in the same file, using it.

The two disagree. `classifyDelegationLiveness` additionally closes on `parent.step !== linkage.parentStep`, a missing substep, a rotated or absent substep token (`token-reissued`), `delegation.cancelledAt !== null`, and frame-entry mismatch. PR 7's predicate treats all of those as **open**, so they block the parent advance.

This is not a regression — it is `listOpenClaimsForParent`'s existing semantics, faithfully mirrored, and it mostly self-heals because the same authoritative write that closes a delegation also tombstones its claim. The residual is PR 6's Delta 8 item 1 case: while the child holds an execution lease, supersession is deferred, so a closed-but-active claim keeps blocking until the lease releases. Erring toward refusal is the safe direction, and PR 7 is not the place to reconcile them.

Recorded because it is the duplication PR 6 spent a delta eliminating, because a reader will otherwise assume the two agree, and because it is the natural cleanup for a later PR in this sequence.

Two smaller observations in the same predicate, neither blocking:

- It reads full run states through `readRun` (Zod-validated) for the parent and for every candidate child, inside the `BEGIN IMMEDIATE` transaction. `invalidateClosedDelegatedClaims` deliberately selects only `lifecycle`, `exec_token`, and `delegation_json`. Correctness-first is the right call; the cost is worth knowing.
- It filters on the `claims.parent_run_id` column while `listOpenClaimsForParent` filters on `delegation.parentRunId` from the JSON blob. `ON DELETE SET NULL` can diverge them, but only when the parent is deleted — unreachable here, since the guard runs inside a write to that parent. `invalidateClosedDelegatedClaims` already uses the column, so PR 7 is consistent with PR 6's precedent.

## Delta 7 — `expectOverlap` can fail `verify`, and it is not PR 7's doing

`session-service.process.test.ts`'s `expectOverlap` sensitivity witness failed twice during this trial, on two different tests:

- once under the default worker count (`converges with no duplicate or resurrected entries when releases and pops race`),
- once under `verify`'s `jest --maxWorkers=2` (`keeps every pushed run id exactly once when N processes push concurrently`), **failing the gate**.

PR 6's addendum records the same flake with the same diagnosis: the witness asserts at least two child processes' mutation windows were genuinely in flight together, and it starves when the suite competes for cores. A concurrent full test run in another worktree held this machine at load 20–35 throughout.

Measured A/B, interleaved so both arms saw comparable contention, using `verify`'s exact invocation: **3/3 clean with the change, 3/3 clean at base**. Across all runs: 1 failure in 4 default-worker full runs with the change, 0 in 3 at base; 1 failure in 4 `--maxWorkers=2` runs with the change, 0 in 3 at base. PR 7 does not touch either failing test.

Worth watching rather than acting on. PR 7 does add a third multi-process test to that file, and its worker hot-spins on two barrier files (`while (!existsSync(...)) {}`) — though the existing fixture already hot-spins on one, so the pattern is inherited, not introduced. If CI reddens here, re-run the file in isolation before treating it as a finding.

## Delta 8 — implementation record: how the Delta 5 gaps were closed

Implemented on `0374d6b91` (#652's head, two commits past the trial base), then rebased onto `786acbc25` — the #652 merge, and `origin/main` as of the rebase — once #652 landed. The rebase was conflict-free: the only paths `origin/main` gained in the interval are `execution-lease*` and `lease-wait-clock*` (#650), disjoint from PR 7's 13-path allowlist, exactly as this addendum's Base note predicted. Delta 1's six resolutions applied unchanged; only the line numbers shifted, as predicted. `c25d1e14d` added four core tests between the trial base and this one, which is why every count below sits four above the trial's.

Six tests added, all in files already on the allowlist. Each was verified by hand-mutation — neutered, run, restored — because a test that passes with and without the code it names is worth nothing.

| Gap | Test | Hand-mutation result |
| --- | --- | --- |
| Terminal-child skip (`runbook-store.ts:1552`) | `commits a guarded write when the delegated child is already %s`, `it.each(['completed','stopped'])` in `guarded-parent-advance.test.ts` | Whole skip removed → **4 fail**. Only the `completed` arm removed → **2 fail**. Only the `stopped` arm removed → **2 fail**. |
| Non-guard rethrow (`session-service.ts`, the `isOpenDelegatedChildrenError` narrowing) | `propagates a non-guard failure from the advance unchanged` in `session-service.test.ts` | Condition forced `true` → **the new test fails and no other does**; the pre-existing window test still passes, which is the addendum's Delta 5 baseline reproduced exactly. Condition negated → 2 fail. |
| `linkageMatchesClaim` skip (`:1555`) | `commits a guarded write when the child no longer carries the claim linkage` | Skip removed → **2 fail**. |
| Misapplication throw (`:1188`/`:1190`) | `throws when a parent-advance guard is applied to a write of another run` | Throw removed → 2 fail. Condition negated → 16 fail. Message emptied → **2 fail** (so the message is pinned too, not just the branch). |
| `parentSubstep?.` optional chain (`:1563`) | `refuses a guarded write when the parent holds no substep state for the delegation` | Chain removed → **2 fail**. Listed in Delta 5's survivor table but not among its named five; closed because it cost one test. |
| `!claim.delegation` skip (`:1548`) | `does not read a delegation-less claim row on the parent as an open child` | **Survives — the mutant is equivalent. See below.** |

### The `!claim.delegation` skip is unkillable, not untested

`linkageMatchesClaim` (`targeting.ts`) opens with its own `if (!claim.delegation) return false;`. Deleting the skip at `:1548` therefore changes nothing observable: control falls through to `readRun`, then to `linkageMatchesClaim`, which returns `false`, and the claim is `continue`d anyway. The two guards are redundant, and no state the store can produce separates them.

Confirmed by a double mutation — skip removed **and** `linkageMatchesClaim`'s early return removed. The test still passes, because the dereference that would throw is short-circuited a second time by `linkage?.kind === 'delegation'` on a controlled run whose linkage does not match. Three independent guards stand between this row and a crash.

The test is kept regardless. It pins the observable contract — a half-linked row (`parent_run_id` set, `delegation_json` NULL) must not be reported as an open delegated child, because that would refuse the advance naming a delegation that does not exist and hand the caller a claim list it cannot act on. It also records the divergence Delta 6 describes from the other direction: `openDelegatedChildrenFor` skips that row while `invalidateClosedDelegatedClaims`, ~60 lines below, *throws* on it. The test asserts the throw is what surfaces, so a future reconciliation of the two predicates cannot silently swap which one wins.

Staging needs raw SQL (`txn.tx.prepare('UPDATE claims SET parent_run_id = …')`) because `insertClaim` derives `parent_run_id` from `delegation.parentRunId`, so only a corrupt row reaches this state. Same technique `runbook-store.test.ts` already uses for its two half-linked-row capture tests.

### Scoped Stryker, run 1 — the guard predicate and its refusal boundary

Delta 3's replacement command, with `session-service.ts` widened to `996-1064` (the whole rewritten method) since Delta 5's cited line had moved:

```bash
rm -f packages/core/reports/stryker-incremental.json
corepack pnpm --filter @rundown-org/core exec stryker run \
  --mutate 'src/runbook/storage/runbook-store.ts:88-138,src/runbook/storage/runbook-store.ts:926-960,src/runbook/storage/runbook-store.ts:1172-1200,src/runbook/storage/runbook-store.ts:1521-1570,src/runbook/session-service.ts:996-1064' \
  --testFiles '__tests__/runbook/storage/guarded-parent-advance.test.ts,__tests__/runbook/storage/runbook-store.test.ts,__tests__/runbook/state.test.ts,__tests__/runbook/session-service.test.ts,__tests__/runbook/lifecycle-command-service.test.ts'
```

`Instrumented 2 source file(s) with 112 mutant(s)`, `Ran 17.95 tests per mutant` — both pre-trust lines non-zero. 4m56s. **99 killed / 1 timeout / 12 survived / 0 no-coverage / 0 errors** (trial: 75 killed / 22 survived / 5 no-coverage). `session-service.ts` 96.15, `runbook-store.ts` 87.21.

Every row of Delta 5's survivor table is resolved:

| Delta 5 row | Then | Now |
| --- | --- | --- |
| `:1552` terminal-child skip | 9 | **0** |
| `:1188`, `:1190` misapplication throw | 3 | **0** |
| `:1555` `linkageMatchesClaim` | 2 | **0** |
| `:1563` `parentSubstep?.` chain | 1 | **0** |
| `session-service.ts` non-guard rethrow | 1 | **0** |
| `:1548` `!claim.delegation` | 2 | 2 — equivalent, above |
| `:1540` `parent?.substepStates ?? []` | 2 | 2 — unreachable, below |

The 12 remaining are: `:1548` (2, equivalent); `:1540` (2, see below); error-message and `kind` string literals at `:106`/`:123`/`:124`/`:944`/`:960` (6); and `mutateState`'s pre-existing retry loop at `:941`/`:960` (2 plus the timeout), which this PR only reformatted.

`:1540`'s `parent?.substepStates ?? []` is defence against the parent vanishing between `mutateState`'s read transaction and its write transaction. Unreachable as a *behavioural* difference: `claims.parent_run_id` is `ON DELETE SET NULL`, so a deleted parent's claims stop matching the predicate's `WHERE` clause, the loop body never runs, and the `UPDATE` reports `missing` either way. No seam stages the deletion mid-`mutateState`.

Worth recording separately: `ParentAdvanceGuard.kind` is a phantom discriminant. `writeStateAtVersion` branches on `guard !== undefined` and never reads `kind`, which is why mutating the literal at `:106` survives. Harmless today — the type is a closed one-member union — but a second guard variant would need the dispatch to actually read it.

### Scoped Stryker, run 2 — the guard-forwarding chain

The pass the trial did not run. `state.ts`, `actor-service.ts`, `completion-service.ts`, `lifecycle-command-service.ts`, scoped to each file's changed ranges, against the six suites that exercise them.

`Instrumented 4 source file(s) with 142 mutant(s)`, `Ran 53.33 tests per mutant`. 17m. 98 killed / 2 timeout / 27 survived / 15 no-coverage. `completion-service.ts` 94.74, `actor-service.ts` 78.26.

Cross-referencing every survivor against the diff's added lines leaves **eleven on lines this PR touched, and no genuine gap among them**:

- **Three are the same equivalent mutant**: `options.guard === undefined ? {} : { guard: options.guard }` forced to always take the second branch (`actor-service.ts:991`, `:1409`, `completion-service.ts:573`). The ternary exists for `exactOptionalPropertyTypes` — every consumer down the chain ends at `if (guard !== undefined)`, so `{ guard: undefined }` and `{}` are indistinguishable.
- **The rest are pre-existing logic the diff marks as added** only because the enclosing call was reformatted to thread the guard: `lifecycle-command-service.ts:2351`/`:2354` (the `targetIteration` spread and the `agentId` literal, both unchanged from `main`, merely moved out of an arrow function into a `recordArgs` const) and `state.ts:620`/`:776`.

The forwarding itself is pinned: mutants on the actual guard-threading statements are killed, which is `e21dab179`'s two production-path regression tests doing the job they were written for. The other 33 survivors/no-coverage sit on unchanged code that fell inside the line ranges.

### Review finding P1 — the duplicate record path dropped the guard (real, fixed)

Found by CodeRabbit, not by the replay or by Delta 5's mutation work. **Valid, reachable, and fixed test-first.**

`recordManualCompletionUnlocked` returns `{ status: 'duplicate' }` from `findExistingCompletion` **before** it reaches `manager.updateWithState`, so a guard threaded into it is never evaluated. `#driveSubstep` then runs `#drainSubstepObservations` outside `runGuardedParentAdvance`, and that drain dispatches the parent forward. A claim committing after the cheap pre-check therefore advanced the parent past a live delegated child — precisely the refusal this path exists to make.

`runGuardedParentAdvance`'s docblock ("the callback MUST perform only the decisive transition write … downstream drain/release steps run afterwards") is sound *while the record is the decisive write*. When the record no-ops, the decisive write moves to the drain, and nothing guarded it.

**Reachability.** The one non-obvious precondition is an undrained `resolvedCompletions` row at the active cursor on a run where `guardOpenChildren` is true. It is reachable because `readDelegationCollectionPendingForPolicy` — the refusal that fires *before* the callback — counts only `agentId: 'delegation'` rows (`readDelegationOutcomeReportedFacts` filters on `DELEGATION_AGENT_ID`). A `manual` row is invisible to it. That is the state a process leaves behind by dying between the record and the drain, which are separately locked on the bare path.

RED was `Expected: "open_delegated_children" / Received: "applied"` in `refuses a racing claim when the substep completion was already recorded`. An earlier attempt failed for the *wrong* reason — `TypeError: snapshot.hasTag is not a function` — which was itself evidence: the stack showed control reaching `#drainSubstepObservations` → `drainResolvedCompletions` → `sendAndSync`, i.e. the unguarded drain really does dispatch the parent forward. The final test stubs the drain inert (the convention the neighbouring exemption test already uses, since these hand-seeded states carry no actor snapshot), which only strengthens the assertion: with the drain unable to advance anything, `applied` can only mean the guard failed to refuse.

**Fix: guard the decisive drain write** (the reviewer's second suggested shape). The first — making the duplicate path perform an in-transaction guarded operation — was rejected: it would manufacture a write purely to run a guard, and it treats the symptom, since the drain is what actually advances the parent. `DrainResolvedCompletionsArgs` gains an optional `guard` forwarded into the drain's `sendAndSync`, and `#driveSubstep` wraps the drain in its own `runGuardedParentAdvance` **only when the record returned `duplicate`**.

Scoping to the duplicate case is deliberate, not incidental. After a `recorded` result the decisive write already committed under its own guard; re-guarding the follow-on drain would let an unrelated live child abort it and strand a recorded-but-undrained completion — manufacturing the very state this defect exploits. Pinned in both directions.

**Lock ordering holds.** `runGuardedParentAdvance` wraps the *locking* drain from outside and holds no CompletionLock itself, so this is the same `SessionLock → CompletionLock` edge the guarded record above already holds; `#driveSubstepExplicit`'s proof names that edge explicitly. The forbidden `CompletionLock → SessionLock` inversion is untouched. Confirmed rather than assumed: `guardOpenChildren` is false by construction on every explicit-target path (`ready.kind === 'default' || ready.kind === 'run') && !targeted`), so `#driveSubstepExplicit` never enters this branch.

Three hand-mutations, all killed:

| Mutation | Result |
| --- | --- |
| Drain-guard branch disabled (reverts the fix) | the duplicate repro fails |
| `guard` dropped in the drain → `sendAndSync` forwarding | `forwards a parent-advance guard from the drain…` fails |
| Guard widened to *every* drain, not just the duplicate | `leaves the follow-on drain unguarded when the record actually committed` fails |
| Guarded-drain callback neutered (drops the `guard` it threads) | `threads a real guard into the drain and proceeds when no child is live` fails |
| The drain's refusal check forced always-true | same test fails |

**The scoped mutation run found a gap in the fix's own test, and it is worth recording.** The duplicate repro commits its racing claim inside the `recordManualCompletion` spy — which runs inside the *first* guarded advance. By the time the second (drain) guarded advance runs, the claim is already committed, so it refuses at that advance's own cheap pre-check and **never invokes the callback**. The wiring inside the guarded branch was therefore unexercised: the callback's arrow and the `refusal` check survived mutation even though the defect was genuinely fixed. `threads a real guard into the drain and proceeds when no child is live` closes it by driving the duplicate path with **no** live child, so the callback actually runs, the drain receives a guard naming the parent, and the non-refusing arm is exercised. Composed with `forwards a parent-advance guard from the drain into the applied completion write` (100% of that file's mutants killed), the guard is proven to reach `sendAndSync`'s store write.

### The other eleven review findings

Taken: **M2** (the process test's hand-written structural cast for `advance` replaced with `Awaited<ReturnType<SessionService['runGuardedParentAdvance']>>` plus an `if` narrow — a cast that invents the shape cannot catch production drifting away from it); **M3** (both barriers in `session-writer-child.ts`, see below); **m4** (this file's five-vs-six count); **m5** (`closeRunbookStore(scratchDir)` before `fs.rm`); **t6** (`childExit` now rejects on `'error'`, so a spawn failure settles with its diagnostic instead of hanging); **t7** (all three race spies inject on the first call only and every site now asserts `claimed` is defined — an unasserted injection is how a race test quietly stops racing); **t8** (seven inline guard literals replaced with the `parentAdvanceGuard` factory); **t10** (`guardOptions` exported alongside `ParentAdvanceGuard`, collapsing four copies of the `exactOptionalPropertyTypes` ternary).

**M3 — one barrier yields, the other deliberately does not.** The second-stage barrier this PR adds is a pure ordering barrier: the child waits alone and nothing measures its overlap, so it now polls with `await` and a 60s deadline. An unyielding spin there burns a core for exactly the window in which the parent commits its racing claim — a plausible contributor to the Delta 7 starvation. The pre-existing first-stage release barrier is different: its comment states that the tight spin is what makes every child enter its mutation within the same few milliseconds, and `expectOverlap` is the assertion that would degrade if a sleep quantised them. It keeps the tight spin and gains only a deadline, so a lost signal fails with a diagnosis instead of hanging until the suite timeout.

**M1 — declined.** The reviewer wants `openDelegatedChildrenFor` to use `classifyDelegationLiveness`. This is Delta 6, found independently, and the answer is still no — for a reason stronger than "out of scope". `openDelegatedChildrenFor` is a byte-for-byte mirror of `listOpenClaimsForParent`, which is the *cheap pre-check in the same method*. Adopting the classifier in the in-transaction guard alone would make the authoritative check disagree with the pre-check it exists to make authoritative: the pre-check would refuse cases the guard would allow. PR 7's contract is "the same predicate, now transaction-local", and that is exactly what makes the replay reviewable. Reconciling the two predicates means changing both, which is a behaviour change needing its own race analysis and coverage — and it errs toward refusing an advance, the safe direction, in the meantime. Recorded as follow-up, as Delta 6 already says.

### Second review round (on the open PR)

**F1 — the guard's throw contract was undocumented. Taken.** `state.ts`'s `update`/`mutate` carry `@throws {OpenDelegatedChildrenError}`, but the two `actor-service.ts` methods that reach that throw via `guardOptions(options.guard)` did not. `updateFromActor` was missing both `@param options.guard` and the `@throws`; `sendAndSync` already had the `@param` from `70a7082ec` and was missing only the `@throws`. Both now document it, and both say the throw is raised by the store write beneath them rather than lexically inside them — which is also why `check:lint:typed`'s `jsdoc/require-throws` never flagged it. A gate that only sees lexical `throw` cannot see a contract inherited through a delegated write; the standard's "`@throws` where exceptions are possible" is the binding rule.

**F2 — t9 reconsidered, and taken. My first decline rested on a premise I had not tested.**

I declined the extract-a-helper suggestion on the grounds that a helper cannot force the guarded callback's *body* to use the guard it receives, so it would re-admit the P1 shape. That objection is **empirically false in this repo**, and one probe settles it: neutering the record site's callback to ignore its guard produces

```text
error  'guard' is defined but never used. Allowed unused args must match /^_/u  @typescript-eslint/no-unused-vars
```

`@typescript-eslint/no-unused-vars` is `error` with only `argsIgnorePattern: '^_'`, and `check:lint:typed` runs inside `verify`. So the residual I refused to accept is closed by the lint gate: accepting a guard and silently dropping it fails the build. Confirming it during the mutation pass, the "drop the guard" mutant had to rename the parameter to `_guard` before it would even lint — the enforcement is real, not theoretical.

With that premise corrected, CodeRabbit's argument stands unopposed: the guarded/unguarded branch was hand-rolled at three sites, and the duplicate-drain defect is precisely what a missed instance looks like. `#runGuardedOrPlain(guardOpenChildren, parentRunId, guarded, unguarded)` is now the single place pairing `runGuardedParentAdvance` with `#guardRefusal`. Both callbacks are required parameters, so the guarded path cannot be skipped by omission — only by an explicit, visible choice at the call site.

**What it does not do, stated so the record is not oversold.** The helper would *not* have prevented P1. That defect was not a call site writing the branch wrongly; it was a decisive parent-advancing write (the drain) that nobody had recognised as one. No signature prevents that — only noticing that a write advances the parent does. The helper narrows the "fourth site skips the guard by omission" failure; it does not touch the "fourth site is never identified as a guarded site at all" failure. The TSDoc on the helper says exactly this, so the next reader does not mistake its reach.

The P1 scoping comment survives verbatim above the drain call, and the drain passes `guardOpenChildren && recordResult.status === 'duplicate'` as the helper's condition — the scoping is still visible at the call site, not buried in the helper.

Four hand-mutations, all killed: drain condition widened to plain `guardOpenChildren`; drain guarded branch disabled; record callback dropping its guard; and the helper itself forced always-unguarded (4 tests fail). Coverage survived the refactor intact.

Confirmed by a scoped Stryker run over the refactored ranges — `Instrumented 2 source file(s) with 77 mutant(s)`, `Ran 24.42 tests per mutant`, 58 killed / 16 survived / 3 no-coverage. **Exactly one survivor lands on the new helper**, and it is equivalent: the `'advanced'` discriminant literal on the unguarded return, which every caller compares only against `'refusal'` — the same phantom-discriminant class as `ParentAdvanceGuard.kind`. Every other survivor sits on pre-existing lines the ranges happen to span (`targetIteration`, `agentId`, the `duplicate` literal, `drained.terminalStatus`, `event.type` checks). The refactor is coverage-neutral.

One pre-existing gap the run made newly visible, recorded rather than fixed: `#driveSubstep`'s **unguarded** record branch is unexercised by the selected suites — it is reached only by the claim-authorized substep path (`ready.kind === 'claim'`), since explicit targets route to `#driveSubstepExplicit`. The gap predates this PR (the old `else` branch had the same hole) and closing it is unrelated to the guard, so it belongs in follow-up rather than in a force-push at review time.

**t9 — original decline, superseded by F2 above.** Extracting the shared guarded/unguarded flow now spans three sites (record, drain, top-level). A helper taking an optional guard would let a call site forget to thread it and still compile — which is *precisely* the P1 defect: a guard accepted and silently unused. The explicit two-branch shape at each site is what makes "did this branch thread the guard?" visible, and the duplication is three short blocks. Making that failure easier to write and harder to see is a bad trade.

**Allowlist expansion (stop-and-review): `packages/core/__tests__/runbook/completion-service.test.ts`.** The P1 fix adds a write-options argument to the drain's `sendAndSync` call, which broke an existing assertion in that suite pinning the call's exact arity (`normalizes sentinel completions before dispatching the validated event`). The assertion was updated to expect the new argument explicitly — `{}` for an unguarded drain — rather than loosened, and the suite also gains `forwards a parent-advance guard from the drain into the applied completion write`. The production file `completion-service.ts` was already allowlisted; only its test was not. Recorded here rather than added silently, per the parent plan.

**`verify` earned its place again.** The review round passed every scoped `jest` run and still failed the gate twice: once on `cspell` (`undrained`, appended to the dictionary alongside the Delta 2 entries and a fourth child run id `rd_a{31}e`), and once on typed ESLint — `@typescript-eslint/prefer-nullish-coalescing` rejected the `if (!claimed) claimed = …` first-call injection from t7 in favour of `claimed ??= …`. Neither rule runs outside `verify`, exactly as `CLAUDE.md` warns.

**A harness note worth carrying forward.** The hand-mutation script restored files with `git checkout -- <file>`, which silently destroyed the *unstaged* P1 production fix mid-run — the third mutation then reported `MUTATION-NOT-APPLIED` against code that no longer contained the fix. Rewritten to restore from a real backup copy, and the production change is staged before any mutation run. A mutation harness that reverts from the index is only safe when the work is already committed.

### Third review round (on `2f3b00721`)

Six findings, all taken. Two were real weakenings of existing assertions, which is the class worth reading twice.

**G1 — the `ChildOp` union was duplicated byte-for-byte** across `session-service.process.test.ts` and `session-writer-child.ts`, coupled by a JSON wire format across a process boundary that TypeScript cannot check. This PR added two variants to both copies, which is exactly the maintenance hazard: forget one side and the only symptom is a child exiting non-zero from a `default:` arm.

Extracted to `__tests__/runbook/storage/fixtures/child-protocol.ts`, imported by both. **Widened beyond the suggestion**: `ChildResult` was the other half of the same contract and had the worse version of the same problem — declared once in the parent and constructed as a bare untyped object literal in the child, so nothing checked the writer against the reader at all. It moved too, and the fixture's two result writes are now annotated `const result: ChildResult = …` rather than inferred, so the producing side is type-checked against the consuming side.

**G2 — a dangling `exit` rejection could mask the real failure.** `childExit` is created before the barrier protocol and awaited only at `collect`, so any assertion that throws in between leaves it unawaited; teardown kills the worker, the promise rejects unobserved, and Jest reports an unhandled rejection on top of — or instead of — the assertion that actually failed. On a cross-process race test that destroys precisely the signal being sought. Fixed by attaching a no-op handler (`exit.catch(() => {})`), which suppresses only the unhandled-rejection report; the returned promise still rejects for `collect`.

**Found and fixed the same bug a second time in the same file**, outside the finding: `race()` builds one exit promise per child and awaits them with `Promise.all`, which settles on the first rejection — so with two failing children the second rejects unobserved. Same one-line remedy, same reasoning.

**G3 — the second scoped Stryker command is now written down.** Delta 3 gave one invocation and then said "with a second run over the forwarding chain", while Delta 8 reported that pass's results — so a reader following the written procedure could skip guard-forwarding validation entirely and still believe they had followed it. The exact `--mutate` ranges and `--testFiles` are now in Delta 3, with a note to re-derive the ranges rather than trust the literals.

**G4 — the allowlist count contradicted itself.** Step 4 still said `comm -3` reports only `cspell-dictionary.txt` while Delta 8 recorded `completion-service.test.ts` as a third path. Reconciled to name all three, so the check cannot be read as passing when it should report three.

**G5 — `not.toBe('done')` was too weak, in four places.** The negative also holds when `findSubstepState` returns `undefined` — i.e. when the parent failed to load or the substep vanished — neither of which is the rollback being proven. `seedLiveDelegation` seeds `status: 'running'`, so the exact post-rollback value is known at every site. All four now assert `toBe('running')` plus `expect(parentAfter).toBeDefined()`, and the child-lifecycle pair in `session-service.test.ts` collapsed from two negatives into `toBe('running')`.

Verified as a genuine strengthening rather than a cosmetic one: pointing the lookup at a substep id that does not exist yields `Expected: "running" / Received: undefined` — a failure the old form passed silently.

For the record, this was **not** among the ten findings passed to me in the first round, so there is no deliberate decline to justify; I simply never saw it.

No production code changed in this round, so the mutation check was a regression check on the lines the strengthened assertions cover: `Instrumented 3 source file(s) with 178 mutant(s)`, `Ran 46.89 tests per mutant`, 139 killed / 24 survived / 10 no-coverage. On `runbook-store.ts` the survivor set is **identical to the first round modulo the line shift `guardOptions` introduced** — the same two documented non-kills (`:1558` parent-unreadable, `:1566` `!claim.delegation`), the same error-message literals, and `guardOptions`'s own equivalent ternary. `parentSubstep?.status === 'done'` stays killed; `session-service.ts` holds at one survivor (the pre-existing `if (parentState)`). Nothing regressed, and no guard behaviour lost coverage.

**Allowlist expansion (stop-and-review): `packages/core/__tests__/runbook/storage/fixtures/child-protocol.ts`.** G1's shared wire-contract module. Fourth and final expansion; recorded here rather than absorbed.

**A false alarm worth recording, because the next reader will hit it too.** The final `comm -3` briefly reported a fifth path, `tests/e2e/fixtures/test-app/package-lock.json`. It is not a change of this PR's: `origin/main` moved during the review round (Dependabot #654 bumping `postcss` in an e2e fixture), and the local ref updated under a routine fetch. Diffing against the moved *ref* attributes main's own commits to your branch. Against the true merge base the path disappears. The branch is deliberately left on its original base — the dependabot change is disjoint from every allowlisted path, and rebasing would invalidate the gate evidence produced above without changing any outcome.

**G6 — `state.test.ts` proved the refusal but not the rollback.** The manager layer sits between the store's rollback and the caller, and that half of the contract is exactly what the test omitted: a future change that caught the throw and continued would keep the rejection assertion green while the parent silently advanced. Now also asserts the parent's `step` is still `'1'`.

### Fourth review round — `guardOptions` consistency, and a fifth allowlist expansion

**The finding.** `state.ts`'s `mutate` passed `{ guard: options.guard }` inline to `store.mutateState` while `completion-service.ts` and `actor-service.ts` had been converted to `guardOptions(options.guard)` in the second round. Valid, and taken.

**Applied to three sites, not the one named.** The reviewer cited only the `mutateState` call (~772-781), but `update` and `updateWithStateIfExists` carry the same inline shape when forwarding to `mutate`. Fixing only the cited line would have left the inconsistency two lines up — the same partial-consistency smell the finding is about. Those two spread (`{ missingIsError: …, ...guardOptions(options.guard) }`) because `missingIsError` is required; the `mutateState` site takes the helper's return directly. The two `{ guard }` literals in `lifecycle-command-service.ts` are deliberately untouched: `guard` there is a non-optional callback parameter, so the helper does not apply.

Required the same type→value import promotion Delta 1 records for `session-service.ts` — `state.ts` imported `runbook-store.js` as `import type`, and `guardOptions` is a value.

**No regression test, deliberately.** The change is behaviourally identical: `{ guard: undefined }` and `{}` both yield `undefined` at `writeStateAtVersion`'s `guard !== undefined` check, and the repo does not set `exactOptionalPropertyTypes`. A test would assert what is already asserted. What *was* verified is that the new call sites genuinely thread the guard rather than silently dropping it — hand-mutating `guardOptions` to `return {}` fails 4 tests across `state.test.ts`, `session-service.test.ts`, and `lifecycle-command-service.test.ts`. Equivalence and threading are both evidenced; neither needed a new assertion.

**The fifth allowlist expansion, previously unrecorded.** Computing `comm -3` against the derived allowlist for this round surfaced `packages/core/__tests__/runbook/storage/fixtures/child-protocol.ts` — the shared `ChildOp` module added for G1 — which is a new path outside the allowlist that no round recorded. The gates table below is corrected to name all four additions. The G4 finding was that the table contradicted the Delta 8 record; the table was still claiming a single addition after that round, and it was under-counting by two, not one.

### Implementation gates

| Gate | Result |
| --- | --- |
| Conflicts | 6 hunks / 5 files, exactly as Delta 1 predicted; `--diff-filter=U` empty, `git diff --check origin/main...HEAD` exit 0 (re-measured post-commit against the base; a bare `git diff --check` on a committed branch sees only unstaged changes and so cannot fail) |
| `comm -3` vs the 13-path allowlist | four additions, zero allowlisted-but-unchanged: `cspell-dictionary.txt` (Delta 2), this addendum, `packages/core/__tests__/runbook/completion-service.test.ts` (P1 fix), `packages/core/__tests__/runbook/storage/fixtures/child-protocol.ts` (G1) |
| `tsc --noEmit` on `@rundown-org/core` | exit 0, no output, no adaptation |
| Plan-named tests (4 suites) | 244 passed |
| Full `@rundown-org/core` | 4,672 passed / 1 skipped / 204 suites, exit 0 (after the P1 fix and the review round; 4,652 / 203 before rebasing onto #650) |
| Full `@rundown-org/cli` | 3,116 passed / 143 suites, exit 0 — the trial's exact figure |
| Scoped Stryker, review round | 43 mutants, 16.81 tests/mutant, 36 killed / 4 survived / 2 no-coverage; `completion-service.ts` and `actor-service.ts` 100%, remaining survivors are the `guardOptions` equivalent and pre-existing lines |
| Scoped Stryker run 1 | 112 mutants, 17.95 tests/mutant, 99 killed / 12 survived / 0 no-coverage |
| Scoped Stryker run 2 | 142 mutants, 53.33 tests/mutant, 98 killed / 27 survived, none a gap on changed lines |

## Delta 9 — a guarded scope spanned several writes, not one (second review round)

`runGuardedParentAdvance`'s TSDoc required the callback to "perform only the decisive transition write". The duplicate-path callback installed by the P1 fix does not: `#drainSubstepObservations` loops with `maxApplied: 1`, one committed transaction per queued completion, and the closure re-supplied the same guard on every iteration. `drainResolvedCompletionsUnlocked` has the same shape one level down — its own `for (;;)` is bounded only by an **optional** `maxApplied`, so a guarded caller omitting it reuses the guard across every apply in a single call.

So the P1 fix did not reduce the guarded scope to one write; it **moved** a multi-write guarded scope from the `recorded` path to the `duplicate` path.

State integrity was never at risk — each apply commits or rolls back alone, unapplied rows stay queued, and the drain is resumable. The damage was to reporting: `drainEvents` accumulates in a local, so a later iteration's refusal discarded the prefix and the caller saw a bare `open_delegated_children` with **zero** events while an advance had committed. An agent trusting that envelope retries against a cursor that already moved. Worse, the two paths then enforced opposite invariants for the identical hazard: the `recorded` path's follow-on drain is deliberately unguarded and pinned as such, while the `duplicate` path aborted everything after its first apply.

**Fix.** Each loop arms the guard on its own first write only — `applied.length === 0` in the drain, `applied === 0` in the observation loop — and the guard reaches `#drainSubstepObservations` as a parameter rather than baked into the `drain` closure, because that loop is what decides which write is decisive. The two rules compose to exactly one guarded write per scope however the loops interleave. The `recordResult.status === 'duplicate'` condition is unchanged and its justification generalises: after a `recorded` result the decisive write already committed under its own guard, so there is no decisive write left in the drain to arm.

The contract TSDoc was rewritten to the invariant that is now enforced rather than the stricter one the code could not honour: a callback **may** span several writes; only the first carries the guard.

**Coverage.** Three tests, each verified against the pre-fix code or by hand-mutation: guard-once in the drain call (`completion-service.test.ts`, `maxApplied` deliberately omitted), guard-once across observation-loop iterations (`lifecycle-command-service.test.ts`), and prefix reporting — two applies must yield two `STEP_TRANSITIONED` events, which pins the "zero events" half and dies to a mutation that drops the accumulator. The two rollback assertions missing from `guarded-parent-advance.test.ts` (refusal asserted, non-advance not) were added and proven sensitive on both storage runtimes.

**Composition pin.** `packages/core/__tests__/runbook/guarded-drain-composition.test.ts` runs the whole path for real — a real machine snapshot (`manager.create` + `initializeState`), real applies, a real delegated child claiming between them, and the real store predicate deciding. Nothing is stubbed; the only spy is a passthrough on `sendAndSync` that wraps the real implementation to control *when* the claim lands. It asserts the consequence — outcome `applied`, two `STEP_TRANSITIONED`, both completion rows consumed, cursor on the delegated substep — and never inspects a guard value, so it stays honest if the guarding mechanism is ever reshaped.

Reverting each fix independently shows the two layers are complementary, not redundant:

| Reverted | Composition test | Per-loop unit test |
| --- | --- | --- |
| Observation loop (`lifecycle-command-service.ts`) | **fails** — `open_delegated_children` instead of `applied` | fails |
| Drain loop (`completion-service.ts`) | passes | **fails** |

The drain-loop revert is invisible end-to-end because `#drainSubstepObservations` pins `maxApplied: 1`, so on that path the inner loop never applies twice. Its guard-once rule is defence for any caller that leaves `maxApplied` unbounded — a shape the type still permits — and only the unit test covers it. Neither test subsumes the other.

Earlier reasoning that an end-to-end test would necessarily "fake the store's refusal" was wrong: it holds only at the layers where `drainResolvedCompletions` or `sendAndSync` is mocked. The real harness already existed in `actor-service-compute-commit-equivalence.test.ts` (real `initializeState`, real `APPLY_CURRENT_RESOLVED_COMPLETION`); it just had not been combined with `guarded-parent-advance.test.ts`'s real claim insertion.

**Gates.** `corepack pnpm run verify` exit 0; full core 4,676 passed / 1 skipped / 205 suites (+4 tests). Scoped Stryker over the changed lines only — `completion-service.ts:843-851` and `lifecycle-command-service.ts:2403-2409,2551,2566` against the three touched suites — `Instrumented 2 source file(s) with 4 mutant(s)`, `Ran 18.00 tests per mutant`, 4 killed / 0 survived / 0 no-coverage, 100%. Two process notes worth carrying forward: repeated `--testFiles` flags do **not** accumulate (the last wins, producing the `Ran 0.00 tests per mutant` selection trap PR 6 documented — pass one comma-separated list), and `reports/stryker-incremental.json` must be deleted first or the run prints survivors from lines outside the requested scope.

The `verify` run also emits `A worker process has failed to exit gracefully` from the core suite. Measured against a stashed baseline it appears in 2 of 3 baseline runs and 2 of 2 changed runs — pre-existing, load-dependent, not this change.

## Trial-replay evidence

On `97c124d98`, after the Delta 1 resolutions and the Delta 2 dictionary entries:

- Conflicts: 6 hunks, 5 files. `git diff --name-only --diff-filter=U` empty; `git diff --check <recorded-base>` exit 0.
- Allowlist: `comm -3` reports exactly one addition against the 13 derived paths — `cspell-dictionary.txt` (Delta 2) — and zero allowlisted-but-unchanged.
- `tsc --noEmit` on `@rundown-org/core`: clean.
- Plan-named tests (`guarded-parent-advance`, `runbook-store`, `state`, `completion-service`): 229 passed, 4 suites.
- Other touched suites (`lifecycle-command-service`, `session-service`, `session-service.process`): 220 passed, 3 suites.
- Full core suite: 4,635 passed / 1 skipped / 203 suites (base: 4,627 / 202) — 8 new tests.
- Full CLI suite: 3,116 passed, 143 suites.
- `corepack pnpm run verify`: every stage green except the Delta 7 flake — format, markdown, spell (after Delta 2), biome, ESLint, build, five `check:types`, CLI-help, xstate-version, parser/plugin/mcp/cli suites all pass.

- Replacement Stryker command (Delta 3): 3m42s, `Ran 12.93 tests per mutant`, 75 killed / 1 timeout / 22 survived / 5 no-coverage. Survivors enumerated in Delta 5.

Not run in trial: the second Stryker pass over the forwarding chain (`state.ts`, `actor-service.ts`, `completion-service.ts`, `lifecycle-command-service.ts`). It **was** run at implementation time — see the "Scoped Stryker run 2" row in the implementation gates above and Delta 8's record. Nothing outstanding; this bullet scopes the trial only.

## Revised step list

1. Branch from freshly fetched `origin/main` after #652 merges; record the SHA.
2. Cherry-pick `0f896b8b6 03d9144a1 63f469945 e21dab179 ee650ce7c 70a7082ec` with `--no-commit`, resolving the six hunks per Delta 1.
3. Append the two Delta 2 literals to `cspell-dictionary.txt`. Two more are needed by the end — `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaae` from step 5's fixtures and `undrained` from step 5's comments (Delta 8) — so expect to revisit this once `verify` runs, or add all four now.
4. Confirm `comm -3` reports exactly four paths — `cspell-dictionary.txt` (Delta 2), this addendum, `packages/core/__tests__/runbook/completion-service.test.ts` (the P1 fix, Delta 8), and `packages/core/__tests__/runbook/storage/fixtures/child-protocol.ts` (G1, Delta 8) — and `git diff --check <recorded-base>` exit 0. Any fifth is a stop-and-review event. Derive the actual list with the **two-dot** form against the base SHA step 1 recorded: `git diff --name-only <recorded-base>`. This step runs before step 9's commit, with the cherry-picks still `--no-commit`, and every other spelling is wrong at that point: `origin/main...HEAD` and any three-dot form compare committed history and so print nothing while the work sits staged; `git diff HEAD^` compares against the immediate parent, which on an unstarted branch is `origin/main`'s own last commit and so attributes that commit's paths to you; and a bare `git diff` / `git diff --check` sees unstaged changes only, missing everything the cherry-pick staged. Switch to `git diff --name-only <recorded-base>...HEAD` once the work is committed. (Originally written as "only `cspell-dictionary.txt`"; that went stale when the P1 fix landed.)
5. **Close the Delta 5 coverage gap** — six tests over the five named gaps (see Delta 8), terminal-child first, the non-guard rethrow second.
6. Run the plan's named tests, then both full suites.
7. Run the Delta 3 replacement Stryker commands; check `Instrumented` and `Ran N tests per mutant` before reading any score.
8. `corepack pnpm run verify`. If `expectOverlap` fails, re-run `session-service.process.test.ts` in isolation before treating it as a finding (Delta 7).
9. Commit `fix(core): make guarded parent advance atomic`; open PR 7; record any further deviation here and on #648.
