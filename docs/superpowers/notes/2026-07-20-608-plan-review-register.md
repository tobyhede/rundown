# Verified issue register: remediation plan review

**Date:** 2026-07-20
**Subject:** `docs/superpowers/plans/2026-07-20-claim-concurrency-sqlite-remediation-and-completion-plan.md`
**Evidence base:** `docs/superpowers/notes/2026-07-20-608-audit-findings.md`

Nine review agents across two rounds, plus two external human-supplied reviews. Every claim below was independently verified against the tree by an agent instructed to refute as readily as confirm. Claims that did not survive verification are recorded in the final section rather than dropped.

**Status key:** RESOLVED = the revised successor now contains an executable correction; FIXED = corrected in the first revision; REFUTED = claim did not survive verification. Findings retain their verification narrative below as historical rationale.

---

## S1 — Blocking

### S1.1 R2 does not do what the plan says it does — RESOLVED

**Claim (both external reviews, independently):** R2 does not eliminate both holes the audit found.

**Verified, and worse than claimed.** Two *distinct* residuals, not one restated:

- **Temporal (substep path).** At the moment the claim transaction calls `ctx.readState`, the advance has not committed. `classifyParentSubstep` reads the pre-advance snapshot and admits the claim. R2 refuses only claims whose read happens after the decisive write. The check→claim→advance interleaving the audit documented survives verbatim.
- **Structural (top-level path).** `#driveTopLevel` → `sendAndSync` (`lifecycle-command-service.ts:2654-2659`) writes no `done` substep row at any point. `classifyParentSubstep` therefore returns `unresolved` regardless of interleaving — R2 is not racy there, it is **inert**. The same is true of the existing `listOpenClaimsForParent` exclusion (`session-service.ts:786-792`).

The two guarded call sites are the only ones (`lifecycle-command-service.ts:2359` and `:2658`), routed by `isSubstepCompletion` at `:2300-2305`.

**Resolution:** the revised R2 no longer uses that predicate as its authority. It validates exact delegation liveness inside claim insertion and tombstones closed delegated claims in the parent commit, covering both transaction orders and top-level cursor advance.

**Design consequence, needs a decision.** Task 8's atomicity and R2 are **provably disjoint**: atomicity serialises check-and-write so a claim lands strictly before or strictly after, and only a claim-side predicate can refuse the strictly-after case. Task 8 also does **not** close the `resetReopenedSubsteps` durability hole, because that is not a race — openness is *derived* from live substep status rather than latched on the claim. So "keep both" is correct and the external reviewer's transitional-scoping suggestion is wrong.

The durable design must be two-sided: a claim-row-only latch cannot update a row that does not yet exist. The revised R2 therefore pairs commit-time tombstoning with claim-time live-linkage validation. Task 8 separately restores the open-child check and decisive parent write to one transaction.

### S1.2 R3's recovery path is circular; the error is unmapped — RESOLVED

**Claim (contract review, corroborated by infra review).** The plan asserted `ensureSchema`'s hard reject needed "no new code". False.

- `IncompatibleSchemaError` (`schema.ts:37-58`) extends `Error`, not `RundownError`.
- Not exported from `packages/core/src/index.ts` or `runbook/index.ts` — the CLI cannot catch it by type.
- `toRundownError` (`wrapper.ts:30-52`) has no branch; falls through to `Errors.unknown` → **`RD-999` / "An unexpected error occurred."**
- `ensureSchema` runs inside `openRunbookDriver` (`driver-factory.ts:117-125`) on **every** store open, so read-only commands fail too.
- Its own message says "finish, stop, or prune the active runs" — **all three commands open the store and throw the same error.** Recovery is circular; the real remedy is `rm .rundown/rundown.db`, documented nowhere.

