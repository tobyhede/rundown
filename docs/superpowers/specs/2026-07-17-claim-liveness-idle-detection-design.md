# Claim Liveness and Idle Detection Design

Issue: #519 (leaf of cluster #565, R4 Capability Tier; epic #564)

## Supersession

This design supersedes the recording rule and progress vocabulary in
[`2026-07-16-claim-progress-idle-detection-design.md`](2026-07-16-claim-progress-idle-detection-design.md).
Where that design asks whether a claim advanced its controlled run, this design
asks the question #519 needs answered:

> **Is the claimant still alive?**

The earlier design remains the historical record. Its unchanged decisions still
apply: idle is advisory, claims are neither expired nor reclaimed, one unreadable
child cannot hide its siblings, and the reporting surfaces remain `status` and
`collect`. This document replaces its definition of what the timestamp means,
when it is recorded, and the names derived from that meaning.

## Context

A delegated child holds a bearer claim while it works. If the child disappears,
the parent can observe the claim but cannot tell whether its holder is still
alive. The useful raw fact is therefore not that the run changed. It is that the
claim holder presented the bearer as authority and core verified it against an
authorized grant.

An authorized bearer presentation proves liveness at authorization time. The
following mutation may advance the run, be refused by workflow policy, or fail
after authorization; none of those outcomes can undo the observation that the
claimant was alive to present its secret. Recording only successful advancement
would misclassify a live claimant that is refused or encounters an error, and
would impose an `advanced` concept that #519 neither requests nor needs.

This remains an idle-reporting design, not a progress monitor. Silence after the
last sighting is ambiguous: the claimant may be gone, or may be alive and doing
long-running work without invoking Rundown. The derived idle signal tells the
parent when to investigate. It does not diagnose the cause.

## Design Decision

Record a required per-claim `lastSeenAt` timestamp when the claim's holder
presents its bearer as authority and the bearer and relevant grant are verified.
Derive advisory idle activity at read time by comparing `lastSeenAt` to the idle
threshold.

The recording predicate is about **caller versus target**:

- Record when the presenter is the claim holder using its own bearer as
  authority for the operation.
- Do not record when the presenter names another actor's claim only to select
  that claim's run as the target.

Recording happens after bearer and grant authorization, before the subsequent
mutation outcome is known. A verified presentation is recorded whether that
mutation later advances, refuses, or fails. Recording remains best-effort: a
bookkeeping failure must not block or mask the command's real outcome.

No lifecycle or transition union gains an `advanced` discriminator. Liveness is
already established by verified authority, so inspecting the later transition
outcome would add the wrong dependency.

## Caller Versus Target

The `--claim-id` command surface already exposes two meanings in its help text.
The eight recording commands describe the flag as bearer authority for the
presenter's operation. The three non-recording commands describe it as
`Target a claimed delegated child runbook`.

| Meaning of `--claim-id` | Commands | Records `lastSeenAt` |
| ----------------------- | -------- | -------------------- |
| Holder presents its own bearer as authority | `pass`, `fail`, `complete`, `stop`, `collect`, `delegate`, `goto`, `abort` | Yes |
| Caller selects another actor's claimed run | `status`, `stash`, `pop` | No |

The authority wording is command-specific where the holder controls a different
resource: for example, `delegate` uses bearer authority for the run that issues
the delegation, while `abort` uses bearer authority for the parent run that owns
the delegation. These remain presentations by that authority's holder. By
contrast, the shared target-selector wording on `status`, `stash`, and `pop`
does not establish that the selected child's holder is the caller.

This preserves the existing eight-record / three-do-not-record classification.
Only its rationale changes. The earlier "changes runbook workflow state"
predicate is superseded.

### AC5: under-report rather than accept borrowed liveness

A parent may legitimately inspect, stash, or pop a child's claimed run. That
proves the parent is alive; it says nothing about the child. Refreshing the
child's mark on those target-selector paths would allow an active parent to keep
a dead child looking alive. AC5 therefore requires that a command refresh only
the claim whose holder presents it as authority: a parent cannot vouch for a
child's liveness.

