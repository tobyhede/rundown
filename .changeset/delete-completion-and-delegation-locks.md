---
'@rundown-org/core': major
---

# Delete the completion and delegation domain locks

The two surviving core domain locks are gone, along with the error surface that
existed only to report their timeouts. This is a pure deletion: every production
acquisition had already been retired site by site under #690, so no behaviour
changes here — the modules were dead code with a live public export.

**Removed from `@rundown-org/core`'s public surface** (six symbols):

- `DelegationLock`, `DelegationLockTimeoutError`, `DelegationLockLike`
- `CompletionLock`, `CompletionLockTimeoutError`, `CompletionLockLike`

**Removed error code:** `DELEGATION_LOCK_TIMEOUT` / `RD-810`, together with the
`Errors.delegationLockTimeout` factory and the code's Zod enum member. No
producer of RD-810 remained in any package — the last emit sites went with the
inline-launch and claim-and-launch retirements — so no envelope that a caller
could previously observe stops being emitted. A consumer that pattern-matched on
the literal `'RD-810'` will now never match, which is the intended outcome: the
condition it named cannot arise.

**Removed path helpers:** `delegationLockPath` and `completionLockPath`.
`LOCKS_DIR`, `locksDir`, and `ensureStateDirs` are unchanged — the
artifact-manifest append lock and the sql.js durable-replacement lock still
occupy `.rundown/locks/`.

The `file-lock.ts` primitives are untouched and remain public: `acquireFileLock`
/ `releaseFileLock`, `heldLock` / `heldLockSync`, and the `ScopedLock` /
`ScopedLockSync` scoped-release types. File-based exclusive locks remain the
correct mechanism for concurrent writes to a file-backed artifact; what is gone
is using one to fence run or session state, which lives in SQLite and is fenced
by transactions and execution leases.

Nothing replaces the locks because every span they protected now derives its
decision inside the compare-and-swap that commits it, rather than excluding
other writers from the gap between the two.
