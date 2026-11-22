# Concurrent writes (current implementation)

Descriptive: this is how run and file-backed state is written **today**. Run
state follows [ADR 0005](../adr/0005-one-writer-per-run.md): every run has one
Run Owner, proven by its Owner Token, and only the owner's commands write it.
The execution lease the ADR also calls for is not built yet (#902).

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

**For manifest writes:** Wrap `findEquivalentManifestRow` + append in a lock at
`.rundown/locks/.rd-<contextId>.manifest.lock` (`appendArtifactManifestRecord`
in `artifact-manifest.ts`).
