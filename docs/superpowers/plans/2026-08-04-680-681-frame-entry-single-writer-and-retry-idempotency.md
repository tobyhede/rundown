# Frame-Entry Single Writer and Retry Idempotency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the XState machine the single writer of frame entry (#680), then
land the retry idempotency contract that depends on it (#681).

**Architecture:** Today two writers move the frame entry: the machine stamps
`credential.parentEntry` from `RunbookContext.frameEntry` (a bootstrap mirror of
*pre*-transition persisted state) during a transition, and
`deriveActiveEntryProjection` bumps the committed entry *after* the machine has
run. Part A moves the bump into the machine as a leaf-state entry action, makes
`RunbookContext.frameEntry` authoritative, persists it from context in
`deriveActorStatePatch`, and deletes the projection with all thirteen call
sites. Part B then adds `resolveRetryIssuance` — a pure resolver implementing
the ratified 15-row decision table over a four-conjunct `unobservedReplacement`
predicate — called from `#issueRetry`'s `beforeEffect`, plus three new error
codes and a new `retry-already-applied` outcome.

**Tech Stack:** TypeScript (ESM, NodeNext), XState v5, Zod, Jest, fast-check,
Stryker, pnpm workspaces, Biome (TS/JSON) + Prettier (Markdown only).

## Global Constraints

Every task's requirements implicitly include this section.

- **Base branch:** `issue-680/machine-owned-frame-entry`, stacked on
  `issue-608/pr12-transactional-delegation-workflows` (PR 673) at `4ca59e6f8`.
  **Not** `main`. Every line number in this plan is against that tree.
- **Binding design:** `docs/superpowers/specs/2026-08-04-680-681-frame-entry-single-writer-and-retry-idempotency-design.md`.
  Do not redesign it. Options 2, 3 and 4 in #680 are rejected and are not
  revisited.
- **Binding contract for Part B:** `docs/superpowers/plans/2026-08-03-608-pr12-review-remediation-addendum.md`
  § "Retry idempotency contract". The decision table is reproduced verbatim in
  Task B2. **Do not soften the fourth conjunct to `>=` or a one-entry
  tolerance.** Do not ship Part B without it.
- **Entry arithmetic is preserved exactly.** Today's rule is
  `max(frameEntryCounts[target] ?? 0, previousActiveEntry) + 1` — run-global and
  monotonic, **not** per-frame-local. Entering frame 2 from frame 1 at entry 5
  yields 6, not 1. `classifyDelegationLiveness` (`targeting.ts:536-545`) and
  completion-key scoping are calibrated against it. This change is about
  *ordering*, never renumbering.
- **No persisted-state migration, ever.** No fallback parsers, no legacy field
  hydration, no compatibility shims. Derived bearer tokens change because
  `parentEntry` is HMAC input; the recovery path is finish / stop / prune /
  restart.
- **`pnpm run verify` MUST pass before any push.** Scoped `jest` runs are not a
  substitute (cspell and typed ESLint only run there).
- **Never run Prettier on TypeScript.** Biome owns TS/JSON/CSS
  (`npx biome check --config-path=. --write <files>`); Prettier owns Markdown
  only.
- **Never run an unscoped Stryker run**, never use repo-relative `--mutate`
  paths, never insert the `--` separator. Prefer
  `pnpm run test:mutate:changed --package <pkg>`; hand-scoped runs must pass
  `--force`.
- **TSDoc on every exported symbol** — description, `@param` for all
  parameters, `@returns` when non-void, `@throws` when it can throw.
- **CLI tests default to JSON output.** Add `--text` coverage separately, never
  as a proxy for the JSON contract.
- **Type-driven dispatch.** New decisions return discriminated unions the caller
  narrows on; no `if` chains over raw string discriminants.
- **How to read the TypeScript in test steps.** A test block in this plan
  specifies the **binding assertions** — what must be true, in the shape it must
  be asserted. The surrounding harness is the implementer's: fixtures, seeding
  and setup helpers are named but not implemented here, because inventing their
  bodies would fix decisions that belong with the file's existing conventions.
  Every helper a block names has a one-line contract at its point of first use —
  what it seeds and what it returns. Build it to that contract, reusing the
  neighbouring tests' fixtures, and treat the assertions as the part you may not
  change. Production code blocks are the opposite: they are literal, and the
  surrounding lines they slot between are cited by line number.

---

## File Structure

**Part A — machine owns the entry bump**

| File                                                | Responsibility after this plan                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/runbook/frame-entry.ts`          | Owns the entry arithmetic: `inferFrameEntryFromState` (existing) + `advanceFrameEntry` (new). Pure, no `targeting` value imports |
| `packages/core/src/runbook/targeting.ts`            | Owns frame-key derivation: new `frameKeyForCursor`, with `deriveActiveFrame` delegating to it                                    |
| `packages/core/src/runbook/compiler.ts`             | Declares re-entry on GOTO/RETRY transitions; runs `syncFrameEntry` as a leaf entry action; advances inline at the two retry-hook call sites |
| `packages/core/src/runbook/retry-hook.ts`           | Unchanged. It already resolves entry via `inferFrameEntryFromState(context.frameEntry, …)`; the caller hands it advanced coordinates |
| `packages/core/src/runbook/actor-service.ts`        | Persists `activeEntry` / `frameEntryCounts` from context; drops the `hydrateSnapshot` frame-entry overlay and the bootstrap `ensureActiveEntry` |
| `packages/core/src/runbook/execution-lifecycle-service.ts` | Loses `deriveActiveEntry`, `ensureActiveEntry`, and `deriveActiveEntryProjection`                                          |
| `packages/core/src/runbook/lifecycle-command-service.ts`   | Seven `deriveActiveEntry` calls become direct reads of captured/prepared state                                             |
| `packages/core/src/runbook/completion-service.ts`   | One `ensureActiveEntry` call becomes a direct read                                                                              |
| `packages/cli/src/services/execution.ts`            | Four Category-B projection calls removed; `entryAlreadyProjected` plumbing deleted                                               |

**Part B — retry idempotency**

| File                                                     | Responsibility after this plan                                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `packages/core/src/runbook/delegation-scan.ts`           | Adds `findBySupersededToken` returning **all** matching rows                                       |
| `packages/core/src/runbook/delegation-inference.ts`      | Adds the pure `resolveRetryIssuance` resolver and its `RetryIssuanceCapture` / `RetryIssuanceResolution` types |
| `packages/core/src/errors/codes.ts`                      | Registers RD-826 / RD-827 / RD-828, replacing the reservation comment at `:403-406`                |
| `packages/core/src/errors/factory.ts`                    | Adds the three matching factories                                                                  |
| `packages/core/src/runbook/lifecycle-command-service.ts` | Adds the `retry-already-applied` outcome and calls the resolver from `#issueRetry`'s `beforeEffect` |
| `packages/cli/src/commands/delegate.ts`                  | Renders the new outcome (JSON default and `--text`) and the three refusals                         |
| `packages/core/src/output/zod-schemas.ts`                | Adds the `retry-already-applied` arm to `DelegateResponseSchema`                                    |

**Docs**

| File                                | Change                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------- |
| `docs/internal/architecture.md`      | **Descriptive** — new "Frame entry ownership" subsection; edited in place            |
| `docs/reference/cli.md`              | RD-826/827/828 rows in the error table; retry idempotency bullet in delegate semantics |
| `docs/spec/cli-output.md`            | `retry-already-applied` delegate action; three new error subsections                  |

---

## Source findings that qualify the design

Read these before starting. They are places where the source contradicts or
under-specifies the design document; each is resolved inside the task that hits
it.

1. **`runRetryHook` is a transition action, not an entry action.** It is invoked
   from inside `runbookSetup.assign(...)` on `always` transitions at
   `compiler.ts:1856` (parent aggregation retry) and `:1980` (FOR-iteration
   retry). Transition actions run **before** the target state's entry actions,
   so a leaf `syncFrameEntry` cannot make the entry current for it. The design's
   A3/A4 split alone leaves the retry path lagging exactly as it does today.
   **Resolution (Task A4):** those two assigns advance `frameEntry` inline via
   `advanceFrameEntry`, hand the advanced coordinates to `runRetryHook`, and
   deliberately do **not** set the `frameReentry` marker — so the leaf
   `syncFrameEntry` that runs afterwards is a no-op for that frame.
2. **There are thirteen `deriveActiveEntry`/`ensureActiveEntry` call sites, not
   twelve.** The design's A6 table omits `actor-service.ts:1467` — the bootstrap
   `ensureActiveEntry` inside `initializeState`. It is removed too (Task A6);
   the machine's entry action now seeds the coordinates at bootstrap.
3. **`frameKeyForCursor` cannot live in `frame-entry.ts`.** It needs
   `buildFrameKey` and `getActiveForContext` as *values*, both in
   `targeting.ts`, and `deriveActiveFrame` (in `targeting.ts`) must delegate to
   it — a value-level import cycle. It goes in `targeting.ts` beside its
   dependencies; `advanceFrameEntry` stays in `frame-entry.ts` and takes the
   frame key as a parameter, so `frame-entry.ts` keeps its type-only dependency
   on `targeting.ts`.
4. **The design's bootstrap branch is stated loosely.** A1 says "No
   `activeFrameKey` yet (bootstrap): `entry = frameEntryCounts[frameKey] ?? 1`".
   The source predicate is `!base.activeFrameKey || base.activeEntry ===
   undefined` and the value is `knownEntry > 0 ? knownEntry : 1`. Preserve the
   **source** form (both disjuncts, and `0` treated as `1`).
5. **Nine transitions must declare re-entry, not two.** The design names "GOTO
   and RETRY transitions"; the concrete sites are enumerated in Task A3.

---

## Part A — the machine owns the entry bump (#680)

### Task A1: Pure entry arithmetic and one frame-key derivation

**Files:**

- Modify: `packages/core/src/runbook/frame-entry.ts`
- Modify: `packages/core/src/runbook/targeting.ts:238-265`
- Modify: `packages/core/src/runbook/index.ts:393`
- Test: `packages/core/__tests__/runbook/frame-entry.test.ts`
- Test: `packages/core/__tests__/runbook/targeting.test.ts`

**Interfaces:**

- Consumes: `FrameEntryCoordinates`, `inferFrameEntryFromState` (existing,
  `frame-entry.ts`); `buildFrameKey`, `getActiveForContext`, `ForContext`,
  `FrameKey` (existing, `targeting.ts`).
- Produces:
  - `advanceFrameEntry(coordinates: FrameEntryCoordinates, frameKey: FrameKey, reentered: boolean): FrameEntryCoordinates`
    — exported from `packages/core/src/runbook/frame-entry.ts`.
  - `frameKeyForCursor(stepName: string, forStack: readonly ForContext[] | undefined): FrameKey`
    — exported from `packages/core/src/runbook/targeting.ts`.

- [ ] **Step 1: Write the failing unit tests for `advanceFrameEntry`**

Append to `packages/core/__tests__/runbook/frame-entry.test.ts`:

```typescript
import { advanceFrameEntry } from '../../src/runbook/frame-entry.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';

describe('advanceFrameEntry', () => {
  const FRAME_1 = buildFrameKey('1');
  const FRAME_2 = buildFrameKey('2');

  it('bootstraps to 1 when no active frame has been recorded', () => {
    expect(advanceFrameEntry({}, FRAME_1, false)).toEqual({
      activeFrameKey: FRAME_1,
      activeEntry: 1,
      frameEntryCounts: { [FRAME_1]: 1 },
    });
  });

  it('bootstraps to the recorded count when the frame has history but no active entry', () => {
    expect(
      advanceFrameEntry({ frameEntryCounts: { [FRAME_1]: 4 } }, FRAME_1, false),
    ).toEqual({
      activeFrameKey: FRAME_1,
      activeEntry: 4,
      frameEntryCounts: { [FRAME_1]: 4 },
    });
  });

  it('bootstraps when activeFrameKey is present but activeEntry is not', () => {
    expect(
      advanceFrameEntry({ activeFrameKey: FRAME_1, frameEntryCounts: {} }, FRAME_1, false),
    ).toEqual({
      activeFrameKey: FRAME_1,
      activeEntry: 1,
      frameEntryCounts: { [FRAME_1]: 1 },
    });
  });

  it('leaves the entry unchanged for a same-frame entry that is not a declared re-entry', () => {
    const coords = {
      activeFrameKey: FRAME_1,
      activeEntry: 3,
      frameEntryCounts: { [FRAME_1]: 3 },
    };
    expect(advanceFrameEntry(coords, FRAME_1, false)).toEqual(coords);
  });

  it('bumps on a declared same-frame re-entry', () => {
    expect(
      advanceFrameEntry(
        { activeFrameKey: FRAME_1, activeEntry: 3, frameEntryCounts: { [FRAME_1]: 3 } },
        FRAME_1,
        true,
      ),
    ).toEqual({
      activeFrameKey: FRAME_1,
      activeEntry: 4,
      frameEntryCounts: { [FRAME_1]: 4 },
    });
  });

  it('is run-global and monotonic across a frame switch, not per-frame-local', () => {
    // Entering frame 2 for the FIRST time from frame 1 at entry 5 yields 6, not 1.
    expect(
      advanceFrameEntry(
        { activeFrameKey: FRAME_1, activeEntry: 5, frameEntryCounts: { [FRAME_1]: 5 } },
        FRAME_2,
        false,
      ),
    ).toEqual({
      activeFrameKey: FRAME_2,
      activeEntry: 6,
      frameEntryCounts: { [FRAME_1]: 5, [FRAME_2]: 6 },
    });
  });

  it('takes the max of the per-frame count and the previous active entry', () => {
    expect(
      advanceFrameEntry(
        { activeFrameKey: FRAME_1, activeEntry: 2, frameEntryCounts: { [FRAME_1]: 2, [FRAME_2]: 9 } },
        FRAME_2,
        false,
      ).activeEntry,
    ).toBe(10);
  });

  it('never lowers a recorded count', () => {
    const next = advanceFrameEntry(
      { activeFrameKey: FRAME_2, activeEntry: 3, frameEntryCounts: { [FRAME_1]: 7, [FRAME_2]: 3 } },
      FRAME_2,
      false,
    );
    expect(next.frameEntryCounts).toEqual({ [FRAME_1]: 7, [FRAME_2]: 3 });
  });

  it('does not mutate the coordinates it is given', () => {
    const counts = { [FRAME_1]: 1 };
    const coords = { activeFrameKey: FRAME_1, activeEntry: 1, frameEntryCounts: counts };
    advanceFrameEntry(coords, FRAME_2, false);
    expect(counts).toEqual({ [FRAME_1]: 1 });
  });
});
```

- [ ] **Step 2: Write the failing unit tests for `frameKeyForCursor`**

Append to `packages/core/__tests__/runbook/targeting.test.ts`:

```typescript
import { frameKeyForCursor, buildFrameKey } from '../../src/runbook/targeting.js';
import type { ForContext } from '../../src/runbook/types.js';

describe('frameKeyForCursor', () => {
  const forContext = (over: Partial<ForContext> = {}): ForContext =>
    ({
      stepId: '2',
      iteration: 3,
      start: 1,
      implicit: false,
      ...over,
    }) as ForContext;

  it('returns the bare step frame with no FOR stack', () => {
    expect(frameKeyForCursor('2', undefined)).toBe(buildFrameKey('2'));
    expect(frameKeyForCursor('2', [])).toBe(buildFrameKey('2'));
  });

  it('includes the iteration when the top context belongs to the step', () => {
    expect(frameKeyForCursor('2', [forContext()])).toBe(buildFrameKey('2', 3));
  });

  it('ignores an implicit top context', () => {
    expect(frameKeyForCursor('2', [forContext({ implicit: true })])).toBe(buildFrameKey('2'));
  });

  it('ignores a top context belonging to a different step', () => {
    expect(frameKeyForCursor('3', [forContext()])).toBe(buildFrameKey('3'));
  });

  it('agrees with deriveActiveFrame for the same cursor', () => {
    const forStack = [forContext()];
    expect(frameKeyForCursor('2', forStack)).toBe(
      deriveActiveFrame({ step: '2', forStack } as never).frameKey,
    );
  });
});
```

Add `deriveActiveFrame` to the existing import from `../../src/runbook/targeting.js`
if it is not already imported.

- [ ] **Step 3: Run both suites and verify they fail**

Run:

```bash
pnpm --filter @rundown-org/core exec jest __tests__/runbook/frame-entry.test.ts __tests__/runbook/targeting.test.ts
```

Expected: FAIL — `advanceFrameEntry is not a function` /
`frameKeyForCursor is not a function` (or TS2305 module-has-no-exported-member).

- [ ] **Step 4: Implement `advanceFrameEntry`**

Append to `packages/core/src/runbook/frame-entry.ts`:

```typescript
/**
 * Advance the frame-entry coordinates for one state entry.
 *
 * The single owner of the entry bump rule. Semantics are preserved verbatim
 * from the projection this replaces (`deriveActiveEntryProjection`): the entry
 * ordinal is run-global and monotonic, not per-frame-local, so entering a fresh
 * frame from entry 5 yields 6 rather than 1. `classifyDelegationLiveness` and
 * completion-key scoping are calibrated against that form — do not "fix" it to
 * a per-frame counter.
 *
 * - No recorded active frame or no recorded active entry (bootstrap): the entry
 *   is the frame's recorded count, or `1` when it has none.
 * - Frame switch, or a re-entry the transition declared: one past the greater of
 *   the frame's recorded count and the previous active entry.
 * - Otherwise the active entry carries through unchanged.
 *
 * In every case the frame's recorded count is raised to the resulting entry and
 * never lowered.
 *
 * @param coordinates - The coordinates before this state entry.
 * @param frameKey - The frame being entered, from {@link frameKeyForCursor}.
 * @param reentered - Whether the transition declared this a GOTO/RETRY re-entry.
 * @returns New coordinates; the input is never mutated.
 */
export function advanceFrameEntry(
  coordinates: FrameEntryCoordinates,
  frameKey: FrameKey,
  reentered: boolean,
): FrameEntryCoordinates {
  const frameEntryCounts: Record<FrameKey, number> = { ...(coordinates.frameEntryCounts ?? {}) };
  const known = frameEntryCounts[frameKey] ?? 0;
  let entry: number;
  if (coordinates.activeFrameKey === undefined || coordinates.activeEntry === undefined) {
    entry = known > 0 ? known : 1;
  } else if (reentered || frameKey !== coordinates.activeFrameKey) {
    entry = Math.max(known, coordinates.activeEntry) + 1;
  } else {
    entry = coordinates.activeEntry >= 1 ? coordinates.activeEntry : known > 0 ? known : 1;
  }
  frameEntryCounts[frameKey] = Math.max(known, entry);
  return { activeFrameKey: frameKey, activeEntry: entry, frameEntryCounts };
}
```

- [ ] **Step 5: Implement `frameKeyForCursor` and route `deriveActiveFrame` through it**

In `packages/core/src/runbook/targeting.ts`, insert after `getActiveForContext`
(currently ending at `:246`):

```typescript
/**
 * Derive the frame key for an execution cursor.
 *
 * The single frame-key derivation. It replaces three subtly different ones that
 * agreed only by accident: `deriveActiveFrame` checked both `implicit` and
 * `stepId`, while `deriveActorStatePatch` and `buildDelegationIssueInvokeBlock`
 * filtered `implicit` but never compared `stepId`. Once the machine's entry
 * ordinal depends on the frame key matching what committed-state readers
 * compute, that accident becomes load-bearing, so all three route here.
 *
 * @param stepName - The step the cursor sits on.
 * @param forStack - The live FOR context stack, or undefined.
 * @returns The frame key: `step|iteration` when a non-implicit FOR context for
 *   this step is on top of the stack, otherwise `step|`.
 */
export function frameKeyForCursor(
  stepName: string,
  forStack: readonly ForContext[] | undefined,
): FrameKey {
  return buildFrameKey(stepName, getActiveForContext(forStack, stepName)?.iteration);
}
```

Then rewrite `deriveActiveFrame` (`:254-265`) to delegate:

```typescript
export function deriveActiveFrame(state: RunbookState): {
  frameKey: FrameKey;
  step: string;
  iteration?: number;
} {
  const activeFor = getActiveForContext(state.forStack, state.step);
  return {
    frameKey: frameKeyForCursor(state.step, state.forStack),
    step: state.step,
    ...(activeFor ? { iteration: activeFor.iteration } : {}),
  };
}
```

- [ ] **Step 6: Export both from the core barrel**

In `packages/core/src/runbook/index.ts`, change line 393 to:

```typescript
export { advanceFrameEntry, inferFrameEntryFromState } from './frame-entry.js';
```

and add `frameKeyForCursor` to the existing `export { … } from './targeting.js'`
list.

- [ ] **Step 7: Run the tests and verify they pass**

Run:

```bash
pnpm --filter @rundown-org/core exec jest __tests__/runbook/frame-entry.test.ts __tests__/runbook/targeting.test.ts
```

Expected: PASS.

- [ ] **Step 8: Mutation-test the two new pure functions**

Run:

```bash
pnpm --filter @rundown-org/core exec stryker run \
  --mutate 'src/runbook/frame-entry.ts' \
  --testFiles '__tests__/runbook/frame-entry.test.ts' \
  --force
```

Check the `Instrumented N source file(s) with M mutant(s)` line reads `N > 0`.
Judge on **in-scope Survived / NoCoverage mutants**, not the aggregate score.
Add a unit case for any survivor in `advanceFrameEntry` (the `Math.max` boundary
and the `>= 1` guard are the likely ones).

- [ ] **Step 9: Format, lint and commit**

```bash
npx biome check --config-path=. --write \
  packages/core/src/runbook/frame-entry.ts \
  packages/core/src/runbook/targeting.ts \
  packages/core/src/runbook/index.ts \
  packages/core/__tests__/runbook/frame-entry.test.ts \
  packages/core/__tests__/runbook/targeting.test.ts
git add packages/core/src/runbook/frame-entry.ts packages/core/src/runbook/targeting.ts \
  packages/core/src/runbook/index.ts packages/core/__tests__/runbook/frame-entry.test.ts \
  packages/core/__tests__/runbook/targeting.test.ts
git commit -m "feat(core): add advanceFrameEntry and unify frame-key derivation

One bump rule and one frame-key derivation, extracted as pure functions ahead
of moving frame-entry ownership into the machine (#680). No behaviour change:
deriveActiveEntryProjection still owns the committed bump."
```

---

### Task A2: `syncFrameEntry` as a leaf entry action

**Files:**

- Modify: `packages/core/src/runbook/compiler.ts:862` (context type), `:4124-4207`
  (`buildLeafSubstateConfig`), `:3871-3908`
  (`buildDelegationIssueInvokeBlock`)
- Test: `packages/core/__tests__/runbook/compiler.test.ts`

**Interfaces:**

- Consumes: `advanceFrameEntry` (Task A1), `frameKeyForCursor` (Task A1),
  `FrameEntryCoordinates`, `RunbookContext`.
- Produces:
  - `RunbookContext.frameReentry?: { readonly cause: 'GOTO' | 'RETRY' }` — the
    one-shot marker Task A3 writes and this task consumes.
  - `RunbookContext.frameEntry` is now authoritative and written on every leaf
    state entry.

This task is verified entirely at the **machine** level — compile a machine,
drive it with `createActor`, and read `snapshot.context.frameEntry`. It is
deliberately independent of the still-live projection, so it stays green while
both writers coexist. The seam-level (committed state) assertions land in Task
A9, after the projection is gone.

- [ ] **Step 1: Write the failing machine tests**

Append to `packages/core/__tests__/runbook/compiler.test.ts`. The assertions are
the contract; build the fixtures on the file's existing step-construction helpers
(`createRunbook` and neighbours) to these contracts. Tasks A3 and A4 reuse the
same set, so define them once at the top of the describe block.

| Fixture                    | Shape                                                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------------------------- |
| `options`                   | The compile option bag used throughout this file, plus `frameEntry: { frameEntryCounts: {} }`            |
| `recordingIssuer()`         | A `DelegationCredentialIssuer` double that appends each `DelegationCredentialLocation` it is handed to a `locations` array and returns a valid descriptor; `lastLocation` is `locations.at(-1)` |
| `delegatingSteps()`         | Plain step `1` (PASS CONTINUE) then substep-bearing step `2` with one DELEGATE substep (`runbooks: ['child.runbook.md']`, DEFER transitions) and `aggregation: { strategy: 'ALL' }` |
| `delegatingRetrySteps()`    | `delegatingSteps()` with step `2`'s FAIL transition carrying `retry: 1`, so an ALL-aggregation failure drives the parent retry hook |
| `aggregationRetrySteps()`   | As `delegatingRetrySteps()` but with a plain (non-DELEGATE) substep — exercises the retry re-entry without issuance |
| `parentArtifactSteps()`     | Step `2` has substeps **and** step-level `artifacts`, so entering `2.1` routes through `step::2::__parent-entry::1` |
| `forLoopSteps(n)`           | Step `2` is a FOR step over `n` iterations with one substep per iteration                                |
| `forIterationRetrySteps()`  | A FOR step whose `forClause.transitions.fail` carries `retry: 1`, so a failure retries *within* the iteration frame |
| `twoSubstepSteps()`         | Step `2` with two plain substeps, both DEFER, so PASS advances `2.1 → 2.2` inside one frame              |
| `retryBudgetSteps()`        | Step `1` with `fail: { retry: 1, action: STOP }`, so FAIL routes through `step::1::fail-retry` and back  |

```typescript
describe('machine-owned frame entry', () => {
  it('advances the entry on entry to a leaf state, before its invoked children run', async () => {
    // Steps: plain step "1" -> delegating parent "2" with one DELEGATE substep.
    // The credential the machine stamps must equal the entry the machine holds
    // once the transition settles.
    const machine = compileRunbookToMachine(delegatingSteps(), {
      /* …existing option bag from this file's helpers…, plus: */
      frameEntry: { frameEntryCounts: {} },
      issueDelegationCredential: recordingIssuer,
    });
    const actor = createActor(machine).start();

    expect(actor.getSnapshot().context.frameEntry).toEqual({
      activeFrameKey: buildFrameKey('1'),
      activeEntry: 1,
      frameEntryCounts: { [buildFrameKey('1')]: 1 },
    });

    actor.send({ type: 'PASS' });
    await waitFor(actor, (snap) => !snap.hasTag(PENDING_MACHINE_EFFECT_TAG));

    // The frame switch bumped BEFORE `__issue-delegations` read the context.
    expect(actor.getSnapshot().context.frameEntry?.activeEntry).toBe(2);
    expect(recordingIssuer.lastLocation.parentEntry).toBe(2);
  });

  it('does not double-bump when a substep routes through __parent-entry::', async () => {
    // Parent step declares ARTIFACTS, so entering substep 2.1 routes
    // step::2::__parent-entry::1 -> step::2::1 — two state entries, one frame.
    const actor = createActor(compileRunbookToMachine(parentArtifactSteps(), options)).start();
    const before = actor.getSnapshot().context.frameEntry?.activeEntry ?? 0;
    actor.send({ type: 'PASS' });
    await waitFor(actor, (snap) => !snap.hasTag(PENDING_MACHINE_EFFECT_TAG));
    expect(actor.getSnapshot().context.frameEntry?.activeEntry).toBe(before + 1);
  });

  it('bumps exactly once per FOR iteration advance', async () => {
    const actor = createActor(compileRunbookToMachine(forLoopSteps(3), options)).start();
    const entries: number[] = [];
    for (let i = 0; i < 3; i++) {
      entries.push(actor.getSnapshot().context.frameEntry?.activeEntry ?? 0);
      actor.send({ type: 'PASS' });
      await waitFor(actor, (snap) => !snap.hasTag(PENDING_MACHINE_EFFECT_TAG));
    }
    // Each loop-back is a frame switch (2|1 -> 2|2 -> 2|3): +1 each, never +2.
    expect(entries).toEqual([entries[0], entries[0] + 1, entries[0] + 2]);
  });

  it('does not bump when advancing between substeps of the same frame', async () => {
    const actor = createActor(compileRunbookToMachine(twoSubstepSteps(), options)).start();
    const before = actor.getSnapshot().context.frameEntry?.activeEntry;
    actor.send({ type: 'PASS' }); // 2.1 DEFER -> advance to 2.2, same frame
    await waitFor(actor, (snap) => !snap.hasTag(PENDING_MACHINE_EFFECT_TAG));
    expect(actor.getSnapshot().context.frameEntry?.activeEntry).toBe(before);
  });

  it('is not attached to __parent-entry:: states', () => {
    const machine = compileRunbookToMachine(parentArtifactSteps(), options);
    const parentEntryState = machine.config.states?.['step::2::__parent-entry::1'];
    // The transient artifact pass-through carries only clearCurrentEntryArtifacts.
    expect(JSON.stringify(parentEntryState?.entry)).not.toContain('frameEntry');
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
pnpm --filter @rundown-org/core exec jest __tests__/runbook/compiler.test.ts -t 'machine-owned frame entry'
```

Expected: FAIL — `context.frameEntry` is `{ frameEntryCounts: {} }` at start and
never advances; the stamped `parentEntry` is `1` where `2` is expected.

- [ ] **Step 3: Add the `frameReentry` context field**

In `packages/core/src/runbook/compiler.ts`, replace the TSDoc block on
`frameEntry` (`:845-862`) and add the sibling field:

```typescript
  /**
   * Authoritative frame-entry coordinates, in the shape
   * {@link inferFrameEntryFromState} consumes.
   *
   * The machine is the sole writer: {@link advanceFrameEntry} runs as an entry
   * action on every step/substep leaf state, and `deriveActorStatePatch`
   * persists the result. It is seeded at bootstrap only for a run that has no
   * snapshot yet.
   *
   * Plain data — it serialises into the persisted snapshot cleanly and carries
   * no function references or process-runtime values.
   */
  readonly frameEntry?: FrameEntryCoordinates;
  /**
   * One-shot declaration that the transition now running is a frame re-entry.
   *
   * Written by every GOTO/RETRY transition assign, consumed and cleared by the
   * first leaf `syncFrameEntry` that follows. The split exists because a
   * transition knows *that* it re-enters but not yet *which* frame — the FOR
   * iteration is only current after the leaf's `initForStack` runs — and
   * because one transition can drive several state entries
   * (`__parent-entry::` routing), which a one-shot marker survives and a
   * `lastAction` read does not.
   *
   * Never present in a settled snapshot: every transition that sets it is
   * followed in the same macrostep by the leaf entry that consumes it.
   */
  readonly frameReentry?: { readonly cause: 'GOTO' | 'RETRY' };
```

- [ ] **Step 4: Add the `syncFrameEntry` builder and attach it to every leaf**

Inside `compileRunbookToMachine`, beside the other per-machine helpers (near
`buildDelegationIssueInvokeBlock`, `:3871`):

```typescript
  /**
   * Build the entry action that makes `context.frameEntry` current for a leaf.
   *
   * Appended AFTER the leaf's existing entry actions so it runs after
   * `initForStack` has made the FOR iteration current — that is what makes a
   * loop-back register as a frame switch with no extra wiring. It runs before
   * the leaf's initial child's `invoke` input factory is read, so
   * `__issue-delegations` and `__prepare-inline-launch` see the advanced value.
   *
   * @param stepName - The step this leaf belongs to.
   * @returns The XState assign action.
   */
  const buildSyncFrameEntry = (stepName: string) =>
    runbookSetup.assign({
      frameEntry: ({ context }: { context: RunbookContext }): FrameEntryCoordinates =>
        advanceFrameEntry(
          context.frameEntry ?? {},
          frameKeyForCursor(stepName, context.forStack),
          context.frameReentry !== undefined,
        ),
      frameReentry: undefined,
    });
```

Then in `buildLeafSubstateConfig`, change `leafEntryActions` (`:4204-4207`):

```typescript
    const leafEntryActions = [
      ...currentEntryActions,
      ...(shouldClearLeafEntryArtifacts ? [clearCurrentEntryArtifacts] : []),
      buildSyncFrameEntry(config.stepName),
    ];
```

`leafEntryActions` is now never empty, so the `...(leafEntryActions.length > 0 ? … : {})`
spread at `:4367` always contributes `entry`. Leave the spread in place — it is
harmless and the structural snapshot diff stays minimal.

Do **not** touch the `parentEntryStateId` states at `:4094-4108`; they are
same-frame artifact pass-throughs and bumping there would double-count.

Add the imports at the top of `compiler.ts`:

```typescript
import { advanceFrameEntry, inferFrameEntryFromState } from './frame-entry.js';
```

(`inferFrameEntryFromState` is already imported; extend the specifier list) and
add `frameKeyForCursor` to the existing `./targeting.js` import.

- [ ] **Step 5: Route `buildDelegationIssueInvokeBlock` through `frameKeyForCursor`**

Replace `compiler.ts:3877-3881`:

```typescript
      const frameKey = frameKeyForCursor(stepName, context.forStack);
```

(deleting the local `activeFor`/`peekForStack` derivation). Leave `:3896-3897`
unchanged — `inferFrameEntryFromState(context.frameEntry ?? {}, frameKey)` now
returns the advanced entry because `context.frameEntry.activeFrameKey` equals
`frameKey`.

- [ ] **Step 6: Run the tests and verify they pass**

Run:

```bash
pnpm --filter @rundown-org/core exec jest __tests__/runbook/compiler.test.ts -t 'machine-owned frame entry'
```

Expected: PASS.

- [ ] **Step 7: Refresh the structural snapshot**

Run:

```bash
pnpm --filter @rundown-org/core exec jest __tests__/runbook/compiler-machine-structural-snapshot.test.ts -u
```

Then **read the snapshot diff**: it must show exactly one added entry action per
leaf state and nothing else. Anything else means the entry action landed on the
wrong node.

- [ ] **Step 8: Commit**

```bash
npx biome check --config-path=. --write packages/core/src/runbook/compiler.ts \
  packages/core/__tests__/runbook/compiler.test.ts
git add packages/core/src/runbook/compiler.ts packages/core/__tests__/runbook/compiler.test.ts \
  packages/core/__tests__/runbook/__snapshots__
git commit -m "feat(core): advance frame entry as a leaf state entry action

Adds RunbookContext.frameReentry and syncFrameEntry, appended after the
existing leaf entry actions so it runs after initForStack and before the
leaf's invoked children. Unifies buildDelegationIssueInvokeBlock's frame-key
derivation on frameKeyForCursor. Part of #680."
```

---

### Task A3: Declare re-entry on every GOTO/RETRY transition

**Files:**

- Modify: `packages/core/src/runbook/compiler.ts` — nine sites, enumerated below
- Test: `packages/core/__tests__/runbook/compiler.test.ts`

**Interfaces:**

- Consumes: `RunbookContext.frameReentry` (Task A2).
- Produces: no new exports. The invariant it establishes: **wherever the machine
  writes a `lastAction` of type `GOTO` or `RETRY`, it writes `frameReentry` in
  the same assign.** That is exactly the predicate
  `deriveActiveEntryProjection` used (`lastAction?.type === 'GOTO' | 'RETRY'`),
  relocated to where the decision is made and made immune to multi-entry
  transitions by one-shot consumption.

**Eight assigns** declare the marker. `RETRY_ERROR` is deliberately excluded — it
routes to `STOPPED` and re-enters nothing. The two `runRetryHook` assigns are
excluded too and are handled differently in Task A4: they advance inline and
must **not** also mark, or the leaf entry action would double-count them.

| # | Site                                                             | Marker  |
| - | ----------------------------------------------------------------- | ------- |
| 1 | `buildSimpleGotoAssign` (`:1525`) — covers the authored-GOTO and event-GOTO simple paths | `GOTO`  |
| 2 | Parent-exit GOTO into a FOR target (`:1697`)                     | `GOTO`  |
| 3 | Parent-exit GOTO into a non-FOR target (`:1718`)                 | `GOTO`  |
| 4 | Authored GOTO into a FOR target (`:3127`)                        | `GOTO`  |
| 5 | Event GOTO into a FOR target (`:4286`)                           | `GOTO`  |
| 6 | Recovery reconcile GOTO (`:2650`)                                | `GOTO`  |
| 7 | Leaf `RETRY` event handler (`:4387`)                             | `RETRY` |
| 8 | `buildRetryStateConfig` retry arm (`:2790`)                      | `RETRY` |

- [ ] **Step 1: Write the failing tests**

Append to the `machine-owned frame entry` describe block in
`packages/core/__tests__/runbook/compiler.test.ts`:

```typescript
  it('bumps once on a same-frame GOTO and clears the marker', async () => {
    const actor = createActor(compileRunbookToMachine(twoSubstepSteps(), options)).start();
    actor.send({ type: 'PASS' }); // now on 2.2
    await waitFor(actor, (snap) => !snap.hasTag(PENDING_MACHINE_EFFECT_TAG));
    const before = actor.getSnapshot().context.frameEntry?.activeEntry ?? 0;

    actor.send({ type: 'GOTO', target: { step: '2', substep: '1' } });
    await waitFor(actor, (snap) => !snap.hasTag(PENDING_MACHINE_EFFECT_TAG));

    expect(actor.getSnapshot().context.frameEntry?.activeEntry).toBe(before + 1);
    expect(actor.getSnapshot().context.frameReentry).toBeUndefined();
  });

  it('bumps once on a GOTO that routes through __parent-entry::', async () => {
    // The step declares ARTIFACTS, so one GOTO drives TWO state entries.
    const actor = createActor(compileRunbookToMachine(parentArtifactSteps(), options)).start();
    actor.send({ type: 'PASS' });
    await waitFor(actor, (snap) => !snap.hasTag(PENDING_MACHINE_EFFECT_TAG));
    const before = actor.getSnapshot().context.frameEntry?.activeEntry ?? 0;

    actor.send({ type: 'GOTO', target: { step: '2', substep: '1' } });
    await waitFor(actor, (snap) => !snap.hasTag(PENDING_MACHINE_EFFECT_TAG));

    expect(actor.getSnapshot().context.frameEntry?.activeEntry).toBe(before + 1);
  });

  it('bumps once when a step-level retry budget re-enters the leaf', async () => {
    // Step "1" has FAIL retry: 1, so ::fail-retry self-targets back to step::1.
    const actor = createActor(compileRunbookToMachine(retryBudgetSteps(), options)).start();
    const before = actor.getSnapshot().context.frameEntry?.activeEntry ?? 0;
    actor.send({ type: 'FAIL' });
    await waitFor(actor, (snap) => !snap.hasTag(PENDING_MACHINE_EFFECT_TAG));
    expect(actor.getSnapshot().context.frameEntry?.activeEntry).toBe(before + 1);
    expect(actor.getSnapshot().context.frameReentry).toBeUndefined();
  });

  it('never leaves frameReentry set in a settled snapshot', async () => {
    const actor = createActor(compileRunbookToMachine(twoSubstepSteps(), options)).start();
    for (const event of [{ type: 'PASS' } as const, { type: 'GOTO', target: { step: '2', substep: '1' } } as const]) {
      actor.send(event);
      await waitFor(actor, (snap) => !snap.hasTag(PENDING_MACHINE_EFFECT_TAG));
      expect(actor.getPersistedSnapshot().context.frameReentry).toBeUndefined();
    }
  });
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
pnpm --filter @rundown-org/core exec jest __tests__/runbook/compiler.test.ts -t 'machine-owned frame entry'
```

Expected: FAIL — the same-frame GOTO and the retry-budget re-entry leave the
entry unchanged (`before`, not `before + 1`).

- [ ] **Step 3: Add the two shared marker constants**

Near `EMPTY_FOR_STACK` (`compiler.ts:738`):

```typescript
/** One-shot marker declaring a GOTO-driven frame re-entry (consumed by `syncFrameEntry`). */
const FRAME_REENTRY_GOTO: NonNullable<RunbookContext['frameReentry']> = Object.freeze({
  cause: 'GOTO' as const,
});
/** One-shot marker declaring a RETRY-driven frame re-entry (consumed by `syncFrameEntry`). */
const FRAME_REENTRY_RETRY: NonNullable<RunbookContext['frameReentry']> = Object.freeze({
  cause: 'RETRY' as const,
});
```

- [ ] **Step 4: Add `frameReentry` to the eight assigns**

Add exactly one property to each assign object. Sites 1–6 get
`frameReentry: FRAME_REENTRY_GOTO,`; sites 7–8 get
`frameReentry: FRAME_REENTRY_RETRY,`.

Site 1 — `buildSimpleGotoAssign` (`:1525`), inside `runbookSetup.assign({ … })`,
after `retryMax: undefined,`:

```typescript
    frameReentry: FRAME_REENTRY_GOTO,
```

Site 2 — `:1697`, after `lastAction: makeAggregationLastAction(buildGotoLastAction(parentAction.target)),`.
Site 3 — `:1718`, after the same `lastAction` line at `:1728`.
Site 4 — `:3127`, after `lastAction: makeDirectLastAction(buildGotoLastAction(target)),` (`:3141`).
Site 5 — `:4286`, after `lastAction: buildGotoLastActionFromEvent(target.substepId),` (`:4314`).
Site 6 — `:2650`, after `lastAction: buildGotoLastActionFromEvent(first.substepId),` (`:2663`).
Site 7 — the leaf `RETRY` handler (`:4387`), after `retryMax: retryMaxFromTransitions,`.
Site 8 — `buildRetryStateConfig` (`:2790`), after `retryMax: transition.retry,`.

- [ ] **Step 5: Run the tests and verify they pass**

Run:

```bash
pnpm --filter @rundown-org/core exec jest __tests__/runbook/compiler.test.ts -t 'machine-owned frame entry'
```

Expected: PASS (all nine cases from Tasks A2 and A3).

- [ ] **Step 6: Refresh the structural snapshot and read the diff**

```bash
pnpm --filter @rundown-org/core exec jest __tests__/runbook/compiler-machine-structural-snapshot.test.ts -u
```

The diff must show `frameReentry` added to exactly eight assigns. A ninth means
you marked `RETRY_ERROR` or a retry-hook site.

- [ ] **Step 7: Commit**

```bash
npx biome check --config-path=. --write packages/core/src/runbook/compiler.ts \
  packages/core/__tests__/runbook/compiler.test.ts
git add packages/core/src/runbook/compiler.ts packages/core/__tests__/runbook/compiler.test.ts \
  packages/core/__tests__/runbook/__snapshots__
git commit -m "feat(core): declare frame re-entry on every GOTO/RETRY transition

Eight assigns now write the one-shot frameReentry marker alongside their
GOTO/RETRY lastAction. The marker is consumed by the first leaf syncFrameEntry,
so a transition that drives several state entries (__parent-entry:: routing)
bumps exactly once. Part of #680."
```

---

### Task A4: Advance inline at the two `runRetryHook` call sites

**Files:**

- Modify: `packages/core/src/runbook/compiler.ts:1852-1899` (parent-aggregation
  retry), `:1974-2016` (FOR-iteration retry)
- Test: `packages/core/__tests__/runbook/compiler.test.ts`

**Interfaces:**

- Consumes: `advanceFrameEntry`, `frameKeyForCursor`, `runRetryHook`.
- Produces: no new exports.

**Why this task exists.** `runRetryHook` runs inside a transition `assign`, and
transition actions run *before* the target state's entry actions. Tasks A2 and
A3 therefore cannot make the entry current for it — the marker-plus-entry-action
split fixes GOTO and step-level RETRY, and leaves `runRetryHook` reading the
pre-transition value exactly as it does today (`retry-hook.ts:374`). These two
assigns must advance `frameEntry` themselves and hand the hook the advanced
coordinates.

They must **not** also set `frameReentry`: they already performed the bump, and
the leaf `syncFrameEntry` that follows would double-count it. With no marker and
an unchanged frame key, `advanceFrameEntry` returns the coordinates unchanged —
the entry action is a deliberate no-op on this path.

The parent-aggregation site additionally assigns `forStack: EMPTY_FOR_STACK`. On
a FOR parent the following leaf `initForStack` therefore rebuilds the loop at
`forClause.start`, which is a *different* frame from the one the hook retried.
That is a legitimate second bump for a legitimate second frame, and the
credential stamped for the retried frame still equals
`inferFrameEntryFromState(committed, retriedFrameKey)` because
`advanceFrameEntry` raised that frame's recorded count. Task A9 pins it.

- [ ] **Step 1: Write the failing tests**

Append to the `machine-owned frame entry` describe block:

```typescript
  it('stamps the retried credential with the entry the same transition commits', async () => {
    // Parent "2" aggregates ALL with FAIL retry: 1 over one DELEGATE substep.
    const issuer = recordingIssuer();
    const actor = createActor(
      compileRunbookToMachine(delegatingRetrySteps(), { ...options, issueDelegationCredential: issuer }),
    ).start();
    actor.send({ type: 'PASS' }); // into frame 2, fresh issuance at entry 2
    await waitFor(actor, (snap) => !snap.hasTag(PENDING_MACHINE_EFFECT_TAG));
    expect(issuer.locations.at(-1)?.parentEntry).toBe(2);

    actor.send({ type: 'FAIL' }); // aggregation retry -> runRetryHook re-issues
    await waitFor(actor, (snap) => !snap.hasTag(PENDING_MACHINE_EFFECT_TAG));

    const committed = actor.getSnapshot().context.frameEntry;
    expect(committed?.activeEntry).toBe(3);
    expect(issuer.locations.at(-1)?.parentEntry).toBe(3);
    expect(issuer.locations.at(-1)?.parentEntry).toBe(committed?.activeEntry);
  });

  it('bumps exactly once for an aggregation RETRY into the first substep', async () => {
    const actor = createActor(compileRunbookToMachine(aggregationRetrySteps(), options)).start();
    actor.send({ type: 'PASS' });
    await waitFor(actor, (snap) => !snap.hasTag(PENDING_MACHINE_EFFECT_TAG));
    const before = actor.getSnapshot().context.frameEntry?.activeEntry ?? 0;
    actor.send({ type: 'FAIL' });
    await waitFor(actor, (snap) => !snap.hasTag(PENDING_MACHINE_EFFECT_TAG));
    expect(actor.getSnapshot().context.frameEntry?.activeEntry).toBe(before + 1);
  });

  it('bumps exactly once for a FOR-iteration retry within the same iteration frame', async () => {
    const actor = createActor(compileRunbookToMachine(forIterationRetrySteps(), options)).start();
    await waitFor(actor, (snap) => !snap.hasTag(PENDING_MACHINE_EFFECT_TAG));
    const before = actor.getSnapshot().context.frameEntry?.activeEntry ?? 0;
    actor.send({ type: 'FAIL' });
    await waitFor(actor, (snap) => !snap.hasTag(PENDING_MACHINE_EFFECT_TAG));
    // Same iteration frame, one retry: +1, and the iteration did NOT advance.
    expect(actor.getSnapshot().context.frameEntry?.activeEntry).toBe(before + 1);
    expect(actor.getSnapshot().context.frameEntry?.activeFrameKey).toBe(buildFrameKey('2', 1));
  });
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
pnpm --filter @rundown-org/core exec jest __tests__/runbook/compiler.test.ts -t 'machine-owned frame entry'
```

Expected: FAIL — the retried credential stamps `2` where `3` is expected, and
the aggregation-retry entry does not move.

- [ ] **Step 3: Advance inline at the parent-aggregation retry**

Replace the body of the retry assign at `compiler.ts:1852-1899`. The whole
`assign(({ context }) => …)` callback gains three leading lines and one extra
returned field:

```typescript
        actions: runbookSetup.assign(({ context }: { context: RunbookContext }) => {
          // `runRetryHook` runs as a TRANSITION action, so the leaf
          // `syncFrameEntry` that follows cannot make the entry current for it.
          // Advance here, hand the hook the advanced coordinates, and do NOT set
          // `frameReentry` — the entry action would otherwise score this bump a
          // second time.
          const frameEntry = advanceFrameEntry(
            context.frameEntry ?? {},
            frameKeyForCursor(parentStep.name, context.forStack),
            true,
          );
          const hook = runRetryHook(
            { ...context, frameEntry },
            parentStep,
            steps,
            issueDelegationCredential,
          );
          if (hook.status === 'error') {
            // RETRY_ERROR routes to STOPPED and re-enters no frame, so the
            // advance is discarded with the rest of the retry.
            return {
              lastAction: makeAggregationLastAction({
                type: 'RETRY_ERROR' as const,
                code: hook.code,
                message: hook.message,
              }),
              substepStates: hook.substepStates,
            };
          }
          return {
            frameEntry,
            lastAction: makeAggregationLastAction({ type: 'RETRY' as const }),
            parentRetryCount: context.parentRetryCount + 1,
            // …every existing field below unchanged…
```

Keep every other returned field and every existing comment verbatim.

- [ ] **Step 4: Advance inline at the FOR-iteration retry**

Apply the same three-line prologue and the same `frameEntry,` field to the
assign at `compiler.ts:1974-2016`. This site does **not** reset `forStack`, so
the frame key is the current iteration's and the advance is a same-frame
re-entry.

- [ ] **Step 5: Run the tests and verify they pass**

Run:

```bash
pnpm --filter @rundown-org/core exec jest __tests__/runbook/compiler.test.ts -t 'machine-owned frame entry' && \
pnpm --filter @rundown-org/core exec jest __tests__/runbook/retry-hook.test.ts
```

Expected: PASS. `retry-hook.ts` itself is unchanged, so its own suite must stay
green untouched.

- [ ] **Step 6: Refresh the structural snapshot, then commit**

```bash
pnpm --filter @rundown-org/core exec jest __tests__/runbook/compiler-machine-structural-snapshot.test.ts -u
npx biome check --config-path=. --write packages/core/src/runbook/compiler.ts \
  packages/core/__tests__/runbook/compiler.test.ts
git add packages/core/src/runbook/compiler.ts packages/core/__tests__/runbook/compiler.test.ts \
  packages/core/__tests__/runbook/__snapshots__
git commit -m "fix(core): make the frame entry current for runRetryHook

runRetryHook is invoked from a transition assign, which runs before the target
leaf's entry actions, so syncFrameEntry cannot serve it. Both retry sites now
advance frameEntry inline and hand the hook the advanced coordinates, without
setting the one-shot marker the entry action would double-count. Part of #680."
```

---

### Task A5: Persist frame entry from context

**Files:**

- Modify: `packages/core/src/runbook/actor-service.ts:557-585` (`hydrateSnapshot`),
  `:633-783` (`deriveActorStatePatch`)
- Test: `packages/core/__tests__/runbook/actor-service.test.ts`

**Interfaces:**

- Consumes: `RunbookContext.frameEntry` (Task A2), `frameKeyForCursor` (Task A1),
  `replace` (already imported in `actor-service.ts`).
- Produces: `RunbookStateUpdate` from `deriveActorStatePatch` now carries
  `activeEntry: number` and `frameEntryCounts: FrameEntryCountsOp` on the
  non-terminal branch.

This task is combined with Task A6 in one commit — persisting from context while
`deriveActiveEntryProjection` still runs would double-bump every committed
entry. Implement A5 and A6, then run the verification and commit once.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/__tests__/runbook/actor-service.test.ts`:

```typescript
describe('frame-entry persistence', () => {
  it('persists activeEntry and frameEntryCounts from machine context', async () => {
    const { state } = await service.transitionState(runId, steps, { type: 'PASS' });
    expect(state.activeEntry).toBe(2);
    expect(state.frameEntryCounts).toEqual({ [buildFrameKey('1')]: 1, [buildFrameKey('2')]: 2 });
  });

  it('keeps the cursor-derived activeFrameKey in agreement with context.frameEntry', async () => {
    // A5 deliberately keeps deriving activeFrameKey from the cursor rather than
    // mirroring context.frameEntry.activeFrameKey. This is the standing check
    // that A1's unification holds.
    const { state, snapshot } = await service.transitionState(runId, steps, { type: 'PASS' });
    expect(state.activeFrameKey).toBe(snapshot.context.frameEntry?.activeFrameKey);
  });

  it('writes no frame-entry patch on a terminal snapshot', async () => {
    const { state } = await service.transitionState(runId, steps, { type: 'FAIL' }); // STOP
    expect(state.lifecycle).toBe('stopped');
    expect(state.activeEntry).toBe(previousState.activeEntry);
  });

  it('does not re-run the entry action when an actor is rehydrated', async () => {
    const first = await service.transitionState(runId, steps, { type: 'PASS' });
    const again = await service.initializeState(runId, steps);
    expect(again?.activeEntry).toBe(first.state.activeEntry);
  });

  it('seeds the coordinates at bootstrap with no ensureActiveEntry call', async () => {
    const state = await service.initializeState(freshRunId, steps);
    expect(state?.activeEntry).toBe(1);
    expect(state?.frameEntryCounts).toEqual({ [buildFrameKey('1')]: 1 });
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
pnpm --filter @rundown-org/core exec jest __tests__/runbook/actor-service.test.ts -t 'frame-entry persistence'
```

Expected: FAIL — `state.activeEntry` is `undefined` from the patch (the
projection, not the patch, wrote it).

- [ ] **Step 3: Emit the frame-entry patch**

In `deriveActorStatePatch`, immediately after the `activeFrameKeyPatch` line
(`:766`):

```typescript
  // Frame entry is machine-owned: the leaf `syncFrameEntry` entry action is the
  // sole writer, and this mirrors its result into persisted state. `activeFrameKey`
  // above stays cursor-derived rather than mirrored, and an invariant test pins
  // that the two agree — a cheap standing check on the unified frame-key
  // derivation.
  const contextFrameEntry = snapshot.context?.frameEntry;
  const frameEntryPatch =
    contextFrameEntry?.activeEntry === undefined
      ? {}
      : {
          activeEntry: contextFrameEntry.activeEntry,
          frameEntryCounts: replace({ ...(contextFrameEntry.frameEntryCounts ?? {}) }),
        };
```

and add `...frameEntryPatch,` to the returned object immediately after
`...activeFrameKeyPatch,` (`:780`).

Leave the terminal branch (`:670-682`) alone: it deliberately writes no
`activeFrameKey`, and frame entry follows the same rule.

- [ ] **Step 4: Drop the `hydrateSnapshot` frame-entry overlay**

In `hydrateSnapshot`, delete the `frameEntry: frameEntryCoordinatesOf(state)`
line and its comment (`:575-578`). The persisted snapshot's own context is now
authoritative, and overlaying persisted state on top of it would re-introduce a
second writer at the hydration boundary.

Keep `frameEntry: frameEntryCoordinatesOf(state)` at `:931`
(`compileMachineFromState`): it seeds `initial.context` and is only read when
there is no snapshot at all. Update its neighbouring comment to say so.

`frameEntryCoordinatesOf` now has one caller; leave it exported-in-module and
documented.

- [ ] **Step 5: Route `deriveActorStatePatch`'s frame-key derivation through `frameKeyForCursor`**

Replace `:764-765`:

```typescript
  const derivedFrameKey = frameKeyForCursor(stepName, realForStack);
```

Note this is the behaviour-bearing half of A1's unification: the old code took
the last non-implicit FOR context with **no `stepId` check**, while
`frameKeyForCursor` rejects a context belonging to another step. Add
`frameKeyForCursor` to the existing `./targeting.js` import and delete the now
unused `activeFrame` local and `buildFrameKey` import if nothing else uses them.

- [ ] **Step 6: Proceed directly to Task A6 — do not run the full suite yet**

Both writers are live at this point and every committed entry double-bumps. Task
A6 removes the second writer; verify and commit the pair together.

---

### Task A6: Delete the second writer (production change only)

**Files:**

- Modify: `packages/core/src/runbook/execution-lifecycle-service.ts` — delete
  `deriveActiveEntry` (`:71-89`), `ensureActiveEntry` (`:91-136`), and
  `deriveActiveEntryProjection` (`:296-340`)
- Modify: `packages/core/src/runbook/lifecycle-command-service.ts:2389`, `:2403`,
  `:3137`, `:3173`, `:3199`, `:3359`, `:3367`
- Modify: `packages/cli/src/services/execution.ts:210`, `:930-934`, `:1261`,
  `:1754`, `:1770`, `:1842`
- Modify: `packages/core/src/runbook/completion-service.ts:1046-1052`, `:1087`
- Modify: `packages/core/src/runbook/actor-service.ts:1465-1468`
- Modify: `packages/core/src/runbook/state-update-ops.ts:81-83` (comment only)

**Interfaces:**

- Consumes: the frame-entry patch from Task A5.
- Produces: `ExecutionLifecycleService` no longer exposes `deriveActiveEntry` or
  `ensureActiveEntry`. Every caller reads `state.activeFrameKey` /
  `state.activeEntry` directly.

All thirteen sites, and what each becomes:

| # | File / line                                | Replacement                                                                                            |
| -- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1  | `lifecycle-command-service.ts:2389`        | `previousState = capturedState;`                                                                       |
| 2  | `lifecycle-command-service.ts:2397-2404`   | Delete the projection **and the double-bump comment** — the workaround it explains no longer exists. `return { ...prepared, previousState };` |
| 3  | `lifecycle-command-service.ts:3137`        | `const initial = capturedState;`                                                                       |
| 4  | `lifecycle-command-service.ts:3173-3174`   | Delete both lines; `state` already carries the coordinates                                             |
| 5  | `lifecycle-command-service.ts:3199`        | `const next = prepared.nextState;`                                                                     |
| 6  | `lifecycle-command-service.ts:3359`        | `previousState = capturedState;`                                                                       |
| 7  | `lifecycle-command-service.ts:3367-3372`   | `return { ...prepared, previousState };`                                                               |
| 8  | `cli/src/services/execution.ts:930-934`    | `const updatedState = postState;` — then delete the `entryAlreadyProjected` field (`:210`) and its one caller (`:1842`) |
| 9  | `cli/src/services/execution.ts:1261-1262`  | `let currentState: RunbookState = state;`                                                              |
| 10 | `cli/src/services/execution.ts:1754`       | `previousState = capturedState;`                                                                       |
| 11 | `cli/src/services/execution.ts:1770-1775`  | `return { ...prepared, previousState };`                                                               |
| 12 | `completion-service.ts:1046-1052`, `:1087` | Drop the `ensured` await; `const activeFrameKey = state.activeFrameKey ?? deriveActiveFrame(state).frameKey;` and `const entry = state.activeEntry ?? 1;` |
| 13 | `actor-service.ts:1465-1468`               | `return await this.initializeActiveSubsteps(id, synced, steps);` — drop the `ExecutionLifecycleService` construction and its now-unused import if nothing else in the file uses it |

The `transitioned` parameter disappears with the function; there is no caller
left that could pass it.

- [ ] **Step 1: Delete the projection and the two service methods**

Remove `deriveActiveEntry`, `ensureActiveEntry`, and
`deriveActiveEntryProjection` from
`packages/core/src/runbook/execution-lifecycle-service.ts`. Remove the now-unused
imports (`replace`, and any `targeting` import only they used — keep whatever
`buildActiveCompletionKey` and friends still need).

- [ ] **Step 2: Rewrite the thirteen call sites per the table above**

Work top to bottom. After each file, run `pnpm --filter <pkg> exec tsc --noEmit`
to catch a missed site immediately.

- [ ] **Step 3: Update the `state-update-ops.ts` comment**

`:81-83` names `ensureActiveEntry` as the constructor of the replacement map.
Change it to name `deriveActorStatePatch`.

- [ ] **Step 4: Verify the build type-checks**

Run:

```bash
pnpm --filter @rundown-org/core exec tsc --noEmit && \
pnpm --filter @rundown-org/cli exec tsc --noEmit
```

Expected: clean. Any error naming `deriveActiveEntry` / `ensureActiveEntry` /
`entryAlreadyProjected` is a missed site.

- [ ] **Step 5: Run the targeted suites and record the expected damage**

Run:

```bash
pnpm --filter @rundown-org/core exec jest __tests__/runbook/actor-service.test.ts -t 'frame-entry persistence'
pnpm --filter @rundown-org/core exec jest 2>&1 | tail -40
pnpm --filter @rundown-org/cli exec jest 2>&1 | tail -40
```

Expected: the `frame-entry persistence` block PASSES. The wider suites FAIL on
roughly 36 files that assert entry numbers, completion keys, or mock the removed
methods. **That is expected and is why this commit is separate.** Save the
failing-file list — Task A7 works through it.

- [ ] **Step 6: Commit the production change alone**

```bash
npx biome check --config-path=. --write \
  packages/core/src/runbook/execution-lifecycle-service.ts \
  packages/core/src/runbook/lifecycle-command-service.ts \
  packages/core/src/runbook/completion-service.ts \
  packages/core/src/runbook/actor-service.ts \
  packages/core/src/runbook/state-update-ops.ts \
  packages/cli/src/services/execution.ts
git add packages/core/src packages/cli/src
git commit -m "refactor(core)!: make the machine the single writer of frame entry

deriveActorStatePatch now persists activeEntry and frameEntryCounts from
machine context, and deriveActiveEntryProjection, ExecutionLifecycleService
.deriveActiveEntry and .ensureActiveEntry are deleted with all thirteen call
sites — including four Category B sites that were sitting in the CLI and the
inline-launch double-bump workaround that only existed because two writers
could each score one \`rundown goto\`.

BREAKING: \`rundown goto\` into a new frame now bumps the entry, and derived
delegation bearers change because parentEntry is HMAC input. There is no
persisted-state compatibility contract; finish, stop, prune or restart.

Test expectations are renumbered in the next commit so this diff is reviewable
on its own. Closes part of #680."
```

---

### Task A7: Renumber the test expectations

**Files:**

- Modify: roughly 36 test files across `packages/core/__tests__` and
  `packages/cli/__tests__`. The heaviest are
  `packages/core/__tests__/runbook/actor-service.test.ts`,
  `packages/cli/__tests__/services/execution-loop.test.ts`,
  `packages/core/__tests__/runbook/lifecycle-command-service.test.ts`,
  `packages/core/__tests__/runbook/delegation-lifecycle-read-model.test.ts`,
  `packages/cli/__tests__/helpers/claim-and-launch.test.ts`.
- Modify: `packages/cli/__tests__/helpers/run-pipeline-context-helpers.ts`,
  `packages/cli/__tests__/helpers/test-utils.ts` (shared fakes that stub the
  removed methods).

**Interfaces:**

- Consumes: everything from Task A6. Produces: nothing — this task changes only
  expected values and test doubles.

- [ ] **Step 1: Delete the stubs for the removed methods**

Search and remove:

```bash
rg -n 'deriveActiveEntry|ensureActiveEntry|entryAlreadyProjected' packages/*/__tests__ packages/*/src/testing
```

Every hit is either a mock of a method that no longer exists (delete the stub) or
a direct call (delete the call and read the state field instead). The
`ExecutionLifecycleService` doubles in
`packages/cli/__tests__/helpers/run-pipeline-context-helpers.ts` and
`packages/cli/__tests__/helpers/test-utils.ts` are the two shared ones — fix
them first, since they unblock many files at once.

- [ ] **Step 2: Renumber `packages/core/__tests__/runbook/execution-lifecycle-service.test.ts`**

Delete the `deriveActiveEntry` / `ensureActiveEntry` describe blocks outright.
Their behaviour is now covered by `frame-entry.test.ts` (arithmetic) and
`compiler.test.ts` (ordering). Do not port them.

- [ ] **Step 3: Work the failing-file list from Task A6 Step 5**

For each file, run it, read the assertion, and apply one of exactly three
edits — never a fourth:

1. An entry number that is now one higher because the GOTO path stopped
   suppressing its bump (`rundown goto` into a new frame: `1` → `2`).
2. A completion key whose entry segment moved with it
   (`2|1|2|` → `2|1|3|`, i.e. `frameKey|iteration|entry|substep`).
3. A removed mock.

If an assertion needs a change that is **not** one of those three, stop: that is
a real regression, not churn. Record it and use
`superpowers:systematic-debugging` before continuing.

Run each file as you go:

```bash
pnpm --filter @rundown-org/core exec jest <path>
pnpm --filter @rundown-org/cli exec jest <path>
```

- [ ] **Step 4: Run both package suites green**

Run:

```bash
pnpm --filter @rundown-org/core exec jest && pnpm --filter @rundown-org/cli exec jest
```

Expected: PASS, except
`packages/core/__tests__/runbook/entry-projection-ordering.investigation.test.ts`,
which now fails its `not.toBe` assertions. Task A8 owns it.

- [ ] **Step 5: Commit the churn alone**

```bash
git add packages/core/__tests__ packages/cli/__tests__ packages/core/src/testing
git commit -m "test: renumber frame-entry expectations for the single writer

Mechanical follow-up to the single-writer change: entry ordinals on the GOTO
path move from 1 to 2, completion keys follow, and the doubles for the deleted
ExecutionLifecycleService methods are removed. No production change. #680"
```

---

### Task A8: Flip the investigation test into the regression pin

**Files:**

- Rename: `packages/core/__tests__/runbook/entry-projection-ordering.investigation.test.ts`
  → `packages/core/__tests__/runbook/entry-projection-ordering.test.ts`
- Modify: the renamed file

**Interfaces:**

- Consumes: everything from Tasks A2–A7. Produces: the direct regression pin for
  #680 and the precondition for every Part B entry assertion.

- [ ] **Step 1: Rename the file**

```bash
git mv packages/core/__tests__/runbook/entry-projection-ordering.investigation.test.ts \
       packages/core/__tests__/runbook/entry-projection-ordering.test.ts
```

- [ ] **Step 2: Rewrite the file header**

Replace the `INVESTIGATION — not a behaviour contract.` block (lines 1-41) with:

```typescript
/**
 * Regression pin for #680: the machine is the single writer of frame entry.
 *
 * A machine-issued delegation credential must stamp the `parentEntry` that the
 * *committed* `RunbookState` carries for the same frame, on every issuance
 * path. Part B's `unobservedReplacement` predicate compares those two values
 * directly, so a lag on either machine-owned path would silently degrade the
 * retry idempotency contract to an unconditional re-mint while reading as
 * implemented.
 *
 * Method: drive real transitions through the real
 * `RunbookLifecycleCommandService` — the production caller that sequences
 * `RunbookActorService.prepareActorMutation` (which runs the machine, and
 * therefore issues credentials) — then read the credential back off committed
 * state and compare.
 *
 * All five cases assert agreement. Before #680 the first, second and fifth
 * lagged the committed value by exactly one.
 */
```

- [ ] **Step 3: Flip the assertions**

Case 1 (`FRESH issuance, carried into the frame by PASS`): rename to
`AGREES: …`; change `expect(delegation.credential.parentEntry).toBe(1)` to
`.toBe(2)`; replace the trailing `not.toBe` with:

```typescript
    expect(delegation.credential.parentEntry).toBe(inferFrameEntryFromState(committed, FRAME_2));
```

Case 2 (`RETRY re-issuance`): rename to `AGREES: …`; change
`expect(fresh.credential.parentEntry).toBe(1)` → `.toBe(2)`;
`expect(replacement.credential.parentEntry).toBe(2)` → `.toBe(3)`; replace the
`not.toBe` and the arithmetic-lag assertion
(`inferFrameEntryFromState(...) - replacement.credential.parentEntry).toBe(1)`)
with a single equality:

```typescript
    expect(replacement.credential.parentEntry).toBe(inferFrameEntryFromState(committed, FRAME_2));
```

Case 3 (`GOTO into the delegating frame`): the numbers move from `1` to `2`
and the comment about `runNavigationMutation` deliberately not scoring the
transition is now false — replace it:

```typescript
    // `rundown goto` into a new frame now bumps the entry, like every other
    // frame-entering transition. The old `transitioned=false` workaround existed
    // only because two writers could each score one navigation; with a single
    // writer the correct number under the stated rule ("entry increments when
    // execution enters a frame from another frame") is 2.
```

then `expect(delegation.credential.parentEntry).toBe(2)`,
`expect(committed.activeEntry).toBe(2)`,
`expect(inferFrameEntryFromState(committed, FRAME_2)).toBe(2)`, and keep the
final equality assertion as-is.

Case 4 (`manual retry issuance`): unchanged in shape. `afterFresh.activeEntry`
is now `2`; the assertions are written relatively so they should already pass —
confirm rather than edit.

Case 5 (`frame-scoped, EVERY substep`): rename to `AGREES: …`; change
`expect(delegation.credential.parentEntry).toBe(1)` → `.toBe(2)` and replace the
`not.toBe` inside the loop with `toBe`.

Finally rename the outer describe:

```typescript
describe('entry projection ordering: machine credential issuance agrees with committed state', () => {
```

- [ ] **Step 4: Run the file and verify it passes**

Run:

```bash
pnpm --filter @rundown-org/core exec jest __tests__/runbook/entry-projection-ordering.test.ts
```

Expected: PASS, 5/5.

- [ ] **Step 5: Commit**

```bash
npx biome check --config-path=. --write packages/core/__tests__/runbook/entry-projection-ordering.test.ts
git add -A packages/core/__tests__/runbook
git commit -m "test: flip the entry-projection investigation into a regression pin

All five cases now assert that the stamped parentEntry equals the entry
committed state carries for the same frame. Renamed off .investigation.
Closes the measurable half of #680."
```

---

### Task A9: Pin the multi-state-entry paths end to end

**Files:**

- Create: `packages/core/__tests__/runbook/frame-entry-multi-entry-paths.test.ts`
- Modify: `packages/core/__tests__/runbook/delegation-credential-coordinate.properties.test.ts`

**Interfaces:**

- Consumes: `RunbookLifecycleCommandService`, `RunbookStateManager`,
  `inferFrameEntryFromState`. Produces: nothing — pure coverage.

This is the highest-risk part of Part A. A single `prepareActorMutation` can
drive several state entries, so a per-entry bump could count where the
per-mutation projection counted once. Task A3 handles that with a one-shot
marker; this task proves it at the seam, on committed state, for every such
path. Model the fixtures on
`packages/core/__tests__/runbook/entry-projection-ordering.test.ts` — same
manager / seam / claim setup, and copy its `loadCommitted`, `delegationFor` and
`drive` helpers. `goto` and `driveIntoIteration` are new thin wrappers over
`seam.runNavigationMutation` and repeated `drive('pass')`.

- [ ] **Step 1: Write the five failing-or-passing delta tests**

Each test asserts an exact `activeEntry` **delta** across one CLI-level mutation.

```typescript
describe('one mutation, one entry bump', () => {
  it('__parent-entry:: artifact routing: a GOTO into an artifact-declaring parent bumps by exactly 1', async () => {
    // Step 2 declares ARTIFACTS and has substeps, so the GOTO routes
    // step::2::__parent-entry::1 -> step::2::1 — two state entries.
    const before = (await loadCommitted()).activeEntry;
    await goto({ step: '2', substep: '1' });
    expect((await loadCommitted()).activeEntry).toBe((before ?? 0) + 1);
  });

  it('aggregation RETRY into firstSubstepStateId bumps by exactly 1', async () => {
    await drive('pass'); // into frame 2
    const before = (await loadCommitted()).activeEntry;
    await drive('fail'); // ALL aggregation fails -> parent retry -> first substep
    expect((await loadCommitted()).activeEntry).toBe((before ?? 0) + 1);
  });

  it('aggregation RETRY on a FOR parent bumps the retried frame and the rebuilt frame once each', async () => {
    // The parent-aggregation retry assigns forStack: EMPTY_FOR_STACK, so the
    // following leaf initForStack rebuilds the loop at forClause.start — a
    // different frame from the one runRetryHook retried. Two frames, two bumps,
    // and the retried frame's recorded count still reproduces the stamped value.
    await driveIntoIteration(3);
    const before = await loadCommitted();
    const retriedFrame = before.activeFrameKey!;
    await drive('fail');
    const after = await loadCommitted();
    expect(after.frameEntryCounts?.[retriedFrame]).toBe((before.activeEntry ?? 0) + 1);
    expect(after.activeFrameKey).toBe(buildFrameKey('2', 1));
    expect(after.activeEntry).toBe((before.activeEntry ?? 0) + 2);
    expect(delegationFor(after, retriedFrame).credential.parentEntry).toBe(
      inferFrameEntryFromState(after, retriedFrame),
    );
  });

  it('FOR loop-back bumps by exactly 1 per iteration', async () => {
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) {
      seen.push((await loadCommitted()).activeEntry ?? 0);
      await drive('pass');
    }
    expect(seen).toEqual([seen[0], seen[0] + 1, seen[0] + 2]);
  });

  it('a BREAK/NEXT chain that crosses steps bumps by exactly 1', async () => {
    // BREAK exits the loop to the parent, which exits to step 3 in one macrostep:
    // several state entries (parent + leaf), one frame actually entered.
    const before = (await loadCommitted()).activeEntry;
    await drive('fail'); // FAIL BREAK on the last substep
    const after = await loadCommitted();
    expect(after.step).toBe('3');
    expect(after.activeEntry).toBe((before ?? 0) + 1);
  });
});
```

- [ ] **Step 2: Run and read every failure carefully**

Run:

```bash
pnpm --filter @rundown-org/core exec jest __tests__/runbook/frame-entry-multi-entry-paths.test.ts
```

A failure here is **not** churn. If a delta is `+2`, a transition set
`frameReentry` on a path that also switches frames, or a retry site both
advanced inline and set the marker. Fix the compiler, not the expectation.

- [ ] **Step 3: Extend the coordinate property suite**

In `packages/core/__tests__/runbook/delegation-credential-coordinate.properties.test.ts`,
add a property asserting stamped-equals-committed across both machine issuance
paths:

```typescript
  it('property: a machine-stamped parentEntry equals the entry committed state reports', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }), // starting entry for the issuing frame
        fc.boolean(),                    // fresh issuance vs runRetryHook re-issuance
        (startEntry, viaRetry) => {
          const { credential, committed } = issueThroughMachine({ startEntry, viaRetry });
          expect(credential.parentEntry).toBe(
            inferFrameEntryFromState(committed, credential.parentFrameKey),
          );
        },
      ),
      { numRuns: 50 },
    );
  });
```

`issueThroughMachine` drives a real actor (fresh: `PASS` into the delegating
frame; retry: `PASS` then `FAIL` with an aggregation retry budget) and returns
the issued credential plus `snapshot.context.frameEntry` as the committed
coordinates. Keep it in this file — it is the cross-path invariant this suite
exists for.

- [ ] **Step 4: Run and verify green**

```bash
pnpm --filter @rundown-org/core exec jest \
  __tests__/runbook/frame-entry-multi-entry-paths.test.ts \
  __tests__/runbook/delegation-credential-coordinate.properties.test.ts
```

- [ ] **Step 5: Commit**

```bash
npx biome check --config-path=. --write packages/core/__tests__/runbook/frame-entry-multi-entry-paths.test.ts \
  packages/core/__tests__/runbook/delegation-credential-coordinate.properties.test.ts
git add packages/core/__tests__/runbook
git commit -m "test: pin the entry delta on every multi-state-entry path

__parent-entry:: routing, aggregation RETRY into firstSubstepStateId (plain and
FOR-parent), FOR loop-back, and a BREAK chain across steps each move the
committed entry by exactly one per mutation. Plus a property asserting
stamped-equals-committed across both machine issuance paths. #680"
```

---

### Task A10: Document the ownership change

**Files:**

- Modify: `docs/internal/architecture.md` — new subsection after
  § "Per-step substate pattern" (`:169-226`), plus one sentence in
  § "Actor input wiring" (`:262`)

**Interfaces:** none — documentation only. `docs/internal/` is **descriptive**
and edited in place; it describes the code as it now is.

- [ ] **Step 1: Add the "Frame entry ownership" subsection**

Insert after § "Per-step substate pattern" and before § "Delegated Command
Infrastructure Terminals":

```markdown
### Frame entry ownership

The XState machine is the single writer of frame entry. `RunbookContext.frameEntry`
holds `{ activeFrameKey, activeEntry, frameEntryCounts }` and is advanced by
`syncFrameEntry`, an `assign` appended after the existing entry actions on every
step/substep **leaf** state. `deriveActorStatePatch` mirrors the result into
`RunbookState.activeEntry` / `frameEntryCounts`.

Two ordering facts make the placement correct:

- **After `initForStack`.** FOR-stack initialisation lives in the same entry-action
  slot, so appending puts the sync after the iteration is current. A FOR loop-back
  therefore reads as a frame switch with no extra wiring.
- **Before the leaf's invoked children.** A compound state's `entry` assign runs
  before its initial child's `invoke` input factory is read, so
  `__issue-delegations` and `__prepare-inline-launch` see the advanced value.

`syncFrameEntry` is **not** attached to `step::N::__parent-entry::M`: those are
same-frame artifact pass-throughs that route on to the real leaf, and bumping
there would double-count.

The bump rule lives in `advanceFrameEntry` (`frame-entry.ts`) and the frame-key
derivation in `frameKeyForCursor` (`targeting.ts`), the single derivation that
`deriveActiveFrame`, `deriveActorStatePatch` and `buildDelegationIssueInvokeBlock`
all route through. The entry ordinal is run-global and monotonic —
`max(frameEntryCounts[target] ?? 0, previousActiveEntry) + 1` — not per-frame-local;
`classifyDelegationLiveness` and completion-key scoping depend on that form.

**Re-entry is declared, not inferred.** Every transition that writes a `GOTO` or
`RETRY` `lastAction` also writes the one-shot `context.frameReentry` marker, which
the first following `syncFrameEntry` consumes and clears. The split is deliberate:
a transition knows *that* it re-enters but not yet *which* frame (the FOR iteration
is only current after the leaf's `initForStack` runs), and one transition can drive
several state entries — `__parent-entry::` routing is two — which a one-shot marker
survives and a `lastAction` read does not. `RETRY_ERROR` sets no marker; it routes
to `STOPPED` and enters no frame.

**The two `runRetryHook` sites are the exception.** `runRetryHook` is invoked from a
transition `assign`, and transition actions run before the target's entry actions,
so `syncFrameEntry` cannot serve it. Both sites call `advanceFrameEntry` inline,
hand the hook the advanced coordinates, and deliberately set no marker — the entry
action that follows is then a no-op for that frame.
```

- [ ] **Step 2: Cross-reference from § "Actor input wiring"**

Append to that section:

```markdown
`context.frameEntry` is the canonical event-time-bound dependency: machine-owned
delegation issuance reads it inside `buildDelegationIssueInvokeBlock`'s `input`
factory at fire time, after the leaf's `syncFrameEntry` entry action has made it
current. It is plain data and serialises into the persisted snapshot; no function
reference or process-runtime value travels with it.
```

- [ ] **Step 3: Format and commit**

```bash
npx prettier --write docs/internal/architecture.md
git add docs/internal/architecture.md
git commit -m "docs(internal): describe machine-owned frame entry

architecture.md is descriptive and edited in place: records the single-writer
model, the declared-re-entry marker, and why the two runRetryHook sites advance
inline. #680"
```

---

### Task A11: Part A gate

- [ ] **Step 1: Run the full pre-PR gate**

Run:

```bash
pnpm run verify
```

Expected: PASS. This is the first point in Part A where the whole gate is
expected green. Do not push before it is.

- [ ] **Step 2: Mutation-test the changed core and CLI ranges**

Run:

```bash
pnpm run test:mutate:changed --package core
pnpm run test:mutate:changed --package cli
```

Read the report for **in-scope Survived and NoCoverage mutants only**; the
aggregate percentage is meaningless at this scope. Expect survivors in
`compiler.ts` that only integration tests kill — re-check those with
`pnpm run test:mutate:changed --package core --related-tests` before adding a
test. Add unit cases for any survivor inside `advanceFrameEntry`,
`frameKeyForCursor`, the `frameEntryPatch` construction, or a `frameReentry`
assign.

- [ ] **Step 3: Commit any added mutation-driven tests**

```bash
git add packages/core/__tests__ packages/cli/__tests__
git commit -m "test: close mutation gaps in the frame-entry single-writer change"
```

---

## Part B — retry idempotency (#681)

Part B's tests assert entry ordinals that only Part A makes correct. Do not
start it until Task A11 is green.

### Task B1: Locate a delegation by the token it superseded

**Files:**

- Modify: `packages/core/src/runbook/delegation-scan.ts`
- Test: `packages/core/__tests__/runbook/delegation-scan.test.ts`

**Interfaces:**

- Consumes: `hashDelegationToken`, `RunbookStateManager.list`, `TokenScanResult`.
- Produces:
  `DelegationScanService.findBySupersededToken(rawToken: string): Promise<readonly TokenScanResult[]>`
  — **all** rows whose `delegation.credential.supersedesTokenHash` matches, never
  the first hit.

Why a collection: decision-table row 8 (`multiple rows supersede H` → RD-828) is
only expressible if the scan returns one. It is unreachable by construction; it
is refused, never resolved.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/__tests__/runbook/delegation-scan.test.ts`:

```typescript
describe('findBySupersededToken', () => {
  it('returns the row whose credential supersedes the named token', async () => {
    await manager.save(stateWith([substepWithDelegation({ supersedesTokenHash: hashOf(T1) })]));
    const rows = await service.findBySupersededToken(T1);
    expect(rows).toHaveLength(1);
    expect(rows[0].frameKey).toBe(buildFrameKey('2'));
  });

  it('returns every matching row, not the first hit', async () => {
    await manager.save(
      stateWith([
        substepWithDelegation({ id: '1', supersedesTokenHash: hashOf(T1) }),
        substepWithDelegation({ id: '2', supersedesTokenHash: hashOf(T1) }),
      ]),
    );
    expect(await service.findBySupersededToken(T1)).toHaveLength(2);
  });

  it('returns an empty array when nothing supersedes the token', async () => {
    await manager.save(stateWith([substepWithDelegation({})]));
    expect(await service.findBySupersededToken(T1)).toEqual([]);
  });

  it('does not match on tokenHash', async () => {
    // A token that is CURRENT, not superseded, is findByToken's job.
    await manager.save(stateWith([substepWithDelegation({ tokenHash: hashOf(T1) })]));
    expect(await service.findBySupersededToken(T1)).toEqual([]);
  });

  it('scans across runs', async () => {
    await manager.save(stateWith([substepWithDelegation({})], { id: RUN_A }));
    await manager.save(
      stateWith([substepWithDelegation({ supersedesTokenHash: hashOf(T1) })], { id: RUN_B }),
    );
    const rows = await service.findBySupersededToken(T1);
    expect(rows.map((row) => row.parentState.id)).toEqual([RUN_B]);
  });
});
```

- [ ] **Step 2: Run and verify failure**

```bash
pnpm --filter @rundown-org/core exec jest __tests__/runbook/delegation-scan.test.ts -t findBySupersededToken
```

Expected: FAIL — `service.findBySupersededToken is not a function`.

- [ ] **Step 3: Implement it**

Append to `DelegationScanService` in
`packages/core/src/runbook/delegation-scan.ts`:

```typescript
  /**
   * Find every delegation that records the given raw token as superseded.
   *
   * `findByToken` matches `tokenHash` only, so a replayed retry naming a bearer
   * that has since been rotated away resolves to nothing there. This is the
   * companion lookup: it hashes the token and scans every active run's substep
   * states for a credential whose `supersedesTokenHash` matches.
   *
   * Returns **all** matches rather than the first, because "more than one
   * attempt records this bearer as superseded" is a distinct, refusable
   * condition (RD-828). It is unreachable by construction; surfacing it as data
   * is what lets the caller refuse rather than silently resolve one of them.
   *
   * Same O(N) full-scan cost profile as {@link findByToken} — see its
   * performance note.
   *
   * @param rawToken - The plain-text delegation token that may have been superseded.
   * @returns Every matching scan result, in state-listing order; empty when none match.
   */
  async findBySupersededToken(rawToken: string): Promise<readonly TokenScanResult[]> {
    const hash = hashDelegationToken(rawToken);
    const states = await this.manager.list();
    const matches: TokenScanResult[] = [];

    for (const state of states) {
      for (const ss of state.substepStates ?? []) {
        if (ss.delegation?.credential.supersedesTokenHash === hash) {
          matches.push({
            parentState: state,
            stepId: ss.delegation.contextSnapshot.step ?? state.step,
            substepId: ss.id,
            frameKey: ss.frameKey,
            delegation: ss.delegation,
          });
        }
      }
    }

    return matches;
  }
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
pnpm --filter @rundown-org/core exec jest __tests__/runbook/delegation-scan.test.ts
```

- [ ] **Step 5: Mutation-test the file (96 lines — whole-file scope is fine)**

```bash
pnpm --filter @rundown-org/core exec stryker run \
  --mutate 'src/runbook/delegation-scan.ts' \
  --testFiles '__tests__/runbook/delegation-scan.test.ts' \
  --force
```

- [ ] **Step 6: Commit**

```bash
npx biome check --config-path=. --write packages/core/src/runbook/delegation-scan.ts \
  packages/core/__tests__/runbook/delegation-scan.test.ts
git add packages/core/src/runbook/delegation-scan.ts packages/core/__tests__/runbook/delegation-scan.test.ts
git commit -m "feat(core): add DelegationScanService.findBySupersededToken

Locates every delegation recording a raw token as superseded. Returns all
matches, not the first, so the ambiguous case is refusable rather than
silently resolved. Precondition for #681's token-locator rows."
```

---

### Task B2: `resolveRetryIssuance` — the pure resolver

**Files:**

- Modify: `packages/core/src/runbook/delegation-inference.ts` (append after
  `resolveDelegationIssuance`, `:534`)
- Modify: `packages/core/src/runbook/index.ts` (export the resolver and its types)
- Test: `packages/core/__tests__/runbook/delegation-inference.test.ts`

**Interfaces:**

- Consumes: `StepDelegation`, `DelegationTokenHash` (from `delegation-token.js`).
- Produces:

```typescript
export type RetryReplacementConsumedReason = 'claimed' | 'cancelled' | 'entry_superseded';

export type RetryIssuanceCapture =
  | {
      readonly locator: 'token';
      readonly identityTokenHash: DelegationTokenHash;
      readonly current: StepDelegation | undefined;
      readonly supersededBy: readonly StepDelegation[];
      readonly frameEntry: number;
    }
  | {
      readonly locator: 'step';
      readonly current: StepDelegation | undefined;
      readonly frameEntry: number;
    };

export type RetryIssuanceResolution =
  | { readonly kind: 'rotatable' }
  | { readonly kind: 'already-replaced'; readonly delegation: StepDelegation }
  | { readonly kind: 'replacement-consumed'; readonly reason: RetryReplacementConsumedReason }
  | { readonly kind: 'identity-unmatched' }
  | { readonly kind: 'ambiguous' };

export function resolveRetryIssuance(capture: RetryIssuanceCapture): RetryIssuanceResolution;
```

**The ratified decision table** (copied verbatim from
`docs/superpowers/plans/2026-08-03-608-pr12-review-remediation-addendum.md`
§ "Retry idempotency contract"). Let `Hc = D.tokenHash`,
`Hs = D.credential.supersedesTokenHash`, `H = identity.tokenHash`,
`entryCurrent = D.credential.parentEntry === inferFrameEntryFromState(state, frameKey)`.

| Locator       | Captured attempt                    | Resolution                              | Outcome                 | Writes |
| ------------- | ----------------------------------- | --------------------------------------- | ----------------------- | ------ |
| token         | row or delegation absent            | `rotatable`                             | RD-801                  | no     |
| token         | `H === Hc`                          | `rotatable`                             | `retried`               | yes    |
| token         | `H === Hs`, unobserved, `entryCurrent` | `already-replaced`                   | `retry-already-applied` | no     |
| token         | `H === Hs`, `childRunId !== null`   | `replacement-consumed('claimed')`       | RD-826                  | no     |
| token         | `H === Hs`, `cancelledAt !== null`  | `replacement-consumed('cancelled')`     | RD-826                  | no     |
| token         | `H === Hs`, `!entryCurrent`         | `replacement-consumed('entry_superseded')` | RD-826               | no     |
| token         | matches neither                     | `identity-unmatched`                    | RD-827                  | no     |
| token         | multiple rows supersede `H`         | —                                       | RD-828                  | no     |
| token         | not located                         | —                                       | `token-not-found`       | no     |
| step / active | `Hs === undefined`                  | `rotatable`                             | `retried`               | yes    |
| step / active | `Hs` set, unobserved, `entryCurrent` | `already-replaced`                     | `retry-already-applied` | no     |
| step / active | `Hs` set, live linked child         | `rotatable`                             | RD-823                  | no     |
| step / active | `Hs` set, terminal linked child     | `rotatable`                             | `retried`               | yes    |
| step / active | `Hs` set, cancelled                 | `rotatable`                             | `retried`               | yes    |
| step / active | `Hs` set, `!entryCurrent`           | `rotatable`                             | `retried`               | yes    |

**Row 8 is this resolver's, not the seam's.** The seam scans the supersession
index unconditionally and hands the result in; it never inspects the length.
Deciding ambiguity in the locator would make it invisible whenever `findByToken`
also hits — precisely the "row 8 outranks row 2" case below — so the priority
lives here and only here.

Row 9 (`not located → token-not-found`) is the one genuine locator concern: it is
the fallthrough once both lookups miss, decided before any capture exists, so
there is nothing for a resolver to be handed. Rows 1 and 12 reach here as
`rotatable` because their outcomes come from machinery that already exists —
`inferRunbookFromStep` raises RD-801, and the child-liveness guard raises RD-823
*before* the resolver is called.

- [ ] **Step 1: Write one failing test per decision-table row**

Append to `packages/core/__tests__/runbook/delegation-inference.test.ts`:

```typescript
describe('resolveRetryIssuance', () => {
  const H = 'ha' as DelegationTokenHash;
  const HOTHER = 'hb' as DelegationTokenHash;
  const ENTRY = 3;

  const delegation = (over: Partial<StepDelegation> = {}, cred: Partial<StepDelegation['credential']> = {}): StepDelegation =>
    ({
      tokenHash: HOTHER,
      childRunId: null,
      cancelledAt: null,
      childRunbookPath: 'child.runbook.md',
      contextSnapshot: { step: '2', at: '2.1' },
      ...over,
      credential: { parentEntry: ENTRY, parentFrameKey: buildFrameKey('2'), ...cred },
    }) as StepDelegation;

  // --- token locator -------------------------------------------------------
  it('row 1 — token, row or delegation absent -> rotatable', () => {
    expect(
      resolveRetryIssuance({ locator: 'token', identityTokenHash: H, current: undefined, supersededBy: [], frameEntry: ENTRY }),
    ).toEqual({ kind: 'rotatable' });
  });

  it('row 2 — token, H === Hc -> rotatable', () => {
    expect(
      resolveRetryIssuance({ locator: 'token', identityTokenHash: H, current: delegation({ tokenHash: H }), supersededBy: [], frameEntry: ENTRY }),
    ).toEqual({ kind: 'rotatable' });
  });

  it('row 3 — token, H === Hs, unobserved, entryCurrent -> already-replaced', () => {
    const replacement = delegation({}, { supersedesTokenHash: H, parentEntry: ENTRY });
    expect(
      resolveRetryIssuance({ locator: 'token', identityTokenHash: H, current: replacement, supersededBy: [replacement], frameEntry: ENTRY }),
    ).toEqual({ kind: 'already-replaced', delegation: replacement });
  });

  it('row 4 — token, H === Hs, childRunId set -> replacement-consumed(claimed)', () => {
    const replacement = delegation({ childRunId: 'rd_child' as RunId }, { supersedesTokenHash: H });
    expect(
      resolveRetryIssuance({ locator: 'token', identityTokenHash: H, current: replacement, supersededBy: [replacement], frameEntry: ENTRY }),
    ).toEqual({ kind: 'replacement-consumed', reason: 'claimed' });
  });

  it('row 5 — token, H === Hs, cancelled -> replacement-consumed(cancelled)', () => {
    const replacement = delegation({ cancelledAt: '2026-08-04T00:00:00.000Z' }, { supersedesTokenHash: H });
    expect(
      resolveRetryIssuance({ locator: 'token', identityTokenHash: H, current: replacement, supersededBy: [replacement], frameEntry: ENTRY }),
    ).toEqual({ kind: 'replacement-consumed', reason: 'cancelled' });
  });

  it('row 6 — token, H === Hs, entry advanced -> replacement-consumed(entry_superseded)', () => {
    const replacement = delegation({}, { supersedesTokenHash: H, parentEntry: ENTRY - 1 });
    expect(
      resolveRetryIssuance({ locator: 'token', identityTokenHash: H, current: replacement, supersededBy: [replacement], frameEntry: ENTRY }),
    ).toEqual({ kind: 'replacement-consumed', reason: 'entry_superseded' });
  });

  it('row 6b — the fourth conjunct is exact equality, never >= or a tolerance', () => {
    for (const stamped of [ENTRY - 1, ENTRY + 1]) {
      const replacement = delegation({}, { supersedesTokenHash: H, parentEntry: stamped });
      expect(
        resolveRetryIssuance({ locator: 'token', identityTokenHash: H, current: replacement, supersededBy: [replacement], frameEntry: ENTRY }),
      ).toEqual({ kind: 'replacement-consumed', reason: 'entry_superseded' });
    }
  });

  it('row 7 — token, matches neither Hc nor Hs -> identity-unmatched', () => {
    expect(
      resolveRetryIssuance({ locator: 'token', identityTokenHash: H, current: delegation(), supersededBy: [], frameEntry: ENTRY }),
    ).toEqual({ kind: 'identity-unmatched' });
  });

  it('row 8 — token, more than one row supersedes H -> ambiguous', () => {
    const a = delegation({}, { supersedesTokenHash: H });
    const b = delegation({}, { supersedesTokenHash: H });
    expect(
      resolveRetryIssuance({ locator: 'token', identityTokenHash: H, current: a, supersededBy: [a, b], frameEntry: ENTRY }),
    ).toEqual({ kind: 'ambiguous' });
  });

  it('row 8 outranks row 2 — ambiguity refuses even when the current row matches', () => {
    const a = delegation({ tokenHash: H }, { supersedesTokenHash: H });
    const b = delegation({}, { supersedesTokenHash: H });
    expect(
      resolveRetryIssuance({ locator: 'token', identityTokenHash: H, current: a, supersededBy: [a, b], frameEntry: ENTRY }),
    ).toEqual({ kind: 'ambiguous' });
  });

  it('consumed reasons are checked claimed -> cancelled -> entry_superseded', () => {
    const all = delegation(
      { childRunId: 'rd_child' as RunId, cancelledAt: '2026-08-04T00:00:00.000Z' },
      { supersedesTokenHash: H, parentEntry: ENTRY - 1 },
    );
    expect(
      resolveRetryIssuance({ locator: 'token', identityTokenHash: H, current: all, supersededBy: [all], frameEntry: ENTRY }),
    ).toEqual({ kind: 'replacement-consumed', reason: 'claimed' });
  });

  // --- step / active locator ----------------------------------------------
  it('row 10 — step, Hs undefined -> rotatable', () => {
    expect(resolveRetryIssuance({ locator: 'step', current: delegation(), frameEntry: ENTRY })).toEqual({
      kind: 'rotatable',
    });
  });

  it('row 10b — step, no delegation at the cursor -> rotatable', () => {
    expect(resolveRetryIssuance({ locator: 'step', current: undefined, frameEntry: ENTRY })).toEqual({
      kind: 'rotatable',
    });
  });

  it('row 11 — step, Hs set, unobserved, entryCurrent -> already-replaced', () => {
    const replacement = delegation({}, { supersedesTokenHash: H });
    expect(resolveRetryIssuance({ locator: 'step', current: replacement, frameEntry: ENTRY })).toEqual({
      kind: 'already-replaced',
      delegation: replacement,
    });
  });

  it('rows 12/13 — step, Hs set, linked child -> rotatable', () => {
    const replacement = delegation({ childRunId: 'rd_child' as RunId }, { supersedesTokenHash: H });
    expect(resolveRetryIssuance({ locator: 'step', current: replacement, frameEntry: ENTRY })).toEqual({
      kind: 'rotatable',
    });
  });

  it('row 14 — step, Hs set, cancelled -> rotatable', () => {
    const replacement = delegation({ cancelledAt: '2026-08-04T00:00:00.000Z' }, { supersedesTokenHash: H });
    expect(resolveRetryIssuance({ locator: 'step', current: replacement, frameEntry: ENTRY })).toEqual({
      kind: 'rotatable',
    });
  });

  it('row 15 — step, Hs set, entry advanced -> rotatable', () => {
    const replacement = delegation({}, { supersedesTokenHash: H, parentEntry: ENTRY - 1 });
    expect(resolveRetryIssuance({ locator: 'step', current: replacement, frameEntry: ENTRY })).toEqual({
      kind: 'rotatable',
    });
  });

  it('never throws and performs no I/O', () => {
    expect(() =>
      resolveRetryIssuance({ locator: 'token', identityTokenHash: H, current: undefined, supersededBy: [], frameEntry: 1 }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run and verify failure**

```bash
pnpm --filter @rundown-org/core exec jest __tests__/runbook/delegation-inference.test.ts -t resolveRetryIssuance
```

Expected: FAIL — `resolveRetryIssuance is not a function`.

- [ ] **Step 3: Implement the resolver**

Append to `packages/core/src/runbook/delegation-inference.ts`:

```typescript
/**
 * Why a retry replacement is treated as consumed.
 *
 * Each value names committed evidence that the superseded bearer's replacement
 * was presented — never an inference about whether it was observed.
 */
export type RetryReplacementConsumedReason = 'claimed' | 'cancelled' | 'entry_superseded';

/**
 * Everything {@link resolveRetryIssuance} decides from, captured inside the
 * deciding transaction.
 *
 * Discriminated on `locator` so the token-only fields cannot be read on the
 * step/active path, and vice versa.
 */
export type RetryIssuanceCapture =
  | {
      /** The retry named a bearer token. */
      readonly locator: 'token';
      /** Hash of the bearer the caller named. */
      readonly identityTokenHash: DelegationTokenHash;
      /** The delegation currently recorded at the resolved `(substepId, frameKey)`. */
      readonly current: StepDelegation | undefined;
      /** Every captured row whose credential records `identityTokenHash` as superseded. */
      readonly supersededBy: readonly StepDelegation[];
      /** `inferFrameEntryFromState(capturedState, frameKey)` for the resolved frame. */
      readonly frameEntry: number;
    }
  | {
      /** The retry named a step, or inferred the active substep. */
      readonly locator: 'step';
      /** The delegation currently recorded at the resolved `(substepId, frameKey)`. */
      readonly current: StepDelegation | undefined;
      /** `inferFrameEntryFromState(capturedState, frameKey)` for the resolved frame. */
      readonly frameEntry: number;
    };

/**
 * Whether the named retry should rotate, echo, or refuse.
 *
 * - `rotatable` — mint a replacement (the caller's existing retry path).
 * - `already-replaced` — a replacement exists with no committed evidence it was
 *   used; echo it and write nothing.
 * - `replacement-consumed` — the replacement shows committed evidence of use.
 * - `identity-unmatched` — the named bearer identifies neither the current
 *   attempt nor one it superseded.
 * - `ambiguous` — more than one attempt records the bearer as superseded.
 */
export type RetryIssuanceResolution =
  | { readonly kind: 'rotatable' }
  | { readonly kind: 'already-replaced'; readonly delegation: StepDelegation }
  | { readonly kind: 'replacement-consumed'; readonly reason: RetryReplacementConsumedReason }
  | { readonly kind: 'identity-unmatched' }
  | { readonly kind: 'ambiguous' };

/**
 * `unobservedReplacement(state, frameKey, D)` — no committed evidence that the
 * bearer `D` replaced was ever presented.
 *
 * All four conjuncts are required. The fourth is not defensive: a delegation row
 * is keyed `(id, frameKey)` with no entry component and `resetReopenedSubsteps`
 * preserves `delegation` across frame re-entry, so without it a replay after a
 * GOTO would echo a bearer `classifyDelegationLiveness` has already closed as
 * `cursor-advanced` — an unclaimable token, strictly worse than rotating.
 *
 * @param delegation - The replacement row being judged.
 * @param frameEntry - The entry committed state reports for the row's frame.
 * @returns True when the replacement shows no committed evidence of use.
 */
function unobservedReplacement(delegation: StepDelegation, frameEntry: number): boolean {
  return (
    delegation.credential.supersedesTokenHash !== undefined &&
    delegation.childRunId === null &&
    delegation.cancelledAt === null &&
    delegation.credential.parentEntry === frameEntry
  );
}

/**
 * Decide whether a `delegate --retry` should rotate, echo a committed
 * replacement, or refuse.
 *
 * Implements the ratified 15-row decision table
 * (`docs/superpowers/plans/2026-08-03-608-pr12-review-remediation-addendum.md`
 * § "Retry idempotency contract"). Pure: no I/O, never throws. The caller
 * narrows on the returned variant rather than re-checking any predicate.
 *
 * Rows the caller owns and this resolver deliberately does not: "not located"
 * (`token-not-found`) is decided at the scan boundary before a capture exists,
 * and "live linked child" (RD-823) is refused by the child-liveness guard that
 * runs immediately before this call — both reach here, if at all, as
 * `rotatable`.
 *
 * Ambiguity, by contrast, is decided **here** and nowhere else. The caller
 * scans the supersession index unconditionally and passes the result in
 * `supersededBy` without inspecting its length, so a caller that also matched a
 * current row cannot mask it.
 *
 * @param capture - The locator-discriminated capture taken inside the transaction.
 * @returns The discriminated resolution.
 */
export function resolveRetryIssuance(capture: RetryIssuanceCapture): RetryIssuanceResolution {
  if (capture.locator === 'step') {
    const current = capture.current;
    if (current === undefined) return { kind: 'rotatable' };
    if (current.credential.supersedesTokenHash === undefined) return { kind: 'rotatable' };
    return unobservedReplacement(current, capture.frameEntry)
      ? { kind: 'already-replaced', delegation: current }
      : { kind: 'rotatable' };
  }

  // Ambiguity outranks every other token-locator row: with more than one
  // superseding attempt there is no single replacement to echo or judge, so the
  // contract refuses rather than picking one.
  if (capture.supersededBy.length > 1) return { kind: 'ambiguous' };

  const current = capture.current;
  if (current === undefined) return { kind: 'rotatable' };
  if (current.tokenHash === capture.identityTokenHash) return { kind: 'rotatable' };

  const replacement = capture.supersededBy[0];
  if (replacement === undefined) return { kind: 'identity-unmatched' };
  if (replacement.childRunId !== null) {
    return { kind: 'replacement-consumed', reason: 'claimed' };
  }
  if (replacement.cancelledAt !== null) {
    return { kind: 'replacement-consumed', reason: 'cancelled' };
  }
  if (replacement.credential.parentEntry !== capture.frameEntry) {
    return { kind: 'replacement-consumed', reason: 'entry_superseded' };
  }
  return { kind: 'already-replaced', delegation: replacement };
}
```

Add the `DelegationTokenHash` type import from `./delegation-token.js` if it is
not already present.

- [ ] **Step 4: Export from the barrel**

In `packages/core/src/runbook/index.ts`, extend the existing
`./delegation-inference.js` export list with `resolveRetryIssuance`, and its type
export list with `RetryIssuanceCapture`, `RetryIssuanceResolution`,
`RetryReplacementConsumedReason`.

- [ ] **Step 5: Run the tests and verify they pass**

```bash
pnpm --filter @rundown-org/core exec jest __tests__/runbook/delegation-inference.test.ts -t resolveRetryIssuance
```

- [ ] **Step 6: Mutation-test the added range**

Get the range from the diff, then:

```bash
git diff -U0 packages/core/src/runbook/delegation-inference.ts | grep -E '^@@'
pnpm --filter @rundown-org/core exec stryker run \
  --mutate 'src/runbook/delegation-inference.ts:<start>-<end>' \
  --testFiles '__tests__/runbook/delegation-inference.test.ts' \
  --force
```

Every conjunct of `unobservedReplacement` and every branch order must have a
killing test. A surviving `!==` → `===` mutant on the fourth conjunct is the
exact defect this contract exists to prevent — do not ship with it.

- [ ] **Step 7: Commit**

```bash
npx biome check --config-path=. --write packages/core/src/runbook/delegation-inference.ts \
  packages/core/src/runbook/index.ts packages/core/__tests__/runbook/delegation-inference.test.ts
git add packages/core/src/runbook/delegation-inference.ts packages/core/src/runbook/index.ts \
  packages/core/__tests__/runbook/delegation-inference.test.ts
git commit -m "feat(core): add resolveRetryIssuance, the retry idempotency resolver

Pure implementation of the ratified 15-row decision table over a four-conjunct
unobservedReplacement predicate. Returns a discriminated union so the caller
narrows on the variant rather than re-checking predicates. #681"
```

---

### Task B3: Register RD-826, RD-827 and RD-828

**Files:**

- Modify: `packages/core/src/errors/codes.ts:403-407` (replace the reservation
  comment)
- Modify: `packages/core/src/errors/factory.ts` (after `delegationInFlight`, `:137`)
- Test: `packages/core/__tests__/errors/codes.test.ts` (or the existing error
  registry test in that directory)

**Interfaces:**

- Produces: `Errors.delegationReplacementConsumed`,
  `Errors.delegationRetryIdentityUnmatched`,
  `Errors.delegationSupersessionAmbiguous`.

- [ ] **Step 1: Write the failing tests**

```typescript
describe('retry idempotency error codes', () => {
  it('registers RD-826/827/828 in the DELEGATION category', () => {
    expect(ERROR_CODES.DELEGATION_REPLACEMENT_CONSUMED.code).toBe('RD-826');
    expect(ERROR_CODES.DELEGATION_RETRY_IDENTITY_UNMATCHED.code).toBe('RD-827');
    expect(ERROR_CODES.DELEGATION_SUPERSESSION_AMBIGUOUS.code).toBe('RD-828');
    for (const key of [
      'DELEGATION_REPLACEMENT_CONSUMED',
      'DELEGATION_RETRY_IDENTITY_UNMATCHED',
      'DELEGATION_SUPERSESSION_AMBIGUOUS',
    ] as const) {
      expect(ERROR_CODES[key].category).toBe(ErrorCategory.DELEGATION);
    }
  });

  it('never carries a bearer token in a refusal envelope', () => {
    const error = Errors.delegationReplacementConsumed('2.1', 'claimed');
    expect(JSON.stringify(error.toJSON())).not.toContain('rdtk_');
  });

  it('names the consumption reason in the message', () => {
    expect(Errors.delegationReplacementConsumed('2.1', 'entry_superseded').message).toContain(
      'entry_superseded',
    );
  });
});
```

- [ ] **Step 2: Run and verify failure**

```bash
pnpm --filter @rundown-org/core exec jest __tests__/errors
```

- [ ] **Step 3: Register the codes**

Replace the reservation comment at `packages/core/src/errors/codes.ts:403-407`
with:

```typescript
  DELEGATION_REPLACEMENT_CONSUMED: {
    code: 'RD-826',
    category: ErrorCategory.DELEGATION,
    title: 'Delegation replacement consumed',
    description:
      'The named bearer was already replaced, and the replacement shows committed evidence of use — it was claimed, cancelled, or its frame entry advanced. Retrying it would mint a third bearer over work already in progress. Target the current delegation instead, or abort it and re-delegate.',
    docSlug: 'delegation-replacement-consumed',
  },
  DELEGATION_RETRY_IDENTITY_UNMATCHED: {
    code: 'RD-827',
    category: ErrorCategory.DELEGATION,
    title: 'Delegation retry identity unmatched',
    description:
      'The named bearer identifies neither the delegation currently recorded at the target nor one that it superseded. The retry is refused rather than re-minted against an identity the parent does not recognise.',
    docSlug: 'delegation-retry-identity-unmatched',
  },
  DELEGATION_SUPERSESSION_AMBIGUOUS: {
    code: 'RD-828',
    category: ErrorCategory.DELEGATION,
    title: 'Delegation supersession ambiguous',
    description:
      'More than one delegation attempt records this bearer as superseded, so there is no single replacement to echo or judge. Unreachable by construction; it is refused, never resolved. Prune invalid runbook state and restart execution.',
    docSlug: 'delegation-supersession-ambiguous',
  },
```

The `DELEGATION_FRONTIER_CONSUME_FAILED: { code: 'RD-829' … }` entry that
follows stays exactly where it is — RD-829 was assigned precisely so these three
numbers stayed free.

- [ ] **Step 4: Add the three factories**

In `packages/core/src/errors/factory.ts`, after `delegationInFlight` (`:137`):

```typescript
  delegationReplacementConsumed: (
    step: string,
    reason: 'claimed' | 'cancelled' | 'entry_superseded',
  ): RundownError =>
    new RundownError('DELEGATION_REPLACEMENT_CONSUMED', {
      step,
      message: `the replacement for this bearer shows committed evidence of use (${reason})`,
    }),

  delegationRetryIdentityUnmatched: (step: string): RundownError =>
    new RundownError('DELEGATION_RETRY_IDENTITY_UNMATCHED', {
      step,
      message: 'the named bearer matches neither the current delegation nor one it superseded',
    }),

  delegationSupersessionAmbiguous: (step: string): RundownError =>
    new RundownError('DELEGATION_SUPERSESSION_AMBIGUOUS', {
      step,
      message: 'more than one delegation attempt records this bearer as superseded',
    }),
```

No factory takes a raw token: nothing here can echo a bearer, so the redaction
class stays closed by construction.

- [ ] **Step 5: Run the tests and verify they pass, then commit**

```bash
pnpm --filter @rundown-org/core exec jest __tests__/errors
npx biome check --config-path=. --write packages/core/src/errors/codes.ts \
  packages/core/src/errors/factory.ts packages/core/__tests__/errors
git add packages/core/src/errors packages/core/__tests__/errors
git commit -m "feat(core): register RD-826/827/828 for retry idempotency

Replaces the reservation comment left by the PR 12 remediation addendum. None
of the three factories accepts a raw token, so no refusal envelope can carry a
bearer. #681"
```

---

### Task B4: Wire the resolver into `#issueRetry`

**Files:**

- Modify: `packages/core/src/runbook/lifecycle-command-service.ts` — the
  `DelegationIssuanceOutcome` union (`:288-356`), the token locator (`:1442-1471`),
  the seam dependency bag (`:152`, `:174`), `verifyEchoedDelegationToken`
  (`:418-442`), and `beforeEffect` (`:1660-1691`)
- Modify: `packages/cli/src/commands/delegate.ts:629-642`,
  `packages/cli/src/helpers/lifecycle-seam-factory.ts:57-67` — the two production
  construction sites of the seam's dependency bag
- Test: `packages/core/__tests__/runbook/lifecycle-command-service.test.ts`
- Test (dependency-bag updates only):
  `packages/core/__tests__/runbook/claim-seen.test.ts`,
  `packages/core/__tests__/runbook/guarded-drain-composition.test.ts`,
  `packages/core/__tests__/runbook/entry-projection-ordering.test.ts`

**Interfaces:**

- Consumes: `resolveRetryIssuance` (B2), `findBySupersededToken` (B1),
  `Errors.delegation*` (B3), `inferFrameEntryFromState`, `hashDelegationToken`,
  `createDelegationTokenDeriver`.
- Produces:
  - New `DelegationIssuanceOutcome` member:

    ```typescript
    | {
        /**
         * The retry was already applied: a replacement exists with no committed
         * evidence its bearer was used. The response echoes that bearer so the
         * caller can rotate deliberately by naming it. Nothing was written.
         */
        readonly kind: 'retry-already-applied';
        readonly stepLabel: string;
        readonly runbookPath: string;
        readonly token: string;
        readonly tokenHash: string;
        readonly parentRunId: RunId;
      }
    ```

  - New **required** seam dependency, mirroring the existing
    `FindDelegationByToken` type (`lifecycle-command-service.ts:174`) and its
    required field (`:152`):

    ```typescript
    export type FindDelegationsBySupersededToken = (
      token: string,
    ) => Promise<readonly TokenScanResult[]>;
    ```

    Required, never optional. An optional dependency consumed as
    `(await deps.findDelegationsBySupersededToken?.(t)) ?? []` fails **open**:
    any construction site that omits it silently reverts every replayed retry to
    `token-not-found` — the exact behaviour #681 exists to add — and the failure
    is invisible because the fallback is a legal empty result. Making it
    required turns each omission into a compile error, per "invalid states are
    unrepresentable".

  - Extracted helper
    `verifyDerivedBearer(credential, tokenHash, subject, deriveToken): EchoedDelegationToken`,
    with `verifyEchoedDelegationToken` re-expressed in terms of it.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/__tests__/runbook/lifecycle-command-service.test.ts`.
`seam`, `manager`, `runId` and `evidence()` are the file's existing fixtures
(`:207`, `startSeamOnDelegateStep` at `:321`). The seed helpers this block needs
are new; build them on `startSeamOnDelegateStep` and give them these contracts:

| Helper                                        | Seeds                                                                                                       | Returns                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `seedDelegation()`                            | An active run parked on delegating step `2`, substep `2.1` carrying one freshly issued, unclaimed delegation | `void`                         |
| `currentToken()`                              | Nothing — reads the bearer currently recorded at `2.1` from committed state                                 | `Promise<string>`              |
| `seedRotatedAndClaimed()`                     | `seedDelegation()`, one retry to T2, then a committed claim linking a child run to T2                       | `{ t1: string; t2: string }`   |
| `seedRotatedThenReplacedByUnrelatedDelegation()` | `seedDelegation()`, one retry to T2, then overwrite `2.1`'s row with a delegation whose `tokenHash` and `supersedesTokenHash` both name neither T1 nor T2 | `{ t1: string }` |
| `seedTwoRowsSuperseding()`                    | `seedDelegation()`, one retry to T2, then write a **second** substep row in the same frame whose credential also records `hash(T1)` as `supersedesTokenHash`. T1 is no longer any row's `tokenHash`, so `findDelegationByToken(T1)` misses | `{ t1: string }` |
| `seedTwoRowsSupersedingWithLiveCurrent()`     | As above, but leaves T1 as the `tokenHash` of a third row so `findDelegationByToken(T1)` **hits** — the corrupted state that is only reachable because the supersession scan is unconditional | `{ t1: string }` |
| `gotoBackIntoTheDelegatingFrame()`            | Drives `seam.runNavigationMutation` to `{ step: '2', substep: '1' }`, bumping the frame entry               | `void`                         |
| `retryUnderRotatedClaim()`                    | `seedDelegation()`, one retry, then rotates the run-control claim and replays the retry under the new one   | the `DelegationIssuanceOutcome` |

```typescript
describe('#issueRetry idempotency', () => {
  it('echoes the surviving replacement instead of rotating a second time', async () => {
    await seedDelegation();
    const first = await seam.issueDelegation({ mode: 'retry', callerEvidence: evidence(), locator: { kind: 'step', step: '2.1' } });
    expect(first.kind).toBe('retried');
    const afterFirst = await manager.load(runId);

    const second = await seam.issueDelegation({ mode: 'retry', callerEvidence: evidence(), locator: { kind: 'step', step: '2.1' } });
    expect(second).toMatchObject({ kind: 'retry-already-applied', token: (first as { token: string }).token });

    // The echo writes nothing.
    expect(await manager.load(runId)).toEqual(afterFirst);
  });

  it('runs before resolveOverrides so a bad --input-file cannot mask it', async () => {
    await seedDelegation();
    await seam.issueDelegation({ mode: 'retry', callerEvidence: evidence(), locator: { kind: 'step', step: '2.1' } });
    const resolveOverrides = jest.fn(async () => { throw new Error('bad --input-file'); });

    const outcome = await seam.issueDelegation({
      mode: 'retry', callerEvidence: evidence(), locator: { kind: 'step', step: '2.1' }, resolveOverrides,
    });
    expect(outcome.kind).toBe('retry-already-applied');
    expect(resolveOverrides).not.toHaveBeenCalled();
  });

  it('rotates again when the caller names the current bearer', async () => {
    await seedDelegation();
    const first = await seam.issueDelegation({ mode: 'retry', callerEvidence: evidence(), locator: { kind: 'step', step: '2.1' } });
    const second = await seam.issueDelegation({
      mode: 'retry', callerEvidence: evidence(), locator: { kind: 'token', token: (first as { token: string }).token },
    });
    expect(second.kind).toBe('retried');
  });

  it('refuses RD-826 when the replacement was claimed', async () => {
    const { t1 } = await seedRotatedAndClaimed();
    const outcome = await seam.issueDelegation({ mode: 'retry', callerEvidence: evidence(), locator: { kind: 'token', token: t1 } });
    expect(outcome).toMatchObject({ kind: 'error' });
    expect((outcome as { error: RundownError }).error.code).toBe('DELEGATION_REPLACEMENT_CONSUMED');
  });

  it('refuses RD-827 when the bearer matches neither attempt', async () => {
    // T1 is located by the scan, but by the time the transaction captures state
    // the cursor's row carries an unrelated delegation: neither its tokenHash
    // nor its supersedesTokenHash names T1.
    const { t1 } = await seedRotatedThenReplacedByUnrelatedDelegation();
    const beforeState = await manager.load(runId);

    const outcome = await seam.issueDelegation({ mode: 'retry', callerEvidence: evidence(), locator: { kind: 'token', token: t1 } });
    expect((outcome as { error: RundownError }).error.code).toBe(
      'DELEGATION_RETRY_IDENTITY_UNMATCHED',
    );
    // A refusal writes nothing.
    expect(await manager.load(runId)).toEqual(beforeState);
  });

  it('refuses RD-828 when two rows supersede the bearer', async () => {
    // Unreachable through normal issuance; seed it directly by writing two
    // substep rows whose credentials both record T1 as superseded.
    const { t1 } = await seedTwoRowsSuperseding();
    const outcome = await seam.issueDelegation({ mode: 'retry', callerEvidence: evidence(), locator: { kind: 'token', token: t1 } });
    expect((outcome as { error: RundownError }).error.code).toBe(
      'DELEGATION_SUPERSESSION_AMBIGUOUS',
    );
    expect(JSON.stringify(outcome)).not.toContain('rdtk_');
  });

  it('refuses RD-828 even when findByToken also matches the named bearer', async () => {
    // The reachability pin for the unconditional scan. T1 is still a current
    // tokenHash, so `findDelegationByToken` HITS. If the supersession scan were
    // a fallback that ran only on a miss, the two superseding rows would be
    // invisible and this would resolve `rotatable` — the resolver's stated
    // "row 8 outranks row 2" priority would never actually run.
    const { t1 } = await seedTwoRowsSupersedingWithLiveCurrent();
    const outcome = await seam.issueDelegation({ mode: 'retry', callerEvidence: evidence(), locator: { kind: 'token', token: t1 } });
    expect((outcome as { error: RundownError }).error.code).toBe(
      'DELEGATION_SUPERSESSION_AMBIGUOUS',
    );
  });

  it('rotates rather than echoing after a GOTO advanced the frame entry', async () => {
    // The fourth conjunct at work: the replacement survives the re-entry, but
    // its parentEntry no longer names the frame's current entry, so echoing it
    // would hand back a bearer classifyDelegationLiveness has already closed.
    await seedDelegation();
    await seam.issueDelegation({ mode: 'retry', callerEvidence: evidence(), locator: { kind: 'step', step: '2.1' } });
    await gotoBackIntoTheDelegatingFrame();
    const outcome = await seam.issueDelegation({ mode: 'retry', callerEvidence: evidence(), locator: { kind: 'step', step: '2.1' } });
    expect(outcome.kind).toBe('retried');
  });

  it('locates a run by a superseded token so the replay can be judged', async () => {
    await seedDelegation();
    const t1 = await currentToken();
    await seam.issueDelegation({ mode: 'retry', callerEvidence: evidence(), locator: { kind: 'step', step: '2.1' } });
    // findByToken misses T1 now; findBySupersededToken must find its replacement.
    const outcome = await seam.issueDelegation({ mode: 'retry', callerEvidence: evidence(), locator: { kind: 'token', token: t1 } });
    expect(outcome.kind).toBe('retry-already-applied');
  });

  it('refuses an echo it cannot verify rather than disclosing an unverified bearer', async () => {
    // A rotated issuing claim cannot reconstruct the credential: RD-821, no token.
    const outcome = await retryUnderRotatedClaim();
    expect((outcome as { error: RundownError }).error.code).toBe('DELEGATION_INVARIANT_VIOLATED');
    expect(JSON.stringify(outcome)).not.toContain('rdtk_');
  });
});
```

- [ ] **Step 2: Run and verify failure**

```bash
pnpm --filter @rundown-org/core exec jest __tests__/runbook/lifecycle-command-service.test.ts -t 'issueRetry idempotency'
```

- [ ] **Step 3: Add the outcome member**

Insert into `DelegationIssuanceOutcome` immediately after the `retried` member
(`:311`), using the shape in this task's Interfaces block.

- [ ] **Step 4: Extract `verifyDerivedBearer`**

Replace `verifyEchoedDelegationToken` (`:418-442`) with a general helper plus a
thin wrapper, so the retry echo is gated on exactly the same invariant the fresh
echo is:

```typescript
/**
 * Reconstruct and verify a bearer before any seam discloses it.
 *
 * An echo is a credential disclosure, so it is gated on the invariant
 * `projectDelegateFrontier` enforces at the observation boundary: the token
 * reconstructed from the persisted descriptor MUST hash to the verifier the
 * parent recorded at issuance. Derivation itself can fail — a rotated issuing
 * claim cannot reproduce its predecessor's credential — and that throw must not
 * escape a seam whose contract is typed data, so it collapses into the same
 * refusal. Neither arm carries the reconstructed token.
 *
 * @param credential - The persisted, non-secret credential descriptor.
 * @param tokenHash - The verifier recorded alongside it.
 * @param subject - Step or substep label used in the refusal message.
 * @param deriveToken - Verified runtime deriver bound to the presenting claim.
 * @returns The verified bearer, or the typed refusal to return in its place.
 */
function verifyDerivedBearer(
  credential: DelegationCredentialDescriptor,
  tokenHash: DelegationTokenHash,
  subject: string,
  deriveToken: DelegationTokenDeriver,
): EchoedDelegationToken {
  let token: string;
  try {
    token = deriveToken(credential);
  } catch {
    return {
      kind: 'unverifiable',
      error: Errors.delegationInvariantViolated(
        `the presented claim cannot reconstruct the in-flight delegation credential for ${subject}`,
      ),
    };
  }
  if (hashDelegationToken(token) !== tokenHash) {
    return {
      kind: 'unverifiable',
      error: Errors.delegationInvariantViolated(
        `reconstructed delegation credential for ${subject} does not match its persisted verifier`,
      ),
    };
  }
  return { kind: 'verified', token };
}

/**
 * Verify the bearer an already-issued fresh delegation would echo.
 *
 * @param echo - The `already-issued` resolution the seam matched.
 * @param deriveToken - Verified runtime deriver bound to the presenting claim.
 * @returns The verified bearer, or the typed refusal to return in its place.
 */
function verifyEchoedDelegationToken(
  echo: Extract<DelegationIssuanceResolution, { readonly kind: 'already-issued' }>,
  deriveToken: DelegationTokenDeriver,
): EchoedDelegationToken {
  return verifyDerivedBearer(echo.credential, echo.tokenHash, echo.stepId, deriveToken);
}
```

- [ ] **Step 5: Add the unconditional superseded-token scan to the token locator**

In `#issueRetry`'s token branch (`:1442-1471`), after
`const scan = await this.#deps.findDelegationByToken(locator.token);` and before
the `if (!scan)` early return:

```typescript
      // `findByToken` matches `tokenHash` only, so a replayed retry naming a
      // bearer that has since been rotated away resolves to nothing there.
      //
      // The supersession index is scanned UNCONDITIONALLY — not as a fallback
      // when `findByToken` misses. Skipping it on a hit would make "more than
      // one attempt records this bearer as superseded" invisible in exactly the
      // case where a current row also matches, which is the corrupted state the
      // refusal exists for. Scanning always is the fail-closed choice, and it is
      // what lets `resolveRetryIssuance` remain the single place the priority
      // between ambiguity and a matching current row is expressed. This seam
      // decides nothing from the result but *where* the target run is.
      const supersedingScan = await this.#deps.findDelegationsBySupersededToken(locator.token);
      const located = scan ?? supersedingScan[0];
      if (!located) return { kind: 'token-not-found', token: locator.token };
```

Then replace every subsequent use of `scan` in that branch with `located`, and
carry `supersedingScan` into `beforeEffect` (declare it in `#issueRetry`'s outer
scope alongside `cursor`, defaulting to `[]` on the non-token locators).
`identityTokenHash` for the capture is `hashDelegationToken(locator.token)`;
compute it once here and close over it.

There is deliberately **no** RD-828 return here. Row 9 (`not located →
token-not-found`) is a locator concern and stays — it is decided before any
capture exists — but row 8 is a resolver row and is emitted in Step 6.

- [ ] **Step 6: Call the resolver from `beforeEffect`**

In `beforeEffect`, insert between the child-liveness guard (which ends at
`:1690`) and `const overrides = await input.resolveOverrides?.();` (`:1691`):

```typescript
        // Retry idempotency (#681). Placed exactly here on purpose: after the
        // linked-child guards, whose refusals outrank a committed-result echo,
        // and BEFORE `resolveOverrides`, which is deliberately deferred so a bad
        // `--input-file` cannot mask a higher-priority precondition. This mirrors
        // the fresh path, where `resolveDelegationIssuance` decides
        // echo-versus-issue in `beforeEffect` and the machine runs only on the
        // issuable branch.
        // `supersededBy` is derived primarily from the CAPTURED parent state:
        // the disk scan ran before this transaction took its capture, so only
        // the captured rows carry in-transaction authority. The scan's
        // contribution is the rows it found in *other* runs, which the captured
        // parent cannot contain and which are the only way cross-run ambiguity
        // becomes visible. Union, deduped by `tokenHash`.
        const capturedSuperseding = (parent.state.substepStates ?? [])
          .map((row) => row.delegation)
          .filter(
            (row): row is StepDelegation =>
              row?.credential.supersedesTokenHash === identityTokenHash,
          );
        const foreignSuperseding = supersedingScan
          .filter((row) => row.parentState.id !== parent.state.id)
          .map((row) => row.delegation)
          .filter((row) => row.credential.supersedesTokenHash === identityTokenHash);
        const supersededBy = [
          ...new Map(
            [...capturedSuperseding, ...foreignSuperseding].map((row) => [row.tokenHash, row]),
          ).values(),
        ];

        const retryResolution = resolveRetryIssuance(
          locator.kind === 'token'
            ? {
                locator: 'token',
                identityTokenHash,
                current: exactSubstep?.delegation,
                supersededBy,
                frameEntry: inferFrameEntryFromState(parent.state, exactCursor.frameKey),
              }
            : {
                locator: 'step',
                current: exactSubstep?.delegation,
                frameEntry: inferFrameEntryFromState(parent.state, exactCursor.frameKey),
              },
        );
        switch (retryResolution.kind) {
          case 'ambiguous':
            return {
              kind: 'return',
              value: {
                kind: 'error',
                error: Errors.delegationSupersessionAmbiguous(exactCursor.substepId),
              },
            };
          case 'identity-unmatched':
            return {
              kind: 'return',
              value: {
                kind: 'error',
                error: Errors.delegationRetryIdentityUnmatched(exactCursor.substepId),
              },
            };
          case 'replacement-consumed':
            return {
              kind: 'return',
              value: {
                kind: 'error',
                error: Errors.delegationReplacementConsumed(
                  exactCursor.substepId,
                  retryResolution.reason,
                ),
              },
            };
          case 'already-replaced': {
            const echoed = verifyDerivedBearer(
              retryResolution.delegation.credential,
              retryResolution.delegation.tokenHash,
              exactCursor.substepId,
              deriveToken,
            );
            if (echoed.kind === 'unverifiable') {
              return { kind: 'return', value: { kind: 'error', error: echoed.error } };
            }
            return {
              kind: 'return',
              value: {
                kind: 'retry-already-applied',
                stepLabel: exactCursor.stepLabel,
                runbookPath: retryResolution.delegation.childRunbookPath,
                token: echoed.token,
                tokenHash: retryResolution.delegation.tokenHash,
                parentRunId: parent.state.id,
              },
            };
          }
          case 'rotatable':
            break;
          default: {
            const _exhaustive: never = retryResolution;
            throw new Error(`Unhandled retry resolution: ${JSON.stringify(_exhaustive)}`);
          }
        }
```

`identityTokenHash` is `undefined` on the step/active path; declare it as
`const identityTokenHash = locator.kind === 'token' ? hashDelegationToken(locator.token) : undefined;`
next to `cursor` at the top of `#issueRetry` and narrow with the `locator.kind`
check above.

- [ ] **Step 7: Declare the required dependency**

In `packages/core/src/runbook/lifecycle-command-service.ts`, add the field
immediately after `findDelegationByToken` (`:152`) — **not** optional:

```typescript
  /**
   * Locate every delegation across runs that records a plain-text token as
   * superseded.
   *
   * CLI-bound; wraps `DelegationScanService.findBySupersededToken`. Required,
   * like its `findDelegationByToken` sibling: the retry `token` locator scans
   * this index unconditionally, and an omitted dependency would silently return
   * every replayed retry to `token-not-found` rather than failing loudly.
   */
  readonly findDelegationsBySupersededToken: FindDelegationsBySupersededToken;
```

and the type beside `FindDelegationByToken` (`:174`):

```typescript
/**
 * Where the seam obtains every delegation superseding a given plain-text token.
 *
 * @param token - Plain-text delegation bearer that may have been superseded.
 * @returns Every matching scan result; empty when none match.
 */
export type FindDelegationsBySupersededToken = (
  token: string,
) => Promise<readonly TokenScanResult[]>;
```

- [ ] **Step 8: Supply it at every construction site**

Making the field required turns each omission into a compile error, so `tsc`
finds them — but fix them from this list rather than discovering them one at a
time. Eight literal dependency objects need the new field. Two sites that spread
`...deps` (`lifecycle-command-service.test.ts:1837` and `:2161`) inherit it and
need **no** edit.

Production:

| Site                                                | Wiring                                                                    |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| `packages/cli/src/commands/delegate.ts:629` (`buildDelegateSeam`, field at `:641`) | real scan over the same `manager`                       |
| `packages/cli/src/helpers/lifecycle-seam-factory.ts:57` (field at `:66`)           | real scan over the same `manager`                       |

Both take the same shape as their `findDelegationByToken` neighbour:

```typescript
    findDelegationsBySupersededToken: (token) =>
      new DelegationScanService(manager).findBySupersededToken(token),
```

Tests:

| Site                                                                       | Wiring                    |
| --------------------------------------------------------------------------- | --------------------------- |
| `packages/core/__tests__/runbook/claim-seen.test.ts:304` (field at `:313`)  | `async () => []`          |
| `packages/core/__tests__/runbook/claim-seen.test.ts:417` (field at `:426`)  | `async () => []`          |
| `packages/core/__tests__/runbook/guarded-drain-composition.test.ts:99` (field at `:108`) | `async () => []` |
| `packages/core/__tests__/runbook/lifecycle-command-service.test.ts:207` (field at `:221`) | `async () => []` |
| `packages/core/__tests__/runbook/lifecycle-command-service.test.ts:318` (the `deps` literal returned at `:321`) | real scan over `manager` |
| `packages/core/__tests__/runbook/entry-projection-ordering.test.ts:153` (field at `:165`; the file Task A8 renamed) | real scan over `manager` |

The three `async () => []` stubs are the seams whose suites never call
`issueDelegation`, matching their existing `findDelegationByToken: async () => undefined`
stub. The two real-scan sites drive genuine retry flows and must see the index.

Verify none were missed:

```bash
pnpm --filter @rundown-org/core exec tsc --noEmit && pnpm --filter @rundown-org/cli exec tsc --noEmit
rg -n 'findDelegationByToken:' packages | wc -l
rg -n 'findDelegationsBySupersededToken:' packages | wc -l
```

The two counts must match (`findDelegationByToken:` also appears at the two
spread-override sites, which override only that one field — so expect the
superseded count to be two lower, and confirm the difference is exactly those
two lines and nothing else).

- [ ] **Step 9: Run the tests and verify they pass**

```bash
pnpm --filter @rundown-org/core exec jest __tests__/runbook/lifecycle-command-service.test.ts
```

- [ ] **Step 10: Commit**

```bash
npx biome check --config-path=. --write packages/core/src/runbook/lifecycle-command-service.ts \
  packages/cli/src/commands/delegate.ts packages/cli/src/helpers/lifecycle-seam-factory.ts \
  packages/core/__tests__/runbook
git add packages/core/src packages/cli/src packages/core/__tests__
git commit -m "feat(core): apply the retry idempotency contract in #issueRetry

resolveRetryIssuance runs in beforeEffect after the linked-child guards and
before resolveOverrides. Adds the retry-already-applied outcome carrying the
re-derived current bearer (verified against its persisted hash before
disclosure) and refuses RD-826/827/828. A replayed retry naming a rotated-away
bearer now resolves through the supersession index instead of dying as
token-not-found.

The supersession scan is unconditional and its result is handed to the resolver
untouched, so ambiguity stays decidable in the one place the priority is
expressed. Its dependency is required, not optional: an omitted one would fail
open, returning every replayed retry to token-not-found. #681"
```

---

### Task B5: Render the new outcome and refusals

**Files:**

- Modify: `packages/cli/src/commands/delegate.ts:299-409` (retry switch),
  `:535-540` (fresh switch's unreachable arm)
- Modify: `packages/core/src/output/zod-schemas.ts:1433-1475`
  (`DelegateResponseSchema`)
- Test: `packages/cli/__tests__/commands/delegate.test.ts`
- Test: `packages/cli/__tests__/commands/delegate-refusals.test.ts`

**Interfaces:**

- Consumes: the `retry-already-applied` outcome (B4).
- Produces: JSON action `retry-already-applied` on the `delegate` response, with
  the same field set as `retried`.

- [ ] **Step 1: Write the failing tests (JSON first)**

In `packages/cli/__tests__/commands/delegate.test.ts`. This suite's real harness
is `createTestWorkspace` + `runCliInProcess(args, workspace)` (returning
`{ stdout, stderr, exitCode }`), `issueRunControlClaim(workspace, runId)`,
`parseCliJsonObject` and `extractToken`, all from `../helpers/test-utils.js`.
The blocks below use two local wrappers over them — define them in the describe
block rather than adding suite-wide helpers:

| Wrapper           | Contract                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `runDelegate(args)` | `runCliInProcess(['delegate', ...args], workspace)` — returns `{ stdout, stderr, exitCode }` unchanged           |
| `claimId`           | The run-control claim id from `issueRunControlClaim(workspace, runId)` during this describe's `beforeEach`      |

The fixture must be parked on a delegating step whose substep `2.1` names
`child.runbook.md` and carries a delegation issued in the same setup.

```typescript
it('emits action retry-already-applied with the current bearer (JSON default)', async () => {
  await runDelegate(['--retry', '--step', '2.1', '--claim-id', claimId]);
  const { stdout } = await runDelegate(['--retry', '--step', '2.1', '--claim-id', claimId]);
  expect(JSON.parse(stdout)).toEqual({
    kind: 'delegate',
    action: 'retry-already-applied',
    step: '2.1',
    runbook: 'child.runbook.md',
    token: expect.stringMatching(/^rdtk_/),
    token_hash: expect.any(String),
    parent_run_id: expect.stringMatching(/^rd_/),
  });
  expect(process.exitCode ?? 0).toBe(0);
});

it('validates against DelegateResponseSchema', async () => {
  await runDelegate(['--retry', '--step', '2.1', '--claim-id', claimId]);
  const { stdout } = await runDelegate(['--retry', '--step', '2.1', '--claim-id', claimId]);
  expect(() => DelegateResponseSchema.parse(JSON.parse(stdout))).not.toThrow();
});

it('renders the echo for humans with --text', async () => {
  await runDelegate(['--retry', '--step', '2.1', '--claim-id', claimId]);
  const { stdout } = await runDelegate(['--retry', '--step', '2.1', '--claim-id', claimId, '--text']);
  expect(stdout).toContain('ALREADY    step 2.1 -> child.runbook.md');
  expect(stdout).toContain('RD_CLAIM_TOKEN=');
});
```

In `packages/cli/__tests__/commands/delegate-refusals.test.ts`, one case per new
code asserting the JSON error envelope carries `code: 'RD-826' | 'RD-827' | 'RD-828'`,
exit code 1, and **no** `rdtk_` substring anywhere in stdout or stderr.

- [ ] **Step 2: Run and verify failure**

```bash
pnpm --filter @rundown-org/cli exec jest __tests__/commands/delegate.test.ts __tests__/commands/delegate-refusals.test.ts
```

- [ ] **Step 3: Add the schema arm**

In `packages/core/src/output/zod-schemas.ts`, add to the discriminated union
after the `retried` arm, and extend the schema's TSDoc list:

```typescript
    z
      .object({
        action: z.literal('retry-already-applied').describe('Action type'),
        ...DelegateResponseBase,
        /** Hash of the bearer being echoed */
        token_hash: z.string().describe('Token hash'),
      })
      .describe('Retry already applied; the current bearer is echoed and nothing was written'),
```

- [ ] **Step 4: Render it in the CLI**

In `packages/cli/src/commands/delegate.ts`, add to the retry switch immediately
after `case 'retried':`'s `break;`:

```typescript
              case 'retry-already-applied':
                // Idempotent replay: the replacement already exists and shows no
                // committed evidence of use, so nothing was written. The current
                // bearer is echoed so a caller who genuinely wants a new one can
                // rotate deliberately by naming it.
                if (!options.text) {
                  output.json({
                    kind: 'delegate',
                    action: 'retry-already-applied',
                    step: outcome.stepLabel,
                    runbook: outcome.runbookPath,
                    token: outcome.token,
                    token_hash: outcome.tokenHash,
                    parent_run_id: outcome.parentRunId,
                  });
                } else {
                  output.message(`ALREADY    step ${outcome.stepLabel} -> ${outcome.runbookPath}`);
                  output.message(`Token:     ${outcome.token}`);
                  output.message('');
                  output.message(`RD_CLAIM_TOKEN=${outcome.token}`);
                }
                break;
```

And add `'retry-already-applied'` to the fresh switch's unreachable arm list
(`:535-540`) so the exhaustiveness check stays honest:

```typescript
            case 'retried':
            case 'retry-already-applied':
            case 'token-not-found':
```

The three new error codes need no new arm: they arrive as
`{ kind: 'error', error: RundownError }` and are thrown into the existing
`withErrorHandling` envelope, exactly like RD-823 today.

- [ ] **Step 5: Run the tests and verify they pass, then commit**

```bash
pnpm --filter @rundown-org/cli exec jest __tests__/commands/delegate.test.ts __tests__/commands/delegate-refusals.test.ts
npx biome check --config-path=. --write packages/cli/src/commands/delegate.ts \
  packages/core/src/output/zod-schemas.ts packages/cli/__tests__/commands
git add packages/cli/src packages/core/src/output/zod-schemas.ts packages/cli/__tests__/commands
git commit -m "feat(cli): render the retry-already-applied delegate outcome

New JSON action with the same field set as retried, plus its --text rendering
and a DelegateResponseSchema arm. RD-826/827/828 travel through the existing
error envelope. #681"
```

---

### Task B6: Cover #681's edge cases

**Files:**

- Create: `packages/cli/__tests__/integration/retry-idempotency.test.ts`

**Interfaces:** none — coverage only. Consumes everything from B1–B5.

One test per bullet on #681's acceptance list. All exercise the JSON default
path.

- [ ] **Step 1: Write the six edge-case tests**

```typescript
describe('retry idempotency edge cases', () => {
  it('frame re-entry with a surviving replacement rotates rather than echoing', async () => {
    // T1 -> retry -> T2 (unclaimed, uncancelled). GOTO back into the delegating
    // frame bumps the entry, so T2's parentEntry no longer names it: echoing
    // would hand back a bearer the claim path has already closed as
    // cursor-advanced. Must rotate.
    const t1 = await delegateJson(['--step', '2.1', '--claim-id', claimId]);
    const t2 = await delegateJson(['--retry', '--step', '2.1', '--claim-id', claimId]);
    await run(['goto', '2.1', '--claim-id', claimId]);

    const replayed = await delegateJson(['--retry', '--step', '2.1', '--claim-id', claimId]);
    expect(replayed.action).toBe('retried');
    expect(replayed.token).not.toBe(t2.token);
    expect(replayed.token).not.toBe(t1.token);
  });

  it('retry-of-a-retry chains rotate once per named bearer', async () => {
    const t1 = await delegateJson(['--step', '2.1', '--claim-id', claimId]);
    const t2 = await delegateJson(['--retry', '--step', '2.1', '--claim-id', claimId]);
    const echo2 = await delegateJson(['--retry', '--step', '2.1', '--claim-id', claimId]);
    expect(echo2).toMatchObject({ action: 'retry-already-applied', token: t2.token });

    const t3 = await delegateJson(['--retry', t2.token, '--claim-id', claimId]);
    expect(t3.action).toBe('retried');
    expect(new Set([t1.token, t2.token, t3.token]).size).toBe(3);

    const echo3 = await delegateJson(['--retry', '--step', '2.1', '--claim-id', claimId]);
    expect(echo3).toMatchObject({ action: 'retry-already-applied', token: t3.token });
  });

  it('a foreign claim replaying the retry is refused without disclosing a bearer', async () => {
    // The echo is same-issuer only: a different --claim-id cannot reconstruct
    // the credential, so the seam returns RD-821 and no token.
    await delegateJson(['--step', '2.1', '--claim-id', claimId]);
    await delegateJson(['--retry', '--step', '2.1', '--claim-id', claimId]);

    const { stdout, stderr, exitCode } = await run([
      'delegate', '--retry', '--step', '2.1', '--claim-id', foreignClaimId,
    ]);
    expect(exitCode).toBe(1);
    expect(`${stdout}${stderr}`).toContain('RD-821');
    expect(`${stdout}${stderr}`).not.toContain('rdtk_');
  });

  it('a rotated issuing claim dead-ends the echo with RD-821, not a partial token', async () => {
    // Q1 in the addendum, recorded as a non-goal: pin the refusal so the
    // dead-end is observable rather than silent.
    await delegateJson(['--step', '2.1', '--claim-id', claimId]);
    await delegateJson(['--retry', '--step', '2.1', '--claim-id', claimId]);
    const rotated = await rotateRunControlClaim();

    const { stdout, stderr, exitCode } = await run([
      'delegate', '--retry', '--step', '2.1', '--claim-id', rotated,
    ]);
    expect(exitCode).toBe(1);
    expect(`${stdout}${stderr}`).toContain('RD-821');
    expect(`${stdout}${stderr}`).not.toContain('rdtk_');
  });

  it('--run with a superseded token still refuses run_target_mismatch on the wrong run', async () => {
    // The supersession fallback must not weaken the fail-closed --run check.
    const t1 = await delegateJson(['--step', '2.1', '--claim-id', claimId]);
    await delegateJson(['--retry', '--step', '2.1', '--claim-id', claimId]);

    const { stdout, exitCode } = await run(['delegate', '--retry', t1.token, '--run', otherRunId]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout).code).toBe('RUN_TARGET_MISMATCH');
    expect(stdout).not.toContain(parentRunId); // never echoes the token's real owner
  });

  it('a replacement claimed by a terminal child rotates; one claimed by a live child refuses', async () => {
    // Terminal: RD-826 on the token locator (committed evidence of use), and
    // `retried` on the step locator via the terminal-child path. Live: RD-823
    // from the existing child-liveness guard, which runs before the resolver.
    const t1 = await delegateJson(['--step', '2.1', '--claim-id', claimId]);
    const t2 = await delegateJson(['--retry', '--step', '2.1', '--claim-id', claimId]);
    const childClaim = await claim(t2.token);

    const live = await run(['delegate', '--retry', '--step', '2.1', '--claim-id', claimId]);
    expect(live.exitCode).toBe(1);
    expect(`${live.stdout}${live.stderr}`).toContain('RD-823');

    await run(['complete', '--claim-id', childClaim]);

    const byToken = await run(['delegate', '--retry', t1.token, '--claim-id', claimId]);
    expect(byToken.exitCode).toBe(1);
    expect(`${byToken.stdout}${byToken.stderr}`).toContain('RD-826');

    const byStep = await delegateJson(['--retry', '--step', '2.1', '--claim-id', claimId]);
    expect(byStep.action).toBe('retried');
  });
});
```

Build the harness on `packages/cli/__tests__/helpers/test-utils.js` — the
integration suites' shared source of `createTestWorkspace`,
`runCliInProcess(args, workspace)`, `issueRunControlClaim(workspace, runId)`,
`parseCliJsonObject` and `extractToken`. Define these local wrappers over them to
these contracts:

| Helper                        | Contract                                                                                                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run(argv)`                    | `runCliInProcess(argv, workspace)` — returns `{ stdout, stderr, exitCode }` unparsed. Used for every refusal case, where the body is an error envelope rather than a delegate response |
| `delegateJson(args)`           | `run(['delegate', ...args])`, asserts `exitCode === 0`, and returns `JSON.parse(stdout)`. Every call site reads `.action` and/or `.token`, so it must satisfy at minimum `{ action: string; token: string }` — the full `DelegateResponseSchema` shape |
| `claim(token)`                 | `run(['claim', token])`, then reads the minted `claim_id` off the parsed response                                                                               |
| `rotateRunControlClaim()`      | A second `issueRunControlClaim(workspace, parentRunId)` over the same run, which supersedes the first; returns the new `claim_id`. The superseded one can no longer reconstruct credentials it minted |
| `claimId`                      | The run-control `claim_id` captured from `runbook_started` during fixture setup                                                                                 |
| `foreignClaimId`               | `issueRunControlClaim(workspace, otherRunId)` — a run-control claim for a **different** run, used to prove the echo is same-issuer only                          |
| `parentRunId` / `otherRunId`   | The fixture run's id, and a second running stack member used as the wrong `--run` target                                                                        |

The fixture project needs a parent runbook with a delegating step `2` carrying a
DELEGATE substep `2.1` — the same shape Task B5's tests use.

- [ ] **Step 2: Run them**

```bash
pnpm --filter @rundown-org/cli exec jest __tests__/integration/retry-idempotency.test.ts
```

- [ ] **Step 3: Commit**

```bash
npx biome check --config-path=. --write packages/cli/__tests__/integration/retry-idempotency.test.ts
git add packages/cli/__tests__/integration/retry-idempotency.test.ts
git commit -m "test(cli): cover the retry idempotency edge cases from #681"
```

---

### Task B7: Document the surface

**Files:**

- Modify: `docs/reference/cli.md` — the delegation-semantics bullet list
  (`:768-810`) and the error table (`:1180-1205`)
- Modify: `docs/spec/cli-output.md` — a `retry-already-applied` example and three
  error subsections in § "Error Output (all commands)" (after § "Run target
  mismatch", `:1376`)

**Interfaces:** none — documentation only.

- [ ] **Step 1: Add the delegate semantics bullets to `docs/reference/cli.md`**

Insert after the existing `rundown delegate --retry <token>` bullet:

```markdown
- **`--retry` is idempotent over an unobserved replacement.** A retry that has
  already been applied — the replacement exists and shows no committed evidence
  its bearer was used (never claimed, never aborted, and its frame entry still
  current) — **echoes** that bearer as `action: "retry-already-applied"` and
  writes nothing. A replayed command after a dropped response therefore cannot
  orphan a bearer that was already handed out. To rotate deliberately, name the
  current token: `rundown delegate --retry <token> --claim-id <claim_id>`, which
  the echo response carries.
- **Machine-driven RETRY counts as a retry.** A step-level `rundown retry` also
  stamps the replacement, so the first manual `rundown delegate --retry --step X`
  after one echoes rather than rotating. This is deliberate: the contract is
  refusal-biased and never double-mints, and the remedy — the current bearer —
  is in the response.
- Committed evidence that the replacement's bearer was used refuses with RD-826
  (`DELEGATION_REPLACEMENT_CONSUMED`) rather than minting a third bearer over
  work in progress.
```

- [ ] **Step 2: Add the three error-table rows**

Add to the table at `docs/reference/cli.md:1180-1205`, keeping the existing
column order (Error | Cause | Resolution):

```markdown
| `RD-826` (`DELEGATION_REPLACEMENT_CONSUMED`)    | `delegate --retry` named a bearer that was already replaced, and the replacement shows committed evidence of use — claimed by a child, aborted, or its frame entry advanced                                       | Target the current delegation instead of the superseded bearer, or `rundown abort <token> --claim-id <claim_id> --force` and re-delegate. Retrying the same bearer refuses identically |
| `RD-827` (`DELEGATION_RETRY_IDENTITY_UNMATCHED`) | `delegate --retry <token>` named a bearer that identifies neither the delegation currently recorded at the target nor one it superseded                                                                          | Re-read the current delegation with `rundown status` and retry the bearer it names                                                                                                     |
| `RD-828` (`DELEGATION_SUPERSESSION_AMBIGUOUS`)   | More than one delegation attempt records the named bearer as superseded, so there is no single replacement to echo or judge. Unreachable by construction — it is refused, never resolved                        | Invalid state: finish or `rundown prune` the run and restart from the source runbook                                                                                                   |
```

- [ ] **Step 3: Add the output examples to `docs/spec/cli-output.md`**

Add a `### Retry already applied` subsection under the delegate response
documentation showing both formats:

````markdown
### Retry already applied

`rundown delegate --retry` when the retry has already been applied and the
replacement shows no committed evidence its bearer was used. Nothing is written
and the exit code is 0 — this is a successful idempotent replay, not a refusal.
The current bearer is echoed so the caller can rotate deliberately by naming it.

**Text:**

```text
ALREADY    step 2.1 -> child.runbook.md
Token:     rdtk_…

RD_CLAIM_TOKEN=rdtk_…
```

**JSON:**

```json
{
  "kind": "delegate",
  "action": "retry-already-applied",
  "step": "2.1",
  "runbook": "child.runbook.md",
  "token": "rdtk_…",
  "token_hash": "…",
  "parent_run_id": "rd_…"
}
```
````

Then add three error subsections after § "Run target mismatch", each following
that section's existing Text/JSON pair shape, for RD-826, RD-827 and RD-828.
None of them may show a full token.

- [ ] **Step 4: Format and commit**

```bash
npx prettier --write docs/reference/cli.md docs/spec/cli-output.md
git add docs/reference/cli.md docs/spec/cli-output.md
git commit -m "docs: document retry idempotency and RD-826/827/828

Adds the retry-already-applied delegate action to the output spec, the three
new refusal codes to both the CLI error table and the output spec, and the
delegate semantics bullets covering the echo and its machine-RETRY coupling.
#681"
```

---

### Task B8: Final gate and manual end-to-end proof

- [ ] **Step 1: Run the full pre-PR gate**

```bash
pnpm run verify
```

Expected: PASS. Do not proceed with a failure.

- [ ] **Step 2: Mutation-test the changed ranges in both packages**

```bash
pnpm run test:mutate:changed --package core
pnpm run test:mutate:changed --package cli
```

Judge on in-scope Survived / NoCoverage mutants. Non-negotiable kills:

- every conjunct of `unobservedReplacement` (especially the fourth),
- the `supersededBy.length > 1` boundary,
- the `claimed` / `cancelled` / `entry_superseded` branch order,
- the `advanceFrameEntry` bootstrap / switch / re-entry branches,
- the `frameReentry !== undefined` read in `syncFrameEntry`.

Re-check anything reported as surviving with
`--related-tests` before concluding the suite genuinely misses it.

- [ ] **Step 3: Build the workspace CLI and stand up the scratch project**

The proof must exercise **this branch's** CLI, not whatever `rundown` resolves to
on `PATH` — a globally installed release would run the old behaviour and report
a green proof. Build first, then resolve the binary from the package manifest
rather than guessing its path:

```bash
cd /Users/tobyhede/psrc/rundown/.worktrees/680-machine-owned-frame-entry
pnpm run build

# packages/cli/package.json declares { "bin": { "rundown": "dist/cli.js", "rd": "dist/cli.js" } }.
# Resolve it from the manifest so a future bin rename cannot silently break this.
RD="$PWD/packages/cli/$(node -p "require('./packages/cli/package.json').bin.rundown")"
test -f "$RD" || { echo "CLI not built at $RD"; exit 1; }

SCRATCH="$(mktemp -d)"
mkdir -p "$SCRATCH/.rundown/runbooks"
cd "$SCRATCH"
```

Write the two runbooks the sequence needs. `parent.runbook.md` parks the run on
a delegating step `1` whose substep `1.1` is an authored DELEGATE target naming
`child.runbook.md`:

````bash
cat > parent.runbook.md <<'EOF'
---
name: retry-idempotency-proof
---

# Retry idempotency proof

## 1. Delegate one child

- ALL

### 1.1 Hand the work to a child

- DELEGATE
- child.runbook.md

Wait for the child to report.

- PASS DEFER
- FAIL DEFER

## 2. Finish

Nothing to do.

- PASS COMPLETE
- FAIL STOP
EOF

cat > .rundown/runbooks/child.runbook.md <<'EOF'
---
name: child
---

# Child

## 1. Do the work

Report the outcome.

- PASS COMPLETE
- FAIL STOP
EOF
````

- [ ] **Step 4: Run #681's acceptance sequence and check the three properties**

```bash
"$RD" run parent.runbook.md                          # capture claim_id -> C, and the run id
"$RD" delegate --step 1.1 --claim-id "$C"            # T1
"$RD" delegate --retry --step 1.1 --claim-id "$C"    # rotates -> T2
"$RD" delegate --retry --step 1.1 --claim-id "$C"    # ECHOES T2, no write, exit 0
"$RD" delegate --retry "$T2" --claim-id "$C"         # intentional rotation -> T3
"$RD" delegate --retry "$T1" --claim-id "$C"         # RD-826 or token-not-found
```

Every command emits JSON by default; read `.token` off each response and keep
`STATE=".rundown/runs/<run id>.json"`.

1. **Two rotations committed.** `T1`, `T2` and `T3` are three distinct bearers,
   and each rotation is verifiable **at the moment it happens** — not
   retrospectively. `replaceIssuedDelegation` → `replaceSubstepStateEntry`
   substitutes the `(id, frameKey)` row wholesale (`targeting.ts:565`, whose own
   TSDoc says "substitutes the entry wholesale"), so after the second rotation
   the row carries only `supersedesTokenHash = hash(T2)` — the T2→T1 link is
   gone and a count of supersessions in the final file is not observable.
   Capture the state after each rotation instead:

   ```bash
   # after the T2 rotation
   cp "$STATE" /tmp/after-t2.json
   node -e 'const h=require("crypto").createHash("sha256").update(process.argv[1]).digest("hex");
     const s=require("/tmp/after-t2.json");
     const d=s.substepStates.find(r=>r.delegation).delegation;
     console.assert(d.credential.supersedesTokenHash==="sha256:"+h, "T2 must supersede T1");' "$T1"

   # after the T3 rotation
   cp "$STATE" /tmp/after-t3.json
   node -e 'const h=require("crypto").createHash("sha256").update(process.argv[1]).digest("hex");
     const s=require("/tmp/after-t3.json");
     const d=s.substepStates.find(r=>r.delegation).delegation;
     console.assert(d.credential.supersedesTokenHash==="sha256:"+h, "T3 must supersede T2");' "$T2"
   ```

   (Match the hash encoding to `hashDelegationToken` in
   `packages/core/src/runbook/delegation-token.ts` — read it rather than assuming
   the `sha256:` prefix.)

2. **The echo writes no persisted state.** Hash the run state file either side of
   the third command and confirm the digests match:

   ```bash
   shasum "$STATE"                                       # before
   "$RD" delegate --retry --step 1.1 --claim-id "$C"     # the echo
   shasum "$STATE"                                       # must be identical
   ```

3. **No full token in any refusal envelope.** The fifth command's stdout and
   stderr contain no `rdtk_`-prefixed string:

   ```bash
   "$RD" delegate --retry "$T1" --claim-id "$C" 2>&1 | grep -c 'rdtk_'  # must print 0
   ```

Clean up with `rm -rf "$SCRATCH"` once all three hold.

- [ ] **Step 5: Commit anything the gate or the manual proof turned up**

```bash
git add -A
git commit -m "test: close the final mutation and end-to-end gaps for #680/#681"
```

---

## Definition of Done

### #680 — Frame entry has two writers in the wrong order

#680 carries no literal acceptance checklist; its deliverables are the content
of Option 1 ("The machine owns the entry bump") plus its Follow-on section.

| #680 deliverable                                                                     | Satisfied by     |
| ------------------------------------------------------------------------------------ | ---------------- |
| Advance `context.frameEntry` inside the machine so it is current before `delegationIssueActor` reads it | Task A2          |
| …and before `runRetryHook` reads it                                                  | Task A4          |
| The bump lands as an entry action so XState runs it before that state's `invoke`     | Task A2, Step 4  |
| Persist `activeEntry` / `frameEntryCounts` from context in `deriveActorStatePatch`    | Task A5, Step 3  |
| Bootstrap seeding becomes a machine entry action                                     | Task A5 (test), Task A6 (site 13) |
| The `transitioned` flag disappears                                                   | Task A6, Step 1  |
| The inline-launch double-bump workaround at `:2397-2404` disappears                  | Task A6, site 2  |
| All external `deriveActiveEntry` / `ensureActiveEntry` call sites removed             | Task A6 (thirteen sites) |
| The two CLI sites — Category B logic outside core — close here                        | Task A6, sites 8–11 |
| One frame-key derivation replaces the three that agreed by accident                  | Task A1, Steps 5; Task A2 Step 5; Task A5 Step 5 |
| Derived tokens change; acceptable, no compatibility contract                         | Task A6 commit message (BREAKING) |
| Flip `entry-projection-ordering.investigation.test.ts` to `toBe` and rename it        | Task A8          |
| Multi-state-entry paths do not double-bump                                           | Tasks A2, A3, A4 (machine) and A9 (committed state) |
| Descriptive documentation updated in place                                           | Task A10         |

### #681 — Retry idempotency

| #681 acceptance checkbox                                                                                   | Satisfied by      |
| ----------------------------------------------------------------------------------------------------------- | ----------------- |
| #680 landed; `entry-projection-ordering.investigation.test.ts` flipped to `toBe` and renamed                | Tasks A1–A11, A8  |
| `resolveRetryIssuance` implemented per the addendum's decision table (15 rows, token and step/active locators) | Task B2           |
| RD-826/827/828 registered and documented in `docs/reference/cli.md` and `docs/spec/cli-output.md`           | Tasks B3, B7      |
| Edge cases: frame re-entry with a surviving replacement, retry-of-a-retry chains, foreign-claim replay, rotated issuing claim, `--run` + superseded token, replacement claimed by a terminal vs live child | Task B6 |
| Manual end-to-end proof: two rotations committed, the echo writes no persisted state, no full token in any refusal envelope | Task B8, Steps 3–4 |

### Cross-cutting

| Requirement                                                        | Satisfied by            |
| ------------------------------------------------------------------- | ----------------------- |
| `pnpm run verify` green before push                                 | Tasks A11 Step 1, B8 Step 1 |
| Mutation coverage judged on in-scope survivors, scoped correctly     | Tasks A1 Step 8, A11 Step 2, B1 Step 5, B2 Step 6, B8 Step 2 |
| Part A production change reviewable separately from its test churn   | Task A6 and Task A7 are separate commits |
| No persisted-state migration, fallback, or shim anywhere in the diff | Global Constraints; enforced by review |
| No fail-open wiring: the supersession lookup is a required dependency supplied at every construction site | Task B4 Steps 7–8 |
| Ambiguity (row 8) is decidable in every case, including when `findByToken` also matches | Task B4 Step 5 (unconditional scan) + Task B4 Step 1 (`findByToken also matches` test) |
| The manual proof exercises this branch's built CLI, not a `PATH` release | Task B8 Step 3 |