When attribution is uncertain, under-report. A missed sighting can cause a
spurious idle report and prompt an investigation. A sighting falsely attributed
to the holder can suppress the only warning that the holder has disappeared.

Automatic recording inside read-only bearer verification is unsuitable for the
same reason. The verification primitive can prove that a supplied bearer is
valid, but target-selector surfaces also verify bearers without proving that the
holder presented them. Recording inside that shared read-only path would erase
the caller-versus-target distinction and let `status`, `stash`, or `pop` refresh
a child's liveness. Recording must remain at seams that know the claim is being
presented as the caller's authority.

## Claim Shape and Vocabulary

`ClaimRecord` gains the required raw observation:

```typescript
/** ISO timestamp when the claim holder was last seen presenting its bearer as authority. */
readonly lastSeenAt: string;
```

It begins at `issuedAt`: issuance is the first point at which the claimant is
known to be alive. It is deliberately separate from `updatedAt`, which remains
the generic timestamp for the last write to the record. An unrelated record
write must not refresh the liveness mark.

The liveness vocabulary is:

| Concept | Name |
| ------- | ---- |
| Persisted holder sighting | `lastSeenAt` |
| Best-effort recording API | `recordClaimSeen` |
| Recording result | `ClaimSeenRecordResult` |
| Pure record refresher | `seenClaimRecord` |
| Unreadable timestamp error code | `CLAIM_SEEN_UNREADABLE` |
| Unreadable timestamp error factory | `claimSeenUnreadable` |

`claimActivity` keeps its name because activity is the **derived idle signal**,
not the raw observation. Its timestamp input is `lastSeenAt`; its `idleFor` and
`idle` outputs retain their advisory meanings. The `updatedAt` field also keeps
its independent record-write meaning.

An unparseable `lastSeenAt` is rejected with `CLAIM_SEEN_UNREADABLE` rather than
silently treated as active. Read surfaces continue to contain that failure per
child as unreadable activity so one corrupt record cannot erase valid idle
signals for its siblings.

## Persistence

`lastSeenAt` is required, not optional. Existing persisted sessions whose claim
records lack it are incompatible and are rejected with the established recovery
path: finish, stop, prune, or restart from the source runbook.

There is no migration from `lastProgressAt`, no fallback parser, legacy-field
hydration, compatibility shim, or warning-only adapter. This follows the project
policy that persisted runbook state is rejected rather than migrated when its
shape changes.

## Scope Boundary

Issue #519 reports silence from a claimant that may be gone. It provides an
advisory reason for the parent to investigate or use an explicitly authorized
recovery operation. It does not decide that the claimant is dead, expire its
claim, reclaim its work, or synthesize a result.

A claimant can also be alive but stalled: it may be waiting, looping, repeatedly
refused, encountering failures, or performing long work between Rundown
commands. A recent `lastSeenAt` establishes liveness but not forward progress;
an old one establishes silence but not death. Prevention or diagnosis of
live-but-stalled work remains separate from #519.

Issue #613 also remains separate. Its concerns may share the caller-versus-target
axis, but this design does not broaden #519 to change #613's behavior or scope.

## Acceptance Criteria

- The raw timestamp answers whether the claim holder was last seen alive, not
  whether its run advanced.
- An authorized bearer presentation records a sighting before the following
  mutation's advance, refusal, or failure is known.
- The same eight commands record and the same three commands do not record.
- The classification is pinned to authority presentation versus target
  selection, including the `--claim-id` help-text divergence.
- A parent cannot refresh a child's sighting through `status`, `stash`, or
  `pop`, and shared read-only verification does not record automatically.
- The implementation uses `lastSeenAt`, `recordClaimSeen`,
  `ClaimSeenRecordResult`, `seenClaimRecord`, `CLAIM_SEEN_UNREADABLE`, and
  `claimSeenUnreadable`; `claimActivity` and `updatedAt` retain their distinct
  meanings.
- No lifecycle union or transition outcome gains an `advanced` discriminator.
- Idle remains advisory and does not conflate a gone claimant with live but
  stalled work.
- Incompatible persisted state is rejected rather than migrated.
- #613 remains out of scope.
