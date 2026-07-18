# Claim progress → claim liveness: correcting #519's premise

**Lives on `claim-progress-idle-detection` (PR #611).** Part A is this branch.
Part B is `claim-progress-recording`, and depends on Part A landing first.

## Context

#519 is being delivered as three plans. Plan 1 (this branch, #611) built the
foundation: a required `ClaimRecord.lastProgressAt`, a pure `claimActivity` idle
derivation, and the `recordClaimProgress` API. Plan 2
(`claim-progress-recording`, no PR yet) wired recording into the eight
claim-authenticated commands and pinned all eleven `--claim-id` commands with a
drift guard.

**The command split plan 2 shipped is correct. The premise underneath both plans
is not.**

Plan 1's TSDoc (`67410510a`, `claim-id.ts:104-115`) asserted that
`lastProgressAt` means _"the holder last advanced the controlled run"_. Plan 2
(`61988f6a0`) inherited that sentence and derived a predicate from it — _"record
when the command changes runbook workflow state"_ — which is also written into
the spec (`12146f9b3`, `2013cbcbf`) and this branch's design doc.

Nothing asked for that concept. Issue #519 does not mention advancement. Nothing
else in the codebase needs it. It was invented while writing plan 1's TSDoc and
then treated as a given by everything downstream.

The question the mark actually answers is narrower:

> **Is the claimant still alive?**

A verified bearer arriving with an authorized grant _is_ the proof. What happens
to the run afterwards does not bear on it.

### Why this is worth a correction rather than a comment

The wrong premise is load-bearing, and it has already cost real work. A
CodeRabbit review of plan 2 correctly observed three paths that record without
the run advancing (inline-child reactivation, a duplicate re-record, the
vanished-child terminal race). Under "advancement" those look like defects, and
the response drafted was a refactor of `LifecycleTransitionOutcome` — a core
union that four exhaustive switches depend on — to add a discriminator enforcing
a concept nobody wanted. Under "liveness" all three paths are simply correct: a
verified bearer proved its holder alive in each.

An invented premise that survives into a merged spec keeps generating that kind
of work. Plan 3 has not started and would inherit it.

### The corrected predicate: who presents, not what changes

The eight-and-three split survives, for a reason that has nothing to do with
advancement. `--claim-id` carries two different meanings, and the CLI help text
already says so:

| Command                  | `--claim-id` help text                                         | Meaning         |
| ------------------------ | -------------------------------------------------------------- | --------------- |
| `status`, `stash`, `pop` | `Target a claimed delegated child runbook`                     | target selector |
| `abort`                  | `Bearer authority for the parent run that owns the delegation` | authority       |

On `status` / `stash` / `pop` the presenter is plausibly the **orchestrator**,
naming a **child's** claim as a target. Recording there would let a parent's
activity refresh a child's mark — a dead child reading alive because its parent
was still poking at it. That is a parent vouching for a child's liveness, which
is exactly what AC5 forbids.

So:

- **Record** when the claim's own holder presents it as authority — a child doing
  its own work (`pass`, `fail`, `complete`, `stop`, `goto`) or an orchestrator
  presenting its own run-control claim (`delegate`, `collect`, `abort`).
- **Do not record** when `--claim-id` names another agent's claim as a target
  (`status`, `stash`, `pop`).

Same eight commands. Same three exclusions. A reason that holds.

## Non-goals

- **No union changes.** No `advanced` field, no new `LifecycleTransitionOutcome`
  member, no splitting `applied`.
- **No behavioural change to the split.** The same eight record; the same three
  do not.
- **CodeRabbit's `lifecycle-command-service.ts` finding is won't-fix** — correct
  observation, not a defect once the premise is right. Record the disposition on
  plan 2's PR; do not act on it.
- **#613 stays separate.** It is now on the same axis (caller-vs-target is what
  the recording rule turns on), which is worth a comment on the issue, but it
  remains its own branch and PR.

---

# Part A — on this branch (#611)

## Task A1 — Correct the design in a new spec

Specs here are write-once: **do not edit**
`docs/superpowers/specs/2026-07-16-claim-progress-idle-detection-design.md`.
Write a new dated spec that supersedes its recording rule, states the liveness
question, and gives the caller-vs-target predicate with the `--claim-id`
help-text divergence as its evidence. Reference the superseded file by name so a
reader knows which one won.

