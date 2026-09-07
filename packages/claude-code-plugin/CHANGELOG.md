# @rundown-org/claude-code-plugin

## 2.0.0

### Major Changes

- 2e0b7d7: # BREAKING: Move runbook state storage from `.claude/rundown/` to
  `.rundown/`

  State files, session tracking, and delegation locks are now stored under
  `.rundown/` instead of `.claude/rundown/`. No automatic migration is
  performed.

  **Upgrade instructions:**

  1. Complete or abort any in-flight runbooks _before_ upgrading.
  2. Update `.gitignore` — replace `.claude/rundown/` entries with:

     ```text
     .rundown/work/
     .rundown/runs/
     .rundown/session.json
     .rundown/locks/
     ```

  3. Move any project-local runbooks from `.claude/rundown/runbooks/` to
     `.rundown/runbooks/`.
  4. After confirming no in-flight runs, remove the old `.claude/rundown/`
     directory.

  The CLI will print a warning on startup if state is detected in the legacy
  location.

- 2d03652: BREAKING: Raise minimum Node.js version to >=24.0.0. This enables use
  of `Error.isError()` (TC39) and other Node 24 features across the codebase.
- 25251a6: # BREAKING: SQLite is the sole run and session authority

  `.rundown/rundown.db` is now the only run and session authority. Every
  production JSON authority reader and writer is removed, and the path helpers,
  lock classes, and event field that described the old JSON layout are removed
  with them. `.rundown/runs/<run-id>/outputs/` remains for captured outputs.

  Pre-cutover JSON state (`.rundown/session.json`, `.rundown/runs/<id>.json`,
  `.claude/rundown/session.json`) is ignored entirely — not detected, parsed,
  migrated, warned about, refused, deleted, or rewritten. Those files are left
  byte-identical and their presence never prevents opening or creating the
  store. In-flight pre-cutover runs do not carry over: complete or abort them
  before upgrading, then start fresh.

  ## Removed from `@rundown-org/core`'s public API

  | Symbol                                   | Replacement                                                                                         |
  | ---------------------------------------- | --------------------------------------------------------------------------------------------------- |
  | `SESSION_FILE`                           | `DB_FILE` — session rows live in SQLite                                                             |
  | `sessionPath(cwd)`                       | `dbPath(cwd)`                                                                                       |
  | `statePath(cwd, id)`                     | none — run state is a row, not a file                                                               |
  | `LEGACY_SESSION_FILE`                    | none — the legacy location is not recognised                                                        |
  | `runStateLockPath(cwd, runId)`           | none — replaced by the `RunbookStore.mutateState` compare-and-swap                                  |
  | `sessionLockPath(cwd)`                   | none — replaced by `BEGIN IMMEDIATE` transactions                                                   |
  | `SessionLock`, `SessionLockTimeoutError` | as above                                                                                            |
  | `RunbookStartedEvent.statePath`          | `RunbookMetadata.runId` for run identity; `RunbookMetadata.state` now reports `.rundown/rundown.db` |

  `RunStateLock` was internal and is deleted without a public-API impact.
  `CompletionLock` and `DelegationLock` are deleted too — #690 moved every
  refusal they fenced into the transaction or compare-and-swap that commits the
  fact it depends on, leaving nothing for the locks to exclude.

  **`RunbookState.templateVars` is now required.** It was optional. `create`
  always writes it (`{}` at minimum) and `load` rejects a persisted row without
  it, because readers substitute `runbookSrc` against it on every resume and
  there is no sanctioned way to reconstruct one. A row lacking it is
  incompatible state whose only recovery is prune and restart — never a re-parse
  of the stored source. Callers constructing a `RunbookState` literal must now
  supply the field.

  **Default write policy no longer grants `.rundown/session.json`.** The grant
  for `.rundown/runs/**`, the database, its WAL/SHM sidecars, and
  `.rundown/locks/**` is unchanged.

  ## Added to `@rundown-org/core`'s public API

  Four error classes are now exported so a consumer can classify a storage or
  state failure with `instanceof` instead of matching a message or a class name
  as a string. Every one of them previously escaped to the CLI's top-level
  wrapper unclassified and rendered as `RD-999` / "Unknown error" — on **every**
  command, read-only ones included, because opening the database precedes all of
  them.

  - `WalJournalModeUnavailableError` — a file-backed connection did not enter
    WAL journal mode. Only WAL serializes writes across processes, so a silent
    rollback-journal fallback would leave the driver advertising
    `capabilities.multiProcess` over a connection that no longer provides it.
  - `NativeSqliteUnavailableError` and `SqljsUnavailableError` — the two halves
    of the store-open failure surface (WebContainer takes the sql.js path, every
    other host the native one). Both classes already existed; only the exports
    are new. A consumer needs both arms or it still falls through to `RD-999` on
    one class of host.
  - `ConcurrentStateModificationError`, with the
    `isConcurrentStateModificationError` guard — the throwing face of the
    `mutateState` compare-and-swap exhausting its optimistic retry budget.
    Carries the `runId`.
  - `InvalidRunIdError`, carrying the offending `value` — see the behaviour note
    below.

  Four new error codes, with a factory for each: `RD-306`
  `WAL_JOURNAL_MODE_UNAVAILABLE`, `RD-307` `STATE_STORE_UNAVAILABLE`, `RD-308`
  `CONCURRENT_STATE_MODIFICATION`, and `RD-309` `INVALID_PERSISTED_RUN_STATE`
  (`Errors.walJournalModeUnavailable`, `Errors.stateStoreUnavailable`,
  `Errors.concurrentStateModification`, `Errors.invalidPersistedRunState`).
  `RD-308` is deliberately **not** collapsed into the CLI's existing symbolic
  `CONCURRENT_MODIFICATION`: they are the same condition on two surfaces, one
  narrowed from a returned result and one thrown.

  Also added:

  - `DB_SIDECAR_SUFFIXES` — the `-wal`/`-shm` tuple, declared once so file-mode
    hardening, the default write policy, state teardown, and the site's path
    parity assertion all derive from one definition. It is a `readonly` tuple of
    string literals and must stay one; the parity assertion compares literal
    types.
  - `RunbookMetadata.runId` (optional) — run identity now travels here, since
    `state` is the same constant path for every run. Run ids are a read-only
    correlation handle: no read command accepts one as a mutation selector, and
    refusal envelopes never echo the target run id.
  - An optional `runId` on `RunbookContextSchema`, `ActionResponseSchema`,
    `StatusResponseSchema`, `StashResponseSchema`, and `PopResponseSchema`, so
    output carrying it validates against the published `--schema` contract.

  ## Behaviour change: `assertRunId` throws a typed error

  `assertRunId` now throws `InvalidRunIdError` rather than a bare `Error`. The
  class extends `Error`, so every `catch` narrowing with `instanceof Error` is
  unaffected, and all 21 production call sites were checked: none catches it and
  none matches its message.

  The message keeps its original prefix —
  `Invalid run id: expected rd_<32 lowercase hex chars>` — and appends the
  offending value, so a **substring or prefix** match still succeeds while an
  **exact-equality** match on the whole message no longer does. That is
  announced here rather than treated as internal because a consumer outside this
  repo could be doing the latter. Match the class, not the text.

  ## Also fixed: a cold-start WAL race

  `PRAGMA journal_mode = WAL` takes an EXCLUSIVE lock, and `PRAGMA busy_timeout`
  does not cover that acquisition. Two `rundown` invocations racing to create
  the database on a fresh project could leave one dead with
  `database is locked`, reported as a false "Native SQLite is unavailable"
  diagnosis. The conversion is now retried on `SQLITE_BUSY` under the driver's
  own bounded budget. A genuine non-WAL fallback still refuses immediately,
  without consuming the budget.

  A note on which faults produce which code, since the two are easily confused:
  a non-WAL journal mode reaches `RD-306` only when SQLite **answers** the
  pragma with the mode it kept instead of failing. A read-only database file or
  directory does not do that — it fails the pragma outright and surfaces as
  `RD-307`. Reach for `chmod` on `RD-307`, not on `RD-306`.