**Correction:** add R3 steps to define `ErrorCodes.INCOMPATIBLE_STATE_SCHEMA`, export the error from core, register the symbolic name in `CLISymbolicErrorCodeValues` (mandatory — `ErrorCodeSchema` is a closed enum, `zod-schemas.ts:175-177`), rewrite the message to name a remedy that works, and add a CLI test asserting both code and actionability. Add an explicit note that every developer and CI checkout loses its `.rundown/rundown.db` at R3.

### S1.3 R6 Step 2 cannot produce `recovery-required` from a trigger catch — RESOLVED

**Claim (external review).** Confirmed, and the blocking part is not the part claimed.

- All five `RAISE(ABORT, …)` carry the identical payload `'execution_in_progress'` (`schema.ts:187, 202, 210, 240, 248`), all guarded by the same `exec_token IS NOT NULL` predicate.
- `commitRecovery` (`runbook-store.ts:1016-1052`) nulls `exec_token` in the same transaction that writes the recovery snapshot, so after recovery commits **the guard triggers cannot fire at all**. The two conditions are mutually exclusive, not merely indistinguishable.

**The abort-shape "detail pass" is cheap and now done.** Measured:

| Driver | `message` | other fields |
| --- | --- | --- |
| `node:sqlite` | `"execution_in_progress"` | `code: 'ERR_SQLITE_ERROR'`, `errcode: 1811`, `errstr: 'constraint failed'` |
| `sql.js` | `"execution_in_progress"` | bare `Error`; `code === undefined`, no own keys |

A catch must key on `message`; only `node:sqlite` gives a structured code.

**The genuinely blocking part is the result unions.** Most session APIs cannot carry a typed refusal today: `popRunbook`/`stash`/`stashRunbook` return `Promise<RunId | null>`, `resetForPruneAll` returns `Promise<void>`, `pruneClaimsForChildren` returns `Promise<ClaimLookupKey[]>`, mint/rotate return `Promise<{claimId, claim}>`. Only `claimRunbook`, `recordClaimSeen`, `unstashForClaimId`, `releaseRunbook(s)` have unions. **~25 production call sites** are affected (`releaseRunbook` 16, `releaseRunbooks` 3, `popRunbook` 2, `stashRunbook` 2, `issueRunControlClaim` 1, `pruneClaimsForChildren` 1).

Also: `readPendingRecovery` (`runbook-store.ts:984-999`) uses its own `driver.read`, so an in-transaction preflight needs a new `RunbookStoreTxn` op, not a call to the existing method.

**Correction:** split R6 Step 2 into (a) record the measured abort table above, (b) new in-transaction recovery-read txn op + typed preflight, (c) explicit result-union design across ~25 call sites. State that the trigger catch is a backstop for `execution-in-progress` **only**.

### S1.4 Task 10's schema-version amendment is actively dangerous — RESOLVED

**Claim (external review).** Confirmed. Two distinct constants:

| | Constant | Value | Meaning | Under R3 |
| --- | --- | --- | --- | --- |
| SQLite | `SCHEMA_VERSION` (`storage/schema.ts:27`) | 1 | `PRAGMA user_version` | **→ 2** |
| Rundown | `CURRENT_SCHEMA_VERSION` (`state.ts:50`) | 1 | `RunbookState.schemaVersion` | **stays 1** |

The amendment as written ("any documentation stating the persisted schema version must say 2") would corrupt four correct references, all of which are the *Rundown* version: `docs/reference/runtime.md:315`, `:362`, `:388`, and `CLAUDE.md:307`.

**Correction:** reword to distinguish the two explicitly. Add to R3's file list: `driver-contract.test.ts:251` (`expect(version).toBe(1)` — the only hardcoded literal, **will fail at R3**) and `schema.test.ts:30` (title text). `state-schema-version.test.ts` is entirely about the Rundown version and must stay 1.

---

## S2 — Major

### S2.1 R6 Step 3 is mis-scoped, and its motivation is partly wrong — RESOLVED

**Claim (external review): Step 3 deserves its own task.** Confirmed, with one correction that *reduces* scope and two hazards nobody listed.