## Task A2 — Rename: progress → seen

"Progress" _is_ the invented concept. The field means "when this claim's holder
was last seen alive". Free now, expensive after #611 merges: every symbol below
is unmerged, and persisted state needs no migration by policy (CLAUDE.md: never
migrate — reject and prompt), which `67410510a` already does.

`lastSeenAt` over `lastActiveAt`: this codebase already uses "active" for the
session stack (`getActive`, `activeFrameKey`, `defaultStack`), so `lastActiveAt`
would collide with an established meaning.

| Current                                    | New                     | Refs |
| ------------------------------------------ | ----------------------- | ---- |
| `ClaimRecord.lastProgressAt`               | `lastSeenAt`            | 91   |
| `SessionService.recordClaimProgress`       | `recordClaimSeen`       | 25   |
| `ClaimProgressRecordResult`                | `ClaimSeenRecordResult` | 3    |
| `progressedClaimRecord`                    | `seenClaimRecord`       | 3    |
| `CLAIM_PROGRESS_UNREADABLE`                | `CLAIM_SEEN_UNREADABLE` | —    |
| `claimProgressUnreadable` (factory)        | `claimSeenUnreadable`   | —    |
| `__tests__/runbook/claim-progress.test.ts` | `claim-seen.test.ts`    | —    |

`record*` is the house convention (`recordManualCompletion`,
`recordChildCompletion`), so `recordClaimSeen` keeps it. `claim-activity.ts` and
`claimActivity()` **keep their names** — "activity" is the derived idle signal;
"last seen" is the raw fact it derives from. That pairing is correct.

Touches 22 files, including `packages/core/src/schemas.ts:643` (persisted
schema), `packages/core/src/testing/claim-fixtures.ts` (exported fixtures), and
`packages/core/src/errors/{codes,factory}.ts`. Also retitle PR #611, which
currently reads "claim progress foundation — required lastProgressAt…".

## Task A3 — Fix the API contract that Part B reverses

`packages/core/src/runbook/session-service.ts:402-435` — `recordClaimProgress`'s
TSDoc is the root of plan 2's ordering. It currently says:

- _"Record that the holder of a presented bearer claim advanced its controlled
  run"_ — the invented premise, stated as the method's purpose.
- _"Call this ONLY after a claim-authenticated mutation has COMMITTED, and ONLY
  from a mutating path."_ — **the instruction Part B reverses.** Liveness is
  proven at authorization; waiting for the commit adds nothing.

Rewrite both. **Keep**, unchanged in force:

- The AC5 sentence ("a parent cannot vouch for a child's liveness") — it is now
  the _primary_ rationale, not a supporting one.
- The whole lock warning ("CALL ONLY OUTSIDE A HELD SESSION LOCK"), which is
  about lock scope, not commit ordering, and is unaffected by the reorder.
- The RD-102 best-effort/totality argument.

Resolve one live inconsistency while here: the TSDoc's `status` rationale ("a
stuck child polling `rundown status --claim-id` would refresh its own claim
forever") assumes the _child_ polls its own status. The flag's help text says the
presenter is the orchestrator targeting a child. Both may happen; the
caller-vs-target reason covers both and should replace it.

`claim-id.ts:104-115` — the `lastProgressAt` TSDoc, source of the error. Keep its
"deliberately NOT `updatedAt`" argument: one field, one meaning still holds, the
meaning is just different.

---

# Part B — on `claim-progress-recording`, after Part A lands

## Task B1 — Rebase

That branch is **42 commits behind** `claim-progress-idle-detection` — it was cut
from an earlier point, which has since taken a merge from main and several fixes.
It needs the rebase regardless of this plan; do it after Part A so the rename
arrives with it.

## Task B2 — Move recording before the commit

Six call sites, currently recording after the mutation returns:

- `packages/core/src/runbook/lifecycle-command-service.ts` — `runTransition`
  (~:1438), `runTerminal` (~:1467), `issueDelegation` (~:851)
- `packages/core/src/runbook/collection-service.ts` — `recordPresenterProgress`,
  called before both `collection_applied` returns
- `packages/cli/src/helpers/goto-workflow.ts` — after the `sendAndSync` guard
- `packages/cli/src/commands/abort.ts` — after `_lockGuard.release()`

