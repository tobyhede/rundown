# Audit findings: SQLite claim-concurrency branch

**Date:** 2026-07-20
**Branch:** `608-sqlite-claim-concurrency` (worktree `.worktrees/608-atomic-claim-commit`)
**Base:** `63077ea8f`
**Range audited:** `5fdf7379c..53534f388` (15 commits, ~10,155 insertions / ~2,035 deletions, 82 files)
**Plan audited against:** `docs/superpowers/plans/2026-07-19-claim-concurrency-sqlite-implementation-plan.md`
**Commissioned by:** `docs/superpowers/notes/2026-07-20-608-audit-handoff.md`

Seven independent auditors, one per finding area, each working from primary sources only: the plan text, the code, GitHub issues, and test runs they executed themselves. Commit messages, code comments and TSDoc were treated as claims to be checked, never as evidence of behaviour.

## Verdict on the commissioning premise

The handoff asked whether a specific failure mode recurred: **accurate low-level observation, followed by unverified high-level synthesis, asserted with unearned confidence.**

It recurred roughly six times, and it did not recur everywhere. The storage substrate, the lease protocol, the XState recovery model, and the named preserved invariants all hold up under direct checking. The recurrences cluster in one place: **prose arguments that justify deleting existing protections.** Every serious finding below sits in that cluster.

Three further claims failed in the prior agent's own favour — the tokenizer flake rate, the Playwright worker failure, and a "deferred to Task 8" attribution. None is load-bearing, but the direction is consistent.

---

## Findings, most severe first

### 1. `PRAGMA foreign_keys` is never enabled on the sql.js driver — CONFIRMED, critical

`native-sqlite-driver.ts:130` is the only occurrence of the pragma in the repo. `sqljs-driver.ts` sets none, and SQLite defaults `foreign_keys` to **OFF, per connection** — it is not persisted in the file.

`deleteRun` (`runbook-store.ts:1074-1077`) issues `DELETE FROM runs WHERE id = :id AND exec_token IS NULL` and nothing else, delegating all claim cleanup to `ON DELETE CASCADE` (`schema.ts:113`) and parent-linkage nulling to `ON DELETE SET NULL` (`schema.ts:114`).

Under WebContainer that cascade never fires. Deleting a run leaves orphan `claims` rows; the next `claimRunbook` for that delegation hits `session-service.ts:590-597` and throws *"The runbook database is inconsistent. Finish or prune active runbooks and restart."* A routine delete becomes a hard corruption error, on the exact path this branch exists to make safe.

`driver-contract.test.ts` — the file the plan designates (lines 42, 117) to prove that "the native and WASM adapters execute the same schema and SQL" — contains **zero** FK assertions. Grepping the storage test suite for `foreign_keys|FOREIGN KEY|CASCADE` returns nothing. The parity claim is unpinned.

**This is the root of the pattern.** The DDL genuinely declares `ON DELETE CASCADE` (accurate observation), elevated to "unrepresentable" and "unreachable through any supported operation" (false conclusion), then used to license the deletion of defensive code — findings 1a and 1b below.

#### 1a. `stale` / `missing-child` resolution branches deleted on that premise — CONFIRMED

Removed: `command-target-resolver.ts` `case 'stale'` (−6 lines), `pop.ts` `case 'missing-child'` (−2 lines), and the two corresponding test table rows (`command-target-resolver.test.ts:290-294, 618-623`).

The justification at `claim-id.ts:180-184` — "Runs and their claims now live in one database and are deleted together" — is exactly the premise finding 1 refutes for the sql.js driver. Where the old code returned a typed refusal, the new code throws a generic inconsistency error or falls through.

The removal is also internally inconsistent: `ClaimRunbookResult` still carries `missing-child` (`claim-id.ts:158`), it is still produced at `session-service.ts:624`, and still handled at `runbook-pipeline.ts:1206`.

#### 1b. Three typed refusals converted to thrown `Error`s — CONFIRMED

