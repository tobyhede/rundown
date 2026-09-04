---
'@rundown-org/core': minor
'@rundown-org/cli': minor
---

The `rundown collect` continuation now runs on a core-owned Run Progression
activation instead of the CLI execution loop. Core exports
`activateRunProgression`, which drives the delegating run through
machine-selected fenced turns under one core-minted, run-bound authority and
returns a closed outcome — `waiting`, `completed`, `stopped`, `refused`, or
`failed` — where every non-terminal arm names the responsible run and carries a
typed reason plus a recovery classification. A command fence lost to a
concurrent writer now reports a typed `refused` outcome
(`CONCURRENT_MODIFICATION`, retryable) while the run stays running and targeted;
the false `runbook_stopped` the old collect follow-on emitted for that refusal
(#849) is gone. Refusal kind→code mappings and frontier refusal messages now
live once in core, and the collection outcome's running arm carries the
progression authority as a required field.
