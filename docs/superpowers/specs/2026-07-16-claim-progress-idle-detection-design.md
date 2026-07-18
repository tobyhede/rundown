# Claim Progress and Idle Detection Design

Issue: #519 (leaf of cluster #565, R4 Capability Tier; epic #564)

## Context

A delegated child holds a bearer claim and is expected to reach `rundown pass/fail --claim-id` before its turn ends. When that assumption breaks, the parent sees only `state: "claimed"` / `unresolved: 1` — identical whether the child is working, stuck, or gone. This is cluster #565's third exit criterion, and the only one still untouched.

Two failure modes share the symptom. A **live child that yields mid-protocol** is child-side and belongs to #470 (open), whose `SubagentStop` hook would structurally prevent it once fixed. A **genuinely dead child** fires no hook at all, so #470 cannot cover it even when delivered. This design addresses only the second.

Observed occurrence (2026-07-02): a session running the planning pipeline ended entirely while its dispatched `write-plan` child held claim `rdclm_v1O2iBnoxkc0f1IPU6eBVQ` mid-run. Both parent and child were gone. Recovery worked — a fresh session presenting the bearer drove the orphaned child to completion and the parent collected normally — but only after reading the claim id out of `.rundown/session.json` by hand. That read-model gap was #531 and is now closed: `rundown status` joins claim records onto claimed delegations (`status.ts:43-52`).

So the remaining gap is not recovery, and not observability of the claim id. It is that nothing reports **whether the claim is advancing**.

## Design Decision

Record a per-claim `lastProgressAt` timestamp, refreshed only by successful claim-authenticated mutation. Derive an advisory `idle` label at read time by comparing it to a long threshold. Surface it on `rundown status` and `rundown collect`.

Nothing expires. Nothing is reclaimed. No result is synthesized. The threshold changes only the wording of a report.

### Why not a liveness probe

A file lock is held by a live process for the lock's whole lifetime, which is why `acquireFileLock` records a PID and `kill(pid, 0)` is meaningful (`file-lock.ts:83`). A claim is not like that. It is held by an *agent* across transient CLI invocations — `rundown pass --claim-id` starts, mutates, exits. Nothing holds a process between commands, so a PID recorded at claim time would name a process already dead milliseconds later. In the observed occurrence the holder was an agent session that ended, possibly not even on the same host.

`kill(pid, 0)` has no referent here. CLAUDE.md's prohibition on age-based expiration is textually scoped to file locks because its precondition — a live process to signal — is absent for claims. The prohibition's *purpose* (never reclaim a resource from a holder that may be alive) binds fully, and this design honours it by never reclaiming at all.

### Why an advisory label is sufficient

There is no daemon. The orchestrating agent is always the delegating origin, and it only exists while running a command. Nothing can reap claims in the background, so every signal is necessarily pull: the parent learns a claim is idle when it next asks. "Auto-recovery" would collapse into "the parent, on its next command, is told the claim is idle and decides" — which is reporting with a threshold, not automation.

This is what makes a long threshold safe. Idle is indistinguishable from working: a child mid-build for forty minutes emits exactly what a crashed child emits — nothing. If the threshold expired anything, a wrong guess would destroy live work. Because it only classifies, a false positive costs one wasted check.

Kubernetes reached the same conclusion for Deployments: `progressDeadlineSeconds` (default 600s) sets `Progressing=False` / `ProgressDeadlineExceeded`, and "Kubernetes takes no action on a stalled Deployment other than to report a status condition" — the controller keeps retrying past the deadline. PostgreSQL likewise reports `pg_stat_activity.state = 'idle'` with `state_change`, and leaves termination to a separate explicit action.

## Naming

Terms were chosen against prior art, and two obvious candidates rejected.

**"Heartbeat" is rejected.** A heartbeat is periodic, deliberate, and exists to assert liveness. What we record is aperiodic, incidental, and a side effect of real work. Naming it "heartbeat" would send a reader looking for a keepalive protocol, fail to find one, and invite them to add a periodic ping — reintroducing the rejected design.