Move each to immediately after grant authorization succeeds and before the
mutation dispatches. The `#issueDelegationInner` / `#runTerminalInner` wrapper
split exists only to observe the _outcome_; once recording no longer depends on
the outcome, collapse the wrappers back into their bodies.

**Re-audit the lock at every moved site — the old audit does not carry over.**
`recordClaimSeen` self-acquires the session lock via `withLock`, and the file
lock is not reentrant: it reclaims only from a _dead_ owner (`kill(pid, 0)` →
ESRCH). Called from inside a held session lock the owner is you, so the acquire
spins its jittered backoff to the full 5s deadline and throws — and the method's
totality converts that into `record-failed`. Symptom: a 5-second stall and a
claim that under-reports, with no error anywhere. The old position (after every
lock scope closed) was audited safe; the new position sits earlier and closer to
where locks are taken. It is plausibly _safer_ — no lock has been taken yet at
authorization — but verify, do not assume.

RD-102 still holds: the method returns a result rather than throwing, so a failed
record cannot block the commit that now follows it. Confirm per site rather than
inheriting the old ordering's argument, which was "it runs last".

## Task B3 — Rewrite the rationale at the call sites

No behaviour change. Every _"Recorded on SUCCESS, not on attempt"_ and
_"`lastProgressAt` means 'the run advanced at T'"_ is wrong.

- The six call-site comments.
- `packages/cli/__tests__/helpers/claim-progress-drift-guard.test.ts:313-332` —
  the three `reason` strings, all citing advancement, plus the classification
  comment at :366-369 ("does it change runbook workflow state"). Replace with
  caller-vs-target, citing the help-text divergence. Rename the file to
  `claim-seen-drift-guard.test.ts`; `backdateClaimProgress` in
  `__tests__/helpers/test-utils.ts` becomes `backdateClaimSeen`.
- The delegation site (~:843) separately argues `already-delegated` records
  nothing because it "commits nothing new". Under liveness the presenter was
  alive. **Decide explicitly**: either it records (consistent with liveness) or
  it needs a caller-vs-target reason. Do not leave the advancement reason
  standing.
- Retitle `61988f6a0` — "record claim progress on every command that changes
  runbook workflow state". No PR is open on that branch yet, so history is still
  rewritable; do not ship the wrong reason into it.

## Task B4 — Fix the tests the premise got wrong

`packages/core/__tests__/runbook/claim-progress.test.ts`:

- _"a failed mutation does NOT record"_ — **invert it.** A verified bearer whose
  mutation then fails still proved its holder alive. This is the observable
  behavioural change in the whole plan.
- **Add**: a _refused_ mutation from a verified bearer (e.g.
  `open_delegated_children`) records. Nothing currently pins this.
- The RD-102 non-masking test stays — still true, now because the record precedes
  the commit rather than trailing it.
- The `status` non-recording test stays green; update its comment to the
  caller-vs-target reason.

## Task B5 — Open plan 2's PR

Only once #611 has merged, so the diff is plan 2 alone.

---

## Verification

- `pnpm run verify` on each branch — the pre-PR gate. Must exit 0.
- After Task A2:
  `grep -rn "lastProgressAt\|recordClaimProgress" --include='*.ts'` returns
  nothing; the only surviving mentions are in the dated plan/spec files that
  record the history.
- `pnpm --filter @rundown-org/core exec jest __tests__/runbook/claim-seen.test.ts`
- `pnpm --filter @rundown-org/cli exec jest __tests__/helpers/claim-seen-drift-guard.test.ts`
  — the guard must hold its full count. Its scan comes from the real
  `createProgram()`, so a changed _reason_ must not change the _classification_.
  If it does, the reason was load-bearing and something is wrong.
- **Probe the reorder bites**: make the commit throw _after_ authorization at one
  seam; assert the mark still moved. Watch it fail against pre-move code, then
  revert the probe. A reorder no test can distinguish is a reorder not made.
- **Probe the lock audit**: at each moved site assert the returned result is not
  `record-failed`. A silent 5s stall is indistinguishable from success from the
  outside, so inspection alone cannot close this.

## Provenance

Written after a CodeRabbit review of plan 2 surfaced three "records without
advancing" paths, which escalated toward a core union refactor before the
premise — that advancement was ever the question — was checked and found to be
self-inflicted, introduced by `67410510a`'s TSDoc and inherited unexamined by
everything after it. The review finding is real behaviour, correctly observed,
and not a defect.
