---
'@rundown-org/core': patch
---

# Unparseable `state_json` is refused as RD-309 on every read seam

A run whose persisted `state_json` is not valid JSON is invalid persisted state:
the CLI reports it as RD-309 with reason `unparseable_json` and names the prune
recovery. Only `RunbookStateManager.load` did that. It caught the `SyntaxError`
itself, so every other reader of the row let the bare error escape, and the CLI
could only render it as RD-999 "Unknown error".

The token lookup was one of those readers. `pass`, `goto`, `stop`, `complete`
and `prune` with `--token` all resolve the run through
`findRunByOwnerTokenHash`, so each reported RD-999 for the same row that
`status --run` correctly reported as RD-309. `loadRunWithVersion` had the same
gap.

The refusal now lives where the JSON is parsed. `assembleRaw` in the run store
takes the run id and throws `InvalidRunbookStateError` with
`{ runId, reason: 'unparseable_json' }`, so every row reader refuses the row the
same way: `loadRun`, `loadRunWithVersion`, `findRunByOwnerTokenHash`,
`listRuns`, `readRunJson`, and the in-transaction `readState` /
`readStateWithVersion`. `RunbookStateManager.load` drops its own wrapper and its
duplicate gates and delegates to `RunbookStore.loadRun`, which applies the same
gates and structural parse.

Nothing is repaired or adapted. The row is refused and left as it is, and the
recovery is still to prune the run.
