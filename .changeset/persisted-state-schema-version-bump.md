---
'@rundown-org/core': minor
'@rundown-org/cli': patch
'@rundown-org/claude-code-plugin': patch
---

# Move CURRENT_SCHEMA_VERSION, and pin it to the shape it gates

`CURRENT_SCHEMA_VERSION` sat at `1` while the persisted run-state shape gained a
required field three separate times: `StepInlineChild.startedAt` (#746),
`StepInlineChild.started` replacing it (#772), and `RunbookState.prompted`
(#827). The version is the mechanism that refuses state this build cannot read,
so a stationary version means state written by any of those builds is admitted
by the gate and refused somewhere further in — which is a different refusal,
carrying different advice, at each of the two readers.

Measured on `main` against a run persisted mid-inline-launch on a pre-#772 build
(`inline.startedAt`, no `inline.started`):

- `RunbookStateManager.load` → `InvalidRunbookStateError` with
  `reason: 'schema_validation_failed'`. The right class, the wrong diagnosis: it
  says the row failed validation, not that it was written by another build.
- `RunbookStore.readRun` — the in-transaction reader behind every
  `ctx.readState`, and so behind `rundown stash` / `pop` — → a bare `ZodError`
  carrying a schema dump. That is neither of the classes
  `isRecoverableActiveStackError` accepts, so it reaches the CLI as RD-999
  "Unknown error" and a `--claim-id` bearer cannot finish, stop or prune out of
  it.

`CURRENT_SCHEMA_VERSION` is now `2`, which routes both readers onto
`invalid_schema_version` and the finish/stop/prune recovery RD-309 spells. This
is a rejection, not a migration: version `1` state is not read, adapted, or
rewritten.

## The fixtures were the reason nobody noticed

Every fixture wrote `schemaVersion: 1` as a literal, so a stale constant could
not break anything, and "foreign version" fixtures wrote `schemaVersion: 2` —
which the bump would have quietly turned into valid current state, asserting
nothing. Both are now derived: `CURRENT_SCHEMA_VERSION` for state meant to be
readable, `CURRENT_SCHEMA_VERSION + 1` for state meant to be refused. The
constant is barrelled from `@rundown-org/core` so front-end fixtures can name it
too.

## The pairing is now pinned

`packages/core/__tests__/runbook/persisted-state-shape.test.ts` renders both
persisted run-state schemas as a canonical structural string and compares them
against a fixture named for the version they belong to
(`__tests__/fixtures/persisted-state-shape/schema-v2.txt`). Change the shape and
it fails, naming `CURRENT_SCHEMA_VERSION` as the remedy. Verified by reverting
#772's field in `schemas.ts`: the guard fails, and passes again when restored.

No test can force a developer to move a number — rewriting the fixture in place
would work — but the moment is no longer silent, and rewriting a file named for
an already-shipped version is conspicuous in review. That is the difference
between this and the three PRs that landed with nothing to notice.

`SCHEMA_VERSION` in `runbook/storage/schema.ts` stays at `2` and needs no move:
it gates the DDL, `state_json` is opaque TEXT to that DDL, and no commit has
touched the file since before #746. Both constants now carry a note saying which
half of persisted state each one gates, because they are easy to conflate.