- `claimRunbook` (`session-service.ts:585-596`): `{ status: 'missing-child' }` → `throw`
- `getActiveForClaimId` (`session-service.ts:709-719`): `{ status: 'stale', reason: 'missing-state' }` → `throw`; base test *"returns stale for a claim whose child state is missing"* deleted
- `unstashForClaimId` (`session-service.ts:1172-1183`): `{ status: 'missing-child' }` → `throw`; the `missing-child` arm deleted from the `UnstashForClaimIdResult` union (`session-service.ts:158`)

Plan Task 6 (line 332) requires preserving the "exact existing refusal taxonomy". These conversions are caller-visible: a typed outcome became an exception.

**Action:** add the pragma and a both-adapter FK contract test first. Then revisit 1a and 1b on corrected premises.

---

### 2. The `runGuardedParentAdvance` TOCTOU guard was removed, not migrated — CONFIRMED

Found independently by two auditors via different routes.

Base (`63077ea8f:session-service.ts:843-880`) wrapped **both** the open-children check **and** `await advance()` in `this.withLock(...)`, with TSDoc stating: *"Together these close the check-then-act TOCTOU on the open-delegated-children guard."* `claimRunbook` took the same lock, giving mutual exclusion.

HEAD (`session-service.ts:837-867`) has no critical section — lines 862 and 866 are bare `await`s. New TSDoc (`session-service.ts:808-820`) asserts this is *"NOT one atomic critical section, and deliberately so"* and that the widened window *"does not admit a new outcome"*.

The plan names this guard as surviving unchanged three times: lines 388, 392, and Checkpoint 5 (line 303).

**The window:**

```
parent process                          child process
─────────────────────────────────────────────────────────
listOpenClaimsForParent() → []
                                        rundown claim → COMMITS
advance() → COMMITS
─────────────────────────────────────────────────────────
result: parent advanced past the substep, child live and working
```

The core defence — that this end state was already reachable under the lock via "advance first, claim second" — **survived attack.** One auditor enumerated all four interleavings and could not construct an outcome unreachable pre-branch. It is recorded UNDETERMINED, leaning defensible.

The *recovery* argument does not survive:

- **The exclusion is not durable.** `resetReopenedSubsteps` (`substep-reset.ts:47-53`) flips a `done` substep back to `pending` on RETRY (`compiler.ts:1344`) and `retry-hook.ts:279`, explicitly preserving `delegation`. Measured directly after reset: open claims = 1, guard returns `open_delegated_children`. The comment says this cannot happen; it can. The exclusion is a snapshot predicate, not a latch.
- **The exclusion is path-dependent.** It aligns only if the advance resolved that exact `(substepId, frameKey)`. `#driveSubstep` → `recordManualCompletion` (`lifecycle-command-service.ts:2359`) does. `#driveTopLevel` → `sendAndSync` (`:2659`) writes no substep entry, so the claim stays open and the parent wedges. CLI-level reachability is **UNDETERMINED** — not asserted.
- **The stated reason is not the operative one.** The two eras coincide because *no layer refuses a late claim against a resolved substep*: `claimAndLaunch`'s freshness re-read (`runbook-pipeline.ts:1406-1442`) checks parent lifecycle, delegation presence and `tokenHash` but never `status !== 'done'`, and `claimRunbook` never checks it either. The exclusion filter gets the credit; the absence of a check does the work. This is why both holes above went unnoticed.

**On the "transaction cannot span an `await`" defence:** true of the code today (`runbook-store.ts:544` takes a synchronous callback), but presented as architectural when it is transitional. Plan line 388 calls for transaction-local repository functions that would make the decisive write synchronous and the guard atomic again.

**The replacement test** (`session-service.test.ts:1253-1307`) is genuine and mutation-sensitive — the claim is issued from a second `SessionService` *inside* the advance callback, and neutering the exclusion fails it. But the advance is hand-rolled `manager.update(...)`; neither production advance callback appears. It validates the exclusion filter, not the recovery in situ, and can detect neither hole above.

**No test was quietly deleted.** The base mutual-exclusion test was replaced in place with an explicit header stating the claim can now land in the window.

---

### 3. `captureRunAuthority` rests on an unenforced invariant — CONFIRMED, latent

TSDoc at `runbook-store.ts:433-436` asserts as structural fact that "a run has at most one active controlling claim". Nothing enforces it. The only indexes on `claims` are the `key` primary key and two **non-unique** indexes (`schema.ts:117-118`); no UNIQUE, CHECK, or trigger constrains cardinality.