Scope comparison: R1/R3 add 1 SQL change each and touch 1 production call site. R6 Step 3 adds a cross-table `runs` trigger, the first-ever `parent_linkage_version` write path, and touches **10 terminal-release sites across 6 files** — none of which currently runs in the same transaction as the parent state write.

**Scope reduction:** the plan requires "the structural trigger — not service code — owns the bump". That trigger **already exists**: `parent_linkage_version` is in the `UPDATE OF` list of both `claims_guard_update` (`schema.ts:196`) and `claims_bump_gen_update` (`:224`), and was measured to fire. No new bump trigger needed.

**Two unlisted hazards:**

1. `claims_guard_update` will **abort the parent terminal transaction** when the *child* holds `exec_token`. Today parent terminalization is unaffected by child execution state; after Step 3 it becomes refusable by an unrelated executing child.
2. **Spurious generation bumps.** SQLite fires `UPDATE OF <col>` when the column is merely in the SET list, unchanged value included. Every run-state write includes `lifecycle`, so a naive `AFTER UPDATE OF lifecycle ON runs` trigger bumps every child's `claim_generation` on **every parent pass/fail**, invalidating live child captures as `claim_superseded`. A `WHEN NEW.lifecycle IN ('completed','stopped') AND OLD.lifecycle <> NEW.lifecycle` guard is mandatory.

**Motivation partly overstated:** the CAS at `runbook-store.ts:216-228` already has a live `parentTerminal` disjunct, so the parent-terminal case is *already fenced* without linkage versions. `parent_linkage_version` is written only at INSERT (always `0` or `null`) and excluded from `updateChangedClaimColumns`, so the comparison can only ever be `0 !== 0`. The genuine uncovered case is **relinking** (parent re-delegates the substep to a different child), not terminalization.

**Later verification correction:** the inference that `updateStepDelegationChildRunId` was an A→B relink writer was also false. `claimAndLaunch` returns before that helper when a child is already linked; RETRY creates a new token. The authoritative product has no operation that advances `parent_linkage_version`. Revised R8 removes the vacuous column/type/CAS branch (SQLite schema 3), retains exact parent lifecycle/id plus R2 claim-status/generation validation, and moves only the real initial/adoption claim+link sequence into one core transaction.

### S2.2 The supersession edit broke historical stability and successor anchors — RESOLVED

The predecessor had accumulated a banner and substantive amendments after its dated publication. That made it neither an immutable historical record nor a safe dependency: inserting the banner shifted every line anchor, while later amendments meant restoring only the banner would still leave two competing authorities.

**Resolution:** the 2026-07-19 predecessor is restored byte-for-byte to `HEAD`. The successor embeds Tasks 7–10 and carries every still-required correction as a binding amendment, so no implementation step depends on a mutable predecessor or a line-number range.

### S2.3 R0 commits nothing and leaves `verify` red — RESOLVED

**Claim (external review).** Confirmed. `cspell.json:4-8` defines the sole writable dictionary as `./cspell-dictionary.txt` with `addWords: true`. `package.json` has no `cspell` key. R0's Files line and its `git add cspell.json package.json` are both wrong; Step 4 must stage `cspell-dictionary.txt`.

Baseline reproduced exactly: `Files checked: 1169, Issues found: 75 in 13 files`, exit 1. Note `neighbouring` is already in the dictionary (`:145`) — evidence for R0 Step 2's "check the convention" instruction, since British spellings are established.

### S2.4 R2's contract changes are undocumented until Task 10 — RESOLVED

The reviewed draft minted `DELEGATION_SUBSTEP_RESOLVED` / RD-825, emitted by `rundown claim`, and updated no agent-facing docs. The revised R2 lands documentation in the same task and renames the broader latch outcome `DELEGATION_SUPERSEDED` while retaining free code RD-825.