### Patch Changes

- 68c59ec: # Move CURRENT_SCHEMA_VERSION, and pin the persisted run-state shape
  to it

  `CURRENT_SCHEMA_VERSION` sat at `1` while the persisted run-state shape gained
  a required field three separate times: `StepInlineChild.startedAt` (#746),
  `StepInlineChild.started` replacing it (#772), and `RunbookState.prompted`
  (#827). Nothing connected the shape in `schemas.ts` to the version in
  `runbook/persisted-state-guards.ts`, so nothing failed when the two drifted
  apart (#775).

  ## What actually breaks when the shape moves and the version does not

  Measured on `main` against a run persisted mid-inline-launch on a pre-#772
  build (`inline.startedAt`, no `inline.started`):

  - `RunbookStateManager.load` → `InvalidRunbookStateError` with
    `reason: 'schema_validation_failed'`. Classified correctly, and
    `finish`/`stop`/`prune` clear it.
  - `RunbookStore.readRun` — the in-transaction reader behind every
    `ctx.readState`, and so behind `rundown stash` / `pop` — → an unclassified
    `ZodError`. That is neither of the classes `isRecoverableActiveStackError`
    accepts, so it reaches the CLI as RD-999 "Unknown error" and a `--claim-id`
    bearer cannot finish, stop, or prune out of it. Tracked as #828, together
    with the same escape for a same-version parse failure (corruption, a
    hand-edited `state_json`) — a distinct, pre-existing gap in `readRun`'s bare
    `.parse()` that a version move does not close on its own, and is
    deliberately not fixed here.

  Moving `CURRENT_SCHEMA_VERSION` to `2` would route both readers onto the
  version-gate's `invalid_schema_version` / RD-309 before either reaches its
  parse, closing the `readRun` escape for this specific trigger. **We chose not
  to move it.** Per CLAUDE.md § Active Development Stance, no
  `.rundown/rundown.db` outside a local clone or CI run holds state worth
  protecting with the nicer error path, and the documented hard reset — delete
  the file — clears a stuck run the same as any other. The constant now stays
  `1`; the fixture below is recorded against the shape as it stands today, not a
  new epoch.

  ## The fixtures were the reason nobody noticed

  Every fixture wrote `schemaVersion: 1` as a literal, so a stale constant could
  not break anything, and "foreign version" fixtures wrote `schemaVersion: 2` —
  a literal the constant could one day reach and silently turn into valid
  current state, asserting nothing. Both are now derived:
  `CURRENT_SCHEMA_VERSION` for state meant to be readable,
  `CURRENT_SCHEMA_VERSION + 1` (as `FOREIGN_SCHEMA_VERSION`) for state meant to
  be refused. The constant is barrelled from `@rundown-org/core` so front-end
  fixtures can name it too.

  ## The shape is now pinned

  `packages/core/__tests__/runbook/persisted-state-shape.test.ts` renders both
  persisted run-state schemas as a canonical structural string and compares them
  against a fixture named for the version they belong to
  (`__tests__/fixtures/persisted-state-shape/schema-v1.txt`). Change the shape
  and it fails, naming the fields that moved. The remedy is a judgment call, not
  an automatic bump — see `CURRENT_SCHEMA_VERSION`'s TSDoc — and for an ordinary
  shape edit (a required field added or removed, a narrowed constraint) it is to
  re-record this same version's fixture, because the Zod structural parse
  already refuses state an older build wrote either way. Verified by reverting
  the #772 field in `schemas.ts`: the guard fails, and passes again when
  restored.

  It covers narrowing as well as addition — `z.string()` and `z.string().min(3)`
  now render differently, where they previously rendered identically — because a
  tightened constraint changes the fingerprint the same way a new required field
  does. It does **not** cover the opaque `snapshot` blob (declared
  `z.unknown()`, so a machine-context change is invisible to it) or the body of
  a `.refine()`; both are named as hand-decided triggers for an actual version
  move in the fixture README and in `CURRENT_SCHEMA_VERSION`'s own TSDoc, rather
  than left as an implied guarantee.

  No test can force a developer to move a number — rewriting the fixture in
  place would work whether or not a move was warranted — but the moment is no
  longer silent, and the fixture's own doc comments now say what does and does
  not require it.

  `SCHEMA_VERSION` in `runbook/storage/schema.ts` stays at `2` and needs no
  move: it gates the DDL, `state_json` is opaque TEXT to that DDL, and no commit
  has touched the file since before #746. Both constants now carry a note saying
  which half of persisted state each one gates, because they are easy to
  conflate.

- Updated dependencies [a350173]
- Updated dependencies [91a2dab]
- Updated dependencies [bc12503]
- Updated dependencies [72f01af]
- Updated dependencies [408eb0b]
- Updated dependencies [fb67bab]
- Updated dependencies [7de7ac8]
- Updated dependencies [271b92b]
- Updated dependencies [7755171]
- Updated dependencies [07d998d]
- Updated dependencies [13de29a]
- Updated dependencies [a903483]
- Updated dependencies [c0286c2]
- Updated dependencies [66099ed]
- Updated dependencies [8695941]
- Updated dependencies [da52ad6]
- Updated dependencies [562bd61]
- Updated dependencies [f0329b2]
- Updated dependencies [d6fa167]
- Updated dependencies [f504fe9]
- Updated dependencies [981dd79]
- Updated dependencies [b46ecb6]
- Updated dependencies [dfdcae8]
- Updated dependencies [1596d86]
- Updated dependencies [b4c5354]
- Updated dependencies [1f591ef]
- Updated dependencies [58fc4f1]
- Updated dependencies [216e266]
- Updated dependencies [a6ee531]
- Updated dependencies [5e58b8b]
- Updated dependencies [526ea44]
- Updated dependencies [2e0b7d7]
- Updated dependencies [e20b2e2]
- Updated dependencies [2d03652]
- Updated dependencies [68c59ec]
- Updated dependencies [2a6073d]
- Updated dependencies [d9f22a0]
- Updated dependencies [6be11e7]
- Updated dependencies [14dcd01]
- Updated dependencies [23f11b9]
- Updated dependencies [4f90417]
- Updated dependencies [529c1f5]
- Updated dependencies [c082109]
- Updated dependencies [b7861e1]
- Updated dependencies [0cd8c22]
- Updated dependencies [25251a6]
- Updated dependencies [39cb1ac]
- Updated dependencies [12296bd]
  - @rundown-org/core@2.0.0
  - @rundown-org/cli@2.0.0
  - @rundown-org/mcp@2.0.0