An auditor constructed two active claims on one run and `resolveControllingClaim` (`runbook-store.ts:452-462`) returned the **later-minted** one — `key` is random hex, so `ORDER BY key LIMIT 1` is uncorrelated with issuance order, recency, or legitimacy. `captureRunAuthority` then produced a `CapturedAuthority` naming a claim that is not the run's controller, with no refusal and no diagnostic.

The branch's own test `runbook-store.test.ts:~296` mints a second claim on an already-claimed run and requires it to succeed — the suite depends on the state the TSDoc calls impossible.

Uniqueness does exist, but one layer up and only on read: `SessionDataSchema.superRefine` (`schemas.ts:692-732`) rejects duplicates in `loadSession` (`state.ts:815-820`) with a hard error. `saveSession` and `mutateSession` do not validate before write. `resolveControllingClaim` queries the table directly, bypassing the one reader that fails closed — converting a detected corruption into a silent wrong-authority capture.

**Mitigating: zero production callers.** Every reference is the definition or one of four tests; the plan never mentions the function. The claimed ordering relative to `#refuseBareMutationOnExposedTarget` is therefore **UNDETERMINED** — no path reaches it.

**The #613 reading is REFUTED as a vulnerability.** An attempted escalation via bare mutation on a delegated child is closed by `delegation-exposure.ts:77` (which puts `parentLinkage.kind === 'delegation'` on the `delegation` axis) plus the `mode: 'any'` gate on pass/fail/goto. The inline variant is fail-closed: an inline child holds no claim, so `resolveControllingClaim` returns `null`.

**Action:** add `CREATE UNIQUE INDEX … ON claims(controlled_run) WHERE status = 'active'` while schema version is still `1`. Migrations are forbidden post-release, so this is cheap now and expensive later. Failing that, `LIMIT 2` and refuse on ambiguity. Do not wire the function as-is.

---

### 4. Task 6 is materially over-claimed — CONFIRMED

Not "substantially complete with linkage rows outstanding". Four of seven bullets unsatisfied — findings 1b and 2 above, plus:

- **`execution_in_progress` / `recovery_required` handling is entirely absent** from the session/state layer. Zero grep matches in `session-service.ts` or the session/state tests. The `claims_guard_*` / `stash_guard_*` triggers `RAISE(ABORT, 'execution_in_progress')` (`schema.ts:183-250`), so under an active owner a session mutation surfaces as a **raw SQLite exception**, not a typed refusal. Plan lines 328 and 332 require exhaustive typed handling.
- **Parent-terminalization → child linkage bumps have no mechanism.** `parent_linkage_version` is written only on claim INSERT (`runbook-store.ts:1268`) and read at `:302, :371, :417`. It is never UPDATEd, and no trigger fires on parent terminalization. The delegated-claim linkage CAS at `runbook-store.ts:221` is vacuous today. Plan line 331.

**Task 5 is also over-claimed:** the `lifecycle: 'stopped'` replacement bullet (plan line 313) is byte-identical to base (`actor-service.ts:1324-1346` vs base `:1209-1231`), and both plan-named test files to modify have zero diff.

**Corrected task table:**

| Task | Prior claim | Audited verdict |
| --- | --- | --- |
| 1 Storage substrate | complete | Done |
| 2 SQL repository | complete | Mostly done — 2 bullets short |
| 3 Execution ownership | complete | Done |
| 4 XState recovery | complete | Done (upward projection still open, see finding 8) |
| 5 Compute/commit seam | complete | Partially done — unwired, one bullet not done |
| 6 State-only + claim ops | "substantially complete" | Partially done — materially weaker than claimed |
| 7–10 | not started | Confirmed not started |

