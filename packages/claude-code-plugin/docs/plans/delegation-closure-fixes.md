# Delegation Closure Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close three verified critical defects in the Claude Code plugin's
delegation-closure enforcement: a lost-update race on the plugin session file, a
non-idempotent token-consume-before-verify ordering in SubagentStop, and a
fail-open CLI hook boundary that lets a subagent stop with an open delegation.

**Architecture:** The plugin (`@rundown-org/claude-code-plugin`) is an alternate
front-end to `@rundown-org/core`. It currently keeps a _shadow_ store of
delegation-token state in its own `.claude/session/state.json` (Zod schema +
record/consume/cleanup logic) while core already owns the delegation domain
(`hashDelegationToken`, `readConsumedDelegationClosureForCwd`,
`assertDelegationTokenHash`, and `DelegationLock` — the synchronization
primitive built for exactly this problem). The three defects are symptoms of
that shadow store being unsynchronized, consume-ordered wrong, and fronted by a
fail-open CLI. The fixes are each independently shippable; the locking fix is
gated behind an explicit Option A / Option B decision (Phase 0) about _where the
delegation-token store should live_.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Jest, fast-check
(property tests), Stryker (mutation), Zod, XState (core), pnpm workspaces.

## Global Constraints

Copied verbatim from the repo's architectural principles (root `CLAUDE.md`).
Every task implicitly includes these.

- **Concurrent write synchronization is non-negotiable.** Multiple CLI processes
  that may mutate the same file MUST use file-based exclusive locks with
  PID-aware stale reclamation. Reuse core's primitives —
  `acquireFileLock`/`releaseFileLock` and `heldLock`
  (`packages/core/src/runbook/file-lock.ts`), or a domain lock built on them.
  NEVER hand-roll a lock.
- **`await using` lock release policy (RD-102).** Release locks via
  `await using _guard = await lock.scope(...)` (or `lock.held(...)`), never from
  a bare `try/finally`. A failed release must never propagate and mask the
  committed result of the protected work.
- **The plugin is a thin front-end.** It MUST NOT re-implement, replicate, or
  work around core logic. Delegation domain logic belongs in core. A side effect
  that lives in the plugin but belongs in core is architectural debt; the fix is
  to move it.
- **No state migration.** Never migrate persisted state between versions. Reject
  invalid/incompatible persisted state (schema-version or structural guard) and
  fall back to a fresh init — never silently adapt, rewrite, or shim. (The
  plugin Session already reinitializes on parse/validation failure; preserve
  that, do not add legacy-field hydration.)
- **Type-driven dispatch.** Use discriminated unions and type narrowing so
  invalid states are unrepresentable. Branching on a raw string discriminant is
  a code smell — encode it in a purpose-built type. (The
  `ConsumedDelegationToken` union in `subagent-stop.ts` is the established
  pattern; extend it, do not bypass it.)
- **Hook protocol conformance.** Claude Code reads hook _decisions_ from STDOUT
  only. `continue:false` is ignored on PreToolUse/SubagentStop.
  `process.exit(1)` is non-blocking; **exit 2 blocks.** Decisions are emitted
  via `buildHookOutput` (`packages/claude-code-plugin/src/hook-output.ts`):
  PreToolUse blocks with `hookSpecificOutput.permissionDecision: 'deny'`;
  SubagentStop blocks with `decision: 'block'` + `reason`.
- **Error helpers.** Use `isError`/`isNodeError`/`getErrorMessage` from
  `packages/claude-code-plugin/src/shared/errors.ts` — never call
  `Error.isError()` directly.
- **Verification gate.** `pnpm run verify` (format + spell + lint + test) MUST
  pass before any push.

---

## Context: the three defects (verified against source)

**Defect 1 — Unlocked read-modify-write loses delegation tokens (Critical).**
`Session.get('metadata')` (`session.ts:36-39`) → mutate →
`Session.set('metadata')` (`session.ts:47-51`, persisted by `save` at
`session.ts:188-208`) has no lock. The concurrency note at `session.ts:181-185`
wrongly claims "hooks run sequentially in practice" — each hook is a separate OS
process spawned per `cli.ts`. Atomic rename (`session.ts:191-198`) prevents file
_corruption_ but not _lost updates_: two concurrent `PreToolUse(Agent/Task)`
writers each read the same base `metadata`, each add their own
`delegation_active_tokens[agent_id]` entry (`delegation-dispatch.ts:59-87`), and
the second rename clobbers the first writer's entry. The dropped agent's later
`SubagentStop` then finds no token (`subagent-stop.ts:81`
`Object.hasOwn(map, input.agent_id)` is false) → `{ kind: 'none' }` → no closure
block. This violates the non-negotiable "use file-based exclusive locks" rule.