**Note the forcing function does not exist.** Two agents independently confirmed there is **no #615 docs↔enum drift check** anywhere in the tree; `RundownErrorCodeValues` and `CLISymbolicErrorCodeValues` have zero test or script consumers, and `cli-output.md` does not enumerate error codes. Add the docs step, but do not cite a drift check as the reason.

### S2.5 The refusal message gives no action and overstates finality — RESOLVED

Proposed: *"The parent runbook already advanced past this delegation. It is no longer awaiting a result; nothing to claim."* States the cause twice, the action zero times. Every sibling in `claim.ts:32-125` names a condition or remedy.

`running-runbooks/SKILL.md:130-136` scripts the delegated-child protocol with `rundown claim <token>` at step 2 and **no failure branch** — a dispatched child agent hits a hard stop with no next move. And the message asserts finality that R2's own Step 10 contradicts: a RETRY/GOTO reopen makes the delegation claimable again.

**Correction:** append an action ("Do not retry. Report to the orchestrator that this delegation was superseded."), and add the matching branch to the skill.

### S2.6 One error code, two `details` shapes — RESOLVED

Core path emits `{ parentRunId, stepId }` and drops `childRunId` despite the `ClaimRunbookResult` variant carrying it; the CLI pre-check emits a third shape. Every delegation sibling emits all three (`runbook-pipeline.ts:1230-1241`, `claim.ts:73-110`). An agent cannot correlate the refusal to a launched child.

### S2.7 Both mutation commands are defective — RESOLVED

- **R2 Step 14:** `--testFiles __tests__/runbook/targeting.test.ts`, but no plan step writes `classifyParentSubstep` tests there — R2's tests are authored in `session-service.test.ts`. The mutants Step 14 exists to catch **survive by construction**. The guard's call site and the CLI outcome switches are outside `--mutate` entirely.
- **R3 Step 8:** omits `runbook-store.properties.test.ts` — the file R3 Step 7 adds to pin this exact invariant. Its trailing sentence about the index's `WHERE status = 'active'` clause is incoherent with the command (that clause is in `schema.ts`, not the mutated file). Also omits `CLAUDE.md`'s mandatory non-zero instrumentation check and the stale-`stryker-incremental.json` warning.

---

## S3 — Moderate

### S3.1 R5's overlap terminology is wrong, and a Global Constraint is unsatisfiable — RESOLVED

`immediate()` (`native-sqlite-driver.ts:161-181`) wraps `BEGIN IMMEDIATE` in a `SQLITE_BUSY` retry loop with backoff, atop `PRAGMA busy_timeout`. So `[t0, t1]` brackets lock contention + backoff + retries + one exclusive transaction. **SQLite is single-writer: exclusive sections cannot overlap in wall time by construction.** The timestamps witness overlapping *attempts*.

This makes Global Constraint (plan line 77) — "asserts that the critical sections actually overlapped" — **unsatisfiable as written**. Reword to "asserts that mutation attempts were concurrently in flight".

**Keep the assertion.** It witnesses that the barrier worked and the children were genuinely simultaneous, which is the regression it must catch.

### S3.2 R2 Step 10 calls itself end-to-end and is not — RESOLVED

It hand-writes `status: 'pending'` and never fires `resetReopenedSubsteps`, reachable only via `compiler.ts:1344` and `retry-hook.ts:279`. The hand-written row also **drops `delegation`**, which the real reset explicitly preserves (`substep-reset.ts:50-53`) — so the shortcut does not reproduce the state it stands in for.

### S3.3 Task 9's legacy guard downgrades a typed refusal to a warning — RESOLVED

The amendment says "extend `warnIfLegacyStateExists`" — a one-shot `process.stderr.write` (`state.ts:378-391`) that never reaches the JSON envelope. The Global Constraint reproduced verbatim at plan line 51 demands a **typed incompatible-state refusal**. Decide which, name the code if refusal, and put it in a checkpoint.

Timing: defensible for users (nothing releases before Task 9) but late for developers — session mutations already run on SQLite at `1e0c67cb7`.