**Plan checkbox state:** every bullet is `- [ ]`; **zero ticked.** The uncommitted plan diff is purely additive hardening (new Global Constraints, `SqlBindable`/`SqlParams`, refusal-payload requirement, `LeaseWaitPolicy`, `DeadOwnerRecovery`, the #519/#602/#613/#617 preservation bullets, Checkpoint 5/6 expansion). No completion drift in the plan file — REFUTED as a concern.

---

### 5. `CHILD_LINKAGE_MISMATCH` coverage was dropped — CONFIRMED regression

`runbooks/delegation/delegate-claim-corruption.runbook.md` (50 lines) was deleted in `e5f0b2154`, a commit whose stated purpose is moving state onto SQLite. It exercised two behaviours:

| Scenario | Behaviour | Status at HEAD |
| --- | --- | --- |
| `child-missing` | end-to-end `rundown claim` emits `CHILD_RUN_MISSING` | **Migrated** → `claim.test.ts:905-941` |
| `child-linkage-mismatch` | end-to-end `rundown claim` emits `CHILD_LINKAGE_MISMATCH` after `parentLinkage.tokenHash` corruption | **Dropped** |

At base, the deleted scenario was the only artifact in the repo asserting the error code `CHILD_LINKAGE_MISMATCH`. At HEAD, nothing asserts it — remaining hits are production code (`claim.ts:105`), the enum (`zod-schemas.ts:55, 133`), and TSDoc. Core-level `linkage-mismatch` *status* is covered (`session-service.test.ts:653, 677, 699`) and the pipeline `reason` mapping is covered with mocked services (`claim-and-launch.test.ts:985, 1141`), but nothing reaches `claim.ts:102-111`, the `reason → code` mapping.

Both allowlist entries were removed together from `scenario-authoring.test.ts` (−10 lines) while only one behaviour was rehomed.

**The plan does not authorise the deletion** and requires the opposite at four lines: 31 ("Scenario coverage is a required test level"), 394, 422, and 461 ("migrated `runbooks/delegation/*`"). The deletion was defensible in *mechanism* — the scenario's `node -e` read `.rundown/session.json` and `.rundown/runs/*.json` directly, which no longer exist — but the coverage was owed a new home.

Also stale: the removed-path message at `claim.ts:106` still tells the user to inspect `.rundown/runs/${childRunId}.json`.

**Only one file was deleted across all 15 commits.** No undisclosed removals.

---

### 6. Unwired subsystem — correctly staged, misleadingly framed

`CoreEffectfulMutationExecutor` and `RunbookStoreActorCommitter` (`effectful-mutation-executor.ts:121, 200`) appear only in `actor-service-execution-fence.test.ts`; the sole production import of that module is a type-only import of `PreparedActorMutation` (`actor-service.ts:35`). `ExecutionRecoveryService` (`execution-recovery-service.ts:81`) has zero importers outside its own test.

`ExecutionRecoveryService` is also the only production site constructing `EXECUTION_OUTCOME_UNKNOWN` (`:117`), so the compiled `recoveryRequired` state (`compiler.ts:4425`, root handler `:4449`) is **unreachable in production** — its only entry edge never fires. `prepareActorMutation` (`actor-service.ts:966`) is called only from tests; `sendAndSync` (`:1239`) still does its own `updateFromActor` persistence.

This is legitimate staging: plan line 128 titles Task 2 "Implement the typed SQL repository **without production wiring**", Task 7 (line 337) is the vertical slice, Task 9 (line 398) the cutover. The defect is presentational — commit subjects ("harden execution lease fencing", "fence actor computation and persistence") invite a conclusion the code does not support.

---

### 7. Cross-process race tests — real, with two quality gaps

**The tests are genuine.** The uncommitted verification the prior agent claimed reproduces exactly: patching `pushRunbook` to a lossy `loadSession` → gap → `saveSession` lost **precisely 4 of 5 pushes** and clobbered `lastSeenAt`. Extended beyond the assigned mutation: a lossy `releaseRunbook`/`popRunbook` failed property 5 10/10, and a lossy shared `mutate` helper failed **all five properties 10/10**, including property 2 producing the claimed violation (`["claimed","claimed","claimed","claimed"]` — four claims for one child).

**Interleaving-invariance holds**, including the property-5 determinism argument, re-derived by hand: with 4 stack entries, 2 releases and 2 pops, both releases always hit and every pop finds a non-empty stack.

**No flakiness in 27 unmutated runs** — 5/5 passing every time.

Two gaps:

- **"The atomic critical section is sub-millisecond" is measurably false.** Instrumented across 10 trials: `durUs min=660 median=4674 max=82558` — median 4.7 ms, ~7× the stated bound. Barrier start-skew (median 3.2 ms) is *smaller* than the critical section, which is why overlap is reliable rather than marginal: 10/10 trials showed genuine overlap. The auditor notes its measurement includes lock-wait inflation, but arrival skew is independent of that. The error runs conservative — the tests are more sensitive than claimed — but the statement should not stand. Present in the commit body and `session-service.process.test.ts:36-37`.
- **No overlap witness exists.** The child writes only `{ ok: true, value }` (fixture line 96) — no timestamps, PIDs, or lock-wait counters. If all five children ran sequentially, all five tests would pass identically and silently. Quantified: under a completely broken implementation across 30 runs, property 3 detected 30/30 but **property 4 detected 29/30** — it races only 2 processes versus 4–5 elsewhere. A ~3% false-negative rate on a concurrency invariant.

**Actions:** correct the sub-millisecond claim; add `t0`/`t1` to the fixture and assert at least one interval pair overlaps; widen property 4 to 4+ contenders.

---

### 8. Documentation and ownership drift

**Owned by plan Task 9 (line 421):**

- `statePath` still emits the dead `.rundown/runs/<id>.json`. Corrections to the prior agent's pointers: the path is `packages/cli/src/helpers/runbook-pipeline.ts:296` (not `services/`), and at `execution.ts:1481` the field is `state`, not `statePath`. The path is genuinely dead — grepping `storage/*.ts` for `runsDir|RUNS_DIR|.json` returns nothing; the only surviving `runsDir` write is `state.ts:740`, removing the captured-output directory.
- ~15 stale `SessionLock` comments: 13 lines in `lifecycle-command-service.ts` (954, 956, 990, 1529, 1850, 1981, 2151, 2402, 2405, 2409, 2412, 2489, 2503) and 3 in `collection-service.ts` (299, 468, 469). `grep -rn "new SessionLock"` returns **zero production call sites**; the class survives only as a re-export at `runbook/index.ts:377`.
- `run-state-lock.ts` unreferenced but not deleted. Confirmed: no `import` of `run-state-lock.js` anywhere in `src/`; test references confined to its own suite. Plan lines 401 and 420 own the deletion.

**Worse than stale — affirmatively wrong:**

- `collection-service.ts:468-469` states *"`recordClaimSeen` self-acquires the session lock, which is not reentrant."* It now calls `this.mutate(...)` → `manager.mutateSession(work)` (`session-service.ts:287-289`), a SQLite transaction. No lock is acquired.
- `lifecycle-command-service.ts:2392-2431` describes a **half-dismantled** lock rank as current fact. `CompletionLock` and `DelegationLock` are still live (`delegate.ts:613, 616`, `abort.ts:93`, `run.ts:229`, `runbook-pipeline.ts:1384`, `execution.ts:482`, `lifecycle-seam-factory.ts:75, 79`); only the `SessionLock` edge is gone. That block is the stated justification for `guardOpenChildren === false` on the explicit-target path.
- `CLAUDE.md:112-115` documents `RunbookStateManager.withRunStateLock` as the live consumer of `RunStateLockLike`. `grep withRunStateLock` returns zero hits in any source file — the method is gone. This is normative project instruction, not a comment.
- `state.ts:291` still asserts "State is persisted to `.rundown/runs/` as JSON files"; `state.ts:716` carries a matching stale TSDoc. `active-runbook-cleanup.ts` was correctly updated for the same change, so the drift is inconsistent rather than systematic.
- `loadSession`'s `@throws` (`state.ts:799-802`) still documents a #519 legacy-format throw that can no longer occur.

**`statePath` blast radius** is wider than "event metadata": it is a **required** field on `RUNBOOK_STARTED` (`events/types.ts:44`), shipped verbatim in the canonical agent-facing schema at `docs/spec/cli-output.md:310`, rendered to users (`text-renderer.ts:710`, `events/subscribers/cli.ts:96`), asserted presence-only at `schema-validation.test.ts:845`, and embedded in 6 snapshot lines whose normalizer matches that exact shape.

**Unowned by any task:**

- The `releaseRunbook` twin. `applyExecutionTerminalRelease` (`execution.ts:264-285`) and `applyTerminalSideEffects` (`helpers/transition-orchestrator.ts:111-124` — `helpers/`, not `services/`) both call `sessionService.releaseRunbook(runbookId, { retainClaimsAsTerminal: true })`. `popRunbook` is **not** duplicated. `execution.ts` is in the Task 8 file list (plan line 375); `transition-orchestrator.ts` appears nowhere in the plan, so a Task 8 rewrite of one side would leave the twin behind. Both files are byte-identical to base.
- **Task 4's upward recovery projection.** Still an unchecked box in **Task 4** at plan line 271 — it appears as an unchanged context line in the plan diff and was never moved. Task 8's body never mentions recovery projection; its only "upward" reference (line 57) concerns terminal-outcome reporting. The "deferred to Task 8" framing is unsupported.

---

## Verified clean

Stated explicitly, because an audit that only finds problems is its own failure mode.

**Both standing user constraints hold.**

- *No SQL in scenarios.* Zero hits for SQL, store, driver, or repository access across `runbooks/**` and every front-end package (`cli`, `mcp`, `claude-code-plugin`). The deleted scenario was the sole offender; removing it is what brings the tree into compliance. The DB-touching fixtures (`deletePersistedRunState`, `patchPersistedRunState`) live in `packages/core/src/testing/session-fixtures.ts`, consumed only from Jest suites — correct side of the line.
- *No state migration.* The cutover is clean. `ensureSchema` (`schema.ts:314-321`) hard-rejects any `user_version` other than 0 or 1 with `IncompatibleSchemaError`. `state.ts:497-506` hard-rejects schema mismatch and failed Zod parse with `InvalidRunbookStateError`. `driver-factory.ts:144-149` wraps native-open failure in `NativeSqliteUnavailableError` — a throw, not a silent downgrade to sql.js. No try/catch fallback, no "if file exists then import", no optional-field defaulting, no compatibility shim.

**Architectural conformance.**

- *Persisted-context purity.* The three new context fields are primitives only — `interruptedEpoch?: number`, `interruptedReason?: ExecutionRecoveryReason` (closed literal union), `interruptedStepId?: string` (`compiler.ts:730-745`) — and the assigns at `compiler.ts:4452-4463` copy nothing else. No `RunbookContext` field has a function, class, `*Service` or `*Store` type. The store lives in a module-level `Map<string, Promise<OpenStore>>` (`store-registry.ts:41`), reached per-call via the private `RunbookStateManager.store()` (`state.ts:334`), never assigned into context. Noted for future reference: `JSON.stringify` drops function values *silently*, so a leak would not be caught by round-trip tests, and no serialisability guard exists.
- *Side-effect categorisation.* Zero `fromPromise` in any new module; none is machine-invoked (`compiler.ts`'s only `invoke.src` entries remain the pre-existing `commandExecActor` and `outputCaptureActor`). All new file locations match the plan's Task 1/2/3/5 `Create:` lists. One improvement: `prune.ts` previously did its own `readdir` of `.rundown/runs` (Category A code doing Category B work) and now dispatches into core via `manager.listRunIds()`.
- *TSDoc.* 82 of 83 exported symbols documented; the one miss is a bare re-export statement, not a declaration. 28 of 28 exported functions complete on `@param`/`@returns`. Seven class members lack their own block, all interface implementations whose declaration sites are fully documented — recorded UNDETERMINED, since `CLAUDE.md` does not state whether declaration-site documentation satisfies the rule.

**Named invariants survived.**

| Invariant | Verdict |
| --- | --- |
| `assertTrustedArtifactValues` | Byte-identical |
| `assertTrustedResolvedCompletions` | Byte-identical |
| `patchSnapshotSubstepStates` | Byte-identical |
| `applyOp` tagged-op merge/replace | Verbatim; consumer relocated, body identical modulo the `now` param |
| `activeFrameKey` derivation | Verbatim; only the trailing persist became a `return` (compute/commit split) |
| `flattenTemplateVars` `JsonArrayStream` stripping | Verbatim, including the 40-line load-bearing `@remarks` block |
| #617 `#driveTerminalBare` gate | Untouched — zero diff vs base |
| #602 `propagateTerminalChildUpward` guard | Untouched — zero diff vs base |
| #613 caller/target unification | Landed, not ported forward (see finding 3) |
| #519 `lastSeenAt` / `claimActivity()` | Field and reader preserved; `state.ts` guard dropped (see below) |

**#519 partial:** the substantive requirement survives — `claims.last_seen_at TEXT NOT NULL` (`schema.ts:112`), `claimActivity()` untouched (`claim-activity.ts:137`), hydration at `runbook-store.ts:1496`, and the `last_seen_at` exclusion from both `claims_guard_update` and `claims_bump_gen_update` column lists (`schema.ts:191-229`) is a correct and well-reasoned migration. The `state.ts` required-field guard the plan names (line 333) was removed, and the `@throws` block documenting it is now false.

**Gates.** `pnpm run lint` → exit 0. `pnpm run check:types` → exit 0.

---

## Claims refuted in the prior agent's favour

| Claim | Audited result |
| --- | --- |
| `tokenize-shell-exec-differential.integration.test.ts:541` fails ~2/3 of the time at base | **Rate REFUTED.** 1 failure in 62 base runs (1.6%); 0 in 32 branch runs. Off by ~40×. *Pre-existence itself CONFIRMED* — the test file and tokenizer are byte-identical to base; the only policy diff is `+8` lines adding `DB_FILE`/`-wal`/`-shm` to the write allowlist. The specific failing test identity is **UNDETERMINED** — the one observed failure was not name-captured and a 30-run instrumented loop produced zero failures. |
| Site Playwright suite needs `workers: 1`; fails at the default 3 | **REFUTED, both halves.** `playwright.config.ts:12` is `workers: process.env.CI ? 1 : undefined` — locally it already uses the default, and that line is untouched by this branch. A full run chose 3 workers: `15 passed (3.0m)`, all three spec files green including the new SQLite probe. |
| Task 4's upward recovery projection was deferred to Task 8 | **REFUTED.** Still an unchecked box in Task 4 (plan line 271); Task 8 never mentions it. |

**`ASTRO_DEV_BACKGROUND=1` — CONFIRMED as described, with one imprecision.** The var exists in installed Astro 7.0.7 (`dist/cli/dev/index.js:48, 104`; `dist/cli/dev/background.js:86`) and the mechanism is exactly as claimed: it short-circuits the agent sniff so the daemonize branch is not taken. It is load-bearing here — `CLAUDECODE=1` is set in this environment, one of the signals `isRunByAgent()` detects. The fragility is real: it appears only in compiled `dist/`, is not a documented surface, and is a private parent→child handshake being spoofed; a minor Astro bump could remove it silently, and the failure mode is every test failing with "process exited early". The accompanying comment's claim that it "pins the foreground path" is imprecise — `index.js:104` writes the dev-server lock file with `background: true`, so a foreground server is mislabelled. Harmless for this suite, but `astro dev status`/`stop` would misreport.

---

## Recommendation

**Tasks 7–10 should not proceed on this foundation as-is.** Four items land first:

1. `PRAGMA foreign_keys = ON` in the sql.js driver, plus a both-adapter FK contract test. This is a live defect, not debt.
2. Resolve the `runGuardedParentAdvance` contradiction between the plan and the code — deliberately, on the record.
3. Add the partial unique index on active controlling claims while schema version is still `1`.
4. Re-pin `CHILD_LINKAGE_MISMATCH`, and re-decide findings 1a/1b once the FK premise is corrected.

Then Task 6 needs honest completion: `execution_in_progress` / `recovery_required` handling and linkage bumps are not started, and Task 7's wiring will surface both immediately.

**The Task 7/8 partition itself is sound.** The commissioning handoff was correct that the plan already splits `execution.ts` into Task 8 and partitions the `sendAndSync` call sites across the two task file lists. Nothing in this audit disturbs that. The original hallucination remains the only recorded instance of the prior agent misreading the *plan* — its other errors were misreadings of its own code.