**Defect 2 — SubagentStop consumes the token before verifying closure; block is
not idempotent (Critical).** In `subagent-stop.ts`,
`consumeDelegationTokenForAgent` _deletes and persists_ the entry
(`subagent-stop.ts:106-116`; legacy path `subagent-stop.ts:55-57`) BEFORE
`consumedDelegationStillRequiresClosure` runs (`subagent-stop.ts:186`). Claude
Code re-fires SubagentStop on `stop_hook_active` reentrancy after a block. On
the re-fire the entry is already gone → `consumeDelegationTokenForAgent` returns
`{ kind: 'none' }` (`subagent-stop.ts:175-177`) → `{}` → no block. The first
block is therefore not idempotent: the second stop is permitted with the
delegation still open.

**Defect 3 — CLI boundary fails open (Critical).** `cli.ts` failure paths emit
`{ continue:false, stopReason }` to **stderr** via `console.error` then
`process.exit(1)`:

- empty input: `cli.ts:37-48`
- parse failure: `cli.ts:50-64`
- unexpected throw: `cli.ts:97-107`

Per the hook protocol, none of these block: decisions are read from stdout,
`continue:false` is ignored on PreToolUse/SubagentStop, and exit 1 is
non-blocking. A malformed SubagentStop payload therefore lets the subagent stop
with an open delegation — fail-open. (Note the dispatch _success_ path already
writes correctly to stdout via `buildHookOutput` at `cli.ts:79-96`; only the
error paths fail open.)

**Architectural root cause.** All three are symptoms of the plugin maintaining a
shadow delegation-token store. Core owns the domain and ships `DelegationLock`
for exactly this synchronization, but the plugin re-implemented tracking in its
own Session file + Zod schema (`shared/schemas.ts:163-193`) +
record/consume/cleanup (`delegation-dispatch.ts`, `subagent-stop.ts`). Confirmed
by research: core currently exposes **no** active-token record/consume API (grep
of `packages/core/src/runbook/index.ts` finds none), so Option A below is
genuinely new core code, not a rename.

---

## Phase 0 — Architecture decision: where does active-token tracking live?

This phase produces a written decision, not code. It gates Phase 2 (locking).
Phases 3 and 4 (closure ordering, CLI boundary) are independent of the outcome
and can proceed in parallel.

### Option A (recommended if feasible) — Promote active-token tracking into core

Move the active-token record/consume responsibility into `@rundown-org/core`
behind a typed API that internally uses `DelegationLock`
(`packages/core/src/runbook/delegation-lock.ts`) for synchronization. The plugin
hooks call the core API instead of mutating
`Session.metadata.delegation_active_tokens`.

- **Dissolves Defect 1** (locking) — core's `DelegationLock.scope()` already
  implements the required PID-aware, `await using`, non-masking pattern.
- **Dissolves the legacy/map cross-masking** — `subagent-stop.ts:74`,`82`,`119`
  fall back to a legacy global `delegation_active_token` key whenever the map
  lookup misses; a single core-owned representation removes that ambiguity.
- **Dissolves stale-token accumulation** — one synchronized, already-tested
  owner.
- **Cost / risk:** new core surface area (storage location under `.rundown/`,
  schema, typed record/consume/closure-check API, tests, TSDoc).
  `DelegationLock` is keyed by `parentRunId` (`delegation-lock.ts:71`, path
  `run-<parentRunId>.delegation.lock`); the active-token store is keyed by
  Claude `agent_id`/`session_id`, which the plugin has but core's delegation
  flow may not associate with a `parentRunId`. Resolving that mapping is the
  feasibility question this phase must answer. If a clean key mapping does not
  exist, Option A is not feasible as-is and Option B ships now with an Option-A
  follow-up issue filed.

### Option B (tactical) — Lock the plugin Session in place

Keep the plugin Session but wrap every `metadata` read-modify-write in a
**plugin-session-specific** file lock built on core's
`heldLock`/`acquireFileLock`.

- **Why a new lock path:** core's `SessionLock` locks `.rundown/session.json`
  (`paths.ts:211`, `session-lock.ts:54`), NOT the plugin's
  `.claude/session/state.json`. Reusing `SessionLock` would serialize against
  the wrong file and still race the plugin file. A new lock path (e.g.
  `.claude/session/state.json.lock`, or a `.rundown/locks/` entry derived from
  the plugin state path) is required.
- **Pros:** smallest blast radius; ships the locking fix without new core domain
  modeling; uses the exact established lock primitive.
- **Cons:** the shadow store persists; the legacy/map duality and stale-token
  accumulation remain; architectural debt is paid down only partially. Per
  `CLAUDE.md` this is acceptable as a tactical step **only** if paired with a
  tracked Option-A follow-up.

### Recommendation

