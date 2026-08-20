# Persisted run-state shape fixtures

One file per persisted run-state schema version, named `schema-v<n>.txt`. Each
holds a canonical structural rendering of `RunbookStateSchema` and
`makeRunbookStateSchema` as they stood at that version — sorted keys, sorted
union options, no comments, no declaration order.

`../../runbook/persisted-state-shape.test.ts` renders the schemas live and
compares against the file named for the current `CURRENT_SCHEMA_VERSION`. These
files are generated output; do not hand-edit them. Record a new one with:

```bash
RUNDOWN_RECORD_STATE_SHAPE=1 pnpm --filter @rundown-org/core exec jest __tests__/runbook/persisted-state-shape.test.ts
```

The recording run fails on purpose — recording is not verifying. Re-run without
the variable to check the result.

## What it does not cover

The pin is over the Zod schemas, which is less than `CURRENT_SCHEMA_VERSION`
gates. Two triggers for a bump are invisible to it and have to be spotted by
hand:

- **The opaque `snapshot` blob.** `CLAUDE.md` § State Persistence puts the
  XState snapshot under the same version, but the schema declares it
  `z.unknown().optional()` on purpose, so it renders as `optional(unknown)`. A
  change to the machine's context shape or its state IDs is a persisted-shape
  change that leaves this fixture identical.
- **The body of a `.refine()` / `.superRefine()`.** A custom check renders as
  `custom` and nothing more — its content is a function, which has no stable
  identity across runs. Adding or removing one moves the fingerprint; editing
  what one accepts does not.

Everything the schemas declare structurally is covered, including validation
constraints: `z.string()` and `z.string().min(3)` render differently, because
narrowing a persisted field is the same defect as adding a required one — state
an older build wrote legitimately now fails the parse.

## Why they exist

Three PRs added a required field to the persisted run state and left
`CURRENT_SCHEMA_VERSION` at `1`: `StepInlineChild.startedAt` (#746),
`StepInlineChild.started` replacing it (#772), and `RunbookState.prompted`
(#827). Nothing failed, because nothing connected the shape in `schemas.ts` to
the version in `runbook/persisted-state-guards.ts`. Runs persisted by those
builds cleared the version gate (still `1`, which they still carried) and died
in the schema parse instead — as `schema_validation_failed` through
`RunbookStateManager.load`, and as an unclassified `ZodError` through
`RunbookStore.readRun`, which is outside the taxonomy the CLI's
finish/stop/prune recovery classifies on. See #775.

## When the test fails

The persisted run-state shape changed, and this fixture no longer describes it.
Update the record; whether that also means moving `CURRENT_SCHEMA_VERSION` is a
separate judgment call (see that constant's TSDoc in
`runbook/persisted-state-guards.ts`), not something this test decides for you.

- **Most shape changes — a required field added or removed, a narrowed
  constraint** — are already refused by the Zod structural parse for state an
  older build wrote, version gate or not. Re-record this same version's file:

  ```bash
  RUNDOWN_RECORD_STATE_SHAPE=1 pnpm --filter @rundown-org/core exec jest __tests__/runbook/persisted-state-shape.test.ts
  ```

- **A change the structural parse cannot itself catch** — the opaque `snapshot`
  field is the standing example — needs `CURRENT_SCHEMA_VERSION` moved to the
  next integer first, with the reason recorded in that constant's TSDoc, and the
  new shape recorded as `schema-v<new>.txt`. Leave the older files alone: they
  are history, and a diff between two of them is the clearest available answer
  to "what did this version change?".

Editing `schema-v<n>.txt` by hand, rather than through the recording run above,
is the shortcut this directory exists to prevent.
