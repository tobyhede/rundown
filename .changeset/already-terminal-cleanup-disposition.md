---
'@rundown-org/core': minor
'@rundown-org/cli': minor
---

# A refused already-terminal chain cleanup is no longer reported as success

The bare `complete` / `stop` path reports `already_terminal` when the resolved
inline-cascade root was already terminal on entry. Such a run has no terminal
state write left to make, so the fenced chain release is the _only_ effect the
command owes: it drops the chain out of `session.defaultStack` and revokes the
descendant claims.

Two of the three call sites of `SessionService.releaseAlreadyTerminal` discarded
that release's answer. Both checked only that the envelope was `committed` and
then returned `already_terminal` regardless of the value inside it — so a
committed `claim_rotated` or `determination_lost` (the fence refusals, which
commit _nothing_) was silently dropped. The whole inline chain stayed targeted
with its descendant claims un-revoked, and the caller was told the command had
succeeded. On the capture-time arm the outcome was worse than misleading: that
arm's aggregate returns write-free, so on a lapsed fence nothing at all happened
for the command — no force, no release — yet the result was byte-for-byte a
clean teardown.

The rotation window is reachable in practice, not just in tests: run control is
re-minted for a resumed inline child, and a concurrent `rundown prune` removes
claims for pruned children. `determination_lost` is not an authority question at
all — an _ambient_ caller with no claim can hit it when the root is pruned
between plan resolution and the release transaction, and was then told
`already_terminal` for a run that no longer exists, at exit 0.

The disposition is now part of the outcome. The `already_terminal` member of
`LifecycleTerminalOutcome` carries a required `cleanup: AlreadyTerminalCleanup`
— `released`, `not_attempted`, or `refused` with the fence refusal passed
through as itself. Being required is the point: dropping it is a compile error
rather than a review finding, and the aggregate's generic is narrowed to a
`cleanup`-free outcome so the `beforeEffect` boundary — which runs before the
release is attempted and genuinely cannot know the answer — cannot assert one.

`not_attempted` also closes a pre-existing blind spot of the same shape: an
unauthorized bearer's cleanup skip was just as invisible in the outcome as the
new refusals, and now reads as its own disposition.

CLI behaviour changes for the refused arm only. `rundown complete` /
`rundown stop` now render a refused cleanup as an error envelope with a non-zero
exit — `CLAIMED_RUNBOOK_UNAVAILABLE` for a rotated claim,
`RUN_TARGET_UNAVAILABLE` for a lost determination. Both are permanent for the
presented authority, so neither uses the `CONCURRENT_MODIFICATION` "Retry."
vocabulary, which would be a lie for a claim that can never be authority again
or a run that no longer exists as resolved. `released` and `not_attempted` keep
the previous idempotent exit-0 `RUNBOOK_NOT_RUNNING` rendering.
