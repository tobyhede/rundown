---
'@rundown-org/core': minor
'@rundown-org/cli': patch
---

# Release the inline launch latch on every failed launch span

`INLINE_LAUNCH_CONSUMED` was the only thing that released the inline launch
latch, so every exit between winning the latch and consuming the intent left it
set: a child that would not prepare, a ref that resolved at intent time and not
at launch time, a consume that threw.

That is not a crash the liveness probe can recover. The record names a pid that
is still running, and `classifyInlineLaunchOwnership` deliberately has no
self-pid exemption — a nested observer inside a live span is also "self" and
must stand down — so the **same process** re-observing its own failed launch
stood down against itself. Permanently: nothing ever cleared the record, and the
diagnostic named the operator's own pid as the process to wait for. This is what
made the inline stand-down reachable single-process, and why a long-lived host —
the MCP server, the plugin, the integration harness — could strand itself on one
bad launch.

New root-level `INLINE_LAUNCH_ABANDONED` event, the mirror of
`INLINE_LAUNCH_CONSUMED`. The asymmetry is the point: consumption drops the
latch **and** the intent, because the launch is over; abandonment drops only the
latch and keeps the intent, because the launch is not over and the surviving
intent is exactly what makes it re-observable. Clearing it here would trade a
permanently-latched launch for a permanently-lost one.

The event carries the latch record its sender wrote, and the machine releases
only while the substep row still holds that exact record — owner pid, owner
start id and instant. `INLINE_LAUNCH_CONSUMED` needs no such gate, because it is
sent by the launch span itself, in its own control flow, having just succeeded.
Abandonment is sent from a disposer: best-effort, fire-and-forget, running after
an arbitrary failure, which is the shape of a sender that may have fallen behind
the state it is acting on. Ungated, the machine would be trusting a rule only
the CLI enforces — that nothing but the winner abandons a launch — and a second
front end would have to rediscover it. The reclaim the gate refuses is not one
the CLI can reach today (a reclaimer must first prove the previous owner dead,
and a dead process runs no disposer), which is the point: the exactly-once
launch stops depending on that being true.

The CLI holds the latch with `await using`. `latchInlineLaunch`'s `won` arm now
carries a `ScopedInlineLatch` — an `AsyncDisposable` with `keep()` — built by
the arm that took the latch, so a `won` the caller could receive without a
scope, and therefore forget to release, is unrepresentable. `keep()` disarms the
disposer after a successful consume, which has already released the latch.
Disposal mirrors `heldLock`: best-effort, idempotent, and never propagating, so
a failed release cannot mask the outcome of the span it wrapped.

This is the one place in the launch path a disposer belongs. The latch has an
owner, an acquire/release lifetime and liveness-based reclamation, and scope
exit covers the failure paths a hand-rolled release would have to enumerate —
including the ones a later change adds. The session activation deliberately does
not use one: its undo is right on failure only, so a forgotten `keep()` there
would pop a running child on the common path.

Releasing on failure does not reopen the exactly-once hazard. The latch is still
taken inside the compare-and-swap, so two observers cannot both win it; and
either the span failed before creating the child — `startRunbook` deletes a run
it created on every failure path through `afterStarted` — or the child exists
with matching linkage and the surviving intent still names it, so the next
observer reads `unlatched` with an `existingChild`, wins, and adopts rather than
creating a second run. The loser of a genuine race still reports
`already-latched`, which is permanent and answers `waiting`, never
`concurrent_modification`.

Covered end to end by an integration test that fails a launch past the latch and
then recovers it in the same process — `runCliInProcess` shares this pid, so the
second gesture is exactly the self-stand-down — and finally performs the launch
once the child's missing input is supplied.
