---
'@rundown-org/core': minor
'@rundown-org/cli': patch
'@rundown-org/claude-code-plugin': patch
---

# Move CURRENT_SCHEMA_VERSION, and pin the persisted run-state shape to it

`CURRENT_SCHEMA_VERSION` sat at `1` while the persisted run-state shape gained a
required field three separate times: `StepInlineChild.startedAt` (#746),
`StepInlineChild.started` replacing it (#772), and `RunbookState.prompted`
(#827). Nothing connected the shape in `schemas.ts` to the version in
`runbook/persisted-state-guards.ts`, so nothing failed when the two drifted
apart (#775).

## What actually breaks when the shape moves and the version does not

Measured on `main` against a run persisted mid-inline-launch on a pre-#772 build
(`inline.startedAt`, no `inline.started`):

- `RunbookStateManager.load` → `InvalidRunbookStateError` with
  `reason: 'schema_validation_failed'`. Classified correctly, and
  `finish`/`stop`/`prune` clear it.
- `RunbookStore.readRun` — the in-transaction reader behind every
  `ctx.readState`, and so behind `rundown stash` / `pop` — → an unclassified
  `ZodError`. That is neither of the classes `isRecoverableActiveStackError`
  accepts, so it reaches the CLI as RD-999 "Unknown error" and a `--claim-id`
  bearer cannot finish, stop, or prune out of it. Tracked as #828, together with
  the same escape for a same-version parse failure (corruption, a hand-edited
  `state_json`) — a distinct, pre-existing gap in `readRun`'s bare `.parse()`
  that a version move does not close on its own, and is deliberately not fixed
  here.

Moving `CURRENT_SCHEMA_VERSION` to `2` would route both readers onto the
version-gate's `invalid_schema_version` / RD-309 before either reaches its
parse, closing the `readRun` escape for this specific trigger. **We chose not to
move it.** Per CLAUDE.md § Active Development Stance, no `.rundown/rundown.db`
outside a local clone or CI run holds state worth protecting with the nicer
error path, and the documented hard reset — delete the file — clears a stuck run
the same as any other. The constant now stays `1`; the fixture below is recorded
against the shape as it stands today, not a new epoch.

## The fixtures were the reason nobody noticed

Every fixture wrote `schemaVersion: 1` as a literal, so a stale constant could
not break anything, and "foreign version" fixtures wrote `schemaVersion: 2` — a
literal the constant could one day reach and silently turn into valid current
state, asserting nothing. Both are now derived: `CURRENT_SCHEMA_VERSION` for
state meant to be readable, `CURRENT_SCHEMA_VERSION + 1` (as
`FOREIGN_SCHEMA_VERSION`) for state meant to be refused. The constant is
barrelled from `@rundown-org/core` so front-end fixtures can name it too.

## The shape is now pinned

`packages/core/__tests__/runbook/persisted-state-shape.test.ts` renders both
persisted run-state schemas as a canonical structural string and compares them
against a fixture named for the version they belong to
(`__tests__/fixtures/persisted-state-shape/schema-v1.txt`). Change the shape and
it fails, naming the fields that moved. The remedy is a judgment call, not an
automatic bump — see `CURRENT_SCHEMA_VERSION`'s TSDoc — and for an ordinary
shape edit (a required field added or removed, a narrowed constraint) it is to
re-record this same version's fixture, because the Zod structural parse already
refuses state an older build wrote either way. Verified by reverting the #772
field in `schemas.ts`: the guard fails, and passes again when restored.

It covers narrowing as well as addition — `z.string()` and `z.string().min(3)`
now render differently, where they previously rendered identically — because a
tightened constraint changes the fingerprint the same way a new required field
does. It does **not** cover the opaque `snapshot` blob (declared `z.unknown()`,
so a machine-context change is invisible to it) or the body of a `.refine()`;
both are named as hand-decided triggers for an actual version move in the
fixture README and in `CURRENT_SCHEMA_VERSION`'s own TSDoc, rather than left as
an implied guarantee.

No test can force a developer to move a number — rewriting the fixture in place
would work whether or not a move was warranted — but the moment is no longer
silent, and the fixture's own doc comments now say what does and does not
require it.

`SCHEMA_VERSION` in `runbook/storage/schema.ts` stays at `2` and needs no move:
it gates the DDL, `state_json` is opaque TEXT to that DDL, and no commit has
touched the file since before #746. Both constants now carry a note saying which
half of persisted state each one gates, because they are easy to conflate.
