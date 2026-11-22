# Concurrent writes (current implementation)

Descriptive: this is how run and file-backed state is written **today**. Run
state follows [ADR 0005](../adr/0005-one-writer-per-run.md): every run has one
Run Owner, proven by its Owner Token, and only the owner's commands write it.
The one other thing written on a run row is the execution lease below, and it
rides the same conditional write.

## Run state: one conditional write, never retried

Run state lives in the `runs` table of `.rundown/rundown.db`. Each row carries a
`state_version`. Every run-state write is ONE conditional
`UPDATE … WHERE state_version = :expected` (`RunbookStore` in
`packages/core/src/runbook/storage/runbook-store.ts`), naming the version the
command read. The save returns a closed outcome:

- `committed` — the write landed and `state_version` advanced.
- `concurrent_modification` — the row exists but its `state_version` moved since
  the command read it: two of the owner's own commands raced. Nothing was
  written. The command is refused `CONCURRENT_MODIFICATION` (RD-308 when thrown)
  and the caller re-reads and re-issues it. It is **never retried** on the
  caller's behalf: there is no retry loop, backoff, or re-derive cycle.
- `missing` — the row no longer exists.

Treat `concurrent_modification` as a reachable arm on any path that can be
driven concurrently, and render it as itself; never fold it into a generic
failure or document it as theoretical.

## Execution lease

A run row carries at most one execution lease: the columns `lease_attempt`,
`lease_pid`, `lease_start_id` and `lease_started_at`, all-or-none under the
table's `CHECK`. It is run-row data — never machine context, never a file lock.
The vocabulary and the rule live in
`packages/core/src/runbook/execution-lease.ts`; the writes live in
`RunbookStore`.

- **Set.** Run Progression (`run-progression.ts`, `acquireTurnLease`) sets the
  lease immediately before a command turn — the command execution, together with
  the OUTPUTS helper evaluation inside its finish — by ONE conditional
  `UPDATE … WHERE state_version = :expected AND lease_attempt IS NULL`. The
  `runs_bump_state_version` trigger fires on `lease_attempt` too, so the set
  moves `state_version`, and the lease's `attempt` IS the version it produced.
  The command does not start unless the set landed. Entry-render helpers stay
  outside the lease: an entry is re-rendered on every activation anyway.
- **Clear.** Only a decision or a finish clears the lease:
  `RunbookStore.saveRunResolvingLease` (reached through
  `RunbookStateManager.save`, which the lifecycle seam and Run Progression's
  finish call) clears the lease columns in the same `UPDATE`. A writer at
  version `v` therefore clears exactly the lease `v` carries — the one its seam
  read and decided about. Every other state write (`saveRun`,
  `RunbookStateManager.update` / `mutate`) is refused on a leased row
  (`execution_leased`, or `ExecutionLeaseHeldError` before its build runs), so
  no incidental write can erase an Interrupted marker. Deleting a run by token
  (`prune --token`) is conditional on the version whose lease was checked
  (`deleteAtVersion`), so a lease taken after that read refuses the delete
  `CONCURRENT_MODIFICATION`. The finish of a command commits at
  `state_version = attempt`, so it commits only if its attempt still holds the
  lease. If anything wrote in between (an owner's decision on an Interrupted
  step, a new attempt), the finish is refused `CONCURRENT_MODIFICATION`
  (`command_not_committed`) and records nothing.
- **Readers before the set.** Because the set moves the version, a command that
  read the run before the lease was set is refused `CONCURRENT_MODIFICATION`
  when it saves. A command that reads the lease applies the rule below.

- **Outcome unknown.** If the finish cannot be derived after the command ran —
  the machine-effect wait exceeds its budget, or the actor reaches an XState
  `error` status — `prepareActorMutation` raises
  `MachineEffectOutcomeUnknownError` (only for `EXECUTE_COMMAND`, and only for
  those two causes). Run Progression catches exactly that error and refuses
  `command_outcome_unknown`, code `EXECUTION_INTERRUPTED`, `permanent`. Nothing
  is written and the lease stays set: the step is now Interrupted, and the
  message names the same explicit decisions. Every other error from the finish
  propagates as a defect, also leaving the lease set — and so also Interrupted
  once the turn has unwound.

A held lease has one of two conditions, decided by `classifyExecutionLease`:

- **Another process's lease** — `(pid, start id)` through
  `process-identity.ts`'s `isOwnerAlive`: only a pid with no process, or a
  recorded and an observed start id that disagree, prove the holder gone. Every
  unknown reads as alive, so doubt refuses rather than letting the command run
  twice.
- **This process's lease** (`pid` is `process.pid`) — liveness cannot answer,
  because the process is alive by definition. Run Progression registers each
  attempt it runs in a process-local, never-persisted set (keyed by run and
  attempt) from the lease set until the turn returns or throws
  (`holdInFlightAttempt`, released with `using`). The lease is In Progress only
  while its attempt is registered; otherwise the turn that set it ended without
  committing (or an earlier process recycled the pid), and it is Interrupted.
  Without this rule a long-lived host (an MCP server) whose finish failed would
  read In Progress — refusing even `fail`, `goto` and `stop` — until it exited.

