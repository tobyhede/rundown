# 690 — Domain-lock deletion: implementation handoff

**Tracks:** [#690](https://github.com/tobyhede/rundown/issues/690)
**Related:** [#732](https://github.com/tobyhede/rundown/issues/732) (split out of this work), [#714](https://github.com/tobyhede/rundown/issues/714) (decision recorded, no longer gating), [#684](https://github.com/tobyhede/rundown/issues/684) (same defect class), [#675](https://github.com/tobyhede/rundown/issues/675) (CLI layering)

**Verified against:** `main` @ `72fd136a4`, 2026-08-12.

**Supersedes** the deletion checklist in
[2026-08-02-608-pr13-planning-audit-current-status.md](2026-08-02-608-pr13-planning-audit-current-status.md) (`:121-129`) and the `*Unlocked`-twin inventory in
[2026-08-07-608-pr13-implementation-deviations.md](2026-08-07-608-pr13-implementation-deviations.md) (`:72-77`), both of which name symbols that no longer exist. Those files are dated and immutable; this one corrects them.

---

## What this is

`CompletionLock` and `DelegationLock` survived the single-store cutover (PR 13, #674), which was planned to delete four core domain locks and deleted two. They remain at six production acquisition sites, along with the `DELEGATION_LOCK_TIMEOUT` (RD-810) surface that exists only to report their timeouts.

This document is the implementation handoff. Read § Corrections first — the issue body and both governing plan docs contain stale symbol names that will send you chasing code that is not there.

## Corrections to the issue and the plan docs

Three references are wrong. They were all verified as wrong against `72fd136a4`.

| Reference | Where it appears | Reality |
| --- | --- | --- |
| `consumeStaleDelegatedOutcomes` | #690 body, `2026-08-07…deviations.md:74` | **No such symbol.** It is the docblock *summary line* of `supersedeDelegationOutcomeUnlocked` (`completion-service.ts:1263`), paraphrased into a method name. That method is real, carries the same lock contract (`:1250-1256`), and has zero production callers. |
| `#drainSubstepObservations` ordering proof | #690 body (already flagged in its audit comment), `2026-08-07…deviations.md:77` | **Zero hits in `packages/`.** `lifecycle-command-service.ts` contains the substring `Lock` zero times. The proof block is gone. |
| `cli/src/services/execution.ts:625` | #690 body, `2026-08-07…deviations.md:57` | Now `:720` (function starts `:698`). The other five site line numbers still match. |

**Line numbers drift.** Every citation below was correct at `72fd136a4`. Re-derive rather than trust them if the tree has moved — identify by enclosing function.

## Scope

### The six production acquisitions

| # | Site | Lock | Phase |
| --- | --- | --- | --- |
| 1 | `core/src/runbook/completion-service.ts:1076` `recordManualCompletion` | Completion | 2 |
| 2 | `core/src/runbook/completion-service.ts:1175` `recordChildCompletion` | Delegation | 2 |
| 3 | `core/src/runbook/completion-service.ts:1449` `drainResolvedCompletions` | Completion | 2 |
| 4 | `cli/src/commands/run.ts:231` `afterInit` | Delegation | 3a |
| 5 | `cli/src/helpers/runbook-pipeline.ts:1549` `claimAndLaunch` | Delegation | 3b (see #732) |
| 6 | `cli/src/services/execution.ts:720` `launchInlineChildFromIntent` | Delegation | 3c |

### Explicitly out of scope — do not touch

`file-lock.ts` and its scoped-release primitives; the sql.js durable-replacement lock (`sqljs-driver.ts:214`, `runLocked` `:299-323`); artifact-manifest locking (`artifact-manifest.ts:134-137`, `:173-176`); `PluginSessionLock` (`packages/claude-code-plugin/src/session-lock.ts`); `isProcessAlive`; `locksDir` / `LOCKS_DIR` (`paths.ts:47`, `:106`, `:151` — consumed by `policy/schema.ts:15,247` and the CLI test utils).

## Constraints that will bite

Read these before designing anything. Each one has already invalidated an obvious approach.

**Transaction callbacks are synchronous by type.** `SyncWork<T>` (`storage/sql-driver.ts:234`) makes a Promise-returning callback a compile error, and `assertSyncWorkResult` (`:265`) throws `AsyncTransactionWorkError` at runtime. Rationale at `:240-247`. The CLI lock scopes contain `await`s, dynamic imports, filesystem resolution, and stdout writes. **"Wrap it in a transaction" is not available for sites 4-6.** The aggregate-lease shape is — see § The pattern to copy.

**Leases refuse instantly; the lock blocks.** `LeaseWaitPolicy` (`storage/execution-lease.ts:75`) exists as a type with **zero production constructions** — every reference is a declaration or a pass-through. Default behaviour is immediate `execution_in_progress`. Swapping a lock that waits 5s and usually wins for a lease that refuses at once trades one user-visible failure for another. If a site needs blocking semantics, a wait policy must be introduced deliberately.

**Leases have no TTL, no renew, and `recoverDeadOwner` has no production caller.** The file lock is PID-aware and self-healing. A hard-killed lease owner strands the run: `runs.exec_token` stays set, mutations refuse `EXECUTION_IN_PROGRESS`, and `deleteRun` guards on `exec_token IS NULL` so `prune` refuses too. See `docs/internal/architecture.md:1241-1255`. Do not widen lease usage without closing this.

**Under sql.js there is no cross-process serialization at all.** `sqljs-driver.ts:194` declares `multiProcess: false`; native declares `true` (`native-sqlite-driver.ts:354`). In WebContainer these domain locks are currently the only cross-process exclusion on these paths.

**No persisted-state migration, ever.** Per CLAUDE.md § State Persistence. If a state shape changes, reject incompatible persisted state; do not shim.

**Dated docs are immutable.** CI enforces `check:docs:dated-immutable` (`.github/workflows/ci.yml:43`). Corrections to any `docs/superpowers/**/YYYY-MM-DD-*.md` go in a **new** dated file, following the `2026-08-07-608-pr13-implementation-deviations.md` precedent. This file included.

## The pattern to copy

Do not invent a replacement mechanism. Two already exist in-tree and are in production use.

**Fenced pure preparation + one owned commit.** `prepareManualCompletion` (`completion-service.ts:903`) is the pure twin of `recordManualCompletionUnlocked`; both delegate the duplicate rule to one shared owner, `classifyManualCompletionTarget` (`:713`), explicitly "so the two can never disagree" (`:702-707`). A test already pins that they agree (`completion-service.test.ts:2647`). Its caller is `lifecycle-command-service.ts:3596`. `prepareResolvedCompletionDrain` (`:1330`, documented `:1282-1320`) is the same thing for the drain.

**Aggregate lease + single transaction.** `delegate`, `collect`, and `abort` are already fully transactional through `EffectfulActorMutationRunner.runAll` → `CoreEffectfulMutationExecutor.runAll` → `store.commitOwnedRunSet` (`runbook-store.ts:1156`). `applyCollection` (`collection-service.ts:603-647`) is the worked example, and its docblock at `:560-592` is the narrative — including, at `:583-587`, the explicit statement that a CLI callable which spawns an execution loop is "Category A, an external effect that cannot be re-run inside a fence". That is the shape sites 5 and 6 need.

**The claim-guarded commit.** `commitOwnedState` (`runbook-store.ts:1117`), whose CAS checks `state_version`, `exec_token`, `exec_epoch` in SQL (`writeOwnedState:1890-1929`) and `claim_generation` in `classifyCommitRow` (`:414-419`), all inside one `BEGIN IMMEDIATE`. Contrast `writeStateAtVersion` (`:1599`, SQL at `:1607-1616`), whose CAS is `state_version` + `exec_token IS NULL` and carries **no** `claim_generation` — the store documents the asymmetry itself at `:1219-1225`.

## Phase 1 — `mutateState` backoff (precondition, do this first)

**This is not optional and not a follow-up.** Today the locks serialise these paths, so the CAS underneath them effectively never contends. Delete a lock and `mutateState` becomes the sole contention mechanism: `runbook-store.ts:1245-1275` is a bare `for` loop, `DEFAULT_MUTATE_ATTEMPTS = 8` (`:89`), **no backoff of any kind** — all eight attempts can land within a few milliseconds. It then returns `concurrent_modification` (`:1276-1280`), which `state.ts:830` routes through `requireCommitted`, which **throws** `ConcurrentStateModificationError` (`:456-461`) → RD-308.

Deleting the locks without this trades a lock that waits for a throw that does not, and substitutes RD-308 exposure for RD-810 on exactly the multi-process paths this issue is about.

1. Add jittered backoff to the `mutateState` retry loop. `file-lock.ts:25-27` (`RETRY_MIN_MS = 50`, `RETRY_MAX_MS = 100`, `LOCK_DEADLINE_MS = 5_000`) is the in-repo precedent for the shape; the native driver's linear `busyRetryBaseMs * (attempt + 1)` (`native-sqlite-driver.ts:430`) is the precedent for a bounded retry inside the store.
2. Cover with a multi-writer contention test that fails on the current code.
3. Update the two docs that state "NO backoff" as a binding caller constraint: `docs/internal/architecture.md:1256-1287` (§ "Optimistic CAS: `mutateState` is not a lock") and the matching `CLAUDE.md` § "Concurrent write synchronization" paragraph.

Land as its own commit with its own coverage, ahead of any deletion.

## Phase 2 — core sites onto the fenced seam

All three core sites terminate at the same primitive today: `updateWithState`/`update` → `state.ts:805-834` `mutate` → `store.mutateState` → `writeStateAtVersion`. None uses `commitOwnedState`.

**Site 1 — `recordManualCompletion`.** The lock's real job is the gap between the decision and the commit: `:1103-1111` loads state and classifies (`manager.load`, `findExistingCompletion`), then `:1122-1136` commits a patch derived from that earlier read. Fold the classification inside the commit so the decision is derived against the version the CAS reads, reusing `prepareManualCompletion` (`:903`) and `classifyManualCompletionTarget` (`:713`).

Note its **only** production caller is `:1236`, inside `recordChildCompletionUnlocked` — so sites 1 and 2 move together.

**Site 2 — `recordChildCompletion`.** The DelegationLock makes atomic the read-derive span at `:1203-1235`: parent load, token-hash fence, cancellation check, frame selection, duplicate check. Move that span into one owned transaction.

Doing so **eliminates the cross-lock ordering edge** (`:1175` → `:1236` → `:1076`) rather than documenting it. #690 offers both options; elimination is the better one, and it discharges the acceptance item without needing an ABBA test for a graph that no longer has an edge.

**Site 3 — `drainResolvedCompletions`.** The constrained one. `:1306-1319` carries a section headed WHY NOT MAKE THE PERSISTED DRAIN ATOMIC IN PLACE: the persisted drain is shared with the CLI execution loop and the delegation-completion adapters, and its per-completion commit is deliberate — only the FIRST apply carries the parent-advance guard (`:1563`, `guardOptions(applied.length === 0 ? args.guard : undefined)`), because re-arming it on a follow-on apply would let an unrelated child claiming mid-drain abort a pass whose earlier applies had already committed. `session-service.ts:1520-1533` states the same rule from the guard's side.

**#690's acceptance item — "transaction ownership, rollback, contention, and committed-before-observation coverage at the SQL workflow layer" — collides with that documented decision for this path.** Either honour the partial-commit design, or overturn it explicitly with its own rationale. Do not silently make it atomic. The likely correct move is routing the CLI wrapper (`execution.ts:1190-1211`, caller at `:1499`) onto the already-fenced `prepareResolvedCompletionDrain` rather than changing the persisted drain.

**Collapse the twins.** `recordManualCompletionUnlocked`, `recordChildCompletionUnlocked`, `drainResolvedCompletionsUnlocked`, and `supersedeDelegationOutcomeUnlocked` each have exactly one non-test caller: their own locked wrapper (`:1078`, `:1177`, `:1451`) — and `supersedeDelegationOutcomeUnlocked` has none at all. This is a rename, not a contract migration.

Their stated contracts are **already false** and should not be carried forward: `:1084-1088` cites "the lifecycle seam's explicit-target span … under one lock scope (#500)" (that span holds no lock) and `:1184-1188` cites "the `abort --force` command which acquires the lock" (`abort.ts` has zero lock references).

## Phase 3 — CLI sites

**3a — `run.ts:231`.** Ungated as of the #714 decision: inline composition is an authoring affordance, not a delegation, so no bearer applies and the lock was only ever doing exclusion. `InlineLinkage` (`types.ts:795`) structurally has no credential slot; `DelegationLinkage` (`:784`) has `tokenHash`.

What remains is staleness. `buildInlineLinkage` resolves the parent from `sessionService.getActive()` (`run.ts:425`), and `:226-243` is a load → `upsertSubstepState` → `update` whose CAS re-reads a later version while the callback returns a patch derived from the earlier read. Thread the captured `state_version` through the commit — or move the `upsertSubstepState` derivation *inside* the `updateWithState` callback, which re-derives per attempt and is side-effect free. The lock is then redundant and deletable.

The write scope is already correct (`upsertSubstepState(substeps, link.parentStepId, link.parentFrameKey, { status: 'running' })`); pin it with a test rather than changing it.

**3b — `runbook-pipeline.ts:1549`.** **Split to [#732](https://github.com/tobyhede/rundown/issues/732); do that first, separately.** The lock is function-scoped (`:1569`, function ends `:1984`) and spans `launchRunbook` at `:1841`, which runs `runExecutionLoop` at `:1150` — so it is held across the child's execution prefix including `spawn` of arbitrary COMMAND steps. With a 5s acquire deadline, sibling claims on one parent contend and fail RD-810. Fix the scope with the existing `afterStarted` hook (`:1135-1137`, the mechanism `execution.ts:977` already uses) before touching the lock's existence.

**3c — `execution.ts:720`.** The hardest of the six. The scope spans `manager.load` (`:750`, `:765`), `sessionService.pushRunbook` (`:790`), `consumeInlineLaunchIntent` (`:795`), `recordInlineChildStarted`, dynamic imports, `resolveRunbookRef`, `prepareResolvedRunnableRunbook`, `output.warning`, and emitter events — seven-plus independent transactions plus filesystem and stdout work across multiple early-return branches, released before the child loop at `:833` / `:977`.

Not a critical section a transaction expresses. The replacement is an atomic compare-and-consume of the inline-launch intent, then no lock — a redesign, using the aggregate-lease shape from `applyCollection`. Note the lock's real job here is exactly-once inline launch, not write atomicity: every individual write inside it is already atomic.

## Phase 4 — deletion and surface removal

Delete:

- `packages/core/src/runbook/completion-lock.ts` (143 lines) and `delegation-lock.ts` (155 lines)
- Path helpers `paths.ts:167-170` (`delegationLockPath`) and `:182-185` (`completionLockPath`)
- Six public re-exports at `runbook/index.ts:476-485`: `DelegationLock`, `DelegationLockTimeoutError`, `DelegationLockLike`, `CompletionLock`, `CompletionLockTimeoutError`, `CompletionLockLike`. **This is a public API removal — needs a changeset.** (`core/src/index.ts:47` re-exports the barrel wholesale, so no per-symbol edit there.)
- RD-810: `errors/codes.ts:331-337`, `errors/factory.ts:232-233`, `output/zod-schemas.ts:80` and `:175`, the emit at `cli/src/services/execution.ts:736-747`, the mapping at `cli/src/commands/claim.ts:139-144`, and the `'lock-timeout'` arm of the claim result union (`runbook-pipeline.ts:289`, produced `:1558-1566`).

The `*Like` interfaces are dead code — zero implementers, zero consumers, including in tests (every double is a `jest.mock` module factory or `jest.spyOn(X.prototype)`). No test injects through them.

**Two gotchas:**

- `file-lock.ts:65-68` cites `DelegationLockTimeoutError` as its subclass exemplar. `file-lock.ts` survives; retarget the comment to the plugin's timeout error.
- `paths.test.ts:8-27`'s `assertSafeId` traversal-guard table is built entirely from these two helpers, so it empties out. Re-point it at a surviving path builder rather than deleting the coverage.

**No error-code registry test asserts an exhaustive set**, so removing RD-810 is safe there: `errors/rundown-error.test.ts:225-246` is structural/uniqueness only; `output/schema.test.ts:238` iterates derived values; `docs-error-code-drift.repo-asset.test.ts` checks documented ⊆ registered, and `docs/spec/cli-output.md` has zero RD-810 occurrences. There is no rendered docs page keyed off `docSlug: 'delegation-lock-timeout'`.

### Test churn

The bulk of the diff, mostly mechanical.

- Delete outright: `core/__tests__/runbook/completion-lock.test.ts` (11 cases), `delegation-lock.test.ts` (17 cases). Precedent: `de38e2620` deleted the `session-lock`/`run-state-lock` suites wholesale (213 + 87 lines) without rewriting them.
- `core/__tests__/runbook/completion-service.test.ts` — prototype spies at `:794`, `:2523`, `:2563`, `:2687`; the tests at `:2522` and `:2562` exist solely to prove the unlocked variants bypass the lock and lose their subject entirely.
- Module-mock link stubs must drop the lock keys or ESM named-import checking fails: `cli/__tests__/helpers/claim-and-launch.test.ts:187-197` (plus `mockDelegationLock` `:561-600`, `mockHappyDelegationLock` `:602-612`, ~23 call sites), `runbook-pipeline.test.ts:271-281` (plus `installHappyDelegationLockMock` `:529-555`, ~14 call sites), `delegation-completion.test.ts:116`, `transitions.test.ts:67-70`.
- `cli/__tests__/services/abort-refusals.test.ts:123,135` uses `Errors.delegationLockTimeout` only as an arbitrary error outcome — re-point at any surviving factory.
- Stale comment-only references to fix: `lifecycle-command-service.test.ts:237`, `:4403-4406`; `claim-seen-drift-guard.test.ts:440` (cites a deleted `lifecycle-command-service.ts:1290-1292`); `delegate-workflow.test.ts:299`; `execution-lease.properties.test.ts:52` (sources a `DEAD_PID` constant from the delegation-lock suite you are deleting); `transitions.test.ts:416`.

**Coverage the deletion must add.** The precedent is thinner than #690's acceptance bar: `de38e2620` added no new test files and touched no error codes. #690 asks for transaction ownership, rollback, contention, and committed-before-observation coverage at the SQL workflow layer. That is genuinely new work and the part most likely to be underestimated. Do not retain test-only production APIs to keep old lock fixtures compiling.

## Phase 5 — docs

- `CLAUDE.md` § "Concurrent write synchronization" — remove the survivor paragraphs, the six-site list, and the #690 pointer. Retain the RD-102 scoped non-masking release doctrine, which is unaffected.
- `docs/internal/architecture.md` — `:971-975` ("two file locks do survive") and `:1288-1315` (§ "Two domain locks survive, as tracked debt": heading, five-row table, and the inbound anchor `#two-domain-locks-survive-as-tracked-debt` linked from `:973`).
- Stale prose: `cli/src/helpers/transitions.ts:581`, `:613`; `core/src/runbook/manual-completion-cursor.ts:64`; `core/src/runbook/lifecycle-command-service.ts:692`.
- Historical dated plan docs: leave them. Corrections go in a new dated file.

## Verification

- **`pnpm run verify` before every push.** Non-negotiable. `cspell` and typed lint (`jsdoc/require-throws`) run only here, so scoped jest runs are not a substitute.
- **`pnpm run test:mutate:changed --package core`**, then `--package cli`. Judge on Survived/NoCoverage mutants **inside your changed lines**, never on the aggregate score. Do not hand-roll `--mutate` scopes unless you need a scope the diff does not describe; if you do, derive ranges from `git diff -U0 <merge-base> -- <file> | grep -E '^@@'` against the **working tree**, pass `--force`, and set `STRYKER_SCOPED=true`.
- Targeted suites: `core/__tests__/runbook/completion-service.test.ts`, `cli/__tests__/helpers/{claim-and-launch,runbook-pipeline}.test.ts`, `cli/__tests__/integration/delegate-workflow.test.ts`.
- **New coverage the deletion must add:** multi-process contention on each migrated path (the property the lock provided and the CAS must now provide), rollback, and committed-before-observation.
- **End-to-end, two processes:** `rundown run` a runbook with a DELEGATE step; `rundown claim` from a second process; `rundown pass`; `rundown collect`. Assert no `CONCURRENT_MODIFICATION` under concurrency and no `DELEGATION_LOCK_TIMEOUT` before the surface is removed. Agents use JSON output — never add `--text`.
- Run the bundled composition scenarios (`runbooks/composition/*.runbook.md`) — they exercise `rd run --step`, which is site 4.

## Acceptance (restated from #690, corrected)

- [ ] Zero production callers of `CompletionLock` / `DelegationLock`; both modules and their path helpers deleted
- [ ] The four `*Unlocked` twins collapsed into their single remaining form — including `supersedeDelegationOutcomeUnlocked`, which the issue names as `consumeStaleDelegatedOutcomes`
- [ ] `DELEGATION_LOCK_TIMEOUT` / RD-810 removed from codes, factory, schemas, CLI mappings, and tests — or explicitly retained with a stated reason
- [ ] The `DelegationLock → CompletionLock` edge (`completion-service.ts:1175 → :1236 → :1076`) eliminated with the locks, or documented with an ordering note plus an ABBA test
- [ ] The three lock-scoped writes migrate to a fenced commit path as part of the deletion, not after it
- [ ] `mutateState` contention addressed before any lock is deleted (Phase 1)
- [ ] Lock-fixture assertions replaced with transaction ownership, rollback, contention, and committed-before-observation coverage at the SQL workflow layer; no test-only production APIs retained
- [ ] Changeset for the six removed public exports
- [ ] `CLAUDE.md` § "Concurrent write synchronization" and `docs/internal/architecture.md` §`:971-975`, §`:1288-1315` updated; the #690 pointers removed
