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

**Only claim-authenticated mutating commands record progress.** `rundown pass/fail/goto/delegate/collect --claim-id` do. Bare read-only commands present no claim and cannot. `rundown status --claim-id` is claim-authenticated but read-only and deliberately **does not** record progress: a stuck child polling its own status would otherwise refresh its claim forever and never report idle — a false negative on precisely the case being detected. Only real progress refreshes the mark, so the signal cannot be fooled. This also keeps `verifyClaimId` (`session-service.ts:361`) read-only and lock-free, as designed.

**Recorded on success, not on attempt.** A child whose `rundown pass` fails validation proved it is alive but did not advance the run. The field means "the run advanced at T". A live-but-erroring child correctly reads as idle — a true positive worth surfacing.

**Recording is best-effort and never masks the mutation.** The run mutation writes `.rundown/runs/` under `RunStateLock`; the claim lives in `session.json` under `SessionLock`. Different files, different locks, no atomicity. Progress is recorded *after* the mutation commits, and a failure to record is swallowed, never propagated — the RD-102 policy already applied to lock release, where a failed release "can never mask this committed result". Failing to record under-reports progress, costing one spurious idle report and one wasted check. Failing a user's `rundown pass` because a bookkeeping write hiccuped would be indefensible.

Ordering is therefore: verify bearer → authorize grant → commit mutation → best-effort record progress.

## Derived Activity

New module `packages/core/src/runbook/claim-activity.ts`. (`claim-id.ts` already carries the bearer, hashing, grant, and authorization primitives; this is a separate concern with its own seam.)

```typescript
export type ClaimActivity =
  | { readonly kind: 'progressing'; readonly lastProgressAt: string; readonly idleFor: DurationMs }
  | { readonly kind: 'idle'; readonly lastProgressAt: string; readonly idleFor: DurationMs };

export function claimActivity(
  record: ClaimRecord,
  now: Date,
  idleAfter: DurationMs,
): ClaimActivity;
```

A discriminated union rather than a bare boolean, per type-driven dispatch. Pure — no I/O, no clock read, `now` injected — so it is trivially unit- and property-testable, and cannot drift with wall-clock behaviour in tests.

`DEFAULT_IDLE_AFTER_MS = 60 * 60 * 1000` (one hour). Kubernetes anchors at 10 minutes for a rollout; a delegated agent step legitimately runs far longer, so the default is deliberately six times more generous. The asymmetry is intentional: reporting idle too late costs a delayed check, while reporting it too early trains the reader to ignore the signal — and an advisory label that is routinely wrong is worse than no label, because it is the one failure mode that cannot be corrected by acting on it. No configuration surface in this change — the default is long enough to be safe, and adding config later is purely additive. YAGNI.

## Surfaces

Both are read-only and derived at read. Nothing is persisted, no machine state is added, no events fire.

**`rundown status`** — the delegations rows already join `claimKey` from #531 and already load `session.claims` (`status.ts:43-52`). Each claimed delegation row gains `lastProgressAt`, `idleFor`, and `idle`.

**`rundown collect`** — already reports `unresolved` and is one-shot, not blocking. Each unresolved child carries the same activity data, joining `session.claims` by `controlledRunId` exactly as `status` does. A parent resuming after its child's turn therefore sees which children are not progressing without issuing a second command. Note this reports the *children's* activity; the orchestrator's own claim is refreshed by the collect itself, per Recording Progress.

`idleFor` is milliseconds in JSON, matching `DurationMs`; `--text` renders it humanised. JSON is the contract and the default; `--text` gains a column. `docs/spec/cli-output.md` schemas are updated for both commands.

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
- **Property** — `idleFor` monotonic in `now`; `kind === 'idle'` iff `idleFor > idleAfter`; total over any valid ISO input.
- **Core integration** — progress recorded on successful claim mutation; **not** recorded on `status --claim-id` (the anti-fooling invariant separating this from the rejected verify-path design); **not** recorded on failed mutation; a session-write failure neither fails nor masks the committed mutation (RD-102-shaped).
- **Adoption** — a fresh session presenting the bearer on a mutating command clears idle; presenting it on `status --claim-id` does not.
- **Structural guard** — a session whose claims lack `lastProgressAt` is rejected with the finish/prune/restart error, not migrated.
- **CLI** — JSON path first per testing conventions, `--text` covered separately, for both `status` and `collect`.
- **Mutation** — scoped Stryker over `claim-activity.ts`. Per #541's lesson, the test must **statically** import the module, or Stryker's static related-tests graph will not see it and it will score 0.00%.

## Scope Note

This does not distinguish "working" from "gone" — that is unsolvable without a probe, and there is nothing to probe. It distinguishes *progressing* from *not progressing* and hands that to an authority to act on. This satisfies #565's third exit criterion ("parent-side liveness or lease behavior") as a reframing rather than a literal reading: no liveness detection and no lease are possible here, and an advisory progress signal is the most the architecture admits.

## Acceptance Criteria

1. `ClaimRecord.lastProgressAt` exists, is required, and is set to `issuedAt` at claim creation.
2. Sessions whose claims lack `lastProgressAt` are rejected with a finish/prune/restart error; no migration path exists.
3. Successful claim-authenticated mutation refreshes `lastProgressAt`; failed mutation and `status --claim-id` do not.
4. A command refreshes only the claim whose bearer it presented, never another claim.
5. A failure to record progress never fails and never masks the committed mutation.
6. `claimActivity` is pure, takes an injected `now`, and returns a discriminated union.
7. `rundown status` and `rundown collect` surface `lastProgressAt`, `idleFor` (milliseconds in JSON), and `idle` for claimed/unresolved delegations, in JSON by default and `--text` when asked.
8. `docs/spec/cli-output.md` documents both output schemas.
9. Adopting a claim from a fresh session via a mutating command clears idle.
10. No machine state, event, expiry, reclaim, or synthesized result is introduced.
11. `claim-activity.ts` clears the scoped mutation gate via statically-imported tests.

## References

- Kubernetes Deployments — `progressDeadlineSeconds`, `ProgressDeadlineExceeded`: https://kubernetes.io/docs/concepts/workloads/controllers/deployment/
- SWIM protocol — suspect state: https://www.cs.cornell.edu/projects/Quicksilver/public_pdfs/SWIM.pdf
- dbt source freshness — `warn_after` / `error_after`: https://docs.getdbt.com/reference/resource-properties/freshness
- PostgreSQL connection states — `pg_stat_activity.state` / `state_change`: https://www.mydbops.com/blog/postgresql-connection-states