| Condition       | Holder                                      | Refused                                                                                                                                           | Clears it                                                                                                         |
| --------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **In Progress** | alive (this process: attempt registered)    | every owner decision (`pass`, `fail`, `goto`, `stop`, `complete`, `prune --token`) and a second Run Progression attempt — `EXECUTION_IN_PROGRESS` | the command's own finish                                                                                          |
| **Interrupted** | gone (this process: attempt not registered) | `pass`, `complete` and Run Progression — `EXECUTION_INTERRUPTED`                                                                                  | the owner's `fail` (FAIL handler, including an authored RETRY), `goto` or `stop`; `prune --token` deletes the run |

`pass` and `complete` are refused on an Interrupted step because each would
treat an effect of unknown outcome as having succeeded. Rundown never repeats an
Interrupted command itself; the owner's decision is the only way past it. The
rule is `refuseUnderLease`, applied by `RunbookLifecycleCommandService` before
any derivation, and `status` renders the condition as `execution`.

The lease is never retried, backed off or waited on. A refused set is a refused
turn.

## No other coordination

There are no file locks, compare-and-swap retry budgets, latches, fences, claim
generations or grants on run state. Adding any of them reintroduces a second
writer or a second authority and needs a new ADR; a write that seems to need one
is a design question to raise with the user.

## Transactions

Every writing transaction runs as `BEGIN IMMEDIATE`. Transaction work is
synchronous: `SyncWork<T>` in `storage/sql-driver.ts` makes an async callback a
compile error, and `assertSyncWorkResult` is its runtime half, so an external
effect can never run inside a transaction. Contention for the write lock
_blocks_ rather than fails: `PRAGMA busy_timeout = 5000` inside SQLite, plus up
to 10 application-level retries at 25ms × attempt in the native driver
(`native-sqlite-driver.ts`) for the `SQLITE_BUSY` cases `busy_timeout` does not
cover. These retries wait for the database lock; they never re-run a run-state
decision.

## File-backed artifacts: exclusive file locks

When multiple CLI processes may mutate a file-backed artifact such as the
artifact manifest, use **file-based exclusive locks** with process-aware stale
lock reclamation. A file lock _blocks_ a contender for up to 5s and then usually
succeeds.

**Pattern:** Acquire the lock, then scope its release with `await using` so the
lock is released deterministically on every exit path — including early `return`
and `throw` — without a hand-rolled `try/finally`:

```typescript
await lock.acquire();
await using _guard = lock.held(); // or: await using _guard = await lock.scope();
return await doWork(); // a failed release can never mask this committed result (RD-102)
```

`acquireFileLock` / `releaseFileLock` (and the `*Sync` variants) in
`packages/core/src/runbook/file-lock.ts` are the underlying primitives;
`heldLock` / `heldLockSync` (returning `ScopedLock` / `ScopedLockSync`) are the
consumer-facing wrappers that own the best-effort, non-masking release policy.
The artifact manifest and the sql.js driver call them directly;
`PluginSessionLock` re-exposes them as `scope()` / `held()`.

- **Lock mechanism:** The owner content is written to a unique temp file, which
  is then `fs.link()`ed into place (`atomicCreateLock` in `file-lock.ts`).
  `link` refuses when the lock file already exists, and the lock file is never
  visible half-written. Do not use `open('wx')`: it exposes an empty file that a
  concurrent stale check reclaims from a live holder.
- **Lock paths:** `.rundown/locks/.rd-<contextId>.manifest.lock` (artifact
  manifest), `<dbPath>.lock` (sql.js driver), and
  `.claude/session/locks/state.lock` (`PluginSessionLock`).
- **Stale detection:** Kill signal check (`kill(pid, 0)`) — never age-based
  expiration
- **Retry:** Jittered backoff (50–100ms) bounded to 5 seconds
- **Release:** Best-effort and idempotent. A failed unlink only leaks a
  self-healing lock (reclaimed by the next acquirer via PID-aware stale
  detection) and is **never propagated** by the disposer, so it cannot mask the
  committed outcome of the protected work. Never release a lock from a bare
  `finally` — that is the RD-102 masking defect.

**Examples:** three consumers remain, and every one of them protects a
file-backed artifact rather than run authority — the artifact manifest, the
sql.js driver's durable-replacement cycle, and the plugin's `PluginSessionLock`.
Do not add a fourth for run state: raise the write with the user (ADR 0005).
Note also that `acquireFileLock` is **not reentrant** — a second acquisition on
the same call path blocks its own predecessor for the full 5s deadline and then
times out, so a lock reached twice within one process is worse than no lock at
all.

## Testing a race

"Stub it out and see what breaks" is a BLIND check when every unit suite mocks
the module boundary you stubbed: nothing fails, and nothing was tested. Only a
real multi-process test observes a genuine race.

**For the execution lease:**
`packages/cli/__tests__/integration/execution-lease.test.ts` starts a real
`rundown run` whose command sleeps, observes `EXECUTION_IN_PROGRESS` from a
second process, and SIGKILLs the owner to observe Interrupted.

**For manifest writes:** Wrap `findEquivalentManifestRow` + append in a lock at
`.rundown/locks/.rd-<contextId>.manifest.lock` (`appendArtifactManifestRecord`
in `artifact-manifest.ts`).
