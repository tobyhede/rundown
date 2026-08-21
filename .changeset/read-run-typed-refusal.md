---
'@rundown-org/core': patch
---

# Refuse a schema-invalid run row in the loader's taxonomy at both readers

`packages/core/src/runbook/persisted-state-guards.ts` claims its two callers
"share one order, one taxonomy, and one message by construction rather than by
convention". That held for the three pre-parse gates and stopped holding one
line later, at the parse itself:

- `RunbookStateManager.load` used `safeParse` and reframed a failure as
  `InvalidRunbookStateError` with `reason: 'schema_validation_failed'`.
- `RunbookStore.readRun` used `stateSchema.parse(raw)`, which throws a bare
  `ZodError`.

`readRun` is the store's only validating read, so every in-transaction reader
went through it — `ctx.readState`, and so `rundown stash` / `pop` on both their
bare and `--claim-id` paths. `ZodError` is neither class
`isRecoverableActiveStackError` accepts nor an arm `toRundownError` classifies,
so it reached the operator as RD-999 "Unknown error" carrying a schema dump, and
`complete` / `stop` / `prune` — which all branch on refusal class — could not
clear the run it named. That is the exact failure mode the gates exist to
prevent, surviving one line past them (#828).

## What changed

`parsePersistedRunState` is the structural parse both readers now call, and it
raises `InvalidRunbookStateError` / `schema_validation_failed` for the run it
refuses. `loadRun`, `listRuns`, and `readRunWithVersion` no longer document a
`ZodError` escape, because they no longer have one.

The two named-field refusals that lived in `load` — `missing_template_vars` and
`missing_prompted` — moved into `assertLoadablePersistedRun` alongside the three
gates, so the store reports them by name too. Neither is a new refusal at that
seam: both fields are required by the schema, so those rows were already refused
there, just as the unclassified `ZodError`. `load`'s own order and messages are
unchanged.

## What this does not change

No migration, fallback parse, or default is introduced: a refused row is left
exactly as persisted, and the recovery path is still explicit user action —
finish, stop, prune, or restart (CLAUDE.md § State Persistence). The population
that reaches the parse is unchanged too; only the shape of its refusal moved.