**Adopt Option B now, file an Option-A follow-up issue.** Rationale: the
locking, closure-ordering, and CLI fixes are all independently shippable and
each closes a critical defect immediately; Option B unblocks the critical
Defect-1 fix without waiting on the `agent_id` → `parentRunId` key-mapping
design that Option A needs. Phases 3 and 4 stand regardless. If Phase-0
investigation finds a clean key mapping, promote to Option A and skip Phase 2's
Option-B tasks. This plan implements **Option B** in Phase 2 and records the
Option-A follow-up.

- [ ] **Step 1: Investigate the `agent_id` → `parentRunId` mapping for Option
      A**

Read `packages/core/src/runbook/delegation-service.ts`
(`readConsumedDelegationClosureForCwd` and the closure read model at lines
28-246) and `delegation-token.ts`. Determine whether a Claude
`agent_id`/`session_id` (available on `HookInput`) can be mapped to a core
`parentRunId` (the `DelegationLock` key). Write the finding (one paragraph) into
this plan's "Decision Record" note below.

- [ ] **Step 2: Record the decision**

Append a short "Decision Record" line at the bottom of this file: chosen option,
the key-mapping finding, and (if Option B) the Option-A follow-up issue
reference. No code in this phase.

**Verification:** Decision Record present in this file; `git diff` shows only
this doc changed.

---

## Phase 1 — Pin the defects with failing tests (TDD red)

Write tests that fail against current `HEAD`, proving each defect. These are the
regression guards the later phases turn green. Run each new test and confirm it
FAILS before moving on.

### Task 1: Lost-update test — all concurrent delegation tokens survive

**Files:**

- Test: `packages/claude-code-plugin/__tests__/session.test.ts` (modify —
  strengthen the existing `'handles concurrent writes via atomic rename'` block
  at `session.test.ts:180-199`, add a new lost-update test alongside it)

**Interfaces:**

- Consumes: `Session` (`packages/claude-code-plugin/src/session.ts`),
  `recordDelegationToken` is private — drive it through the public surface by
  calling `Session.set('metadata', ...)` concurrently with distinct per-agent
  keys (mirrors `delegation-dispatch.ts:68-81`).
- Produces: nothing — this is a guard.

- [ ] **Step 1: Write the failing test**

Add to `packages/claude-code-plugin/__tests__/session.test.ts` inside
`describe('error scenarios', ...)`:

```typescript
test('concurrent metadata writers do not lose each other’s delegation tokens', async () => {
  // Simulate N separate hook processes each recording a distinct per-agent token
  // into metadata.delegation_active_tokens via the read-modify-write the plugin uses.
  const agentIds = Array.from({ length: 8 }, (_, i) => `agent-${i}`);

  const recordOne = async (agentId: string): Promise<void> => {
    const session = new Session(testDir);
    const meta = await session.get('metadata');
    const existing =
      meta.delegation_active_tokens && typeof meta.delegation_active_tokens === 'object'
        ? (meta.delegation_active_tokens as Record<string, unknown>)
        : {};
    await session.set('metadata', {
      ...meta,
      delegation_active_tokens: {
        ...existing,
        [agentId]: {
          kind: 'delegation-active-token',
          agent_id: agentId,
          tokenHash: `sha256:${'a'.repeat(64)}`,
          createdAt: new Date().toISOString(),
        },
      },
    });
  };

  await Promise.all(agentIds.map(recordOne));

  const meta = await new Session(testDir).get('metadata');
  const map = meta.delegation_active_tokens as Record<string, unknown>;
  // EVERY token must survive — not merely "length > 0".
  expect(Object.keys(map).sort()).toEqual(agentIds.sort());
});
```

Also strengthen the existing `'handles concurrent writes via atomic rename'`
test: replace the weak `expect(files.length).toBeGreaterThan(0)` assertion
(`session.test.ts:198`) with an exact-survival assertion:

```typescript
// All three appended files must survive, not just "some".
expect(new Set(files)).toEqual(new Set(['file1.ts', 'file2.ts', 'file3.ts']));
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rundown-org/claude-code-plugin test -- session.test.ts`
Expected: FAIL — both the new lost-update test and the strengthened append test
fail because the unlocked read-modify-write drops writers (only the last
writer's key / a subset of files survives).

- [ ] **Step 3: Commit the red test**

```bash
git add packages/claude-code-plugin/__tests__/session.test.ts
git commit -m "test(plugin): pin delegation-token lost-update race (red) (#463)"
```

### Task 2: Double-fire SubagentStop idempotency test

**Files:**

- Test: `packages/claude-code-plugin/__tests__/` — create
  `subagent-stop.test.ts` if absent, else extend the existing SubagentStop test
  file (search first:
  `ls packages/claude-code-plugin/__tests__ | grep -i subagent`).

**Interfaces:**

- Consumes: `handleSubagentStop(input: HookInput): Promise<SubagentStopResult>`
  (`packages/claude-code-plugin/src/workflow/hooks/subagent-stop.ts:168`).
  `readConsumedDelegationClosureForCwd` from `@rundown-org/core` must be mocked
  so the test controls `requiresClosure` without standing up real run state.
  Mock the core module structurally per the repo convention (object-shaped
  doubles, not `new` on a mocked module).
- Produces: nothing — guard.

- [ ] **Step 1: Write the failing test**

```typescript
import { handleSubagentStop } from '../src/workflow/hooks/subagent-stop.js';
import { Session } from '../src/session.js';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

jest.mock('@rundown-org/core', () => {
  const actual = jest.requireActual('@rundown-org/core');
  return {
    ...actual,
    // Closure ALWAYS still required: a correct, idempotent handler must block on
    // every fire until the work is actually closed.
    readConsumedDelegationClosureForCwd: jest
      .fn()
      .mockResolvedValue({ status: 'open', requiresClosure: true }),
  };
});

describe('handleSubagentStop idempotency', () => {
  let testDir: string;
  beforeEach(async () => {
    testDir = await fs.mkdtemp(join(tmpdir(), 'rundown-subagent-stop-'));
  });
  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  test('re-fired SubagentStop re-blocks while closure is still required', async () => {
    const agentId = 'agent-1';
    const session = new Session(testDir);
    await session.set('metadata', {
      delegation_active_tokens: {
        [agentId]: {
          kind: 'delegation-active-token',
          agent_id: agentId,
          tokenHash: `sha256:${'a'.repeat(64)}`,
          createdAt: new Date().toISOString(),
        },
      },
    });

    const input = {
      hook_event_name: 'SubagentStop',
      cwd: testDir,
      agent_id: agentId,
    } as unknown as Parameters<typeof handleSubagentStop>[0];

    const first = await handleSubagentStop(input);
    expect(first.violation).toBeDefined();

    // Reentrancy: Claude Code re-fires SubagentStop with stop_hook_active.
    const second = await handleSubagentStop(input);
    expect(second.violation).toBeDefined(); // MUST still block — defect makes this {} today.
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
`pnpm --filter @rundown-org/claude-code-plugin test -- subagent-stop.test.ts`
Expected: FAIL on the second assertion — the first call deletes the token
(`subagent-stop.ts:115`), so the second call returns `{}` (no violation).

- [ ] **Step 3: Commit the red test**

```bash
git add packages/claude-code-plugin/__tests__/subagent-stop.test.ts
git commit -m "test(plugin): pin SubagentStop double-fire idempotency (red) (#463)"
```

### Task 3: CLI fail-open tests — empty input and parse failure must block to stdout with exit 2

**Files:**

- Test: `packages/claude-code-plugin/__tests__/` — create `cli.test.ts` if
  absent (search: `ls packages/claude-code-plugin/__tests__ | grep -i cli`). The
  CLI runs as a subprocess reading stdin; the most faithful test spawns the
  built CLI entry and inspects stdout + exit code.

**Interfaces:**

- Consumes: the compiled CLI entry (`packages/claude-code-plugin/dist/cli.js`
  after build, or the source via `tsx`/`node --import`). Confirm the run command
  the package already uses for its smoke test (search `package.json` `scripts`
  and existing `__tests__/*smoke*`).
- Produces: nothing — guard.

- [ ] **Step 1: Write the failing test**

```typescript
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// Adjust ENTRY to however the existing smoke test invokes the CLI.
const ENTRY = join(__dirname, '..', 'dist', 'cli.js');

function runCli(stdin: string): { stdout: string; status: number | null } {
  const res = spawnSync(process.execPath, [ENTRY], { input: stdin, encoding: 'utf-8' });
  return { stdout: res.stdout, status: res.status };
}

describe('CLI hook boundary fails closed', () => {
  test('empty input blocks via stdout with exit 2', () => {
    const { stdout, status } = runCli('');
    expect(status).toBe(2);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    // A SubagentStop-style block, or a generic decision:'block' — see hook-output contract.
    expect(parsed.decision === 'block' || parsed.hookSpecificOutput !== undefined).toBe(true);
  });

  test('unparseable SubagentStop payload blocks via stdout with exit 2', () => {
    const { stdout, status } = runCli('{not json');
    expect(status).toBe(2);
    expect(stdout.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Build, then run the test to verify it fails**

Run:
`pnpm --filter @rundown-org/claude-code-plugin build && pnpm --filter @rundown-org/claude-code-plugin test -- cli.test.ts`
Expected: FAIL — current `cli.ts` exits 1 (not 2) and writes the decision to
stderr (so `stdout` is empty and `JSON.parse(stdout)` throws / status is 1).

- [ ] **Step 3: Commit the red test**

```bash
git add packages/claude-code-plugin/__tests__/cli.test.ts
git commit -m "test(plugin): pin CLI fail-open boundary (red) (#463)"
```

---

## Phase 2 — Fix Defect 1: lock the plugin Session read-modify-write (Option B)

Implements the recommended Option B. If Phase 0 selected Option A, replace this
phase with the core-API tasks described there; the Phase-1 Task-1 guard still
applies unchanged.

### Task 4: Add a plugin Session lock and route every read-modify-write through it

**Files:**

- Modify: `packages/claude-code-plugin/src/session.ts` (add lock acquisition
  around `set`/`append`; lock path derived from `this.stateFile`)
- Test: `packages/claude-code-plugin/__tests__/session.test.ts` (Task-1 guard
  turns green)

**Interfaces:**

- Consumes: `acquireFileLock`, `releaseFileLock`, `heldLock`, `type ScopedLock`
  from `@rundown-org/core` (re-exported from core's runbook surface; confirm the
  export path with
  `grep -n "heldLock\|acquireFileLock" packages/core/src/index.ts packages/core/src/runbook/index.ts`).
- Produces: a private `Session` lock seam — `set`/`append` become lock-scoped
  read-modify-write. No public signature changes
  (`get`/`set`/`append`/`contains`/`clear` keep their types from
  `session.ts:36-90`).

- [ ] **Step 1: Add the lock primitives import and a lock-path helper**

In `packages/claude-code-plugin/src/session.ts`, import the lock primitives and
compute a lock file + lock dir from the state file. The lock must guard the
plugin's `.claude/session/state.json`, NOT `.rundown/session.json` — derive the
lock path from `this.stateFile`:

```typescript
import { acquireFileLock, releaseFileLock, heldLock } from '@rundown-org/core';
// ...
export class Session {
  private stateFile: string;
  private lockFile: string;
  private lockDir: string;

  constructor(cwd = '.') {
    this.stateFile = join(cwd, '.claude', 'session', 'state.json');
    this.lockDir = dirname(this.stateFile); // .claude/session
    this.lockFile = `${this.stateFile}.lock`;
  }
```

- [ ] **Step 2: Wrap `set` in an acquire + `await using` scope**

Replace `set` (`session.ts:47-51`) so the read-modify-write is atomic under the
lock, releasing via `await using` (RD-102 — never a bare finally):

```typescript
async set<K extends keyof SessionState>(key: K, value: SessionState[K]): Promise<void> {
  await acquireFileLock(this.lockFile, this.lockDir);
  await using _guard = heldLock(
    () => releaseFileLock(this.lockFile),
    () => ({ lock: 'plugin-session', lockFile: this.lockFile }),
  );
  const state = await this.load();
  state[key] = value;
  await this.save(state);
}
```

- [ ] **Step 3: Wrap `append` in the same lock scope**

Replace `append` (`session.ts:59-68`) identically — the read (`load`), the
dedupe check, and the `save` must all be inside one lock scope:

```typescript
async append(key: SessionStateArrayKey, value: string): Promise<void> {
  await acquireFileLock(this.lockFile, this.lockDir);
  await using _guard = heldLock(
    () => releaseFileLock(this.lockFile),
    () => ({ lock: 'plugin-session', lockFile: this.lockFile }),
  );
  const state = await this.load();
  const array = state[key];
  if (!array.includes(value)) {
    array.push(value);
    state[key] = array;
    await this.save(state);
  }
}
```

- [ ] **Step 4: Correct the stale concurrency comment**

Replace the wrong note at `session.ts:181-185` ("acceptable because hooks run
sequentially in practice") with the truth: hooks run as separate OS processes;
concurrent read-modify-write is serialized by the plugin session file lock
acquired in `set`/`append`. Keep the atomic-rename note (it still prevents
corruption).

- [ ] **Step 5: Run the lost-update guard to verify it passes**

Run: `pnpm --filter @rundown-org/claude-code-plugin test -- session.test.ts`
Expected: PASS — the Task-1 lost-update test and the strengthened append test
now both pass; all tokens / all three files survive.

- [ ] **Step 6: Confirm no `.lock` file leaks into the atomic-write assertion**

The existing `'uses atomic rename'` test (`session.test.ts:132-152`) asserts the
session dir contains no `.tmp` files. The new lock file is named
`state.json.lock` and is removed on release; confirm the test still passes (lock
released before assertion because `set` awaited fully). If the assertion newly
trips on a leftover `.lock`, that is a real release bug — fix the release, do
not loosen the assertion.

Run: `pnpm --filter @rundown-org/claude-code-plugin test -- session.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/claude-code-plugin/src/session.ts packages/claude-code-plugin/__tests__/session.test.ts
git commit -m "fix(plugin): lock plugin session read-modify-write to stop token loss (#463)"
```

---

## Phase 3 — Fix Defect 2: verify closure before consuming the token (idempotent block)

### Task 5: Reorder SubagentStop so the entry is deleted only after closure is CONFIRMED

**Files:**

- Modify: `packages/claude-code-plugin/src/workflow/hooks/subagent-stop.ts`
- Test: `packages/claude-code-plugin/__tests__/subagent-stop.test.ts` (Task-2
  guard turns green)

**Interfaces:**

- Consumes: the `ConsumedDelegationToken` discriminated union
  (`subagent-stop.ts:28-35`), `readConsumedDelegationClosureForCwd`
  (`@rundown-org/core`), `assertDelegationTokenHash`.
- Produces: a non-destructive "peek" of the active token plus a separate "commit
  consume" step. Keep the union shape so callers still narrow on `kind`.

- [ ] **Step 1: Split "peek" from "consume" — stop deleting in the read path**

Today `consumeDelegationTokenForAgent` (`subagent-stop.ts:65-120`) and
`consumeLegacyDelegationToken` (`subagent-stop.ts:37-58`) call
`session.set('metadata', ...)` to delete the entry _during the read_. Refactor
so reading the active token does NOT mutate. Introduce a non-mutating reader
that returns the same `ConsumedDelegationToken` union (rename to reflect it is a
peek, e.g. `peekDelegationTokenForAgent`), and a separate
`commitConsumeDelegationTokenForAgent(session, input)` that performs the
delete + `session.set` (carrying over the hygiene that drops the whole
`delegation_active_tokens` key when the last entry goes,
`subagent-stop.ts:106-114`). The delete path must run under the Phase-2 Session
lock — calling `session.set` already acquires it after Phase 2, so no extra
locking here.

- [ ] **Step 2: Reorder `handleSubagentStop` — verify, then consume only on
      confirmed closure**

Rewrite the body of `handleSubagentStop` (`subagent-stop.ts:168-198`) to:

1. Peek (non-mutating). `kind: 'none'` → return `{}`. `kind: 'tampered'` →
   return the unknown-state context (`subagent-stop.ts:179-183`) unchanged — and
   do NOT delete (nothing trustworthy to delete).
2. Run `consumedDelegationStillRequiresClosure` (`subagent-stop.ts:122-131`).
3. If closure is **confirmed not required** (`requiresClosure === false`): NOW
   commit the consume (delete the entry) and return `{}`. The entry is removed
   exactly once, only after the work is closed.
4. If closure **is still required**, OR the closure read threw (the existing
   fail-closed catch at `subagent-stop.ts:189-192`): leave the entry in place
   and return the `violation` (`subagent-stop.ts:194-197`). A re-fired
   SubagentStop re-peeks the still-present entry and re-blocks — idempotent.

```typescript
export async function handleSubagentStop(input: HookInput): Promise<SubagentStopResult> {
  if (input.hook_event_name !== 'SubagentStop') {
    return {};
  }

  const session = new Session(input.cwd);
  const peeked = await peekDelegationTokenForAgent(session, input); // non-mutating
  if (peeked.kind === 'none') {
    return {};
  }
  if (peeked.kind === 'tampered') {
    return {
      context:
        'Subagent stopped with an active delegation. Unable to verify child runbook state — check with `rd status`.',
    };
  }

  let closed = false;
  try {
    closed = !(await consumedDelegationStillRequiresClosure(input.cwd, peeked.tokenHash));
  } catch {
    // Cannot prove closure → fail closed: leave the entry, block, let the re-fire re-block.
    closed = false;
  }

  if (closed) {
    // Confirmed closed: consume exactly once, then allow the stop.
    await commitConsumeDelegationTokenForAgent(session, input);
    return {};
  }

  return {
    violation:
      'Delegated Rundown work was active when the subagent stopped. Run `rd status` to discover the active delegation, then close it explicitly: if a claim id was issued (the subagent ran `rd claim`), use `rd pass --claim-id <claim_id>` or `rd fail --claim-id <claim_id>`; if the token was never claimed, retry with `rd delegate --retry` or cancel with `rd abort <token>`.',
  };
}
```

- [ ] **Step 3: Run the idempotency guard to verify it passes**

Run:
`pnpm --filter @rundown-org/claude-code-plugin test -- subagent-stop.test.ts`
Expected: PASS — both the first and re-fired SubagentStop return a `violation`
while `requiresClosure` is true.

- [ ] **Step 4: Add the "confirmed-closed consumes once" test**

Add a sibling test: mock `readConsumedDelegationClosureForCwd` to resolve
`{ requiresClosure: false }`, seed one active token, call `handleSubagentStop`
twice. First call returns `{}` AND removes the entry; second call returns `{}`
via `kind: 'none'`. Assert the metadata `delegation_active_tokens` key is gone
after the first call.

```typescript
test('confirmed-closed delegation is consumed exactly once and allows the stop', async () => {
  // readConsumedDelegationClosureForCwd mocked to { requiresClosure: false } in this block
  // ... seed token, call handleSubagentStop, assert {} and entry removed ...
});
```

Run:
`pnpm --filter @rundown-org/claude-code-plugin test -- subagent-stop.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/claude-code-plugin/src/workflow/hooks/subagent-stop.ts packages/claude-code-plugin/__tests__/subagent-stop.test.ts
git commit -m "fix(plugin): verify delegation closure before consuming token (idempotent block) (#463)"
```

---

## Phase 4 — Fix Defect 3: CLI boundary fails closed (block to stdout, exit 2)

### Task 6: Emit an event-appropriate BLOCK to stdout with exit 2 on hook-input failure

**Files:**

- Modify: `packages/claude-code-plugin/src/cli.ts`
- Possibly modify: `packages/claude-code-plugin/src/hook-output.ts` (only if a
  small helper is needed for the parse-failure-without-event case)
- Test: `packages/claude-code-plugin/__tests__/cli.test.ts` (Task-3 guard turns
  green)

**Interfaces:**

- Consumes:
  `buildHookOutput(input: HookInput, result: DispatchResult): ClaudeHookOutput`
  (`hook-output.ts:54`). For a parseable event, build a `DispatchResult` with
  `blockReason` set so `buildHookOutput` emits the event-correct block:
  PreToolUse → `permissionDecision: 'deny'` (`hook-output.ts:67-76`); other
  events incl. SubagentStop → `decision: 'block'` + `reason`
  (`hook-output.ts:78-86`).
- Produces: a CLI that writes block JSON to **stdout** and exits **2** on every
  fail-closed path.

- [ ] **Step 1: Empty input → block to stdout, exit 2**

Rewrite `cli.ts:37-48`. When input is empty there is no parseable event, so the
safest universal block is a SubagentStop-shaped block (`decision: 'block'` +
`reason`) written to **stdout**, then `process.exit(2)`:

```typescript
if (inputStr.length === 0) {
  await logger.error('CLI received empty input', {
    reason: 'stdin was empty - possible CLI race condition or cancelled operation',
  });
  console.log(JSON.stringify({ decision: 'block', reason: 'Empty hook input received' }));
  process.exit(2);
}
```

- [ ] **Step 2: Parse failure → block to stdout, exit 2**

Rewrite `cli.ts:50-64`. The payload may be unparseable, so the event is unknown
— emit the same universal `decision: 'block'` to **stdout** and exit 2. (If the
partial payload reliably carries `hook_event_name`, prefer `buildHookOutput`
with that event; otherwise the universal block below is correct and minimal.)

```typescript
const parseResult = parseHookInput(inputStr);
if (!parseResult.success) {
  await logger.error('CLI input validation failed', {
    input_length: inputStr.length,
    input_preview: inputStr.substring(0, 200),
    error: parseResult.error,
  });
  console.log(JSON.stringify({ decision: 'block', reason: parseResult.error }));
  process.exit(2);
}
```

- [ ] **Step 3: Unexpected throw → block to stdout, exit 2**

Rewrite the catch at `cli.ts:97-107`. If a parsed `input` is in scope, build an
event-appropriate block via `buildHookOutput(input, { blockReason: ... })`;
otherwise fall back to the universal `decision: 'block'`. Write to **stdout**,
exit 2:

```typescript
} catch (error) {
  const errorMessage = getErrorMessage(error);
  await logger.error('Hook dispatch failed', { error: errorMessage });
  console.log(JSON.stringify({ decision: 'block', reason: `Unexpected error: ${errorMessage}` }));
  process.exit(2);
}
```

(If `input` is reliably in scope at the throw site, prefer
`console.log(JSON.stringify(buildHookOutput(input, { blockReason: \`Unexpected
error: ${errorMessage}\`
})))`so a PreToolUse throw blocks with`permissionDecision:
'deny'`. Keep the universal fallback when `input` is not yet parsed.)

- [ ] **Step 4: Run the CLI fail-closed guard to verify it passes**

Run:
`pnpm --filter @rundown-org/claude-code-plugin build && pnpm --filter @rundown-org/claude-code-plugin test -- cli.test.ts`
Expected: PASS — empty and unparseable inputs now exit 2 with a block JSON on
stdout.

- [ ] **Step 5: Commit**

```bash
git add packages/claude-code-plugin/src/cli.ts packages/claude-code-plugin/__tests__/cli.test.ts
git commit -m "fix(plugin): CLI hook boundary blocks to stdout with exit 2 (fail closed) (#463)"
```

---

## Phase 5 — Hardening: mutation coverage and protocol-conformance note

### Task 7: Run plugin mutation testing and close survivors on the changed files

**Files:**

- Possibly modify: the three changed source files and their tests, to kill
  survivors.

- [ ] **Step 1: Run scoped mutation testing on the changed files**

Run: `pnpm run test:mutate:plugin` Expected: Stryker completes; inspect the
report for survivors in `session.ts`, `subagent-stop.ts`, `cli.ts`.

- [ ] **Step 2: Kill survivors**

For each survived mutant in the changed code, add or tighten a test that fails
when the mutant is applied (e.g. a mutant that flips `requiresClosure` handling,
or removes the lock acquire). Do not weaken assertions to pass.

- [ ] **Step 3: Re-run and commit**

Run: `pnpm run test:mutate:plugin` Expected: no survivors in the three changed
files.

```bash
git add packages/claude-code-plugin
git commit -m "test(plugin): kill delegation-closure mutation survivors (#463)"
```

### Task 8: Document the integration/e2e conformance gap

**Files:**

- Modify: this plan's "Out of scope" section is the record; optionally open a
  tracked issue.

- [ ] **Step 1: Record the conformance limitation**

The unit tests assert the plugin emits the right JSON and exit code, but true
protocol conformance (Claude Code actually re-firing SubagentStop, actually
honoring exit 2 to block a stop) requires an integration/e2e check. The repo
already has Docker e2e harnesses (`pnpm run test:e2e`,
`pnpm run test:e2e:shell`). Note in the follow-up issue that an e2e assertion —
"a subagent with an open delegation cannot stop" — is the only check that
exercises the real harness. Do not build it in this plan (see Out of scope).

**Verification:** Follow-up issue referenced in the Decision Record.

---

## Phase 6 — Full verification gate

- [ ] **Step 1: Run the full plugin test suite**

Run: `pnpm --filter @rundown-org/claude-code-plugin test` Expected: all unit
tests pass, including the three new red-turned-green guards.

- [ ] **Step 2: Run the pre-PR verification gate**

Run: `pnpm run verify` Expected: format, spell, lint, and tests all pass.
(`pnpm run verify` is the mandatory pre-push gate per `CLAUDE.md`.)

- [ ] **Step 3: Run the broader suite if touching shared seams**

Run: `pnpm test` (fast unit, all packages) and, if Option A was chosen (core
changed), `pnpm --filter @rundown-org/core test`. Expected: green.

---

## Risks

- **Lock contention / deadlock (Phase 2).** Per-process locks with a 5s deadline
  (`file-lock.ts:19`) and PID-aware stale reclaim cannot deadlock across
  processes, but a within-process re-entrant acquire WOULD self-deadlock.
  Confirm no `set`/`append` call nests inside another `set`/`append` on the same
  `Session` instance. The Phase-3 refactor calls `session.set` once (the
  commit-consume), after the lock from any prior `set` has been released —
  verify no nested acquisition.
- **`await using` requires the right TS target/lib.** `Symbol.asyncDispose`
  needs `lib` including `esnext.disposable` (or a polyfill). Core already uses
  `await using` with `heldLock`, so the workspace TS config supports it; confirm
  the plugin's `tsconfig` inherits the same `lib` before relying on it (build
  will fail loudly otherwise).
- **CLI test harness coupling.** The Phase-1 Task-3 / Phase-4 tests assume an
  invocation form for the built CLI. Align with the existing smoke test's
  invocation (search `__tests__` for the current pattern) rather than inventing
  one.
- **Option A key-mapping unknown (Phase 0).** If `agent_id` cannot be mapped to
  a `parentRunId`, Option A is deferred; the plan already ships Option B so no
  critical fix is blocked.
- **No state migration.** Phase 2/3 must not add legacy-field hydration. The
  legacy `delegation_active_token` global key handling already in
  `subagent-stop.ts:37-58` is preserved as-is (it is not new migration code); do
  not extend it.

## Out of scope

- **Option A core promotion** (active-token tracking moved into core behind
  `DelegationLock`) unless Phase 0 finds a clean `agent_id` → `parentRunId`
  mapping. Tracked as a follow-up issue.
- **Building the e2e protocol-conformance test** ("a subagent with an open
  delegation cannot stop" through the real Docker harness). Recorded as a
  follow-up (Task 8).
- **Removing the shadow Session store entirely** / collapsing the legacy
  global-token path — only meaningful under Option A.
- **Changes to `dispatcher.ts`'s fail-open backstop** (`dispatcher.ts:77-92`):
  it only swallows additive context and the enforcement gates already fail
  closed before it; no change needed for these three defects.

---

## Decision Record

_(Filled in by Phase 0.)_

- **Chosen option:** _TBD (recommended: Option B now, Option A follow-up)_
- **`agent_id` → `parentRunId` mapping finding:** _TBD_
- **Option-A follow-up issue:** _TBD_
- **E2e conformance follow-up issue:** _TBD_
