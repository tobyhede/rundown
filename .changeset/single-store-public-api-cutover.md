---
'@rundown-org/core': major
'@rundown-org/cli': major
'@rundown-org/claude-code-plugin': major
---

# BREAKING: SQLite is the sole run and session authority

`.rundown/rundown.db` is now the only run and session authority. Every
production JSON authority reader and writer is removed, and the path helpers,
lock classes, and event field that described the old JSON layout are removed
with them. `.rundown/runs/<run-id>/outputs/` remains for captured outputs.

Pre-cutover JSON state (`.rundown/session.json`, `.rundown/runs/<id>.json`,
`.claude/rundown/session.json`) is ignored entirely — not detected, parsed,
migrated, warned about, refused, deleted, or rewritten. Those files are left
byte-identical and their presence never prevents opening or creating the store.
In-flight pre-cutover runs do not carry over: complete or abort them before
upgrading, then start fresh.

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
`CompletionLock` and `DelegationLock` are deleted too — #690 moved every refusal
they fenced into the transaction or compare-and-swap that commits the fact it
depends on, leaving nothing for the locks to exclude.

**`RunbookState.templateVars` is now required.** It was optional. `create`
always writes it (`{}` at minimum) and `load` rejects a persisted row without
it, because readers substitute `runbookSrc` against it on every resume and there
is no sanctioned way to reconstruct one. A row lacking it is incompatible state
whose only recovery is prune and restart — never a re-parse of the stored
source. Callers constructing a `RunbookState` literal must now supply the field.

**Default write policy no longer grants `.rundown/session.json`.** The grant for
`.rundown/runs/**`, the database, its WAL/SHM sidecars, and `.rundown/locks/**`
is unchanged.

## Added to `@rundown-org/core`'s public API

Four error classes are now exported so a consumer can classify a storage or
state failure with `instanceof` instead of matching a message or a class name as
a string. Every one of them previously escaped to the CLI's top-level wrapper
unclassified and rendered as `RD-999` / "Unknown error" — on **every** command,
read-only ones included, because opening the database precedes all of them.

- `WalJournalModeUnavailableError` — a file-backed connection did not enter WAL
  journal mode. Only WAL serializes writes across processes, so a silent
  rollback-journal fallback would leave the driver advertising
  `capabilities.multiProcess` over a connection that no longer provides it.
- `NativeSqliteUnavailableError` and `SqljsUnavailableError` — the two halves of
  the store-open failure surface (WebContainer takes the sql.js path, every
  other host the native one). Both classes already existed; only the exports are
  new. A consumer needs both arms or it still falls through to `RD-999` on one
  class of host.
- `ConcurrentStateModificationError`, with the
  `isConcurrentStateModificationError` guard — the throwing face of the
  `mutateState` compare-and-swap exhausting its optimistic retry budget. Carries
  the `runId`.
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
**exact-equality** match on the whole message no longer does. That is announced
here rather than treated as internal because a consumer outside this repo could
be doing the latter. Match the class, not the text.

## Also fixed: a cold-start WAL race

`PRAGMA journal_mode = WAL` takes an EXCLUSIVE lock, and `PRAGMA busy_timeout`
does not cover that acquisition. Two `rundown` invocations racing to create the
database on a fresh project could leave one dead with `database is locked`,
reported as a false "Native SQLite is unavailable" diagnosis. The conversion is
now retried on `SQLITE_BUSY` under the driver's own bounded budget. A genuine
non-WAL fallback still refuses immediately, without consuming the budget.

A note on which faults produce which code, since the two are easily confused: a
non-WAL journal mode reaches `RD-306` only when SQLite **answers** the pragma
with the mode it kept instead of failing. A read-only database file or directory
does not do that — it fails the pragma outright and surfaces as `RD-307`. Reach
for `chmod` on `RD-307`, not on `RD-306`.
