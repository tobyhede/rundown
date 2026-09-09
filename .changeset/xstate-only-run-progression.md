---
'@rundown-org/core': patch
'@rundown-org/cli': patch
---

Delete the legacy CLI progression loop and unfenced actor mutation API so every
supported entry path continues through XState-owned Run Progression under
verified run authority.

Core now decides whether a caller-observed terminal run still owes composition a
turn, and where that turn starts. Only an inline-linked terminal continues — a
delegated child's outcome is recorded against its parent by the same fenced
transaction that applied the terminal — and it re-enters at the already-observed
boundary, so `rundown complete --claim-id` and `rundown stop --claim-id`
announce a claimed child's terminal exactly once instead of emitting a second
`runbook_completed`/`runbook_stopped` on a restarted event sequence. A terminal
that continues with nothing no longer parses its runbook, so a moved or
unreadable child cannot throw after its terminal was already applied and
rendered.

The corrupt-ancestry guard's depth arm now carries the run to prune in its
`details` payload, matching the repeat arm it shares the `INLINE_PARENT_CYCLE`
code with.
