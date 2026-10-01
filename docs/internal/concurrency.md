# Concurrent writes (current implementation)

Descriptive: this is how run, session and file-backed state is written
**today**. [ADR 0005](../adr/0005-one-writer-per-run.md) accepts a replacement
(one writer per run) that has not been built yet. Until it lands, code that
touches these mechanisms must follow the rules below — but do not add new
consumers of them.

When multiple CLI processes may mutate a file-backed artifact such as the
artifact manifest, use **file-based exclusive locks** with process-aware stale
lock reclamation. Run and session authority lives in SQLite and uses database
transactions and execution leases instead.

**The replacement is not equivalent, and the difference is a failure mode, not a
detail.** A file lock _blocks_ a contender for up to 5s and then usually
succeeds. Of the two mechanisms that replaced it, only one behaves that way:

- **Transaction contention** (`mutateSession`, and every `BEGIN IMMEDIATE`
  write) blocks like the lock did — `PRAGMA busy_timeout = 5000` inside SQLite
  plus 10 application-level retries at 25ms × attempt in the native driver.
- **The optimistic CAS** behind `RunbookStore.mutateState` — the per-run
  read-modify-write behind every run-state write — waits, but does not block. It
  replays the whole cycle at most **8 times**, pausing between attempts for a
  jittered interval scaled by attempt number (25–50ms × attempt, so at most
  ~1.4s across the default budget). The jitter is what lets more concurrent
  writers than the attempt budget all commit: without it the losers re-read in
  lockstep and the writer at the back of the queue exhausts the budget before
  its turn. Sustained contention still spends the budget, and the call then
  returns `concurrent_modification` — a command failure where the lock would
  have waited and won.

Treat `concurrent_modification` as a reachable arm on any path that can be
driven concurrently — handle it or retry it, and never document it as
theoretical. `build` callbacks passed to `mutateState` run once per attempt and
MUST therefore be free of external side effects.

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
file-backed artifact rather than run or session authority — the artifact
manifest, the sql.js driver's durable-replacement cycle, and the plugin's
`PluginSessionLock`. Do not add a fourth for run or session state: that belongs
in a transaction or in the compare-and-swap. Note also that `acquireFileLock` is
**not reentrant** — a second acquisition on the same call path blocks its own
predecessor for the full 5s deadline and then times out, so a lock reached twice
within one process is worse than no lock at all.

**Writing a decision a concurrent writer could invalidate.** Derive it
**inside** the `mutateState` build callback, so it is computed against the exact
version the compare-and-swap commits onto and a loser re-derives against the
committed row rather than overwriting it. Do not reach for a transaction instead
— `SyncWork<T>` makes an async callback a compile error, and these spans await.
This fold is what retired every run-state, completion, and delegation lock the
codebase used to hold; four rules generalise from it.

- **Fold the interface, not just the write.** A seam taking a caller-supplied
  `currentState` is stale by construction, and the compare-and-swap does not
  rescue it: it prevents the lost update while still applying a row selected
  against one version to the cursor of another. `applyNextResolvedCompletion`
  applies ONE completion and takes no `currentState`; core Run Progression asks
  XState to select each turn, invokes one apply, and synchronously delivers its
  observation through the frontend-supplied sink before selecting again. The
  frontend renders those observations; it does not own completion sequencing. A
  change that fixes the write and leaves the parameter has kept the defect.
- **Audit the callback for repeatability rather than assuming it.** It re-runs
  once per attempt (up to 8) and must perform no external effect — filesystem
  resolution, dynamic imports, run creation, and emitted warnings all stay
  outside it, and the callback decides only. A clean audit is still a result
  worth recording: the drain's reachable machine actors are effect-free for its
  event apart from producer ARTIFACTS resolution, which is idempotent by
  identity and already repeats on RETRY re-entry.
- **Pick the builder the derivation needs.** An async derivation produces a
  whole state and needs `RunbookStateManager.mutateStateReturning`; a
  patch-shaped one uses `updateWithStateReturning` or `updateWithStateIfExists`,
  whose `null` return on a missing run IS the pre-read existence guard.
- **When the fold is unavailable, loop from outside** — and confirm it is
  unavailable rather than assuming. If the derivation is async and the commit's
  work is `SyncWork`, no callback can hold the span, so wrap capture → derive →
  commit in a bounded re-derive loop paced by the store's exported
  `DEFAULT_MUTATE_ATTEMPTS` / `mutateBackoffMs`, never a mirrored constant.
  Retry only the ambiguous arm: a version mismatch carries no reason, which is
  the point of re-deriving, while every permanent refusal stays permanent. Never
  re-run the side effect the loop sits inside, and let an exhausted budget
  report `concurrent_modification` rather than a cause it never observed.

**Exactly-once entry is a different shape from a read-derive-write gap.** Where
the protected span cannot live inside a callback at all — a launch, a run
creation — the replacement is an atomic **compare-and-latch**: a prior
`mutateStateReturning` cycle whose callback decides the entire question against
the version it commits onto (refuse, stand down, or win) and writes the durable
"I own this" record in the same commit, with only the winner performing the
span. Decide every refusal **ahead of** the latch write, or a refused attempt
leaves a durable record of a start that never happened. Latching before the
create does move one failure: a process that dies between them leaves the work
latched with no child. The next launch reclaims a latch whose owner process is
dead, or whose pid was recycled (start ids disagree), and proceeds; a live owner
makes it stand down (`classifyInlineLaunchOwnership` in
`inline-launch-latch.ts`). Neither path duplicates the `INSERT`.

**Three checks that are cheap to run and expensive to skip.**

- **Establish what an exclusion actually excludes before crediting it with an
  invariant.** The run-start delegation lock fenced a load-derive-write over the
  parent's `substepStates` and lost updates the whole time, because it excluded
  only other acquirers of itself while every writer of those rows (`delegate`,
  `pass`, `fail`, `goto`, `abort`) went through the state machine and took no
  lock at all. "It was load-bearing" and "it was decoration over a live defect"
  need the same fix but are different changes — only the second is a
  user-visible bug fix.
- **Check what each refusal DEGRADES to, not only that correctness holds.**
  Deleting an exclusion makes a formerly impossible race reachable, and the
  refusal it produces has to be spelled correctly at every seam it surfaces
  through: an occupied delegation is permanent, so it classifies
  `already_linked` (no retry) and never `concurrent_modification` ("Retry.") — a
  call that can never succeed must not tell the caller to try again. A wrapper
  that folds failures into a generic envelope re-labels it, so pass every reason
  a concurrent actor can cause through as itself. Move each refusal into the
  transactional owner FIRST, one commit at a time; deleting the exclusion is
  then a no-op rather than a lossy edit.
- **"Stub it out and see what breaks" is a BLIND check** when every unit suite
  mocks the module boundary you stubbed. Nothing fails, and nothing was tested.
  Only a real multi-process test observes a genuine race.

**For manifest writes:** Wrap `findEquivalentManifestRow` + append in a lock at
`.rundown/locks/.rd-<contextId>.manifest.lock` (`appendArtifactManifestRecord`
in `artifact-manifest.ts`).