### S3.4 `statePath` is stale in the contract while R4 fixes it in prose — RESOLVED

R4 corrects the dead `.rundown/runs/<id>.json` in an error message; the same dead value stays a **required** JSON field (`events/types.ts:45-46`) published in `docs/spec/cli-output.md:310` until Task 9. Either state the deferral explicitly or pull the field decision forward.

### S3.5 R3's Interfaces block contradicts its own Step 6 — RESOLVED

Line 611 still says `resolveControllingClaim` "returns `null` on ambiguity"; Step 6 was rewritten to throw. Fix the Interfaces block.

### S3.6 R2 Step 8 guard placement needs to be explicit — RESOLVED

`freshSubstep` comes from `.find(...)`, so it is `SubstepState | undefined`; TypeScript narrows it only via the `!freshDelegation` bail at `:1435`. The stated range `:1430-1437` admits a position where `freshSubstep.status` will not compile. State "after the `!freshDelegation` bail".

### S3.7 Existing delegation scenarios unaudited against R2 — RESOLVED

42 `runbooks/delegation/*` scenarios exist; several claim tokens sequentially. The reviewed draft ran only the new scenario. Revised R2 runs the single case and then `pnpm run test:scenarios:raw`, covering every scenario-bearing runbook before commit.

---

## Refuted — claims that did not survive verification

Recorded because a rejected claim is as much a result as an accepted one.

| Claim | Source | Verdict |
| --- | --- | --- |
| "`--allowEmpty` weakens the intended nonzero-instrumentation gate" | external review | **REFUTED for the reviewed draft:** its commands were defective for other reasons. Revised Task 10 forbids `--allowEmpty` and names eight core plus eight CLI non-zero targets. |
| "R2 should be scoped as transitional and removed when Task 8 lands" | external review | **REFUTED.** Task 8 and R2 cover provably disjoint cases, and Task 8 does not close the durability hole. "Keep both" is correct — but the plan's *justification* for it was wrong (S1.1). |
| "R2's three substep-`done` writers" | this plan's own first revision | **REFUTED.** `updateFromActor` is an un-setter — every `substepStates` assign in `compiler.ts` stores metadata or resets to `pending`; none produces `done`. `completeSubstep` has zero production callers. One real writer, one dead. |
| "The #615 drift check will catch an unregistered code" | superseded plan | **REFUTED.** No such check exists in the tree (confirmed independently by two agents). |
| Nine further code-level claims (`driver.write`, `claimRunbook` arity, `ErrorCodes` shape, `SubstepState.stepId`, …) | external reviews | **STALE, not wrong** — all were corrected in the first revision; the reviewers read the pre-revision file. |

---

## Decisions applied to the revised plan

**Q1 — Durable latch.** Adopted as a two-sided protocol: validate live delegation identity inside claim insertion, and tombstone closed delegated claims inside every authoritative parent commit. A claim-row-only update was rejected because no row exists in the advance-before-insert ordering. The commit half is centralized in `afterAuthoritativeStateWrite`, reached by `writeStateAtVersion`, `applyStateUpdate`, and `commitOwnedState`; manual completion is an explicit acceptance path.

**Q2 — Typed refusal.** Adopted. Incompatible SQLite schema and detected legacy JSON state flow through `ErrorCodes.INCOMPATIBLE_STATE_SCHEMA` as default JSON code `RD-305`; neither case is a stderr-only warning or a migration.

**Q3 — No relink operation.** Verified. R8 removes `parent_linkage_version` and `LinkageVersion`, moves initial/adopted claim+link into one core transaction, and bumps SQLite schema to 3. Parent terminalization and token reissue each use R2's single active→superseded claim UPDATE, so child generation advances exactly once.

**Result-union decision.** R6 uses one outer `SessionMutationResult<T>` for every ownership-sensitive session write. Existing domain results remain inside the committed arm; all core and CLI callers change in the same commit.
