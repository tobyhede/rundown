---
'@rundown-org/core': major
'@rundown-org/cli': minor
---

# BREAKING: Run Progression owns GOTO and collection re-entry

GOTO and collection no longer start a private CLI execution loop or project a
delegation re-entry frontier themselves. Their core seams return one
`RunProgressionDirective` that binds the verified authority, runbook identity,
and exact parsed graph. The CLI renders the command observation and forwards
that directive verbatim to the shared progression driver.

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
classified by the machine-owned progression path rather than collection.

Persisted run-state schema version 2 records the new XState progression state
IDs. Version 1 snapshots are rejected and must be restarted; no migration is
provided.
