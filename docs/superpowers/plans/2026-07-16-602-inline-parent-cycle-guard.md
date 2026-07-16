# Inline Parent-Advance Cycle/Depth Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound the upward recursion in `propagateTerminalChildUpward` so a cyclic or absurdly deep `parentLinkage` graph terminates deterministically with a documented terminal outcome and an operator-actionable diagnostic, instead of exhausting the stack.

**Architecture:** Add a private `propagateTerminalChildUpwardInner(deps, childState, result, visited, depth)` that threads a `Set<RunId>` of runs already walked plus an explicit depth counter; the exported 3-arg `propagateTerminalChildUpward` stays a thin wrapper seeding `new Set([childState.id])` and `depth = 1`. Both guards are checked against `linkage.parentRunId` **before** any side effect (record / advance / release), so a repeat never re-runs the side-effect sequence. A new `'linkage-cycle'` member on `TerminalUpwardPropagationResult` carries the trip out of core for control flow; a new **required** `onLinkageCycle` sink on the deps bag carries the offending run id out for the operator. The four consumers (three CLI adapters + `collection-service`) collapse the member to their pre-existing `'blocked'` at their boundary — an explicit, tested mapping, exactly as they already collapse `'duplicate'` → `'reported'`.

**Tech Stack:** TypeScript (strict), Jest 30 + `@jest/globals`, fast-check 4 (property), Stryker (mutation), pnpm workspaces.

## Design decisions (issue #602 leaves these open)

Ground truth from the current code:

- The seam and its unguarded recursion: `packages/core/src/runbook/inline-parent-advance.ts:152-232` (recursion at `:222`).
- The deps bag: `PropagateTerminalChildUpwardDeps` (`inline-parent-advance.ts:127-136`). Its module TSDoc (`:12-15`) already names this bag as **the** channel for CLI-supplied runtime references — `advanceInlineParent` rides it today.
- Consumers of `TerminalUpwardPropagationResult`: `packages/cli/src/helpers/delegation-completion.ts:268-270`, `:333`, `:388`; `packages/core/src/runbook/collection-service.ts:643-652`.
- **Precedent to follow:** `SessionService.resolveActiveInlineForceTerminalPlan`
  (`packages/core/src/runbook/session-service.ts:766-808`) already walks the *same* inline chain with a `seen = new Set<RunId>([activeState.id])`, checks `seen.has(parentRunId)` **before** loading the parent (`:779`), and fails closed with a dedicated `status: 'inline-cycle'` **carrying `repeatedRunId`** (`:780`) that surfaces as the `INLINE_PARENT_CYCLE` error code with the run id in the message (`packages/core/src/runbook/lifecycle-command-service.ts:1749-1755`). This plan mirrors that shape — including the "name the offending run" half — rather than inventing a second idiom.

**Decision 1 — visited set AND an explicit depth counter (both, independent).** The visited set is the precise detector: it trips at the *first* repeated run id, before that run's side effects run a second time. It is also what makes the guard correct across the release/reload boundary — the set lives in the recursion's argument, not in reloaded state. The depth cap is a backstop for the acyclic-but-corrupt case the visited set cannot bound (a chain of N *distinct* run ids costs N releases + N reloads + N advances before terminating).

The cap is threaded as an **explicit `depth: number` argument**, not derived from `visited.size`. This is load-bearing: `visited.size` grows by one distinct id per level and **saturates** in a true cycle (a 2-node cycle parks at size 2 forever), so a size-based cap is parasitic on the visited check — if `visited.has` ever fails, a size cap does not bound the walk at all, and the two "independent" guards are really one. An explicit counter increments unconditionally per level, so each guard bounds the walk on its own. Same line count; the only cost is one more argument.