**"TTL" / "expiry" is rejected.** A time-to-live is a countdown to death. Nothing dies at this threshold; only a report changes wording. "TTL" is the phrase most likely to lure someone into `if (expired) reclaim()`.

**"Suspect" (SWIM) is rejected.** SWIM runs alive → suspect → confirm, and earns "suspect" because it *probed and got no answer*. We never probe; we only notice silence we never asked a question to provoke. A child grinding through a build is not suspicious, it is busy. We have earned the observation, not the inference.

| Concept                        | Name                              | Prior art                                                |
| ------------------------------ | --------------------------------- | -------------------------------------------------------- |
| Timestamp of last progress     | `lastProgressAt`                  | Kubernetes "progress" vocabulary                         |
| Threshold before reporting idle | `idleAfter`                       | dbt source freshness `warn_after`                        |
| Derived advisory label         | `idle: boolean`, `idleFor`        | PostgreSQL `pg_stat_activity.state` / `state_change`     |
| Child whose record is corrupt  | `unreadable`                      | —                                                        |

Kubernetes names its timestamp `lastUpdateTime`; we deliberately do not, because "update" means *record write*, not *progress* — the conflation this design avoids (see Claim Shape).

`idle` also avoids a local collision: `stale` is taken by `stale_claim` (meaning the claim's run is unavailable, `CLAIMED_RUNBOOK_UNAVAILABLE`), and Kubernetes' informal "stalled" sits two characters from "stale" with a different meaning. `idle` is unambiguous here, and is the issue's own word.

## Claim Shape

`ClaimRecord` (`claim-id.ts:89`) gains one required field:

```typescript
/** ISO timestamp when the holder last advanced the controlled run. */
readonly lastProgressAt: string;
```

Set at claim creation, equal to `issuedAt`.

**Required, not optional.** An optional field with a fallback is legacy-field hydration, which CLAUDE.md forbids.

**Not a reuse of `updatedAt`.** `updatedAt` means "this record was last written" — a generic write timestamp whose only current writer is `unstashForClaimId` (`session-service.ts:1060`). It coincides with progress today only by accident. The day an unrelated claim write is added (revoking a grant, re-scoping), it would silently refresh the idle clock and a dead claim would read as live — a safety signal corrupted by an unrelated feature, with no type error to catch it. One field, two meanings, is the conflation the type-safety principle exists to prevent. `updatedAt` keeps its existing meaning and is left alone.

**This breaks existing persisted sessions.** Per CLAUDE.md that is acceptable and preferred over compatibility code. `loadSession` already carries the enforcement pattern — a structural guard (`state.ts:773`) throwing *"Legacy session ownership format detected. Finish or prune active runbooks and restart."* An analogous guard rejects sessions whose claims lack `lastProgressAt`, with the same error shape and the same recovery path: finish, prune, or restart. No migration, no shim, no warning-only adapter.

## Recording Progress

Recorded in `SessionService`, inside the session-lock scope that claim-authenticated mutations already take. `unstashForClaimId` (`session-service.ts:1023`) is the existing template: `withLock` → verify bearer → `refreshedClaimRecord` → `saveSession`.

**A command refreshes only the claim it presents.** Progress is a property of a single claim and its holder. `rundown pass --claim-id <child-claim>` refreshes the child's claim; `rundown collect --claim-id <orchestrator-claim>` refreshes the orchestrator's own claim, **not** the child's. No command ever refreshes a claim it did not present a bearer for — a parent cannot vouch for a child's liveness, and must not appear to.

**Every successful claim-authenticated command that changes runbook workflow state records progress.** This is a rule, not an enumerated allow-list, because a list has to be remembered. A command added later that forgets to record fails *invisibly*: no test fails, no type error, and the only symptom is a claim reading idle while it is actually advancing — a spurious "go check on this" that nobody can trace back to a missing line in a command file. A safety signal quietly degrading into noise is how the feature loses the reader's trust, and it is exactly what an allow-list invites.

"Changes runbook workflow state" is the predicate, not "mutates". The `--claim-id` surface is eleven commands in three categories:

| Category                              | Commands                                                       | Records |
| ------------------------------------- | -------------------------------------------------------------- | ------- |
| Changes runbook workflow state        | `pass`, `fail`, `complete`, `stop`, `collect`, `delegate`, `goto`, `abort` | Yes     |
| Changes session targeting only        | `stash`, `pop`                                                 | No      |
| Changes nothing (read-only)           | `status`                                                       | No      |

The eight are the codebase's own mutating-command list — the seven pinned by the `--run` registration drift guard at `run-option.test.ts:50`, plus `abort`, which is claim-authenticated and mutating (`abort.ts:59`) but sits outside that guard's scope because it takes a token argument rather than `--run`.

**`stash` and `pop` fail the predicate — they are not exceptions to it.** The anti-fooling invariant is why the predicate is worded as it is, and that wording is why these two fall outside the rule with no carve-out needed. Both are claim-authenticated mutations (`stash.ts:19`, `pop.ts:59`), so a rule keyed on "mutation" alone would sweep them in. But `lastProgressAt` means the holder advanced the *controlled run*, and stashing advances session *targeting* — the run itself is untouched. Recording them would reopen precisely the hole that disqualified the rejected verify-path design: a child looping `stash`/`pop` would refresh itself alive forever without advancing anything, faking liveness through a mutating command instead of through a read. Same defect, different door. Corroboration: `unstashForClaimId` already moves `updatedAt` (`session-service.ts:1060`) — the field this design deliberately leaves alone, precisely because it means "record written", not "run advanced".

**Recording on a claim-terminating command (`complete`, `stop`, `abort`) is deliberately not special-cased away.** It is a redundant write to a claim leaving the reportable population: it costs nothing, and it buys a predicate with no exceptions to remember.

**`rundown status --claim-id` does not record.** It is claim-authenticated but read-only: a stuck child polling its own status would otherwise refresh its claim forever and never report idle — a false negative on precisely the case being detected. Only real workflow progress refreshes the mark, so the signal cannot be fooled. This also keeps `verifyClaimId` (`session-service.ts:361`) read-only and lock-free, as designed.

**A fail-closed drift guard pins all eleven, in both directions.** Modelled on `run-option.test.ts:50` ("so a future command cannot silently miss the flag"), a test classifies every claim-authenticated command and asserts each records or does not, per its category.

**The anchor is a `--claim-id` scan of the real program** — `createProgram()` (`cli.ts:72`), the same factory the shipped binary uses — set-equal against the classification table. Sourcing the scan from the real program is the whole guarantee, and is not a detail of construction: a guard that builds its program by registering the same table it then compares against is **tautological**. Both sides shrink together, a new `rundown foo --claim-id` is never registered and never classified, and the suite stays green while the hole opens. The scanned surface must be independent of the guard's own knowledge, or the guard is theatre.

**`RoleSpecificMutationCommand` is a cross-check, not the definition.** An earlier revision of this spec named that union (`subprocess-mutation-boundary.ts:33`) "core's own mutating-command definition" and made it an anchor. That was wrong. Its TSDoc (`:27-32`) defines a **subprocess-trust** concept — "commands whose only available trust is the bare direct-CLI lane" — and its overlap with the eight is a coincidence that is **already imperfect**: `abort` records but is not a member. Binding the two would give one type two meanings — the same conflation this design rejects for `updatedAt` / `lastProgressAt` — and would let the union drift the guard for subprocess-trust reasons unrelated to idle detection. It survives only as a containment check: every member should be classified somewhere.

The guard must be *proven to bite*, via revert-after probes that include **adding a new `--claim-id` command** and confirming it surfaces as unclassified. That probe is the one a self-fed scan cannot pass, and it is the case the guard exists for.

The guard is what makes the rule enforceable rather than aspirational, and it is why the recording *seam* may differ per command without risk. This is load-bearing in one direction only: with an inert guard there is no guarantee at all, and the CLI silently owns the policy decision of when progress is recorded. The sanction below for the CLI-side seams is therefore **conditional on the guard being real**. `goto` and `abort` commit their mutations in the CLI (`goto-workflow.ts:309` via `sendAndSync`; `abort.ts:203` via `manager.update`) — their core services are authorization gates that return `authorized`/`refused` and mutate nothing — so those two dispatch into the core recording API from the CLI, which CLAUDE.md permits since the CLI is calling a core API rather than re-implementing one. Restructuring those seams is out of scope for #519. **The guard, not the seam's uniformity, is the guarantee.**

**Recorded on success, not on attempt.** A child whose `rundown pass` fails validation proved it is alive but did not advance the run. The field means "the run advanced at T". A live-but-erroring child correctly reads as idle — a true positive worth surfacing.

**Recording is best-effort and never masks the mutation.** The run mutation writes `.rundown/runs/` under `RunStateLock`; the claim lives in `session.json` under `SessionLock`. Different files, different locks, no atomicity. Progress is recorded *after* the mutation commits, and a failure to record is swallowed, never propagated — the RD-102 policy already applied to lock release, where a failed release "can never mask this committed result". Failing to record under-reports progress, costing one spurious idle report and one wasted check. Failing a user's `rundown pass` because a bookkeeping write hiccuped would be indefensible.

Ordering is therefore: verify bearer → authorize grant → commit mutation → best-effort record progress.

## Derived Activity

New module `packages/core/src/runbook/claim-activity.ts`. (`claim-id.ts` already carries the bearer, hashing, grant, and authorization primitives; this is a separate concern with its own seam.)

```typescript
export interface ClaimActivity {
  readonly lastProgressAt: string;
  readonly idleFor: DurationMs;
  readonly idle: boolean;
}

export function claimActivity(
  record: ClaimRecord,
  now: Date,
  idleAfter: DurationMs,
): ClaimActivity;
```

Pure — no I/O, no clock read, `now` injected — so it is trivially unit- and property-testable, and cannot drift with wall-clock behaviour in tests.

**A readonly interface, not a discriminated union.** An earlier revision specified a two-member `progressing` | `idle` union "per type-driven dispatch". That was ceremony, not type safety: the variants carried **identical** fields, so no caller could narrow to anything, and every consumer flattened it straight back to `activity.kind === 'idle'` — a boolean in costume, contradicted by this spec's own naming table (`idle: boolean`). Type-driven dispatch means unions whose variants carry different data and therefore *force* narrowing. The union that earns its keep here is `ChildActivity`, below.

**An unparseable `lastProgressAt` throws `RundownError` with `CLAIM_PROGRESS_UNREADABLE` (RD-824).** Date arithmetic on a corrupt timestamp yields `NaN`, and every `NaN` comparison is false — so `idleFor > idleAfter` would be false and a dead claim would silently classify as not idle. That is the single worst failure this design can have: a safety signal that fails *open*, quietly, in exactly the case it exists to catch. Throwing is also the consistent reading of the reject-invalid-persisted-state stance: corrupt state is rejected, never interpreted.

The error is **typed**, not a bare `Error`, because `durationMs` throws a bare `Error` from the same function: with both untyped, only a message substring separates them, and a harmless reword would silently gut this protection with every test still green. Callers discriminate on the code.

**A corrupt record is contained per child, never swallowed wholesale.** The throw is real, so every read boundary must decide what to do with it — and the tempting shape is the wrong one. Catching around a whole list and returning nothing is a **worse fail-open than the `NaN` this rejects**: one corrupt child erases every genuinely idle sibling from the report, and the parent concludes nothing needs checking. A silently shorter list reads as "fewer children need attention", which is the same fail-open wearing a different hat. Dropping the child from the list is equally wrong for the same reason.

So the boundary derives **per child**, and an unassessable child is reported as such:

```typescript
export type ChildActivity =
  | { readonly kind: 'known'; readonly activity: ClaimActivity }
  | { readonly kind: 'unreadable' };
```

`unreadable` is a first-class member, not an error path: the reader is told this child cannot be assessed — which is itself a reason to look at it — and every other child still renders. This union earns narrowing precisely because `unreadable` has no `idleFor` to read, so a consumer cannot reach a fabricated value without the compiler stopping it. `status`, being read-only, applies the same containment: a corrupt advisory record must never escape as an unhandled error where a JSON envelope is the contract.

This path is reachable, not hypothetical: `z.string().min(1)` admits `'not-a-date'`, and the structural guard in Claim Shape checks key **presence**, not parseability.

`DEFAULT_IDLE_AFTER_MS = 60 * 60 * 1000` (one hour). Kubernetes anchors at 10 minutes for a rollout; a delegated agent step legitimately runs far longer, so the default is deliberately six times more generous. The asymmetry is intentional: reporting idle too late costs a delayed check, while reporting it too early trains the reader to ignore the signal — and an advisory label that is routinely wrong is worse than no label, because it is the one failure mode that cannot be corrected by acting on it. No configuration surface in this change — the default is long enough to be safe, and adding config later is purely additive. YAGNI.

## Surfaces

Both are read-only and derived at read. Nothing is persisted, no machine state is added, no events fire.

**`rundown status`** — the delegations rows already join `claimKey` from #531 and already load `session.claims` (`status.ts:43-52`). Each claimed delegation row gains an `activity` field carrying the same `ChildActivity` union defined above: a `known` member with `lastProgressAt` / `idleFor` / `idle`, or an `unreadable` member for a corrupt record — never both, since an unassessable claim has no idle label to report. The union reaches the wire on this surface exactly as it does on `collect`; it is never flattened into an `activityUnreadable` boolean plus optional fields, which would let a consumer read a missing `idle` as "not idle".

**`rundown collect`** — already reports `unresolved` and is one-shot, not blocking. Each unresolved child carries the same activity data, sourced from `listOpenClaimsForParent` on `CommandTargetReader`, which already returns exactly the unresolved delegated children. A parent resuming after its child's turn therefore sees which children are not progressing without issuing a second command. Note this reports the *children's* activity; the orchestrator's own claim is refreshed by the collect itself, per Recording Progress.

Each entry is a discriminated union on the wire, mirroring `ChildActivity`: a `known` member carrying `lastProgressAt` / `idleFor` / `idle`, or an `unreadable` member carrying only the child's identity. An agent reading this narrows on `kind` rather than trusting a default — the `unreadable` member deliberately has no `idle` field to misread.

**`unresolvedChildren.length` may be less than `unresolved`.** A pending, not-yet-claimed delegation counts toward `unresolved` but has no claim record and therefore no activity data. This is correct — an unclaimed delegation has no holder whose progress could be measured — and the two fields must not be assumed equal by consumers. The output schema documents the distinction. A corrupt claim, by contrast, is **never** a cause of this gap: it appears as an `unreadable` entry rather than vanishing from the list.

`idleFor` is milliseconds in JSON, matching `DurationMs`; `--text` renders it humanised. JSON is the contract and the default. `--text` appends to the existing delegation **line** (`text-renderer.ts:296-314`) — that renderer is a line format with no headers, so this is a suffix, not a new column, and the table conventions in CLAUDE.md's CLI Output Standards do not apply to it. `docs/spec/cli-output.md` schemas are updated for both commands.

Recovery is unchanged and already works: **adopt** the claim by presenting its bearer on a mutating command — which self-heals `lastProgressAt`, because a fresh session issuing `rundown pass --claim-id` genuinely is the new live holder making progress — or **abort** via the orchestrator's existing `abort-delegation` grant (`claim-id.ts:75-76`). Adoption via `status --claim-id` alone does not clear idle, and should not: reading a claim advances nothing.

## Non-Goals

- No expiry, no reclaim, no auto-abort.
- No synthesized child PASS/FAIL (explicitly a #574 non-goal).
- No machine state and no events. Idle is a pure function of `(lastProgressAt, now, idleAfter)`; nothing happens at the boundary, and a claim can cross back out of idle simply by the child running a command. Making it a machine state would require a read to write a transition — a state machine whose transitions are caused by observing it.
- No `rundown heartbeat` command.
- No probing.
- No configuration surface.

## Rejected Designs

**Heartbeat on every `verifyClaimId`, including read-only.** A truer "the holder was alive" signal, since any bearer presentation proves liveness. Rejected on two counts: it turns a deliberately read-only, lock-free path into a write, forcing session-lock acquisition on every claim-authenticated inspection; and it is *less* correct, because a stuck child polling `status --claim-id` refreshes its own claim forever and never reports idle.

**Explicit `rundown heartbeat --claim-id`.** Depends on an agent remembering to call it — the same unreliability that produced #519 — and duplicates what mutations already prove.

**PID liveness on claims.** Architecturally inapplicable; see Design Decision.

**Lease/TTL with auto-expiry.** Requires a TTL simultaneously right for a fast crash and a slow build, and being wrong reclaims live work. Also requires a daemon that does not exist.

**Two-tier `warn_after` / `error_after` thresholds (dbt).** More than is needed. One threshold. YAGNI.

## Testing

- **Unit** — `claimActivity` before, after, and exactly at the threshold boundary.
- **Property** — properties must be derived from an **independent oracle**, never restated from the implementation. `expect(activity.idle).toBe(activity.idleFor > idleAfter)` is a tautology: it reuses the implementation's own output to check the implementation, so it holds under *any* mutation of `>` and pins nothing. Compute the expectation from the raw inputs instead. Worthwhile properties: totality over any valid ISO input; `idleFor` monotonic non-decreasing in `now`; monotonic in the threshold (raising `idleAfter` never makes a claim idler); a claim whose progress is at or after `now` is never idle at any threshold.
- **Core integration** — progress recorded on successful claim mutation; **not** recorded on `status --claim-id` (the anti-fooling invariant separating this from the rejected verify-path design); **not** recorded on failed mutation; a session-write failure neither fails nor masks the committed mutation (RD-102-shaped).
- **Drift guard** — fail-closed, modelled on `run-option.test.ts:50`, classifying all eleven claim-authenticated commands and asserting each records or does not per its category. Anchored on a `--claim-id` scan of the real `createProgram()`, set-equal against the classification table, so the scanned surface is independent of the guard's own tables. **Proven to bite** via revert-after probes, which must include adding a new `--claim-id` command and confirming it surfaces as unclassified — the probe a self-fed scan cannot pass. A guard that cannot fail is theatre.
- **Anti-fooling** — `stash`/`pop` do not record: a loop of them must never clear idle, exactly as a `status --claim-id` loop must not.
- **Corrupt timestamp** — an unparseable `lastProgressAt` throws `CLAIM_PROGRESS_UNREADABLE` rather than classifying as not idle (the fail-open case), asserted **on the error code**, not a message substring. At both read boundaries, a corrupt child is reported `unreadable` while its healthy siblings still report normally — the case that pins per-child containment, and the one that fails if a future edit widens the catch around the whole list.
- **Adoption** — a fresh session presenting the bearer on a mutating command clears idle; presenting it on `status --claim-id` does not.
- **Structural guard** — a session whose claims lack `lastProgressAt` is rejected with the finish/prune/restart error, not migrated.
- **CLI** — JSON path first per testing conventions, `--text` covered separately, for both `status` and `collect`.
- **Mutation** — scoped Stryker over `claim-activity.ts`. Per #541's lesson, the test must **statically** import the module, or Stryker's static related-tests graph will not see it and it will score 0.00%.

## Scope Note

This does not distinguish "working" from "gone" — that is unsolvable without a probe, and there is nothing to probe. It distinguishes *progressing* from *not progressing* and hands that to an authority to act on. This satisfies #565's third exit criterion ("parent-side liveness or lease behavior") as a reframing rather than a literal reading: no liveness detection and no lease are possible here, and an advisory progress signal is the most the architecture admits.

## Acceptance Criteria

1. `ClaimRecord.lastProgressAt` exists, is required, and is set to `issuedAt` at claim creation.
2. Sessions whose claims lack `lastProgressAt` are rejected with a finish/prune/restart error; no migration path exists.
3. Every successful claim-authenticated command that changes runbook workflow state refreshes `lastProgressAt` — `pass`, `fail`, `complete`, `stop`, `collect`, `delegate`, `goto`, `abort`. Commands that change only session targeting (`stash`, `pop`), that change nothing (`status`), and mutations that fail, do not.
4. A fail-closed drift guard classifies all eleven claim-authenticated commands and pins the set in both directions, so a command added later cannot silently miss recording or silently start. Its scan is sourced from the real `createProgram()`, never from the guard's own tables, and is proven to bite — including against a newly added `--claim-id` command.
5. A command refreshes only the claim whose bearer it presented, never another claim.
6. An unparseable `lastProgressAt` throws `CLAIM_PROGRESS_UNREADABLE` rather than classifying as not idle.
7. A failure to record progress never fails and never masks the committed mutation.
8. `claimActivity` is pure and takes an injected `now`.
9. `rundown status` and `rundown collect` surface `lastProgressAt`, `idleFor` (milliseconds in JSON), and `idle` for claimed/unresolved delegations, in JSON by default and `--text` when asked.
10. `docs/spec/cli-output.md` documents both output schemas, including that `unresolvedChildren.length` may be less than `unresolved`.
11. Adopting a claim from a fresh session via a mutating command clears idle.
12. No machine state, event, expiry, reclaim, or synthesized result is introduced.
13. `claim-activity.ts` clears the scoped mutation gate via statically-imported tests.
14. A corrupt claim record is contained per child: it is reported as `unreadable`, its healthy siblings still report their activity, and no read boundary catches around a whole list or drops the child. A read-only command never surfaces it as an unhandled error.

## Revision History

Amended in place, per the precedent of `2013cbcbf` and `12146f9b3`: these correct errors in *this* design rather than proposing a new one, so a new dated file would fragment the record rather than clarify it.

**Rev 3 (this revision)** — four independent reviews of the implementation plan found two defects that originate in this spec, not in the plan. Both are recorded here because both were reasoned to confidently and wrongly:

1. **The drift guard's anchors were unsound.** Anchor B, as specified, admitted a construction that can never fail (scan fed by the classification table). Anchor A rested on the claim that `RoleSpecificMutationCommand` is "core's own mutating-command definition" — it is not; it is a subprocess-trust concept, and `abort` already sits outside it, which this spec noticed without drawing the conclusion. This mattered because §Recording Progress stakes the acceptability of the CLI-side `goto`/`abort` seams **entirely** on the guard: an inert guard meant no guarantee at all. Now: anchored on the real `createProgram()`, with the union demoted to a cross-check.
2. **The corrupt-timestamp throw had no specified containment.** This spec argued the fail-open case at length, then left every caller to decide what to do with the throw — and the natural shape (catch around the list, return nothing) is a *worse* fail-open than the `NaN` it rejects, since one corrupt child erases every idle sibling from the report. Now: per-child containment with a first-class `unreadable` member (AC14).

Also corrected: `ClaimActivity` was specified as a discriminated union "per type-driven dispatch" while its variants were identical — a boolean in costume, contradicting this spec's own `idle: boolean` naming table; it is now an interface, and the narrowing-worthy union moved to the read boundary. The AC6 throw is now typed (RD-824) rather than a bare `Error` distinguishable from `durationMs`'s only by substring. The property-test guidance now forbids restating the implementation as an oracle. The `--text` claim that delegations "gain a column" was wrong — that renderer is a line format.

## References

- Kubernetes Deployments — `progressDeadlineSeconds`, `ProgressDeadlineExceeded`: https://kubernetes.io/docs/concepts/workloads/controllers/deployment/
- SWIM protocol — suspect state: https://www.cs.cornell.edu/projects/Quicksilver/public_pdfs/SWIM.pdf
- dbt source freshness — `warn_after` / `error_after`: https://docs.getdbt.com/reference/resource-properties/freshness
- PostgreSQL connection states — `pg_stat_activity.state` / `state_change`: https://www.mydbops.com/blog/postgresql-connection-states
