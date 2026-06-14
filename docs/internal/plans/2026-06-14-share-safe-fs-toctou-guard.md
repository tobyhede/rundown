# Plan: Converge symlink/TOCTOU file-read guards onto a shared `safe-fs.ts`

**Issue:** [#433](https://github.com/tobyhede/rundown/issues/433) — "Converge output-channels.ts symlink/TOCTOU guard onto shared safe-fs" (label: `security`)
**Branch / worktree:** `share-safe-fs` (`/Users/tobyhede/psrc/rundown/.worktrees/share-safe-fs`)
**Date:** 2026-06-14
**Status:** Plan only — no production code written.

---

## 1. Summary

`packages/core` currently contains **three independently-written copies** of the same
security-critical "race-closed file-read guard" pattern (open with `O_NOFOLLOW`,
`fstat` the opened fd, verify it is a regular file, treat symlink/`ELOOP` specially).
Each copy is a drift hazard: a hardening or fix applied to one does not reach the others.

The canonical, most-hardened version lives **inline and unexported** inside
`packages/core/src/runbook/artifact-manifest.ts` (`openVerifiedRegularFileSync`,
`validateOpenedPathInsideRoot`, `sameFile`, plus the sync/async `readVerifiedUtf8File*`
helpers). The issue's body assumes a prerequisite — that a shared
`packages/core/src/runbook/safe-fs.ts` module would already exist (created by the
separate "validate helper + artifact-schema" Task 10). **That prerequisite has not
landed: `safe-fs.ts` does not exist on this branch** (confirmed: `ls
packages/core/src/runbook/safe-fs.ts` → "No such file or directory").

This plan therefore expands the issue's scope to do the extraction the issue assumed:

1. **Create** `packages/core/src/runbook/safe-fs.ts` by lifting the canonical guard
   family out of `artifact-manifest.ts`.
2. **Repoint** `artifact-manifest.ts` to import from `safe-fs.ts`, preserving behaviour
   exactly (it remains the canonical caller).
3. **Converge** `output-channels.ts` onto a new **async** variant exposed by `safe-fs.ts`,
   with **no behavioural change** to output capture.

Priority order per `CLAUDE.md`: **correctness > type safety > clean architecture > test
coverage**. The convergence must not weaken or alter any of the three call sites'
observable behaviour — it only removes duplication.

---

## 2. Current state (verified file:line references)

### 2.1 `safe-fs.ts` does not exist

`packages/core/src/runbook/safe-fs.ts` is absent. There are no current imports of it
anywhere in the tree (no grep hits). Any reference in the issue to its prior existence
is aspirational.

### 2.2 Canonical guard — `artifact-manifest.ts` (the source of truth)

All of these are **module-private** (not exported) in
`packages/core/src/runbook/artifact-manifest.ts`:

| Symbol | Lines | Role |
|--------|-------|------|
| `openVerifiedRegularFileSync(workRoot, filePath, flags): number` | 720–734 | **Canonical sync guard.** Lexical containment pre-check, `openSync(flags)`, `fstatSync`, `validateOpenedPathInsideRoot`, `isFile()` assert; on any failure closes the fd and rethrows. Returns the open fd (caller closes). |
| `validateOpenedPathInsideRoot(root, filePath, openedStat): void` | 758–767 | realpath(root) + realpath(filePath), lexical containment (`assertContained`), then re-`statSync` the realpath and assert `sameFile(openedStat, current)` (dev/ino match → closes the symlink-swap TOCTOU window). Throws `INVALID_URI_PATH_SHAPE` on mismatch. |
| `sameFile(left, right): boolean` | 769–771 | `dev === dev && ino === ino`. |
| `assertContained(root, candidate): void` | 652–657 | Lexical `path.relative` containment check; throws `INVALID_URI_PATH_SHAPE` if `..`/absolute escapes root. |
| `noFollowFlag(): number` | 773–775 | `O_NOFOLLOW` if present, else `0` (platform fallback). |
| `directoryFlag(): number` | 777–779 | `O_DIRECTORY` if present, else `0`. |
| `assertVerifiedDirectoryInsideRoot(root, dir): void` | 736–756 | Directory analogue of the file guard (uses `directoryFlag`). |
| `readVerifiedUtf8FileSync(workRoot, filePath): string` | 611–623 | **sync** open+fstat+validate+`isFile`+`readFileSync('utf8')`. |
| `readVerifiedUtf8File(workRoot, filePath): Promise<string>` | 706–718 | **async** twin of the above (`fsp.open` + `handle.stat()` + validate + `readFile('utf8')`). Already exists — proves the async shape is viable. |
| `isExistingRegularContainedFile(workRoot, filePath): boolean` | 684–704 | Boolean wrapper over `openVerifiedRegularFileSync` that maps `ENOENT`/`ENOTDIR`/`ELOOP`/`INVALID_URI_PATH_SHAPE` → `false`. |

Inline callers of the canonical guard **inside `artifact-manifest.ts`** that must keep
working unchanged after extraction:

- `writeManifestLineSync` (501–538) — calls `validateOpenedPathInsideRoot` at line 525.
- `readVerifiedUtf8FileSync` (611–623) — line 615.
- `isExistingRegularContainedFile` (684–704) — calls `openVerifiedRegularFileSync` at 687.
- `readVerifiedUtf8File` (706–718) — line 710.
- The `file:`-URI branch of `isExistingRegularArtifactFile` (423–486) open-codes a
  *realpath-first* containment variant (does **not** use `openVerifiedRegularFileSync`).
  **Leave this branch as-is** — it is a different algorithm (realpath-then-stat, no fd
  fstat) and is out of scope for #433. It is noted here so reviewers know it was
  considered and deliberately not converged.

The shared error sentinel is `ARTIFACT_ERROR_TEXT.INVALID_URI_PATH_SHAPE`
(`'Invalid artifact URI path shape'`) defined in
`packages/core/src/runbook/artifact-errors.ts:5`.

### 2.3 Third copy — `output-channels.ts` (the convergence target)

`packages/core/src/runbook/output-channels.ts` has **two** open-coded guard sites, both
**async** (`fs.promises`):

**(a) Write path — `prepareOutputChannels` (202–258):**
- line 208: `const noFollow = fsConstants.O_NOFOLLOW;` (NB: no `'O_NOFOLLOW' in constants`
  fallback — assumes the constant exists).
- 222–226: `fs.open(filePath, O_WRONLY|O_CREAT|O_TRUNC|O_NOFOLLOW, 0o600)`.
- 228–235: `handle.stat()`; if `!stat.isFile()` → **log + `continue`** (skip, not throw).
- 236: `handle.chmod(0o600)`.
- 243–249: catch — `ELOOP` → log "symlinked channel file" + `continue`; other errors →
  log "failed to create channel file" + `continue`.

**(b) Read path — `readCapturedOutputs` (272–333):**
- 281: `fs.open(filePath, O_RDONLY|O_NOFOLLOW)`.
- 282–289: `handle.stat()`; if `!stat.isFile()` → log + `continue`.
- 290–299: `handle.readFile()` + strict UTF-8 decode (skip on non-UTF-8).
- 301–310: catch — `ENOENT` → log "missing"; else log "read failed"; both `continue`.

**Critical behavioural differences from the canonical guard** (these drive the design):

1. **Skip vs throw.** output-channels treats every failure (non-regular, `ELOOP`, read
   error) as *skip-this-entry-and-continue*, emitting a specific `logger.warn` per case.
   The canonical guard *throws* `INVALID_URI_PATH_SHAPE`. Convergence MUST preserve the
   skip-and-log behaviour — it is the documented "best-effort" contract of
   `prepareOutputChannels` / `readCapturedOutputs`.
2. **No workRoot containment check.** output-channels does **not** call
   `validateOpenedPathInsideRoot` — it performs no realpath/containment/`sameFile`
   re-stat. Its paths are pre-validated lexically by `assertSafeId` /
   `assertSafeOutputName` / `outputChannelPath` (74–159). So the canonical guard's
   dev/ino re-stat is **extra** behaviour output-channels does not have today.
3. **Write semantics.** The write path opens with `O_CREAT|O_TRUNC` + `0o600` mode + an
   explicit `chmod(0o600)` and keeps the handle to write into. The canonical
   `openVerifiedRegularFileSync` is read-shaped (returns an fd; the manifest write path
   does its own `O_CREAT|O_APPEND` open separately, see 520–522). The shared async helper
   must support a write/create flavour without forcing containment re-stat.

These differences mean a naive "call `openVerifiedRegularFileSync`" convergence would
**change behaviour** (add a containment re-stat, convert skips to throws). The plan below
resolves this by exposing a small, parameterised async primitive whose *containment check
is opt-in*, so output-channels can adopt the shared open+fstat+`isFile` core while keeping
its skip-and-log policy in the caller.

### 2.4 Other realpath/`ELOOP` sites (surveyed, NOT in scope)

Grep across `packages/core/src` found these additional `realpath`/`ELOOP`/`O_NOFOLLOW`
sites. They are **different patterns** (path canonicalisation, lock realpath, glob
ignore-lists), not the open+fstat+`isFile` guard, and are **out of scope**:

- `source-resolver.ts:201,216`, `variable-preparation.ts:197,330,…`,
  `artifact-directive-resolver.ts:284,294`, `rdpath.ts:124,129` — `fs.realpath`
  canonicalisation only.
- `rdpath.ts:8` — `ELOOP` in a glob-ignore code set.
- `state.ts:256`, `session-lock.ts:52`, `sandbox/*.ts` — `realpathSync` for cwd/lock/node
  resolution.
- `schemas.ts:207,223,761` — realpath-canonical-path *validation* (zod), not fs access.

Only `artifact-manifest.ts` and `output-channels.ts` contain the open+fstat-of-fd+`isFile`
guard. The issue's "third near-copy" = `output-channels.ts` (copies #1 sync and #2 async
both live in `artifact-manifest.ts`; #3 async lives in `output-channels.ts`). Confirmed:
the third copy the issue refers to **is** what was found.

### 2.5 Barrel / export wiring

- `packages/core/src/index.ts:43` does `export * from './runbook/index.js'`.
- `packages/core/src/runbook/index.ts` re-exports per-module:
  - `artifact-manifest.js` block at lines 280–290 (does **not** export the private guards).
  - `output-channels.js` block at lines 375–383.
  - `file-lock.js` block at 213–214 (the model for a focused security-primitive export).
  - `artifact-errors.js` at 238.
- The guard functions are currently **not exported** from any barrel. Whether `safe-fs.ts`
  exports should be added to the barrel is an open question (§7).

### 2.6 Test landscape

- `packages/core/__tests__/runbook/output-channels.test.ts` (464 lines) — pins
  prepare/read behaviour.
- `packages/core/__tests__/runbook/artifact-manifest-toctou.test.ts` — symlink-swap /
  TOCTOU coverage using `jest.unstable_mockModule('node:fs', …)` to inject
  `afterLstat`/`beforeOpen` race hooks. **This is the canonical model for the new
  `safe-fs` symlink-swap test.**
- `artifact-manifest.test.ts`, `artifact-manifest.properties.test.ts` — broader manifest
  behaviour + property tests.

---

## 3. Target design — `safe-fs.ts`

A new module `packages/core/src/runbook/safe-fs.ts` that is the **single canonical home**
for the race-closed file-read guard, exposing **both sync and async** variants. Every
exported symbol gets full TSDoc per `CLAUDE.md` TSDoc Standards (description, `@param`,
`@returns`, `@throws`).

### 3.1 Design constraints (from CLAUDE.md + the behavioural diff)

- **Correctness first:** all three existing call sites keep identical observable behaviour.
- **Type-driven dispatch / invalid states unrepresentable:** the symlink/non-regular
  rejection is signalled by a **typed error class** (not a bare string compare), and the
  "skip" vs "throw" decision is made by the *caller*, not baked into the primitive.
- **Containment is opt-in:** the workRoot re-stat (`validateOpenedPathInsideRoot`) is a
  parameter, so artifact-manifest keeps it and output-channels omits it — matching today's
  behaviour exactly.
- **Platform fallback preserved:** `noFollowFlag()` / `directoryFlag()` move into safe-fs
  so the `'O_NOFOLLOW' in fs.constants` fallback is centralised.

### 3.2 Error contract

Introduce a typed error so callers narrow rather than string-match:

```ts
/**
 * Thrown by safe-fs guards when an opened path fails its regular-file /
 * containment / symlink-swap verification. The `reason` discriminant lets
 * callers map specific failure modes to their own policy (skip vs propagate)
 * without string-matching error messages.
 */
export class UnsafeFileError extends Error {
  readonly reason: UnsafeFileReason;
  constructor(reason: UnsafeFileReason, path: string);
}

/** Why a guarded open was rejected. */
export type UnsafeFileReason =
  | 'not-regular-file'   // fstat of the opened fd is not a regular file
  | 'escaped-root'       // realpath of target is outside the contained root
  | 'symlink-swapped';   // dev/ino re-stat mismatch (TOCTOU window detected)
```

Note: `ELOOP` / `ENOENT` / `ENOTDIR` are **OS** errors from `open` itself — they surface
as `NodeJS.ErrnoException` and are classified by callers with the existing
`isNodeErrorCode` / `isNodeError` helpers (per CLAUDE.md testing conventions: never call
`Error.isError` directly). safe-fs does **not** swallow them; it lets them propagate so
each caller applies its own policy (artifact-manifest → throw/`false`; output-channels →
skip+log).

Decision on artifact-manifest's existing `INVALID_URI_PATH_SHAPE` sentinel: to keep
`artifact-manifest.ts` byte-for-byte behaviour-stable, the **migrated** artifact-manifest
helpers continue to throw `INVALID_URI_PATH_SHAPE`. Two equivalent options (resolve at
implementation time, see §7-Q4):
- **(A, preferred)** safe-fs throws `UnsafeFileError`; artifact-manifest's thin wrappers
  catch `UnsafeFileError` and rethrow `new Error(INVALID_URI_PATH_SHAPE)` so its existing
  catch sites (374, 492, 694, etc.) and tests are unchanged.
- **(B)** safe-fs's guard accepts an injected `onReject: (reason) => never` callback;
  artifact-manifest passes one that throws `INVALID_URI_PATH_SHAPE`, output-channels never
  triggers it (uses the no-throw boolean form). Option A is simpler and keeps the typed
  error as the module's native contract; prefer A unless a caller needs the exact reason.

### 3.3 Proposed API surface

```ts
// packages/core/src/runbook/safe-fs.ts

/** O_NOFOLLOW if the platform defines it, else 0 (open-without-nofollow fallback). */
export function noFollowFlag(): number;

/** O_DIRECTORY if the platform defines it, else 0. */
export function directoryFlag(): number;

/** True when two stat results refer to the same inode (dev+ino match). */
export function sameFile(left: fs.Stats, right: fs.Stats): boolean;

/** Lexical containment assertion: throws UnsafeFileError('escaped-root') if
 *  `candidate` resolves outside `root` (no fs access). */
export function assertContained(root: string, candidate: string): void;

/** realpath(root)+realpath(filePath) containment + dev/ino re-stat against the
 *  already-opened stat; throws UnsafeFileError('escaped-root' | 'symlink-swapped'). */
export function validateOpenedPathInsideRoot(
  root: string, filePath: string, openedStat: fs.Stats,
): void;

// ---- SYNC guard (canonical, used by artifact-manifest) ----

/**
 * Open a path with O_NOFOLLOW, fstat the opened fd, optionally verify the fd
 * is contained under `containedRoot`, and assert it is a regular file. Returns
 * the open fd; the caller owns closing it. Closes the fd and rethrows on any
 * verification failure (UnsafeFileError) or OS error (ELOOP/ENOENT/ENOTDIR).
 *
 * When `containedRoot` is undefined the realpath/dev-ino re-stat is skipped —
 * this is the output-channels-equivalent guarantee (O_NOFOLLOW + isFile only).
 */
export function openVerifiedRegularFileSync(
  filePath: string,
  flags: number,
  containedRoot?: string,
): number;

/** Sync: open+fstat+verify, read whole file as UTF-8, close. */
export function readVerifiedUtf8FileSync(filePath: string, containedRoot?: string): string;

// ---- ASYNC guard (new, used by output-channels) ----

/**
 * Async twin of openVerifiedRegularFileSync. Resolves to an open FileHandle
 * (caller closes). The O_NOFOLLOW guarantee means a symlink target produces an
 * ELOOP ErrnoException from `open` — callers classify it with isNodeErrorCode.
 */
export function openVerifiedRegularFile(
  filePath: string,
  flags: number,
  mode?: fs.Mode,
  containedRoot?: string,
): Promise<fs.promises.FileHandle>;

/** Async: open+fstat+verify, read whole file as UTF-8, close. */
export function readVerifiedUtf8File(filePath: string, containedRoot?: string): Promise<string>;
```

**Why this shape resolves the async/sync dimension (the core decision the issue demands):**

- artifact-manifest keeps using the **sync** variants (`openVerifiedRegularFileSync`,
  `readVerifiedUtf8FileSync`) with a non-`undefined` `containedRoot` → identical behaviour
  (containment + dev/ino re-stat preserved).
- output-channels adopts the **async** `openVerifiedRegularFile` with `containedRoot`
  **omitted** → it gets exactly today's guarantee (O_NOFOLLOW + `isFile`), no new
  containment re-stat, **no behavioural change**. The handle is returned open so
  output-channels can still `chmod`, `writeFile`/`readFile`, and apply its
  skip-and-`logger.warn` policy in its own `catch` (classifying `ELOOP`/`ENOENT` via
  `isNodeErrorCode`, mapping `UnsafeFileError('not-regular-file')` → the existing
  "non-regular channel file" warning).
- `O_NOFOLLOW` is what makes a symlink target raise `ELOOP` at `open()` time, so the
  "ELOOP → skip" semantics output-channels relies on are preserved as long as the helper
  always ORs in `noFollowFlag()` (it must, unconditionally).

This keeps the **isFile / regular-file check** inside the shared helper (so all three
sites share one hardened implementation) while leaving **policy** (skip vs throw,
which warning to log, write vs read flags) entirely in the callers.

---

## 4. Step-by-step changes (ordered, reviewable)

Each step is independently compilable and test-green; review can stop at any boundary.

### Step 1 — Create `safe-fs.ts` (pure extraction, no caller changes yet)

1. Create `packages/core/src/runbook/safe-fs.ts`.
2. Move (cut) from `artifact-manifest.ts`: `noFollowFlag`, `directoryFlag`, `sameFile`,
   `assertContained`, `validateOpenedPathInsideRoot`, `openVerifiedRegularFileSync`,
   `readVerifiedUtf8FileSync`, `readVerifiedUtf8File` (async), and the directory guard
   `assertVerifiedDirectoryInsideRoot` (it shares `directoryFlag`/`validateOpenedPathInsideRoot`).
   - Generalise `openVerifiedRegularFileSync` / read helpers to the new signatures
     (add the optional `containedRoot` param; when present, behave exactly as the current
     `workRoot`-taking versions).
   - Add the new async `openVerifiedRegularFile(filePath, flags, mode?, containedRoot?)`.
   - Introduce `UnsafeFileError` + `UnsafeFileReason`. Internally throw `UnsafeFileError`
     instead of `INVALID_URI_PATH_SHAPE` (the artifact-manifest wrappers in Step 2
     translate it back — option A in §3.2).
3. Full TSDoc on every exported symbol (`@param`/`@returns`/`@throws`). Use
   `isNodeErrorCode`/`isNodeError` from `../errors.js` for any internal errno checks
   (never `Error.isError` directly — CLAUDE.md).
4. Do **not** touch the barrel yet (Step 4 decides exports).

### Step 2 — Repoint `artifact-manifest.ts` (behaviour-preserving)

1. `import` the needed symbols from `./safe-fs.js`.
2. Replace the now-removed local helpers with thin wrappers that preserve the exact
   existing throw contract:
   - Where artifact-manifest previously relied on the guard throwing
     `INVALID_URI_PATH_SHAPE`, wrap the safe-fs call so a caught `UnsafeFileError` is
     rethrown as `new Error(ARTIFACT_ERROR_TEXT.INVALID_URI_PATH_SHAPE)` (option A).
     Concretely: `readVerifiedUtf8FileSync` (was 611–623), `readVerifiedUtf8File`
     (706–718), `isExistingRegularContainedFile` (684–704), and the `writeManifestLineSync`
     inline `validateOpenedPathInsideRoot` call (525) — each passes `workRoot` as
     `containedRoot` so the realpath/dev-ino re-stat is unchanged.
   - `assertVerifiedDirectoryInsideRoot` (736–756) and its callers
     (`assertExistingAncestorsInsideRoot` 659–682, `resolveContainedWorkRoot` 637–650)
     now call the safe-fs directory guard; keep the `INVALID_URI_PATH_SHAPE` translation.
3. Leave the `file:`-URI realpath-first branch (423–486) untouched (§2.2).
4. Confirm `artifact-manifest.ts` no longer defines any of the moved functions (no dead
   private copies left behind — the whole point of #433).

### Step 3 — Converge `output-channels.ts` onto the async guard

1. `import { openVerifiedRegularFile, UnsafeFileError } from './safe-fs.js';`
   (and drop the local `noFollow`/inline open where replaced).
2. **Write path** (`prepareOutputChannels`, 220–255): replace the inline
   `fs.open(..., O_WRONLY|O_CREAT|O_TRUNC|O_NOFOLLOW, 0o600)` + `handle.stat()` +
   `!isFile()` skip with a call to `openVerifiedRegularFile(filePath,
   O_WRONLY|O_CREAT|O_TRUNC, 0o600)` (helper ORs in `noFollowFlag()`; **no**
   `containedRoot`). Keep the surrounding try/finally, `handle.chmod(0o600)`, env push, and
   `prepared.push` exactly as-is. In the `catch`:
   - `isNodeError(err) && err.code === 'ELOOP'` → existing "symlinked channel file" warn +
     `continue` (unchanged).
   - `err instanceof UnsafeFileError && err.reason === 'not-regular-file'` → the existing
     "non-regular channel target" warn + `continue` (this replaces the inline
     `!stat.isFile()` branch, now raised from inside the helper).
   - else → existing "failed to create channel file" warn + `continue`.
3. **Read path** (`readCapturedOutputs`, 281–289): replace the inline
   `fs.open(filePath, O_RDONLY|O_NOFOLLOW)` + `stat()` + `!isFile()` skip with
   `openVerifiedRegularFile(filePath, O_RDONLY)`. Keep the UTF-8 decode, NUL check, trim,
   `parseRuntimeVariableValue`, the `ENOENT` "missing"/"read failed" warnings, and the
   `finally { handle.close() }` exactly as-is. Map `UnsafeFileError('not-regular-file')` →
   the existing "non-regular channel file, omitting" warning.
4. Net effect: identical logs, identical skip behaviour, identical env/captured output —
   the only change is *where the open+fstat+isFile lives*.

### Step 4 — Barrel exports + housekeeping

1. Decide export surface (§7-Q1). Recommended: add a focused `safe-fs.js` export block to
   `packages/core/src/runbook/index.ts` modelled on the `file-lock.js` block (213–214),
   exporting at minimum `UnsafeFileError`, `UnsafeFileReason` (type),
   `openVerifiedRegularFile`, `openVerifiedRegularFileSync`, `readVerifiedUtf8File`,
   `readVerifiedUtf8FileSync`. Keep `assertContained`/`validateOpenedPathInsideRoot`/
   `sameFile`/`noFollowFlag`/`directoryFlag` exported too if any test imports them
   directly; otherwise keep them module-internal and test through the public guards.
2. Remove the now-unused `fsConstants`/`O_NOFOLLOW` import bits from `output-channels.ts`
   if fully superseded; keep `isNodeError` (still used in catches).
3. Run `npm run fix:lint` + `npm run format` to settle import ordering.

---

## 5. Testing strategy

### 5.1 New: `packages/core/__tests__/runbook/safe-fs.test.ts`

Unit tests for the extracted module (model the symlink-swap hooks on
`artifact-manifest-toctou.test.ts`'s `jest.unstable_mockModule('node:fs', …)` pattern):

- **Regular file accepted** — sync and async: `openVerifiedRegularFile{,Sync}` on a real
  regular file returns an fd/handle and `readVerifiedUtf8File{,Sync}` returns its content.
- **Symlink rejected (`ELOOP`)** — point `filePath` at a symlink; assert the call rejects
  with an `ErrnoException` whose `code === 'ELOOP'` (because `O_NOFOLLOW` is always ORed
  in). Both sync and async.
- **Non-regular target → `UnsafeFileError('not-regular-file')`** — target a FIFO/dir
  (something that opens but isn't a regular file) and assert the typed error + `reason`.
- **Missing file (`ENOENT`)** — propagates as `ErrnoException` `ENOENT` (not swallowed).
- **Containment ON (artifact-manifest mode):** with `containedRoot` set, a path whose
  realpath escapes the root → `UnsafeFileError('escaped-root')`; a TOCTOU symlink swap that
  changes dev/ino between open and re-stat → `UnsafeFileError('symlink-swapped')` (use the
  `afterLstat`/`beforeOpen` race-hook style).
- **Containment OFF (output-channels mode):** with `containedRoot` omitted, the
  realpath/dev-ino re-stat is **not** performed (assert no extra `realpathSync` call, or
  assert a path outside any root still opens) — pins that output-channels gets no new
  behaviour.
- **Property test (optional, mirrors `artifact-manifest.properties.test.ts`):** for
  arbitrary safe relative paths, containment-ON accepts iff lexically+realpath contained.

### 5.2 Regression: existing suites must stay green (no new behaviour)

- `output-channels.test.ts` (464 lines) — **must pass unchanged**. This is the primary
  "no behavioural change to output capture" gate from the acceptance criteria. If any
  assertion needs editing, that signals a behaviour change and must be stopped/reviewed.
- `artifact-manifest.test.ts`, `artifact-manifest.properties.test.ts`,
  `artifact-manifest-toctou.test.ts` — **must pass unchanged**. These pin the canonical
  guard's containment + symlink-swap behaviour now living in safe-fs.
- Add output-channels symlink-swap coverage **only if** the existing suite lacks it
  (issue asks to "add escape/symlink-swap coverage if not already present"). Grep
  `output-channels.test.ts` for `ELOOP`/symlink first; if absent, add a case that creates
  a symlinked channel path and asserts the entry is skipped (write path) / omitted (read
  path) with the existing warning.

### 5.3 Mutation coverage

- safe-fs is security-critical; run `npm run test:mutate:core` (or scoped) over
  `safe-fs.ts`. Ensure mutants on the `sameFile` dev/ino comparison, the `isFile()`
  assert, and the `noFollowFlag()` OR are killed (these are the security-load-bearing
  lines). The existing TOCTOU test already kills equivalent mutants in the manifest copy;
  the new safe-fs tests must reproduce that kill coverage at the new home.

---

## 6. Verification

Commands (run from worktree root):

```bash
# Targeted, fast feedback during implementation:
npm test -w @rundown-org/core -- safe-fs
npm test -w @rundown-org/core -- output-channels
npm test -w @rundown-org/core -- artifact-manifest

# Security/mutation focus on the new module:
npm run test:mutate:core   # (or scoped to safe-fs.ts)

# Full pre-PR gate (MANDATORY per CLAUDE.md):
npm run verify             # format + spell + lint + test
```

**Acceptance-criteria mapping (issue #433):**

| Acceptance criterion | Satisfied by |
|----------------------|--------------|
| `output-channels.ts` no longer open-codes its own symlink/containment guard; imports from `safe-fs.ts` | Step 3 — both open sites call `openVerifiedRegularFile` |
| No behavioural change to output capture (existing tests green) | §5.2 — `output-channels.test.ts` passes unchanged; skip+log policy retained in callers |
| Single canonical home for the race-closed file-read guard across core | Steps 1–2 — guard extracted to `safe-fs.ts`; artifact-manifest repointed; no private duplicate remains |
| (issue) expose an **async** variant matching output-channels (`ELOOP`→skip, `isFile()`) | §3.3 `openVerifiedRegularFile`; `O_NOFOLLOW` preserves `ELOOP`, caller keeps skip |
| (issue) pin parity + add escape/symlink-swap coverage if missing | §5.1 new safe-fs tests + §5.2 conditional output-channels symlink case |

---

## 7. Risks / open questions

- **Q1 — Export surface.** Should the guards be exported from the core barrel at all, or
  stay package-internal (imported only by sibling runbook modules via relative path)?
  `file-lock.js` exports its primitives, which argues for exporting safe-fs too. **Lean:**
  export the guard + `UnsafeFileError` (security primitive consumers like rdx
  `--schema-file` — the issue's mentioned future caller — will want it), keep the
  lexical/`*Flag` helpers internal unless a test needs them.

- **Q2 — async/sync decision (the headline risk).** Resolved in §3.3: expose **both**;
  artifact-manifest stays sync, output-channels uses the new async form with
  `containedRoot` **omitted**. The load-bearing correctness point is that output-channels
  must NOT gain the containment re-stat — verify via §5.1 "containment OFF" test, else this
  is a silent behaviour change and an acceptance-criteria failure.

- **Q3 — `noFollowFlag()` fallback divergence.** Today output-channels uses bare
  `fsConstants.O_NOFOLLOW` (no `in` guard) while artifact-manifest uses `noFollowFlag()`
  (falls back to `0`). Centralising on `noFollowFlag()` is *safer* and harmonises the two,
  but on a platform lacking `O_NOFOLLOW` it changes output-channels from
  `undefined`-OR (NaN/throw risk) to `0`-OR. This is a strict improvement, not a
  regression, and should be called out in the PR description. Confirm no test asserts the
  raw flag value.

- **Q4 — `UnsafeFileError` vs `INVALID_URI_PATH_SHAPE` translation.** artifact-manifest has
  many catch sites (374, 492, 694) and tests asserting `INVALID_URI_PATH_SHAPE`. Option A
  (wrap+rethrow the sentinel in artifact-manifest) keeps all of them green with zero test
  edits and is the recommended path. Option B (callback) is heavier. Decide at
  implementation; A preferred.

- **Q5 — Callers to repoint.** All internal callers of the moved guards are inside
  `artifact-manifest.ts` (enumerated §2.2) — no cross-file callers exist today (grep
  confirmed the symbols are module-private). So the repoint blast radius is exactly two
  files plus the barrel. Low risk.

- **Q6 — Third-copy identity.** Confirmed (§2.4): the "third near-copy" the issue names is
  `output-channels.ts`. The realpath-first `file:`-URI branch in `isExistingRegularArtifactFile`
  (423–486) is a *fourth, different* algorithm and is deliberately **not** converged here;
  flag it as possible future follow-on but out of scope for #433.

- **Q7 — Prerequisite drift.** The issue assumed `safe-fs.ts` already existed (its "Task
  10"). It does not. This plan absorbs that extraction. If the separate validate/artifact-
  schema work later lands its own `safe-fs.ts`, coordinate to avoid a merge collision —
  whoever lands second rebases onto the existing module rather than recreating it.