**Decision 2 — cap value `64`, and why only *this* walk is capped.** Legitimate inline nesting is a runbook composing a child that composes a child: a handful of levels at most, and the linkage graph is a tree by construction (a parent stamps a child's `parentLinkage.parentRunId` at launch, always pointing at an already-existing ancestor). `64` is ~2 orders of magnitude of headroom over any real chain while bounding worst-case side effects to 64 releases/reloads. It is deliberately not tuned to the JS stack limit — the constraint being bounded is I/O work per trip, not frame count.

`SessionService.resolveActiveInlineForceTerminalPlan` walks the same graph (`session-service.ts:777-796`) with a visited set and **no** depth cap, and this plan deliberately leaves it that way — `MAX_INLINE_PROPAGATION_CHAIN` is **not** exported to it. The two walks have different hazards: that one is an **iterative** `while` loop (no stack growth) that is documented read-only (`:755`) and performs **no writes per level** — one `manager.load` and an array push. Its visited set already terminates it on any back-edge; its only unbounded case is an acyclic chain of N distinct ids, costing N reads, which is bounded by the number of runs actually on disk. This walk recurses (stack frames) and performs **advance + release + reload — writes — per level**, so an unbounded acyclic chain is unbounded *mutation*. Sharing a constant between them would imply a shared termination rule that does not exist; bounding the read-only walk is a separate, lower-priority call and is out of scope for #602.

**Decision 3 — trip disposition: a new `'linkage-cycle'` union member, fail-closed, highest severity.** Rejected alternatives:

- _Return `'handled'`_ — this is the masking defect the issue warns about: it would swallow a real `stopped`/`blocked` bubble-up into a success-shaped outcome.
- _Return `'blocked'` directly from the seam_ — cheap, but the seam would then be unable to distinguish "the child's terminal was command-infrastructure" from "the persisted linkage graph is corrupt". That is silent mapping inside core, where the distinction is decidable.

So core keeps the cause (`'linkage-cycle'`), and each consumer maps it **explicitly** onto its own pre-existing return type: `'blocked'`. `'blocked'` already means "fail closed; drive a non-zero exit" (`propagationRequiresFailureExit` / `inlineAdvanceRequiresFailureExit`, `packages/cli/src/helpers/delegation-completion.ts:437-464`), which is the correct operator-facing behaviour for corrupt state under the project's "reject, don't adapt" rule. Adding the member is load-bearing type pressure: the four narrowing sites are **hand-written literal unions**, not aliases of the core union (`delegation-completion.ts:50-58`, `collection-service.ts:625`), so adding a member breaks compilation at exactly those four sites and no consumer can forget to handle it.

**Decision 4 — one union member, but two named causes in the diagnostic.** `'linkage-cycle'` covers the depth trip too: every consumer collapses both causes to `'blocked'` identically, so a second `'linkage-depth-exceeded'` **union member** would be unobservable in control flow (YAGNI), and on a tree-by-construction graph a chain past the bound is corruption of the same class. The *operator*, however, does need the distinction — "there is a back-edge at `rd_…`" and "the chain past `rd_…` never ends" imply different inspections — so the cause rides the diagnostic payload (Decision 6) as `'repeat' | 'depth'`, where nothing branches on it. Type-level cause: one. Operator-facing cause: two. The member's TSDoc documents both.

**Decision 5 — severity precedence.** `linkage-cycle` > `blocked` > `stopped` > `handled`. This extends the existing rule (`blocked` already wins over `stopped`, `inline-parent-advance.ts:225-231`) rather than inventing a new one, and it means a cycle discovered deep in the walk can never be downgraded by a shallower `done`.

**Decision 6 — the trip gets a diagnostic surface via a required `onLinkageCycle` sink on the deps bag.** Without this, Decision 3's own rationale fails: core would keep the cause and every consumer would collapse it to a bare `'blocked'` with no message, no code, and no run id — the operator gets an exit code indistinguishable from any other block and cannot know **which run to prune**, even though CLAUDE.md makes explicit user action (finish / stop / prune / restart) the *only* recovery path for corrupt persisted state. The precedent does this right: `lifecycle-command-service.ts:1749-1755` carries `repeatedRunId` into the `INLINE_PARENT_CYCLE` message.

The seam therefore takes a **required** dependency:

```typescript
export interface LinkageCycleTrip {
  readonly runId: RunId;
  readonly cause: 'repeat' | 'depth';
}
export type OnLinkageCycle = (trip: LinkageCycleTrip) => void;
```

on `PropagateTerminalChildUpwardDeps`, invoked exactly once immediately before the guard returns `'linkage-cycle'` — i.e. at the level that *found* the trip, so it reports the true offending run id and cannot be lost to the severity collapse on the way back out. Rejected alternatives:

- _Widen the return to a scalar-or-object union_ (`… | { kind: 'linkage-cycle'; repeatedRunId }`). Compiles, and the existing `=== 'reported'` comparisons survive — but it forces every consumer to branch on `typeof outcome === 'object'`, which is precisely the untyped-discriminant smell CLAUDE.md's type-driven-dispatch rule names. It buys the id by degrading the type.
- _Rewrite the whole union into discriminated objects._ Architecturally the cleanest and what the precedent's `ActiveInlineForceTerminalPlan` does — but the blast radius is every consumer, every `=== 'blocked'` call site, and every existing seam test, for a hardening issue whose own report says it is not a reachable path. Out of scope for #602; a defensible follow-up.
- _Have core log it._ `RUNDOWN_LOG=0` makes the diagnostic vanish, a log line carries no error code, and it is not the agent-facing JSON envelope. Rendering a diagnostic is Category A (CLI) per CLAUDE.md's side-effect table; a DI'd callable is the prescribed shape for a Category-A effect a core seam must trigger.

The sink is **required**, not optional, so it inherits the same type pressure as the union member: the only two deps-construction sites — `buildInlineParentAdvanceDeps` (`delegation-completion.ts:209-226`) and `RunbookCollectionServiceDeps` (`collection-service.ts:56-76`, threaded at `:633-639`) — break at compile time until wired. It rides the exact rail `advanceInlineParent` already rides, so this adds **no new architecture**: one more CLI-supplied runtime callable in the bag the module TSDoc already designates for them.

**Decision 7 — the sink emits the existing `INLINE_PARENT_CYCLE` code, not a new one.** The internal union member is `'linkage-cycle'` (broader than the precedent's `'inline-cycle'` on purpose: the guard sits *before* the kind dispatch, so it covers a cyclic **delegation** linkage too). But the operator-facing code stays `INLINE_PARENT_CYCLE` — already established by the force-terminal path (`lifecycle-command-service.ts:1754`, surfaced through `packages/cli/src/helpers/terminal-command.ts`, pinned at `packages/cli/__tests__/helpers/terminal-command.test.ts:211`). Both conditions are the same fact ("the persisted linkage graph has a back-edge") and imply the same recovery ("prune the named run"), so minting a second code would give operators two indices into one condition. The names diverge deliberately: the member is core's *type-level* cause, the code is the operator's *index into a recovery action*.

## Global Constraints

- **`propagateTerminalChildUpward`'s exported signature stays 3-arg** (`deps, childState, result`). Visited/depth state must not leak into it. Callers: `packages/cli/src/helpers/delegation-completion.ts:258`, `:322`, `:377`; `packages/core/src/runbook/collection-service.ts:633`.
- **No persisted-state changes.** The visited set and depth counter are in-memory recursion arguments only. Nothing here touches `.rundown/runs/` or any schema.
- **All exported symbols need TSDoc** (description; `@param` for every param; `@returns` if non-void). The new constant, union member, sink types, and CLI helper are exported/public surface.
- **Never call `Error.isError()` directly** — not needed here, but ESLint `no-restricted-syntax` enforces it repo-wide.
- **`pnpm run verify` MUST pass before any push.** Note `verify` bottoms out at `test` → `test:unit` (`package.json:11`, `:65`) — it does **not** run `test:property`, `test:integration`, or `test:scenarios:raw`. Task 5 runs the extra gates this change needs explicitly.
- Guard placement: **before** `recordChildCompletion` / `advanceInlineParent` / `releaseRunbook` on the trip path, and before the kind dispatch. A tripped guard performs zero propagation side effects (the diagnostic sink is not a propagation side effect).

## File Structure

- **Modify** `packages/core/src/runbook/inline-parent-advance.ts` — the whole guard: new exported constant, new union member, sink types, the required dep, private inner helper, wrapper. Sole owner of the **recursive** walk's termination rule (`session-service.ts:777-796` owns its own; see Decision 2).
- **Modify** `packages/core/src/runbook/collection-service.ts:56-76`, `:625`, `:633-648` — thread the sink dep; map `'linkage-cycle'` → `'blocked'` in the inline narrowing.
- **Modify** `packages/cli/src/helpers/delegation-completion.ts:209-226`, `:249-271`, `:307-334`, `:367-389` — build the sink; map `'linkage-cycle'` → `'blocked'` in all three adapters.
- **Modify** `packages/cli/src/commands/collect.ts:472-479` — wire the sink into `RunbookCollectionService`.
- **Modify** `packages/core/__tests__/runbook/inline-parent-advance.test.ts` — guard unit tests (the bulk).
- **Modify** `packages/core/__tests__/runbook/collection-service.test.ts` — one end-to-end cycle test through the real seam.
- **Modify** `packages/cli/__tests__/helpers/delegation-completion.test.ts` — adapter collapse + diagnostic tests (this suite already mocks `@rundown-org/core`, so it forces the seam result directly).
- **Create** `packages/core/__tests__/runbook/inline-propagation-guard.properties.test.ts` — property tests over arbitrary linkage graphs.

One new file (the property suite, matching the ten existing `*.properties.test.ts` suites in `packages/core/__tests__/runbook/`). Everything else is a bounded edit to one owner plus its narrowing/wiring sites.

---

### Task 1: Cycle + depth guard across the seam and its consumers

**Files:**

- Modify: `packages/core/src/runbook/inline-parent-advance.ts:85-91` (union), `:152-232` (function)
- Modify: `packages/core/src/runbook/collection-service.ts:643-648`
- Modify: `packages/cli/src/helpers/delegation-completion.ts:264-270`, `:331-333`, `:386-388`
- Test: `packages/core/__tests__/runbook/inline-parent-advance.test.ts`
- Test: `packages/core/__tests__/runbook/collection-service.test.ts`
- Test: `packages/cli/__tests__/helpers/delegation-completion.test.ts`

**Interfaces:**

- Consumes: existing `PropagateTerminalChildUpwardDeps`, `RunbookState`, `DelegationOutcome`, `RunId` (branded `string`, `packages/core/src/runbook/run-id.ts:4`). `RunbookState.id` is already `RunId` (`packages/core/src/runbook/types.ts:961`).
- Produces:
  - `TerminalUpwardPropagationResult` gains the member `'linkage-cycle'`.
  - `MAX_INLINE_PROPAGATION_CHAIN: 64` — exported const.
  - `propagateTerminalChildUpward(deps, childState, result)` — unchanged 3-arg signature, unchanged return type name.
  - `propagateTerminalChildUpwardInner(deps, childState, result, visited: ReadonlySet<RunId>, depth: number)` — **module-private**, not exported, not in `index.ts`.

This task lands the member and all four consumer mappings together: adding the union member breaks compilation at every narrowing site, so a partial landing leaves the tree red. That is the type pressure working as designed, not a reason to split. The diagnostic sink (Decision 6) is deliberately **not** here — it is a separable design call a reviewer could reject while accepting this guard (Task 3).

- [ ] **Step 1: Write the failing tests for the cycle guard**

Add to `packages/core/__tests__/runbook/inline-parent-advance.test.ts`, inside the existing `describe('propagateTerminalChildUpward — inline arm', ...)` block. The helpers `makeState`, `makeDeps`, `inlineLinkage`, `delegationLinkage`, `CHILD`, `PARENT`, `GRANDPARENT`, `NEVER_ADVANCE` already exist at `:19-100` — do not redefine them. Note `makeDeps` takes a **top-level** `Partial<PropagateTerminalChildUpwardDeps>` (`:71-73`), so each overridden service is replaced **wholesale**: supply every method of a service you override.

```typescript
  // --- #602: cycle guard. The linkage graph is a tree by construction, so a
  // repeat means corrupted persisted state: fail closed, perform no side
  // effects for the repeated run, and never downgrade to 'handled'.

  it('self-linked child (parent === child) trips the guard with no side effects', async () => {
    const child = makeState(CHILD, { parentLinkage: inlineLinkage(CHILD) });
    const advanceInlineParent = jest.fn<AdvanceInlineParent>();
    const recordChildCompletion = jest
      .fn<(args: unknown) => Promise<'recorded'>>()
      .mockResolvedValue('recorded');
    const releaseRunbook = jest
      .fn<
        (
          id: RunId,
          o?: { readonly retainClaimsAsTerminal?: boolean },
        ) => Promise<ReleaseRunbookResult>
      >()
      .mockResolvedValue({} as ReleaseRunbookResult);
    const result = await propagateTerminalChildUpward(
      makeDeps({
        advanceInlineParent,
        completionService: { recordChildCompletion },
        sessionService: { releaseRunbook },
      }),
      child,
      'pass',
    );
    expect(result).toBe('linkage-cycle');
    expect(recordChildCompletion).not.toHaveBeenCalled();
    expect(advanceInlineParent).not.toHaveBeenCalled();
    expect(releaseRunbook).not.toHaveBeenCalled();
  });

  it('two-node cycle (child→parent→child) trips after exactly one advance', async () => {
    // child(A) -> parent(B); B's persisted linkage points back at A.
    const child = makeState(CHILD, { parentLinkage: inlineLinkage(PARENT) });
    const parentTerminal = makeState(PARENT, {
      lifecycle: 'completed',
      parentLinkage: inlineLinkage(CHILD),
    });
    const advanceInlineParent = jest
      .fn<AdvanceInlineParent>()
      .mockResolvedValue({ status: 'done' });
    const load = jest
      .fn<(id: string) => Promise<RunbookState | null>>()
      .mockResolvedValue(parentTerminal);
    const releaseRunbook = jest
      .fn<
        (
          id: RunId,
          o?: { readonly retainClaimsAsTerminal?: boolean },
        ) => Promise<ReleaseRunbookResult>
      >()
      .mockResolvedValue({} as ReleaseRunbookResult);
    const result = await propagateTerminalChildUpward(
      makeDeps({ advanceInlineParent, manager: { load }, sessionService: { releaseRunbook } }),
      child,
      'pass',
    );
    expect(result).toBe('linkage-cycle');
    // The FIRST level is legitimate and completes; the repeat of A performs nothing.
    expect(advanceInlineParent).toHaveBeenCalledTimes(1);
    expect(advanceInlineParent).toHaveBeenCalledWith(expect.objectContaining({ parentRunId: PARENT }));
    expect(releaseRunbook).toHaveBeenCalledTimes(1);
    expect(releaseRunbook).toHaveBeenCalledWith(PARENT, { retainClaimsAsTerminal: true });
  });

  it('a cycle discovered by the recursion outranks a stopped advance', async () => {
    // Severity precedence: linkage-cycle > blocked > stopped > handled. A cycle
    // must not be downgraded to 'stopped' (or 'handled') by a shallower level.
    const child = makeState(CHILD, { parentLinkage: inlineLinkage(PARENT) });
    const parentTerminal = makeState(PARENT, {
      lifecycle: 'stopped',
      parentLinkage: inlineLinkage(CHILD),
    });
    const advanceInlineParent = jest
      .fn<AdvanceInlineParent>()
      .mockResolvedValue({ status: 'stopped' });
    const load = jest
      .fn<(id: string) => Promise<RunbookState | null>>()
      .mockResolvedValue(parentTerminal);
    const result = await propagateTerminalChildUpward(
      makeDeps({ advanceInlineParent, manager: { load } }),
      child,
      'fail',
    );
    expect(result).toBe('linkage-cycle');
  });

  it('a cyclic DELEGATION linkage trips before recording report-only', async () => {
    // child(A) -> inline parent(B); B is delegation-linked back to A. The guard
    // is checked before the kind dispatch, so the report is refused too.
    const child = makeState(CHILD, { parentLinkage: inlineLinkage(PARENT) });
    const parentTerminal = makeState(PARENT, {
      lifecycle: 'completed',
      parentLinkage: delegationLinkage(CHILD),
    });
    const advanceInlineParent = jest
      .fn<AdvanceInlineParent>()
      .mockResolvedValue({ status: 'done' });
    const load = jest
      .fn<(id: string) => Promise<RunbookState | null>>()
      .mockResolvedValue(parentTerminal);
    const recordChildCompletion = jest
      .fn<(args: unknown) => Promise<'recorded'>>()
      .mockResolvedValue('recorded');
    const result = await propagateTerminalChildUpward(
      makeDeps({
        advanceInlineParent,
        manager: { load },
        completionService: { recordChildCompletion },
      }),
      child,
      'pass',
    );
    expect(result).toBe('linkage-cycle');
    // Only the child's own record ran (level 1); the cyclic report never did.
    expect(recordChildCompletion).toHaveBeenCalledTimes(1);
    expect(recordChildCompletion).toHaveBeenCalledWith({ childState: child, result: 'pass' });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @rundown-org/core exec jest __tests__/runbook/inline-parent-advance.test.ts -t 'cycle'`

Expected: FAIL. The self-linked test fails with `Expected: "linkage-cycle" / Received: "handled"` (or a thrown `advanceInlineParent must not be called on this path`); the two-node test fails on the advance count / result.

- [ ] **Step 3: Add the `'linkage-cycle'` member to the union**

In `packages/core/src/runbook/inline-parent-advance.ts`, replace the `TerminalUpwardPropagationResult` declaration (currently `:85-91`) — keep the existing TSDoc block above it and append the new paragraph:

```typescript
 * `linkage-cycle` (#602) is the fail-closed trip of the upward walk's guard: the
 * walk reached a run id it had already visited, or the chain exceeded
 * {@link MAX_INLINE_PROPAGATION_CHAIN}. The inline linkage graph is a tree by
 * construction (a parent stamps a child's `parentLinkage.parentRunId` at launch,
 * always pointing at an already-existing ancestor), so either condition means the
 * persisted linkage graph is corrupt. Per the project's no-migration / "reject,
 * don't adapt" rule the seam refuses rather than guessing: it performs NO
 * propagation side effects for the repeated run and surfaces the cause. It is the
 * HIGHEST severity member — a cycle found deep in the walk is never downgraded by
 * a shallower `done`/`stopped`. Consumers that cannot represent it (the CLI
 * adapters, the collect path) map it EXPLICITLY onto their pre-existing `blocked`,
 * which already carries "fail closed, exit non-zero". The two causes are NOT
 * distinguished in this union (no consumer branches on them) — they are named for
 * the operator on the {@link OnLinkageCycle} sink instead.
 */
export type TerminalUpwardPropagationResult =
  | 'handled'
  | 'stopped'
  | 'blocked'
  | 'reported'
  | 'duplicate'
  | 'linkage-cycle'
  | 'not-applicable';
```

- [ ] **Step 4: Implement the guard (inner helper + wrapper)**

In the same file, replace the whole exported function body (currently `:152-232`) with the wrapper + private inner. Keep the existing TSDoc block on the exported function and append the `@remarks` paragraph shown below.

Note the `visited`/`depth` bookkeeping survives release/reload because it is a recursion argument, never read back from disk (which is exactly what a reloaded parent could not tell us).

```typescript
/**
 * Upper bound on the number of runs one upward propagation walk may visit.
 *
 * Backstop for the acyclic-but-corrupt case the visited-set cannot bound: a chain
 * of N DISTINCT run ids costs N advances + N releases + N reloads before it ends.
 * Legitimate inline nesting is a handful of levels (a runbook composing a child
 * that composes a child), so 64 leaves ~2 orders of magnitude of headroom while
 * capping worst-case side effects at 64. Exceeding it trips the same
 * `'linkage-cycle'` disposition — on a tree-by-construction graph, a 64-deep chain
 * is corruption of the same class.
 *
 * Deliberately NOT shared with `SessionService.resolveActiveInlineForceTerminalPlan`
 * (`session-service.ts:777-796`), which walks the same graph ITERATIVELY, read-only,
 * with no writes per level: it cannot exhaust the stack and its unbounded case costs
 * only reads. Different hazard, different rule. See #602.
 */
export const MAX_INLINE_PROPAGATION_CHAIN = 64;

/**
 * Propagate a terminal child run's outcome to its parent, dispatching on linkage.
 *
 * Inline: record the child's outcome, then invoke {@link AdvanceInlineParent}. If
 * the parent reaches terminal (`stopped`/`done`), release it and recurse ONE
 * level up (single-level: inline chains advance synchronously; a delegation
 * boundary takes the report-only arm). Delegation: record report-only and stop.
 *
 * @remarks
 * The walk is guarded (#602): this wrapper seeds the visited-run set with the
 * child's own id and the depth at 1, then delegates to the private recursion. The
 * set is a recursion ARGUMENT, so it survives the release/reload of each parent —
 * a reloaded parent carries no memory of the walk that produced it. On a repeat, or
 * past {@link MAX_INLINE_PROPAGATION_CHAIN} levels, the walk returns
 * `'linkage-cycle'` having performed no propagation side effects for the repeated
 * run. This mirrors `SessionService.resolveActiveInlineForceTerminalPlan`, which
 * fails closed on the same chain with `status: 'inline-cycle'`.
 *
 * @param deps - Core services + the inline-advance callable.
 * @param childState - The terminal child run's state.
 * @param result - Explicit operator result, or `undefined` for lifecycle inference.
 * @returns The upward-propagation outcome.
 * @throws {Error} If the inline-advance callable rejects (e.g. drain failure).
 */
export async function propagateTerminalChildUpward(
  deps: PropagateTerminalChildUpwardDeps,
  childState: RunbookState,
  result: DelegationOutcome | undefined,
): Promise<TerminalUpwardPropagationResult> {
  return propagateTerminalChildUpwardInner(deps, childState, result, new Set([childState.id]), 1);
}

/**
 * Guarded recursion behind {@link propagateTerminalChildUpward}.
 *
 * Private: `visited` / `depth` must never leak into the exported 3-arg signature
 * (#602).
 *
 * `depth` is threaded EXPLICITLY rather than read off `visited.size`: the set
 * saturates in a true cycle (a 2-node cycle parks at size 2), so a size-derived cap
 * would be parasitic on the `visited.has` check instead of an independent bound.
 *
 * @param deps - Core services + the inline-advance callable.
 * @param childState - The terminal child run's state at this level.
 * @param result - Explicit operator result, or `undefined` for lifecycle inference.
 * @param visited - Run ids already walked, INCLUDING `childState.id`.
 * @param depth - 1-based count of runs walked so far, including `childState`.
 * @returns The upward-propagation outcome.
 */
async function propagateTerminalChildUpwardInner(
  deps: PropagateTerminalChildUpwardDeps,
  childState: RunbookState,
  result: DelegationOutcome | undefined,
  visited: ReadonlySet<RunId>,
  depth: number,
): Promise<TerminalUpwardPropagationResult> {
  const linkage = childState.parentLinkage;
  if (!linkage) return 'not-applicable';

  const projection = projectDelegationTerminalOutcome(childState, result);
  if (projection.kind === 'not_terminal') return 'not-applicable';
  if (projection.kind === 'command_infrastructure') return 'blocked';

  // #602 guard — BEFORE any side effect, and before the kind dispatch, so a
  // cyclic delegation linkage is refused as firmly as a cyclic inline one. A
  // repeat means the persisted graph is not the tree it is built as; refuse
  // rather than re-run record → advance → release on a run already walked.
  if (visited.has(linkage.parentRunId)) return 'linkage-cycle';
  if (depth >= MAX_INLINE_PROPAGATION_CHAIN) return 'linkage-cycle';

  if (linkage.kind === 'delegation') {
    const recorded = await deps.completionService.recordChildCompletion({
      childState,
      result: projection.result,
    });
    if (recorded === 'blocked') return 'blocked';
    if (recorded === 'not-applicable') return 'not-applicable';
    // 'recorded' = FRESH upward report; 'duplicate'/'cancelled' = the ancestor
    // already holds the row (or an ordinary cancel short-circuited). Preserve the
    // distinction so the collect path's `reportedTerminalOutcome` stays
    // 'recorded'-only (RD-598 review finding 2, pinned at
    // collection-service.test.ts:1429). The CLI adapters collapse both to
    // 'reported'.
    if (recorded === 'recorded') return 'reported';
    return 'duplicate';
  }

  // Inline arm: record the child's outcome, then advance the composing parent.
  const recorded = await deps.completionService.recordChildCompletion({
    childState,
    result: projection.result,
  });
  if (recorded === 'not-applicable') return 'not-applicable';
  if (recorded === 'cancelled') return 'handled';
  if (recorded === 'blocked') return 'blocked';

  const outcome = await deps.advanceInlineParent({
    parentRunId: linkage.parentRunId,
    parentFrameKey: linkage.parentFrameKey,
    parentEntry: linkage.parentEntry,
    result: projection.result,
  });

  // Parent is still running / waiting on sibling substeps: nothing to release.
  if (outcome.status === 'active') return 'handled';

  // Parent reached a terminal (stopped/done) via the callable. This seam is the
  // SOLE release owner (the callable defers release via 'defer-to-caller'), so
  // release here exactly once and recurse ONE level up. The recursion self-guards
  // when the fresh parent has no linkage of its own.
  //
  // RELEASE DISPOSITION (RD-598 verification): `retainClaimsAsTerminal: true` —
  // matching the collect terminal branch (collection-service.ts releaseRunbook at
  // ~:502) so a later `--claim-id` confirm/conflict against the terminal parent
  // resolves `terminal`, not `missing`. Deciding disposition once, in one owner,
  // eliminates the old drain-deletes / loop-retains inconsistency.
  try {
    await deps.sessionService.releaseRunbook(linkage.parentRunId, {
      retainClaimsAsTerminal: true,
    });
  } catch {
    // Terminal state is already committed by the callable; a failed release only
    // leaks a self-healing session-stack entry (reclaimed by the next acquirer
    // via PID-aware stale detection). Never let cleanup mask the committed
    // upward propagation (RD-102, matching the collect terminal branch).
  }
  const freshParent = await deps.manager.load(linkage.parentRunId);
  const propagated: TerminalUpwardPropagationResult = freshParent
    ? await propagateTerminalChildUpwardInner(
        deps,
        freshParent,
        undefined,
        new Set(visited).add(linkage.parentRunId),
        depth + 1,
      )
    : 'not-applicable';

  // Severity precedence: linkage-cycle > blocked > stopped > handled. The first
  // two lines extend the pre-#602 rule (blocked already outranked stopped) to the
  // new member; the rest is the same stopped/done collapse it always was.
  if (propagated === 'linkage-cycle') return 'linkage-cycle';
  if (propagated === 'blocked') return 'blocked';
  if (outcome.status === 'stopped') return 'stopped';
  if (propagated === 'stopped') return 'stopped';
  return 'handled';
}
```

`RunId` is already type-imported at the top of this file (`import type { RunId } from './run-id.js';`, `:24`) — verified; no import change is needed.

- [ ] **Step 5: Run the core seam tests**

Run: `pnpm --filter @rundown-org/core exec jest __tests__/runbook/inline-parent-advance.test.ts`

Expected: PASS — the four new tests plus all 20 pre-existing ones (the acyclic chain tests at `inline-parent-advance.test.ts:329` and `:494` prove valid chains are unchanged).

- [ ] **Step 6: Fix the consumer narrowing in core (compilation is now red)**

Run: `pnpm --filter @rundown-org/core exec tsc --noEmit`

Expected: FAIL — `Type '"linkage-cycle"' is not assignable to type ...` at `collection-service.ts:647` (the `terminalInlineAdvance` literal union declared at `:625` has no such member).

In `packages/core/src/runbook/collection-service.ts`, replace the inline narrowing (`:643-648`):

```typescript
  if (linkage?.kind === 'inline') {
    // Inline seam yields 'handled' | 'stopped' | 'blocked' | 'linkage-cycle' |
    // 'not-applicable'; narrow away the delegation-only 'reported' / 'duplicate'
    // without a cast. `terminalInlineAdvance` has no 'linkage-cycle' member (it
    // feeds the CLI's exit mapping only), so collapse the trip onto 'blocked' —
    // the deliberate, fail-closed disposition documented on
    // TerminalUpwardPropagationResult (#602).
    const inlineOutcome =
      outcome === 'reported' || outcome === 'duplicate'
        ? 'not-applicable'
        : outcome === 'linkage-cycle'
          ? 'blocked'
          : outcome;
    return { reportedTerminalOutcome: false, terminalInlineAdvance: inlineOutcome };
  }
```

The delegation return on the next line (`outcome === 'reported'`) already yields `false` for `'linkage-cycle'` — correct: a refused walk reported nothing.

- [ ] **Step 7: Fix the three CLI adapter narrowings**

Run: `pnpm --filter @rundown-org/cli exec tsc --noEmit`

Expected: FAIL at `delegation-completion.ts:270`, `:333`, `:388` (the three literal unions at `:50-58` have no `'linkage-cycle'` member).

In `packages/cli/src/helpers/delegation-completion.ts`, in `reportTerminalToDelegatingRun` replace `:264-270`'s trailing lines:

```typescript
  // A delegation linkage yields 'reported' | 'duplicate' | 'blocked' |
  // 'linkage-cycle' | 'not-applicable' from the seam. The CLI never distinguished a
  // duplicate from a fresh report, so collapse 'duplicate' back into 'reported'
  // (finding 2), and narrow away the inline-only members — all without a cast.
  if (outcome === 'handled' || outcome === 'stopped') return 'not-applicable';
  if (outcome === 'duplicate') return 'reported';
  // #602: a corrupt linkage graph is fail-closed. 'blocked' is this adapter's
  // pre-existing "could not propagate; exit non-zero" member, so map onto it
  // explicitly rather than inventing a CLI-visible member no caller can act on.
  // The operator-facing detail is emitted by the deps' onLinkageCycle sink (Task 3).
  if (outcome === 'linkage-cycle') return 'blocked';
  return outcome;
```

In `advanceParentForInlineChild` replace `:331-333`:

```typescript
  // An inline linkage never yields the delegation-only 'reported' / 'duplicate';
  // narrow them away without a cast. #602: a tripped linkage guard is fail-closed
  // onto this adapter's pre-existing 'blocked'.
  if (outcome === 'linkage-cycle') return 'blocked';
  return outcome === 'reported' || outcome === 'duplicate' ? 'not-applicable' : outcome;
```

In `propagateChildTerminal` replace `:386-388`:

```typescript
  // TerminalPropagationResult has no 'duplicate' member (the CLI never
  // distinguished it); collapse to 'reported' (finding 2). #602: nor a
  // 'linkage-cycle' member; collapse to the fail-closed 'blocked'. All other
  // members are shared between the seam union and TerminalPropagationResult.
  if (outcome === 'linkage-cycle') return 'blocked';
  return outcome === 'duplicate' ? 'reported' : outcome;
```

- [ ] **Step 8: Write the consumer mapping tests**

Add to `packages/core/__tests__/runbook/collection-service.test.ts`, inside the existing `describe('terminal branch — unified inline + delegation upward propagation (#598)', ...)` block (mirrors the `'invokes the inline-advance callable for an inline-linked terminal target'` test at `:1160`; reuse that block's `state`, `seedTerminalControlled`, `oneSubstepSteps`, `ORCHESTRATOR_EVIDENCE`, `activeFrame` helpers):

```typescript
    it('collapses a self-linked (cyclic) inline target onto a blocked advance (#602)', async () => {
      // The target's inline linkage points at ITSELF — corrupt persisted state.
      // The seam's guard trips before any side effect, and collect maps the trip
      // onto its fail-closed 'blocked' so the CLI exits non-zero.
      const { controlled } = await seedTerminalControlled('completed', 'pass', {
        parentLinkage: { ...inlineLinkage, parentRunId: controlledRunId },
      });
      const advanceInlineParent = jest.fn<AdvanceInlineParent>();
      const svc = new RunbookCollectionService({
        manager,
        actorService,
        lifecycleService,
        completionService,
        sessionService,
        advanceInlineParent,
      });

      const outcome = await svc.collectDelegationOutcomes({
        targetState: controlled,
        steps: oneSubstepSteps,
        callerEvidence: ORCHESTRATOR_EVIDENCE,
        frame: activeFrame(buildFrameKey('1'), 1),
      });

      expect(outcome.kind).toBe('collection_applied');
      if (outcome.kind === 'collection_applied') {
        expect(outcome.terminalInlineAdvance).toBe('blocked');
        expect(outcome.reportedTerminalOutcome).toBe(false);
      }
      expect(advanceInlineParent).not.toHaveBeenCalled();
    });
```

Now `packages/cli/__tests__/helpers/delegation-completion.test.ts`. This suite already mocks `@rundown-org/core` and drives the seam result via `propagateTerminalChildUpward.mockResolvedValue(...)` (see `:406`, `:434`). **Its `SeamResult` is a hardcoded literal union at `:51`** (the block at `:46-50` is its TSDoc) — it does **not** derive from the core union, so `mockResolvedValue('linkage-cycle')` will not compile until the alias is replaced. Do this FIRST.

Replace `:51` with a type-only alias of the core union. Type-only imports are erased at compile time, so this is safe despite `jest.unstable_mockModule('@rundown-org/core', ...)` — the file already type-imports from `@rundown-org/core` at `:10-22`. Add `TerminalUpwardPropagationResult` to that existing `import type` list (it is re-exported from the package root via `packages/core/src/index.ts:44` → `runbook/index.ts:177`), then:

```typescript
/**
 * Seam-result union produced by the core `propagateTerminalChildUpward`. The
 * thin CLI adapters delegate the decision to this seam, so its mock is the sole
 * driver of adapter routing tests; the REAL seam logic is covered in
 * `packages/core/__tests__/runbook/inline-parent-advance.test.ts`.
 *
 * ALIASED from the core union rather than restated (#602): a hand-written copy
 * silently rots when core gains a member, which is exactly the type pressure the
 * seam's union is there to apply.
 */
type SeamResult = TerminalUpwardPropagationResult;
```

`SeamResult`'s two other uses (`:78`, `:190`) are unchanged.

First test — add inside `describe('reportTerminalToDelegatingRun (thin adapter over core seam)', ...)` (`:384`), beside its existing `'maps a seam blocked result to blocked'` test. The file's local helpers `makeState`, `makeInlineLinkage`, `makeDelegationLinkage`, `makeOutput`, `CHILD_RUN_ID` are defined at `:202-260`:

```typescript
  it('maps a seam linkage-cycle onto the fail-closed blocked (#602)', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeDelegationLinkage(),
    });
    const output = makeOutput();
    propagateTerminalChildUpward.mockResolvedValue('linkage-cycle');
    const result = await reportTerminalToDelegatingRun(childState, 'pass', '/test', output);
    expect(result).toBe('blocked');
  });
```

Second test — add inside `describe('advanceParentForInlineChild (thin adapter over core seam)', ...)` (`:511`):

```typescript
  it('maps a seam linkage-cycle onto the fail-closed blocked (#602)', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeInlineLinkage(),
    });
    const output = makeOutput();
    propagateTerminalChildUpward.mockResolvedValue('linkage-cycle');
    const result = await advanceParentForInlineChild(childState, 'pass', '/test', output);
    expect(result).toBe('blocked');
  });
```

Third — `propagateChildTerminal` has **no** describe block in this file today and is not in its destructured import (verified: absent from `:192-200`). Add it to the import list at `:192-200`:

```typescript
const {
  reportTerminalToDelegatingRun,
  advanceParentForInlineChild,
  buildAdvanceInlineParent,
  extractParentLinkage,
  propagateChildTerminal,
  propagateDrivenRunTerminal,
  propagationRequiresFailureExit,
  inlineAdvanceRequiresFailureExit,
} = await import('../../src/helpers/delegation-completion.js');
```

then add a new describe block after the `advanceParentForInlineChild` block (i.e. before `describe('buildAdvanceInlineParent (CLI execution callable)', ...)` at `:566`):

```typescript
describe('propagateChildTerminal (linkage dispatcher over core seam)', () => {
  it('maps a seam linkage-cycle onto the fail-closed blocked (#602)', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeInlineLinkage(),
    });
    const output = makeOutput();
    propagateTerminalChildUpward.mockResolvedValue('linkage-cycle');
    const result = await propagateChildTerminal(childState, 'pass', '/test', output);
    expect(result).toBe('blocked');
  });

  it('still collapses a seam duplicate to reported (finding 2 regression)', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeDelegationLinkage(),
    });
    const output = makeOutput();
    propagateTerminalChildUpward.mockResolvedValue('duplicate');
    const result = await propagateChildTerminal(childState, 'pass', '/test', output);
    expect(result).toBe('reported');
  });
});
```

- [ ] **Step 9: Run the full affected suites**

Run: `pnpm --filter @rundown-org/core exec jest __tests__/runbook/inline-parent-advance.test.ts __tests__/runbook/collection-service.test.ts && pnpm --filter @rundown-org/cli exec jest __tests__/helpers/delegation-completion.test.ts`

Expected: PASS, all suites green.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/runbook/inline-parent-advance.ts \
        packages/core/src/runbook/collection-service.ts \
        packages/cli/src/helpers/delegation-completion.ts \
        packages/core/__tests__/runbook/inline-parent-advance.test.ts \
        packages/core/__tests__/runbook/collection-service.test.ts \
        packages/cli/__tests__/helpers/delegation-completion.test.ts
git commit -m "fix(core): guard inline parent-advance recursion against linkage cycles (#602)"
```

---

### Task 2: Depth-cap backstop

**Files:**

- Modify: `packages/core/src/runbook/inline-parent-advance.ts` (already carries `MAX_INLINE_PROPAGATION_CHAIN` and the `depth >= MAX` check from Task 1)
- Test: `packages/core/__tests__/runbook/inline-parent-advance.test.ts`

**Interfaces:**

- Consumes: `MAX_INLINE_PROPAGATION_CHAIN` and `propagateTerminalChildUpward` from Task 1.
- Produces: no new symbols — this task pins the cap's behaviour with tests.

The cap code lands in Task 1 (it is one line in the same guard), but it is untested there. This task is the reviewer's gate on the cap *value and boundary*, which is the separable decision: a reviewer can accept the cycle guard and still argue the bound.

- [ ] **Step 1: Write the failing depth-cap tests**

Add to `packages/core/__tests__/runbook/inline-parent-advance.test.ts` (inline arm block). Import the constant by extending the existing import at `:2-6`:

```typescript
import {
  propagateTerminalChildUpward,
  MAX_INLINE_PROPAGATION_CHAIN,
  type AdvanceInlineParent,
  type PropagateTerminalChildUpwardDeps,
} from '../../src/runbook/inline-parent-advance.js';
```

```typescript
  // --- #602: depth cap. The visited-set cannot bound a chain of DISTINCT ids;
  // the cap converts unbounded advance/release/reload work into a fixed bound.

  /** Nth synthetic run id in a long acyclic chain: rd_ + 32 hex chars. */
  const chainRunId = (n: number): RunId => assertRunId(`rd_${n.toString(16).padStart(32, '0')}`);

  it('bounds an over-deep acyclic chain at MAX_INLINE_PROPAGATION_CHAIN', async () => {
    // An unbounded chain of distinct ids: level n's parent is level n+1, forever.
    const child = makeState(chainRunId(0), { parentLinkage: inlineLinkage(chainRunId(1)) });
    let level = 1;
    const load = jest.fn<(id: string) => Promise<RunbookState | null>>(async () => {
      const current = level;
      level += 1;
      return makeState(chainRunId(current), {
        lifecycle: 'completed',
        parentLinkage: inlineLinkage(chainRunId(current + 1)),
      });
    });
    const advanceInlineParent = jest
      .fn<AdvanceInlineParent>()
      .mockResolvedValue({ status: 'done' });
    const result = await propagateTerminalChildUpward(
      makeDeps({ advanceInlineParent, manager: { load } }),
      child,
      'pass',
    );
    expect(result).toBe('linkage-cycle');
    // depth starts at 1 (the child) and grows by one per advance; the guard
    // refuses at depth === MAX, so exactly MAX - 1 advances run.
    expect(advanceInlineParent).toHaveBeenCalledTimes(MAX_INLINE_PROPAGATION_CHAIN - 1);
  });

  it('the cap is 64 — a documented bound, pinned so a change is deliberate', () => {
    expect(MAX_INLINE_PROPAGATION_CHAIN).toBe(64);
  });

  it('a chain exactly at the bound propagates normally (off-by-one boundary)', async () => {
    // MAX - 1 advances then a linkage-free root: the LAST legitimate chain. If the
    // guard used `>` instead of `>=`, or seeded depth at 0, this would still pass —
    // but the over-deep test above would then trip one level late. The two together
    // pin the boundary exactly.
    const child = makeState(chainRunId(0), { parentLinkage: inlineLinkage(chainRunId(1)) });
    let level = 1;
    const load = jest.fn<(id: string) => Promise<RunbookState | null>>(async () => {
      const current = level;
      level += 1;
      // The final run in the chain is the root: no linkage, walk ends naturally.
      return makeState(chainRunId(current), {
        lifecycle: 'completed',
        parentLinkage:
          current === MAX_INLINE_PROPAGATION_CHAIN - 1
            ? undefined
            : inlineLinkage(chainRunId(current + 1)),
      });
    });
    const advanceInlineParent = jest
      .fn<AdvanceInlineParent>()
      .mockResolvedValue({ status: 'done' });
    const result = await propagateTerminalChildUpward(
      makeDeps({ advanceInlineParent, manager: { load } }),
      child,
      'pass',
    );
    expect(result).toBe('handled');
    expect(advanceInlineParent).toHaveBeenCalledTimes(MAX_INLINE_PROPAGATION_CHAIN - 1);
  });
```

`assertRunId` and `RunId` are already imported by this test file (`:7-15`) — verified; no import change needed for them.

- [ ] **Step 2: Run the tests**

Run: `pnpm --filter @rundown-org/core exec jest __tests__/runbook/inline-parent-advance.test.ts -t 'chain'`

Expected: PASS — Task 1 already shipped the `depth >= MAX_INLINE_PROPAGATION_CHAIN` line. If the over-deep test instead hangs or throws `RangeError: Maximum call stack size exceeded`, the cap check was dropped or misplaced in Task 1: re-check it sits with the `visited.has(...)` check, **before** the kind dispatch.

- [ ] **Step 3: Commit**

```bash
git add packages/core/__tests__/runbook/inline-parent-advance.test.ts
git commit -m "test(core): pin the inline propagation depth cap and its boundary (#602)"
```

---

### Task 3: Operator diagnostic for the trip (`onLinkageCycle` → `INLINE_PARENT_CYCLE`)

**Files:**

- Modify: `packages/core/src/runbook/inline-parent-advance.ts` (sink types + required dep + two call sites)
- Modify: `packages/core/src/runbook/collection-service.ts:56-76`, `:633-639`
- Modify: `packages/cli/src/helpers/delegation-completion.ts:209-226`
- Modify: `packages/cli/src/commands/collect.ts:472-479`
- Test: `packages/core/__tests__/runbook/inline-parent-advance.test.ts`
- Test: `packages/cli/__tests__/helpers/delegation-completion.test.ts`

**Interfaces:**

- Consumes: `RunId`, `MAX_INLINE_PROPAGATION_CHAIN`, the guard from Task 1.
- Produces:
  - `LinkageCycleTrip` — `{ readonly runId: RunId; readonly cause: 'repeat' | 'depth' }`.
  - `OnLinkageCycle` — `(trip: LinkageCycleTrip) => void`.
  - `PropagateTerminalChildUpwardDeps` gains **required** `readonly onLinkageCycle: OnLinkageCycle`.
  - `RunbookCollectionServiceDeps` gains **required** `readonly onLinkageCycle: OnLinkageCycle`.
  - `buildLinkageCycleDiagnostic(output: OutputEmitter): OnLinkageCycle` — exported from `packages/cli/src/helpers/delegation-completion.ts`; the single CLI implementation, shared by both wiring sites.

Separable from Task 1: a reviewer can accept the guard and reject this surface. See Decision 6 for why a bare `'blocked'` is not an acceptable end state, and why the sink beats widening the return.

- [ ] **Step 1: Write the failing core sink tests**

Add to `packages/core/__tests__/runbook/inline-parent-advance.test.ts` (inline arm block). `makeDeps` (`:71-100`) must first gain a default so every existing test still constructs a valid deps bag — add to its returned object, before the `...overrides` spread:

```typescript
    onLinkageCycle: () => {},
```

Then the tests:

```typescript
  it('names the repeated run on the sink when the visited set trips (#602)', async () => {
    const child = makeState(CHILD, { parentLinkage: inlineLinkage(CHILD) });
    const onLinkageCycle = jest.fn<(trip: LinkageCycleTrip) => void>();
    const result = await propagateTerminalChildUpward(
      makeDeps({ onLinkageCycle }),
      child,
      'pass',
    );
    expect(result).toBe('linkage-cycle');
    expect(onLinkageCycle).toHaveBeenCalledTimes(1);
    expect(onLinkageCycle).toHaveBeenCalledWith({ runId: CHILD, cause: 'repeat' });
  });

  it('reports the run the walk stalled at, not the entry child, on a deep cycle (#602)', async () => {
    // child(A) -> parent(B) -> back to B itself. The trip is found at level 2, so
    // the operator must be told to prune B — telling them A would be useless.
    const child = makeState(CHILD, { parentLinkage: inlineLinkage(PARENT) });
    const parentTerminal = makeState(PARENT, {
      lifecycle: 'completed',
      parentLinkage: inlineLinkage(PARENT),
    });
    const load = jest
      .fn<(id: string) => Promise<RunbookState | null>>()
      .mockResolvedValue(parentTerminal);
    const advanceInlineParent = jest
      .fn<AdvanceInlineParent>()
      .mockResolvedValue({ status: 'done' });
    const onLinkageCycle = jest.fn<(trip: LinkageCycleTrip) => void>();
    const result = await propagateTerminalChildUpward(
      makeDeps({ advanceInlineParent, manager: { load }, onLinkageCycle }),
      child,
      'pass',
    );
    expect(result).toBe('linkage-cycle');
    expect(onLinkageCycle).toHaveBeenCalledTimes(1);
    expect(onLinkageCycle).toHaveBeenCalledWith({ runId: PARENT, cause: 'repeat' });
  });

  it("distinguishes the depth cause on an over-deep acyclic chain (#602)", async () => {
    const child = makeState(chainRunId(0), { parentLinkage: inlineLinkage(chainRunId(1)) });
    let level = 1;
    const load = jest.fn<(id: string) => Promise<RunbookState | null>>(async () => {
      const current = level;
      level += 1;
      return makeState(chainRunId(current), {
        lifecycle: 'completed',
        parentLinkage: inlineLinkage(chainRunId(current + 1)),
      });
    });
    const advanceInlineParent = jest
      .fn<AdvanceInlineParent>()
      .mockResolvedValue({ status: 'done' });
    const onLinkageCycle = jest.fn<(trip: LinkageCycleTrip) => void>();
    const result = await propagateTerminalChildUpward(
      makeDeps({ advanceInlineParent, manager: { load }, onLinkageCycle }),
      child,
      'pass',
    );
    expect(result).toBe('linkage-cycle');
    expect(onLinkageCycle).toHaveBeenCalledTimes(1);
    // The walk stalls trying to step from level MAX-1 onto level MAX.
    expect(onLinkageCycle).toHaveBeenCalledWith({
      runId: chainRunId(MAX_INLINE_PROPAGATION_CHAIN - 1),
      cause: 'depth',
    });
  });

  it('never fires the sink on a valid acyclic chain (#602)', async () => {
    const child = makeState(CHILD, { parentLinkage: inlineLinkage(PARENT) });
    const parentRoot = makeState(PARENT, { lifecycle: 'completed' });
    const load = jest
      .fn<(id: string) => Promise<RunbookState | null>>()
      .mockResolvedValue(parentRoot);
    const advanceInlineParent = jest
      .fn<AdvanceInlineParent>()
      .mockResolvedValue({ status: 'done' });
    const onLinkageCycle = jest.fn<(trip: LinkageCycleTrip) => void>();
    const result = await propagateTerminalChildUpward(
      makeDeps({ advanceInlineParent, manager: { load }, onLinkageCycle }),
      child,
      'pass',
    );
    expect(result).toBe('handled');
    expect(onLinkageCycle).not.toHaveBeenCalled();
  });
```

Extend the file's seam import (`:2-6`) with `type LinkageCycleTrip`. `chainRunId` is defined in Task 2 Step 1 — keep these tests below it in the same describe block.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @rundown-org/core exec jest __tests__/runbook/inline-parent-advance.test.ts -t 'sink|cause|stalled'`

Expected: FAIL — `LinkageCycleTrip` is not exported (TS error) and `onLinkageCycle` is not a known dep.

- [ ] **Step 3: Add the sink types and the required dep**

In `packages/core/src/runbook/inline-parent-advance.ts`, add above `PropagateTerminalChildUpwardDeps` (currently `:120-136`):

```typescript
/**
 * The trip that ended an upward propagation walk (#602).
 *
 * `cause` is NOT a control-flow discriminant — both causes collapse to the single
 * `'linkage-cycle'` result, and no consumer branches on it. It exists because the
 * two conditions imply different operator inspections: `'repeat'` means the walk
 * reached `runId` twice (a back-edge in a graph built as a tree), `'depth'` means
 * the chain from `runId` upward exceeded {@link MAX_INLINE_PROPAGATION_CHAIN}
 * without ending. Either way the recovery is explicit user action against `runId`.
 */
export interface LinkageCycleTrip {
  /**
   * The run the walk stalled at: the repeated id for `'repeat'`, the last run
   * walked for `'depth'`. This is the run reported to the operator, so it is the
   * id found AT the tripping level — never the entry child's.
   */
  readonly runId: RunId;
  /** Which guard tripped. Diagnostic only; see {@link LinkageCycleTrip}. */
  readonly cause: 'repeat' | 'depth';
}

/**
 * Frontend-supplied diagnostic sink invoked when the upward walk's guard trips.
 *
 * Rendering a diagnostic is a Category A (frontend) side effect, so the seam does
 * not render — it calls this. Required, not optional: a corrupt linkage graph that
 * fails closed with no named run leaves the operator unable to act, and the project
 * makes explicit user action (finish / stop / prune / restart) the only recovery
 * path for invalid persisted state. Called AT MOST ONCE per walk, immediately
 * before the guard returns `'linkage-cycle'`.
 *
 * @param trip - The stalled run and which guard tripped.
 */
export type OnLinkageCycle = (trip: LinkageCycleTrip) => void;
```

and add to `PropagateTerminalChildUpwardDeps` (after `advanceInlineParent`, `:135`):

```typescript
  /**
   * Frontend-supplied diagnostic sink for a tripped linkage guard (#602). Rides
   * the same rail as `advanceInlineParent`: a runtime callable in the deps bag,
   * never persisted.
   */
  readonly onLinkageCycle: OnLinkageCycle;
```

- [ ] **Step 4: Fire the sink at the two guard returns**

In `propagateTerminalChildUpwardInner`, replace the two guard lines from Task 1 Step 4:

```typescript
  if (visited.has(linkage.parentRunId)) {
    deps.onLinkageCycle({ runId: linkage.parentRunId, cause: 'repeat' });
    return 'linkage-cycle';
  }
  if (depth >= MAX_INLINE_PROPAGATION_CHAIN) {
    deps.onLinkageCycle({ runId: childState.id, cause: 'depth' });
    return 'linkage-cycle';
  }
```

The `'depth'` arm names `childState.id` — the deepest run actually walked — because `linkage.parentRunId` was never reached. The `'repeat'` arm names the parent because that is the run the walk would have re-entered. Firing here (not on the way back out) is what keeps the report truthful: the severity collapse in the caller discards everything but the member.

- [ ] **Step 5: Run the core tests**

Run: `pnpm --filter @rundown-org/core exec jest __tests__/runbook/inline-parent-advance.test.ts`

Expected: PASS — the four new sink tests plus everything from Tasks 1-2.

- [ ] **Step 6: Wire core's own deps site (compilation is now red)**

Run: `pnpm --filter @rundown-org/core exec tsc --noEmit`

Expected: FAIL — `Property 'onLinkageCycle' is missing` at `collection-service.ts:634`.

In `packages/core/src/runbook/collection-service.ts`, add to `RunbookCollectionServiceDeps` after `advanceInlineParent` (`:75`):

```typescript
  /**
   * Frontend-supplied diagnostic sink invoked when the upward-propagation guard
   * trips on a corrupt linkage graph (#602). Required for the same reason
   * `advanceInlineParent` is: the collect path can drive the seam, so it must be
   * able to name the offending run to the operator.
   */
  readonly onLinkageCycle: OnLinkageCycle;
```

extend the type import from `./inline-parent-advance.js` with `type OnLinkageCycle`, and thread it at `:633-639`:

```typescript
  const outcome: TerminalUpwardPropagationResult = await propagateTerminalChildUpward(
    {
      manager: input.manager,
      sessionService: input.sessionService,
      completionService: input.completionService,
      advanceInlineParent: input.advanceInlineParent,
      onLinkageCycle: input.onLinkageCycle,
    },
    terminalState,
    undefined,
  );
```

Export `LinkageCycleTrip` / `OnLinkageCycle` from `packages/core/src/runbook/index.ts` alongside the existing `type TerminalUpwardPropagationResult` export (`:177`), so the CLI can type its sink.

Fix the resulting `collection-service.test.ts` constructions by adding `onLinkageCycle: () => {}` to each `new RunbookCollectionService({...})` literal (including the Task 1 Step 8 test).

- [ ] **Step 7: Wire the CLI's two deps sites**

Run: `pnpm --filter @rundown-org/cli exec tsc --noEmit`

Expected: FAIL — `Property 'onLinkageCycle' is missing` at `delegation-completion.ts:220` and `collect.ts:472`.

In `packages/cli/src/helpers/delegation-completion.ts`, add the shared builder above `buildInlineParentAdvanceDeps` (`:209`):

```typescript
/**
 * Build the CLI's linkage-guard diagnostic sink (Category A: terminal rendering).
 *
 * Emits the `INLINE_PARENT_CYCLE` error code — the SAME code the force-terminal
 * path already surfaces for a cyclic inline chain
 * (`core/src/runbook/lifecycle-command-service.ts:1754`). The seam's internal cause
 * is named `linkage-cycle` (broader: its guard precedes the kind dispatch, so it
 * covers delegation linkages too), but both conditions are one operator-facing
 * fact — the persisted linkage graph has a back-edge — with one recovery, so they
 * share one code rather than splitting the operator's index into it (#602).
 *
 * The adapters call `output.flush()` after the seam returns, so the emitted
 * diagnostic lands with the rest of the command's output.
 *
 * @param output - Output emitter owned by the calling command.
 * @returns The sink to place on the core deps bag.
 */
export function buildLinkageCycleDiagnostic(output: OutputEmitter): OnLinkageCycle {
  return ({ runId, cause }) => {
    output.error(
      cause === 'repeat'
        ? `Inline parent cycle detected at ${runId}`
        : `Inline parent chain from ${runId} exceeded the maximum propagation depth`,
      'INLINE_PARENT_CYCLE',
      { runId, cause },
    );
  };
}
```

Add `type OnLinkageCycle` to the existing `@rundown-org/core` import at `:33-44`, and add the sink to `buildInlineParentAdvanceDeps`'s returned bag (`:220-225`):

```typescript
  return {
    manager,
    sessionService,
    completionService,
    advanceInlineParent: buildAdvanceInlineParent(cwd, output, commandStreamOptions),
    onLinkageCycle: buildLinkageCycleDiagnostic(output),
  };
```

In `packages/cli/src/commands/collect.ts`, add to the `new RunbookCollectionService({...})` literal (`:472-479`) — `output` is already in scope there and already feeds `buildAdvanceInlineParent`:

```typescript
    advanceInlineParent: buildAdvanceInlineParent(cwd, output, commandStreamOptions),
    onLinkageCycle: buildLinkageCycleDiagnostic(output),
  });
```

importing `buildLinkageCycleDiagnostic` alongside the existing `buildAdvanceInlineParent` import.

- [ ] **Step 8: Write the CLI diagnostic test**

Add to `packages/cli/__tests__/helpers/delegation-completion.test.ts`, in a new describe block placed after the `propagateChildTerminal` block from Task 1 Step 8. Add `buildLinkageCycleDiagnostic` to the destructured import at `:192-200`:

```typescript
describe('buildLinkageCycleDiagnostic (#602)', () => {
  it('emits INLINE_PARENT_CYCLE naming the repeated run', () => {
    const output = makeOutput();
    buildLinkageCycleDiagnostic(output)({ runId: CHILD_RUN_ID, cause: 'repeat' });
    expect(output.error).toHaveBeenCalledWith(
      `Inline parent cycle detected at ${CHILD_RUN_ID}`,
      'INLINE_PARENT_CYCLE',
      { runId: CHILD_RUN_ID, cause: 'repeat' },
    );
  });

  it('emits INLINE_PARENT_CYCLE naming the run the depth cap stalled at', () => {
    const output = makeOutput();
    buildLinkageCycleDiagnostic(output)({ runId: CHILD_RUN_ID, cause: 'depth' });
    expect(output.error).toHaveBeenCalledWith(
      `Inline parent chain from ${CHILD_RUN_ID} exceeded the maximum propagation depth`,
      'INLINE_PARENT_CYCLE',
      { runId: CHILD_RUN_ID, cause: 'depth' },
    );
  });
});
```

If `makeOutput` (`:202-260`) does not already stub `error`, add `error: jest.fn()` to the object it returns.

- [ ] **Step 9: Run the affected suites**

Run: `pnpm --filter @rundown-org/core exec jest __tests__/runbook/inline-parent-advance.test.ts __tests__/runbook/collection-service.test.ts && pnpm --filter @rundown-org/cli exec jest __tests__/helpers/delegation-completion.test.ts __tests__/commands/collect.test.ts`

Expected: PASS, all suites green.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/runbook/inline-parent-advance.ts \
        packages/core/src/runbook/collection-service.ts \
        packages/core/src/runbook/index.ts \
        packages/cli/src/helpers/delegation-completion.ts \
        packages/cli/src/commands/collect.ts \
        packages/core/__tests__/runbook/inline-parent-advance.test.ts \
        packages/core/__tests__/runbook/collection-service.test.ts \
        packages/cli/__tests__/helpers/delegation-completion.test.ts
git commit -m "feat(cli): name the offending run when the linkage guard trips (#602)"
```

---

### Task 4: Property tests over arbitrary linkage graphs

**Files:**

- Create: `packages/core/__tests__/runbook/inline-propagation-guard.properties.test.ts`

**Interfaces:**

- Consumes: `propagateTerminalChildUpward`, `MAX_INLINE_PROPAGATION_CHAIN`, `OnLinkageCycle` from Tasks 1-3.
- Produces: no new symbols.

The example tests pin named shapes (self-loop, 2-cycle, one long chain). They cannot pin the issue's actual acceptance criterion — **"no repeated side effects"** — which is a statement about *every* graph, and which no test in Tasks 1-3 states. `packages/core` already carries fast-check `^4.9.0` (`package.json:71`) and a `test:property` script (`:33`), with ten property suites in this directory including the adjacent `inline-child-state.properties.test.ts`. Consult the `property-based-testing` skill before writing.

This task precedes mutation (Task 5) deliberately: Stryker's survivors must be assessed against the full suite, so the properties have to exist first or they cannot kill anything.

- [ ] **Step 1: Write the property suite**

Create `packages/core/__tests__/runbook/inline-propagation-guard.properties.test.ts`:

```typescript
/**
 * Property tests for the #602 upward-propagation guard.
 *
 * The example tests pin named shapes (self-loop, 2-cycle, one long chain). These
 * pin the invariants over ARBITRARY linkage graphs — including the issue's actual
 * acceptance criterion, "no repeated side effects", which is a claim about every
 * graph and cannot be stated by any single example.
 *
 * The model: N nodes, each with an arbitrary parent pointer (or none). This
 * generates self-loops, 2-cycles, k-cycles, lassos (a chain into a cycle), long
 * acyclic chains, and linkage-free roots — the whole space the guard must survive,
 * including shapes the real system cannot build (which is the point: the guard
 * exists for corrupt persisted state).
 *
 * Four properties at 200 runs each.
 */

import { describe, it, expect, jest } from '@jest/globals';
import fc from 'fast-check';
import {
  propagateTerminalChildUpward,
  MAX_INLINE_PROPAGATION_CHAIN,
  type AdvanceInlineParent,
  type PropagateTerminalChildUpwardDeps,
  type TerminalUpwardPropagationResult,
} from '../../src/runbook/inline-parent-advance.js';
import { assertRunId, type RunbookState, type RunId } from '../../src/runbook/index.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import { brandStoredOutputsForTest } from '../../src/testing/effective-vars.js';

// ---------------------------------------------------------------------------
// Graph model + arbitraries
// ---------------------------------------------------------------------------

/** `parents[i]` is node i's parent index, or null for a linkage-free root. */
type LinkageGraph = readonly (number | null)[];

const nodeRunId = (n: number): RunId => assertRunId(`rd_${n.toString(16).padStart(32, '0')}`);

/** Dense small graphs: self-loops, 2-cycles, k-cycles, lassos, forests. */
const pointerGraphArb: fc.Arbitrary<LinkageGraph> = fc
  .integer({ min: 1, max: 12 })
  .chain((n) =>
    fc.array(fc.option(fc.integer({ min: 0, max: n - 1 }), { nil: null }), {
      minLength: n,
      maxLength: n,
    }),
  );

/** Long acyclic chains, spanning both sides of the depth cap. */
const longChainArb: fc.Arbitrary<LinkageGraph> = fc
  .integer({ min: 1, max: 200 })
  .map((n) => Array.from({ length: n }, (_, i) => (i === n - 1 ? null : i + 1)));

const graphArb: fc.Arbitrary<LinkageGraph> = fc.oneof(pointerGraphArb, longChainArb);

/** Acyclic chains that stay strictly INSIDE the bound — the no-false-positive space. */
const withinBoundChainArb: fc.Arbitrary<LinkageGraph> = fc
  .integer({ min: 1, max: MAX_INLINE_PROPAGATION_CHAIN - 1 })
  .map((n) => Array.from({ length: n }, (_, i) => (i === n - 1 ? null : i + 1)));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeState(id: RunId, parent: number | null): RunbookState {
  return {
    id,
    runbook: { source: 'project', path: 'test.md' },
    runbookPath: '/tmp/test.md',
    step: '1',
    stepName: 'Step',
    retryCount: 0,
    variables: brandStoredOutputsForTest({}),
    steps: [{ id: '1', status: 'running' }],
    lifecycle: 'completed',
    startedAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
    schemaVersion: 1,
    frontmatterOutputs: [],
    ...(parent === null
      ? {}
      : {
          parentLinkage: {
            kind: 'inline' as const,
            parentRunId: nodeRunId(parent),
            parentStepId: '1',
            parentStep: '1',
            parentFrameKey: buildFrameKey('1'),
            parentEntry: 1,
          },
        }),
  };
}

interface Run {
  readonly result: TerminalUpwardPropagationResult;
  /** Every `parentRunId` passed to advanceInlineParent, in call order. */
  readonly advanced: readonly RunId[];
}

/** Walk `graph` from node 0 with every parent advance reaching 'done'. */
async function walk(graph: LinkageGraph): Promise<Run> {
  const advanced: RunId[] = [];
  const index = new Map<string, number>(graph.map((_, i) => [nodeRunId(i), i]));
  const deps: PropagateTerminalChildUpwardDeps = {
    manager: {
      load: async (id: string) => {
        const i = index.get(id);
        return i === undefined ? null : makeState(nodeRunId(i), graph[i]);
      },
    },
    sessionService: { releaseRunbook: async () => ({}) as never },
    completionService: { recordChildCompletion: async () => 'recorded' as never },
    advanceInlineParent: (async ({ parentRunId }) => {
      advanced.push(parentRunId);
      return { status: 'done' };
    }) as AdvanceInlineParent,
    onLinkageCycle: () => {},
  };
  const result = await propagateTerminalChildUpward(deps, makeState(nodeRunId(0), graph[0]), 'pass');
  return { result, advanced };
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('inline propagation guard — properties (#602)', () => {
  it('the walk always terminates with a member of the result union', async () => {
    await fc.assert(
      fc.asyncProperty(graphArb, async (graph) => {
        // Reaching the assertion at all IS the termination proof: an unguarded
        // walk on a cyclic graph never returns (or throws RangeError).
        const { result } = await walk(graph);
        expect([
          'handled',
          'stopped',
          'blocked',
          'reported',
          'duplicate',
          'linkage-cycle',
          'not-applicable',
        ]).toContain(result);
      }),
      { numRuns: 200 },
    );
  });

  it('advanceInlineParent is invoked at most MAX - 1 times for any graph', async () => {
    await fc.assert(
      fc.asyncProperty(graphArb, async (graph) => {
        const { advanced } = await walk(graph);
        expect(advanced.length).toBeLessThanOrEqual(MAX_INLINE_PROPAGATION_CHAIN - 1);
      }),
      { numRuns: 200 },
    );
  });

  it('no run id is ever advanced twice (the issue AC: no repeated side effects)', async () => {
    await fc.assert(
      fc.asyncProperty(graphArb, async (graph) => {
        const { advanced } = await walk(graph);
        expect(new Set(advanced).size).toBe(advanced.length);
      }),
      { numRuns: 200 },
    );
  });

  it('never trips on an acyclic chain within the bound (no false positives)', async () => {
    await fc.assert(
      fc.asyncProperty(withinBoundChainArb, async (graph) => {
        const { result, advanced } = await walk(graph);
        expect(result).not.toBe('linkage-cycle');
        // Every link in the chain advanced exactly once; the root has no linkage.
        expect(advanced.length).toBe(graph.length - 1);
      }),
      { numRuns: 200 },
    );
  });
});
```

- [ ] **Step 2: Run the property suite**

Run: `pnpm --filter @rundown-org/core exec jest __tests__/runbook/inline-propagation-guard.properties.test.ts`

Expected: PASS, 4 properties × 200 runs. If "no run id is ever advanced twice" fails, fast-check prints the minimal counterexample graph — treat it as a real guard defect, not a test bug, and fix `inline-parent-advance.ts`.

- [ ] **Step 3: Run the property gate**

Run: `pnpm run test:property`

Expected: PASS — the new suite plus the ten pre-existing core suites and the plugin's. This gate is **not** part of `pnpm run verify` (`package.json:65` → `test` → `test:unit`), which is why it is run explicitly.

- [ ] **Step 4: Commit**

```bash
git add packages/core/__tests__/runbook/inline-propagation-guard.properties.test.ts
git commit -m "test(core): property-test the inline propagation guard over arbitrary linkage graphs (#602)"
```

---

### Task 5: Mutation pass and full gates

**Files:**

- Modify (only if survivors demand it): `packages/core/__tests__/runbook/inline-parent-advance.test.ts`, `packages/core/src/runbook/inline-parent-advance.ts`

**Interfaces:**

- Consumes: everything from Tasks 1-4. Produces: no new symbols.

- [ ] **Step 1: Run Stryker scoped to the seam**

Run:

```bash
pnpm --filter @rundown-org/core exec stryker run \
  --mutate 'src/runbook/inline-parent-advance.ts' \
  --incremental false \
  --reporters clear-text,progress
```

Expected: a `clear-text` report listing every surviving mutant with its line. Stryker's jest-runner is configured with `enableFindRelatedTests: true` (`packages/core/stryker.config.mjs`), so it automatically scopes to the test files that statically import the mutated module — no `--testFiles` argument is needed or supported here.

- [ ] **Step 2: Kill the survivors on the guard lines**

Mutants that MUST be killed (they are the guard):

| Mutant | Killed by |
| --- | --- |
| `visited.has(...)` → `false` | the two-node cycle test: the walk now falls through to the depth cap and returns `'linkage-cycle'` anyway, but `advanceInlineParent` runs `MAX - 1` times instead of 1 — a fast assertion kill, no timeout needed. This is why `depth` is threaded explicitly rather than read off `visited.size` (Decision 1): a size-derived cap saturates at 2 in this graph and would never bound the walk, leaving only a Stryker timeout to catch it. Also killed by the properties' no-duplicate-advance invariant. |
| `visited.has(...)` → `true` | any acyclic test — e.g. `'inline→inline chain advances synchronously'` (`:329`) now returns `'linkage-cycle'`; also the no-false-positive property |
| `depth >= MAX` → `depth > MAX` | `'a chain exactly at the bound propagates normally'` + the over-deep advance-count assertion |
| `depth + 1` → `depth` / `depth - 1` | the over-deep chain test (never trips → hangs or overruns the advance count); the at-most-`MAX - 1` property |
| `MAX_INLINE_PROPAGATION_CHAIN` → `65`/`63` | the `toBe(64)` pin + the advance-count assertions |
| `new Set([childState.id])` → `new Set()` | the self-linked test (`parent === child` no longer trips) |
| `new Set(visited).add(...)` → `new Set(visited)` | the two-node cycle test |
| `propagated === 'linkage-cycle'` branch removed | `'a cycle discovered by the recursion outranks a stopped advance'` |
| `cause: 'repeat'` → `'depth'` (or vice versa) | the two Task 3 sink tests asserting the exact trip payload |
| `deps.onLinkageCycle({...})` call removed | `'names the repeated run on the sink…'` / `'distinguishes the depth cause…'` |
| `runId: linkage.parentRunId` → `childState.id` on the repeat arm | `'reports the run the walk stalled at, not the entry child, on a deep cycle'` |

For any OTHER survivor, add a test that distinguishes the mutant — do not weaken an assertion to make it green. If a survivor is genuinely equivalent, annotate it with a scoped `// Stryker disable <MutatorName>: <reason>` + `// Stryker restore <MutatorName>` pair and a comment justifying equivalence, following the existing precedent at `packages/core/src/runbook/collection-service.ts:595-597`.

- [ ] **Step 3: Re-run Stryker and confirm no survivors on the guard**

Run:

```bash
pnpm --filter @rundown-org/core exec stryker run \
  --mutate 'src/runbook/inline-parent-advance.ts' \
  --incremental false \
  --reporters clear-text,progress
```

Expected: every mutant on the guard lines reported `Killed`; the file's score at or above its pre-change score.

- [ ] **Step 4: Run the pre-PR gate AND the gates it does not cover**

`pnpm run verify` bottoms out at unit tests only (`verify` → … → `test` → `test:unit`, `package.json:11`, `:65`). This change touches the inline-composition hot path and adds a property suite, so both extra gates are run explicitly:

```bash
pnpm run verify
pnpm run test:property
pnpm run build && pnpm run test:scenarios:raw
```

Expected: all PASS. `linkage-cycle`, `runId`, and `INLINE_PARENT_CYCLE` are conventional (hyphenated-lowercase member, existing code), so the spell checker needs no new word.

The scenario run is the **false-positive gate**, and the most important of the three. `runbooks/composition/` holds ten inline-composition scenarios — `inline-composition.runbook.md`, `inline-composition-stop.runbook.md`, `inline-child-pass/fail/manual/goto-stop`, `step-runbook-list`, `substep-runbook-list`, `list-fail-any`, `child-task` — which drive real inline parent-advance chains end-to-end through the CLI. A guard that trips on a legitimate chain (an inverted `visited.has`, an off-by-one depth seed) fails them; nothing in the unit suites exercises the seam with a real persisted linkage graph.

**No *cycle* scenario is authorable, deliberately.** A scenario drives real CLI commands, and the linkage graph is a tree by construction: `parentLinkage.parentRunId` is stamped at child launch and always points at an already-existing ancestor, so no command sequence can produce a back-edge. Reaching the guard from a scenario would require hand-corrupting `.rundown/runs/` behind the CLI's back — which the project's no-migration rule treats as invalid state to be rejected, not a fixture to be authored. The trip path is therefore covered at the seam (Tasks 1-3), over arbitrary graphs (Task 4), and mutation-pinned (this task); the scenarios cover only the half a scenario *can* cover — that valid chains still work.

- [ ] **Step 5: Commit**

```bash
git add packages/core/__tests__/runbook/inline-parent-advance.test.ts packages/core/src/runbook/inline-parent-advance.ts
git commit -m "test(core): close mutation gaps in the inline propagation guard (#602)"
```

---

## Acceptance mapping (issue #602)

| Issue AC | Task / evidence |
| --- | --- |
| Cyclic inline linkage terminates deterministically with a documented terminal outcome (no stack exhaustion) | Task 1 steps 1, 4 — `'linkage-cycle'`, guard before every side effect, TSDoc on the union member; Task 4 property 1 (terminates for every graph) |
| …no repeated side effects | Task 1 step 1 (advance/release/record call-count assertions on the named shapes); **Task 4 property 3** — no run id advanced twice, over arbitrary graphs |
| Over-depth chains bounded by a documented limit | Task 1 step 4 (`MAX_INLINE_PROPAGATION_CHAIN = 64`, TSDoc), Task 2; Task 4 property 2 (at most `MAX - 1` advances for any graph) |
| Valid acyclic inline chains propagate unchanged | Pre-existing tests at `inline-parent-advance.test.ts:329` / `:494` stay green (Task 1 step 5) + Task 2's at-the-bound test + Task 4 property 4 (no false positives) + Task 5 step 4's ten `runbooks/composition/` scenarios end-to-end |
| Regression tests for cycle + depth-cap; mutation-pinned | Task 1 step 1, Task 2 step 1, Task 4, Task 5 |
| Scope 1 — signature threading via an internal helper | Task 1 step 4: private `propagateTerminalChildUpwardInner`, exported wrapper stays 3-arg, not re-exported from `index.ts` |
| Scope 2 — bookkeeping survives release/reload, keyed by run id | Task 1 step 4: `visited` (`Set<RunId>`) and `depth` are recursion arguments, never reloaded from disk |
| Scope 3 — trip disposition without silent mapping | Decisions 3/4/5: core keeps the cause; consumers collapse EXPLICITLY onto `blocked`; severity precedence prevents a cycle being downgraded to `handled`/`stopped`. Decision 6/Task 3 keeps the collapse from becoming an *indistinguishable* `blocked`: the operator gets `INLINE_PARENT_CYCLE` naming the run to prune |
