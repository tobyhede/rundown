---
'@rundown-org/core': major
'@rundown-org/cli': minor
---

# BREAKING: Run Progression owns GOTO and collection re-entry

GOTO and collection no longer start a private CLI execution loop or project a
delegation re-entry frontier themselves. Their core seams return one
`RunProgressionDirective` that binds the verified authority and the exact parsed
graph. The CLI renders the command observation and forwards that directive
verbatim to the shared progression driver, on the emitter it already bridged for
its own observation, so one `seq` counter covers the whole command.

The compiled XState machine now selects ordinary entry, fenced frontier
projection/consume, and projected-frontier entry through explicit states. A
frontier bearer is carried only in transient actor output and is emitted after
the SQLite-fenced consume commits; it is never persisted. Projection mismatch,
consume contention, claim supersession, recovery, aggregate recovery, and a
missing run remain distinct typed refusals rather than being converted to a
synthetic stopped lifecycle.

Collection commits only its completion domain. A running result always carries
the same opaque progression directive, including the zero-apply case, so
collection has no second frontier owner or sentinel continuation branch.

Post-consume entry failures remain the permanent RD-833 recovery condition, now
classified by the machine-owned progression path rather than collection. The
same render failure on the ordinary entry state — which consumed nothing — is
the new retryable `RD-504` (`RUN_PROGRESSION_ENTRY_FAILED`) instead of escaping
the actor undiagnosed as RD-999 "Unknown error". One entry actor, one diagnosis;
the codes separate the condition, not the fault.

When another writer replaces the selected frontier before the fenced capture,
progression re-derives against the row that writer committed. That re-derive
makes no progress on its own, so it is bounded by the store's own exported
compare-and-swap budget and pacing, and reports `CONCURRENT_MODIFICATION` once
the budget is spent rather than spinning.
