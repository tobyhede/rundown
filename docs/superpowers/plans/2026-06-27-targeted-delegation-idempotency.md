# Plan: Targeted delegation idempotency (issue #468)

**Date:** 2026-06-27
**Issue:** https://github.com/tobyhede/rundown/issues/468
**Branch/worktree:** `worktree-fix-468-targeted-delegation-idempotency`

## Problem

`rd delegate --step <id>` throws `RD-804` (`delegationAlreadyExists`) when the
targeted substep already carries an auto-issued (in-flight, unclaimed)
delegation token. Bare `rd delegate` already handles the same state idempotently
by echoing the existing token with `action: "already-delegated"`.

This breaks `/rundown:planning`, where a DELEGATE step auto-issues a token on
entry and the workflow instructs the agent to run `rd delegate --step 1.1`.

## Desired behavior

- `rd delegate --step S`
  - If S has an in-flight delegation for its authored runbook → **echo** the
    existing token (`action: "already-delegated"`).
- `rd delegate <runbook> --step S`
  - If `<runbook>` matches the in-flight runbook for S → **echo**.
  - If `<runbook>` conflicts with the in-flight runbook → preserve **RD-804**.
- Never re-issue a fresh token except via `--retry`.
- Echo JSON shape must match bare already-issued delegation:
  `{ kind: "delegate", action: "already-delegated", step, runbook, token, parent_run_id }`.

## Current behavior (verified)

`packages/cli/src/commands/delegate.ts`, targeted issuance path:

1. Runbook/step resolution (lines ~178–228):
   - `runbookArg && step` → `resolvedRunbook = inferRunbookFromStep(...)`
     (authored target is authoritative), `requestedRunbook = runbookArg`.
   - `!runbookArg && step` → `resolvedRunbook = inferRunbookFromStep(...)`, no
     `requestedRunbook`.
2. Child runbook resolution + vars (lines ~230–251).
3. Frame key computation (lines ~253–281).
4. `if (requestedRunbook)` block (lines ~283–316):
   - **First** checks `findPendingDelegationForTarget` (a CLI-local ad hoc scan,
     `delegate.ts:388–402`). If a pending delegation exists → throws **RD-804**
     *regardless* of whether the requested runbook matches (the
     `isDifferentRunbook` flag only selects the error message wording).
   - **Then** (no existing delegation) validates requested-vs-authored:
     unresolvable or non-matching requested runbook → `delegationRunbookMismatch`
     (**RD-822**).
5. `createDelegation(...)` (lines ~318–349). For the `--step`-only path with an
   existing delegation, this returns `delegation_exists` → throws **RD-804**.

So two code paths currently produce RD-804 for an already-delegated substep:
the `requestedRunbook` pre-check (explicit-runbook form) and the
`createDelegation` `delegation_exists` result (`--step`-only form).

RD-819 (nested delegation forbidden) is enforced inside `createDelegation`
(step 0: `state.parentLinkage?.kind === 'delegation'` → `parent_is_delegated`,
matched at the `case 'parent_is_delegated':` label `delegate.ts:339` and
rethrown by the shared `throw result.error` at `delegate.ts:342`).

## Design

### Where logic lives (architecture)

> **Revised after review:** the echo-vs-conflict *decision* moves into core,
> mirroring how the bare path lets core own the decision via
> `resolveDelegateTarget` (discriminated `issuable | already-issued | none`) and
> the CLI merely renders it. The earlier plan left that decision in the CLI; the
> review correctly flagged this as a second site deciding "requested == existing
> runbook" (the first is `createDelegation`, `delegation-service.ts:581–586`),
> drifting from CLAUDE.md's "delegation resolution lives in core" and producing a
> message-format inconsistency (CLI used `.path`; core uses `formatRunbookRef` =
> `source:path`).

- **Core owns the targeted resolution decision.** Add a pure
  `resolveTargetedDelegation(...)` to
  `packages/core/src/runbook/delegation-inference.ts` returning a discriminated
  union `{ kind: 'issuable' } | { kind: 'echo'; … } | { kind: 'conflict'; error }`.
  It is the single source of truth for the echo-vs-conflict (RD-804) decision and
  the conflict message. It is built on the pure `findPendingDelegation` scan
  (promoted from the CLI-local `findPendingDelegationForTarget`).
- **CLI is a thin adapter.** It performs front-end runbook discovery
  (`resolveRunbookFile` → `buildRunbookRef`) to turn the *requested* positional
  arg into a serializable `RunbookRef`, hands that to core as data (exactly the
  pattern already used to pass `childRunbookRef` into `createDelegation`,
  `delegate.ts:322–330`), then renders the returned discriminant. No comparison
  or policy logic in the CLI.
- **Why the decision can live in core despite the I/O:** `RunbookRef` is plain
  `{ source, path }` data (no function refs, no process-runtime handles), so the
  CLI does the I/O and passes the *result* to a pure function. The I/O boundary
  justified keeping the *resolution* in the CLI only under the old design; with a
  `RunbookRef` parameter it does not.
- **RD-822 (requested-vs-authored mismatch) stays a CLI post-issuable check** —
  see the CLI section. It is deliberately *not* folded into
  `resolveTargetedDelegation`, because it needs the resolved *authored*
  `childRunbookRef`, and resolving the authored runbook before the echo decision
  would make the echo path depend on authored-runbook resolvability (breaking the
  file-removed idempotency guarantee). RD-822 only fires on the issuable path,
  where resolving the authored runbook is required anyway.
- No persisted-state changes, no schema changes. The `DelegateResponseSchema`
  already includes the `already-delegated` action
  (`packages/core/src/output/zod-schemas.ts:1353`). No migrations / shims.

### Core change: `findPendingDelegation` + `resolveTargetedDelegation`

Add both to `packages/core/src/runbook/delegation-inference.ts`.

`findPendingDelegation` — pure scan, cast-free via a type-guard `.find`
predicate (idiom precedent: `isRetryDelegationInFlightLike` at
`delegate.ts:421`):

```ts
/**
 * Find the in-flight (pending, unclaimed, non-cancelled) delegation on a target
 * substep within a frame, with a recoverable plaintext token. Returns undefined
 * when the step id has no substep segment, when no matching substep state
 * exists, or when the delegation is cancelled/claimed/tokenless. Pure; no I/O.
 */
export function findPendingDelegation(
  state: DelegationInferenceState,
  stepId: string,
  frameKey: FrameKey,
): (StepDelegation & { token: string }) | undefined {
  const parsed = parseStepIdFromString(stepId);
  if (!parsed?.substep) return undefined;
  const match = (state.substepStates ?? []).find(
    (ss): ss is SubstepState & { delegation: StepDelegation & { token: string } } =>
      ss.id === parsed.substep &&
      ss.frameKey === frameKey &&
      ss.delegation?.cancelledAt === null &&
      ss.delegation.childRunId === null &&
      ss.delegation.token != null,
  );
  return match?.delegation;
}
```

`resolveTargetedDelegation` — owns the echo-vs-conflict decision and message:

```ts
/** How the CLI's requested positional arg resolved (front-end discovery). */
export type RequestedRunbookArg =
  | { readonly kind: 'none' } // bare `--step S`
  | { readonly kind: 'resolved'; readonly ref: RunbookRef; readonly raw: string }
  | { readonly kind: 'unresolvable'; readonly raw: string };

export type TargetedDelegateResolution =
  | { readonly kind: 'issuable' }
  | {
      readonly kind: 'echo';
      readonly stepId: string;
      readonly token: string;
      readonly runbookRef: string;
    }
  | { readonly kind: 'conflict'; readonly error: RundownError };

/**
 * Resolve a targeted `rd delegate [<runbook>] --step S` against any in-flight
 * delegation on the substep. Single source of truth for the RD-804
 * echo-vs-conflict decision (the bare path's `resolveDelegateTarget` analogue).
 * Pure; no I/O — the CLI resolves the requested arg to a `RunbookRef` first.
 */
export function resolveTargetedDelegation(
  state: DelegationInferenceState,
  stepId: string,
  frameKey: FrameKey,
  requested: RequestedRunbookArg,
): TargetedDelegateResolution {
  const existing = findPendingDelegation(state, stepId, frameKey);
  if (!existing) return { kind: 'issuable' };

  const matches =
    requested.kind === 'none' ||
    (requested.kind === 'resolved' && sameRunbookRef(requested.ref, existing.childRunbookRef));

  if (!matches) {
    const requestedLabel = requested.kind === 'none' ? '' : requested.raw;
    return {
      kind: 'conflict',
      error: Errors.delegationAlreadyExists(
        stepId,
        `in-flight delegation for a different runbook: requested ${requestedLabel}, ` +
          `existing ${existing.childRunbookRef.path}, token hash ${existing.tokenHash}`,
      ),
    };
  }

  return {
    kind: 'echo',
    stepId,
    token: existing.token, // narrowed to `string` by findPendingDelegation
    runbookRef: existing.childRunbookRef.path,
  };
}
```

- **Cast-free narrowing (review fix):** the type-guard `.find` predicate makes
  `match` carry `delegation: StepDelegation & { token: string }`, so
  `match?.delegation` is `(StepDelegation & { token: string }) | undefined` with
  **no `as` cast**. The earlier plan's "mirrors `deriveDelegateFrontier`"
  rationale was wrong: `deriveDelegateFrontier` is cast-free only because it
  pushes a *fresh `DelegateFrontierEntry` literal* after in-loop control-flow
  narrowing (`delegation-inference.ts:260–266`); it never returns a narrowed
  existing record, so it could not have justified a cast here.
- **`token != null`** (not `!delegation.token`) — behaviorally identical (tokens
  are never `''`) but `!= null` reads as an explicit presence check. The filter
  is deliberate: a pending unclaimed delegation always retains its plaintext
  token (removed only on claim/abort, `types.ts:648–651`), so a (corrupt-only)
  tokenless record is treated as "no pending delegation" and falls through to
  `createDelegation`'s token-agnostic `delegation_exists` guard — no dead
  defensive branch anywhere.
- **Message single-sourced + consistency (review fix):** the conflict message now
  comes *only* from `resolveTargetedDelegation`. It keeps the CLI's historical
  wording (raw requested arg + existing `.path`) so the kept regression test
  `delegate.test.ts:664–691` (`toContain('runbooks/child-b.runbook.md')`) still
  passes. `createDelegation`'s own `delegation_exists` message
  (`formatRunbookRef`, source-qualified, `delegation-service.ts:584–586`) is no
  longer reachable on the targeted CLI path (the decision resolves before
  `createDelegation`), so the two-format divergence the review flagged is gone
  from this surface; that branch remains a defensive internal guard.
- **`findSubstepState` reuse (NIT, declined with reason):** `findSubstepState`
  (`targeting.ts:372`) centralizes id+frameKey matching, but it returns
  `SubstepState | undefined` and cannot express the `delegation.token` narrowing.
  Reusing it would reintroduce a cast or a second narrowing step, defeating the
  cast-free goal above. The type-guard predicate must check the delegation fields
  anyway, so the inline `.find` is the cleaner choice here.
- Import/type notes: `parseStepIdFromString`, `SubstepState` (`./types.js`:15),
  `RunbookRef` (`./runbook-ref.js`:16), and `Errors` are **already imported** in
  `delegation-inference.ts`. The only genuinely new imports are `StepDelegation`
  (add to the existing `./types.js` type import) and `sameRunbookRef`.
  **`sameRunbookRef`:** core has **no** ref-equality export today (verified —
  `runbook-ref.ts` exports only schema/types). Add a tiny pure
  `sameRunbookRef(a, b) => a.source === b.source && a.path === b.path` — best
  placed in `runbook-ref.ts` (its natural home, typed on `RunbookRef`) and
  exported via the barrel. The CLI's local `sameRunbookRef` (`delegate.ts:381`)
  types its params as `Awaited<ReturnType<typeof buildRunbookRef>>` rather than
  `RunbookRef`, but `buildRunbookRef` yields a `RunbookRef`, so the promotion to
  a `RunbookRef`-typed core function is type-compatible. Remove the CLI copy and
  import the core one — single source of truth.
- **Export from the core barrel.** `packages/core/src/runbook/index.ts` uses an
  explicit named export list for `delegation-inference.js` (lines ~158–169) — add
  `findPendingDelegation`, `resolveTargetedDelegation`, and the two new types.
  The CLI helper re-exports `from '@rundown-org/core'`, so without the barrel
  entries the imports will not resolve and the build fails.
- Re-export `resolveTargetedDelegation` (+ types) and `findPendingDelegation`
  from `packages/cli/src/helpers/delegate-inference.ts` alongside the existing
  re-exports.

### CLI change: `delegate.ts`

1. **Reorder** so the targeted idempotency echo runs *before* authored child
   runbook resolution, making the echo path independent of re-resolving the
   authored runbook (idempotent even if the authored file later changes — see the
   optional test in §Tests). The frame-key block (`delegate.ts:253–281`) depends
   only on `resolvedStepId`, `steps` (loaded at line 171), `options.index`, and
   `state` — none of `childResolved`/`childRunbookRef`/`extraVars` — so moving it
   up breaks nothing. **Pin this exact order** (the only order that both compiles
   and delivers the idempotency guarantee):

   1. Runbook/step resolution (current `delegate.ts:174–228`).
   2. Frame-key block, moved up: `parsedTarget`, `explicitIteration`,
      `--index` FOR validation, `activeFrameKey` (current `253–281`).
   3. Resolve the *requested* arg to a `RequestedRunbookArg` (CLI I/O), call
      `resolveTargetedDelegation`, switch on the result: `echo` →
      `emitAlreadyDelegated` + `return`; `conflict` → `throw resolution.error`;
      `issuable` → fall through.
   4. Authored child resolution: `resolveRunbookFile` → `childPath`,
      `childRunbookRef` (current `230–236`).
   5. No-existing RD-822 mismatch check (needs `childRunbookRef`; reuses the
      already-resolved requested arg).
   6. `extraVars` (current `238–251`).
   7. `createDelegation` + persist + emit (current `318–374`).

2. **Replace** the current `if (requestedRunbook)` block with the core-driven
   resolution (CLI does I/O + render only — no comparison/policy):

```ts
// Resolve the requested positional arg to serializable data for core. Only the
// requested arg is resolved here — never the authored target — so the echo path
// stays independent of authored-runbook resolvability.
let requested: RequestedRunbookArg;
if (!requestedRunbook) {
  requested = { kind: 'none' };
} else {
  const r = await resolveRunbookFile(cwd, requestedRunbook);
  requested = r
    ? { kind: 'resolved', ref: await buildRunbookRef(r), raw: requestedRunbook }
    : { kind: 'unresolvable', raw: requestedRunbook };
}

const resolution = resolveTargetedDelegation(state, resolvedStepId, activeFrameKey, requested);
switch (resolution.kind) {
  case 'echo':
    emitAlreadyDelegated(output, {
      stepId: resolution.stepId,
      runbookRef: resolution.runbookRef,
      token: resolution.token,
      parentRunId: state.id,
      text: options.text,
    });
    output.flush();
    return;
  case 'conflict':
    throw resolution.error;
  case 'issuable':
    break;
  default: {
    const _exhaustive: never = resolution;
    return _exhaustive;
  }
}

// Issuable only: authored child resolution (step 4), then preserve the
// requested-vs-authored mismatch validation (RD-822), reusing `requested`.
const childResolved = await resolveRunbookFile(cwd, resolvedRunbook);
if (!childResolved) throw Errors.delegationRunbookNotFound(resolvedRunbook);
const childPath = childResolved.path;
const childRunbookRef = await buildRunbookRef(childResolved);

if (requested.kind === 'unresolvable') {
  throw Errors.delegationRunbookMismatch(resolvedStepId, requested.raw, resolvedRunbook);
}
if (requested.kind === 'resolved' && !sameRunbookRef(requested.ref, childRunbookRef)) {
  throw Errors.delegationRunbookMismatch(resolvedStepId, requested.raw, resolvedRunbook);
}
```

   Notes:
   - The echo/conflict decision and the RD-804 message now live entirely in
     core `resolveTargetedDelegation`; the CLI only resolves I/O and renders.
   - The unresolvable-requested case splits cleanly: **with** an in-flight
     delegation, core returns `conflict` (RD-804); **without** one (issuable),
     the CLI's RD-822 mismatch fires. Both are now covered by tests (see §Tests).
   - Authored child resolution (step 4) runs only on the issuable path, after the
     echo `return`, so the echo never calls `resolveRunbookFile` for the authored
     target and cannot throw `delegationRunbookNotFound`.

3. **Extract** the echo into a shared helper used by both the bare path
   (currently inline at `delegate.ts:199–216`) and the new targeted path, so the
   JSON/text shapes cannot drift:

```ts
function emitAlreadyDelegated(
  output: OutputEmitter,
  opts: { stepId: string; runbookRef: string; token: string; parentRunId: string; text?: boolean },
): void {
  if (!opts.text) {
    output.json({
      kind: 'delegate',
      action: 'already-delegated',
      step: opts.stepId,
      runbook: opts.runbookRef,
      token: opts.token,
      parent_run_id: opts.parentRunId,
    });
  } else {
    output.message(`ALREADY    step ${opts.stepId} -> ${opts.runbookRef}`);
    output.message(`Token:     ${opts.token}`);
    output.message('');
    output.message(`RD_CLAIM_TOKEN=${opts.token}`);
  }
}
```

   Update the bare path to call `emitAlreadyDelegated` too.

4. **Remove** the now-unused CLI-local `findPendingDelegationForTarget`
   (`delegate.ts:388–402`). Import `resolveTargetedDelegation` and the
   `RequestedRunbookArg` type from `../helpers/delegate-inference.js`
   (`findPendingDelegation` need not be imported by the CLI — it is an internal
   dependency of `resolveTargetedDelegation`). Keep the `parseStepIdFromString`
   import (still used for `parsedTarget`).

5. **Drop the now-unused `StepDelegation` type import** from `delegate.ts:35`.
   Its only use is the return type of the removed `findPendingDelegationForTarget`
   (line 392), so leaving it triggers an ESLint unused-import failure. Keep
   `RunbookState`, `TemplateVarValue`, and `FrameKey` on that import line — all
   still used (e.g. by the retry `ResolvedTarget`/`RetryHandlerOptions` types).

6. **`sameRunbookRef`:** the echo-vs-conflict comparison now lives in core
   (`resolveTargetedDelegation`). The CLI still needs `sameRunbookRef` for the
   RD-822 mismatch check (step 5 of the pinned order), so promote the helper to
   core (`runbook-ref.ts`, exported via barrel) and have the CLI **import it**,
   deleting the local copy at `delegate.ts:381` — one source of truth, no
   duplicate definition.

### Invariants preserved

- **RD-819 (nested delegation):** preserved by fall-through, *for all
  system-produced states*. A delegated child (`parentLinkage.kind ===
  'delegation'`) can never accumulate a pending delegation record: auto issuance
  throws RD-819 at `delegation-inference.ts:421` (`inferAllDelegateSubsteps`)
  before creating any record, and manual `createDelegation` returns
  `parent_is_delegated` at `delegation-service.ts:472–478` before its
  existing-delegation check. So in a nested child `findPendingDelegation` returns
  undefined and control falls through to `createDelegation`, which enforces
  RD-819 (rethrown at `delegate.ts:342`). No CLI-side replication of the
  state-machine guard. **Already pinned:** the existing CLI test
  `delegate.test.ts:809–857` ("refuses nested delegation when active runbook is
  itself a claimed child") injects `parentLinkage.kind === 'delegation'` and,
  because `setupDelegation()` aborts the auto-token (no pending delegation), drives
  exactly the fall-through path — it must continue to error RD-819. Core RD-819
  coverage also exists (`create-delegation.test.ts:1209`,
  `delegation-inference.test.ts:192`), so a *new* dedicated fall-through test is
  redundant; we keep `delegate.test.ts:809` as the load-bearing regression guard.
  **Caveat (acknowledged, not guarded):** because the echo now precedes
  `createDelegation`, an *injected/corrupt* state holding both a delegation
  linkage and a tokened pending delegation would echo and bypass RD-819. This is
  unreachable in normal operation and consistent with the project's
  no-corrupt-state stance; we deliberately do not add a CLI-side `parentLinkage`
  short-circuit (that would duplicate state-machine logic).
- **Collection-pending guard (RD `DELEGATION_COLLECTION_PENDING`):** the targeted
  path never calls `resolveCommandIntent` (only the bare path does, gated by
  `isBareDelegationIssue`). Targeted issuance is therefore inherently exempt; the
  echo runs without consulting the guard. Req #5 is satisfied structurally.
- **RD-822 (runbook mismatch):** preserved for the no-existing-delegation,
  requested-runbook path.
- **No re-issue except `--retry`:** `--retry` keeps its own early-return flow
  (`handleRetry`), untouched.

## Tests

### Core — `packages/core/__tests__/runbook/delegation-inference.test.ts`

**`describe('findPendingDelegation')`** (reuse `makeState`, `makeActiveDelegation`,
`buildFrameKey`). **Each negative case must differ from the positive case in
exactly ONE field** — otherwise an AND→OR conjunction mutant on the predicate
survives (the suite would still pass with `||` because two fields are wrong at
once). Start from a single canonical "pending, tokened, matching" fixture and
flip one dimension per case:

1. returns the delegation when a pending, unclaimed, non-cancelled, **tokened**
   delegation exists on the target substep in the active frame (positive).
2. returns `undefined` when the step id has no substep segment (e.g. `"1"`).
3. returns `undefined` when only the substep **id** differs (no id match).
4. returns `undefined` when only the **frame key** differs (frame-scoped).
5. returns `undefined` when only `cancelledAt` is set (`!== null`).
6. returns `undefined` when only `childRunId` is set (`!== null`, claimed).
7. returns `undefined` when only the `token` is absent (token-filter).
8. returns `undefined` when the matching substep has `delegation === undefined`
   (id+frame match, no delegation record) — exercises the `?.` short-circuit.

> **Helper note:** `makeActiveDelegation()` (`delegation-inference.test.ts:61–71`)
> does **not** set a `token` field. The `token != null` predicate filter means
> the positive cases must build delegations *with* a token (extend the helper to
> accept/default `token: 'rdtk_aaa'`); case 7 uses a tokenless one. Without this,
> case 1 fails against the filter.

**`describe('resolveTargetedDelegation')`** (the new decision function):

1. `requested.kind === 'none'` + in-flight delegation → `{ kind: 'echo', token, runbookRef, stepId }` with the existing token.
2. `requested.kind === 'resolved'` matching the existing ref → `echo`.
3. `requested.kind === 'resolved'` with a *different* ref → `{ kind: 'conflict' }`, `error.code === 'RD-804'`, message contains `requested`/`existing`/token hash, **no `rdtk_`**.
4. `requested.kind === 'unresolvable'` + in-flight delegation → `{ kind: 'conflict' }` (RD-804) — pins the branch the CLI cannot reach via `sameRunbookRef` (mutation gap the review flagged).
5. no in-flight delegation (any `requested`) → `{ kind: 'issuable' }`.

**Property test — `packages/core/__tests__/runbook/delegation-inference.properties.test.ts`**
(fast-check; reuse `DelegationSpec`/`substepFromSpec`/`makeFrontierState`/`frameArb`
from the existing file, extending `DelegationSpec`/`specArb` with a `childRunId`
dimension). Invariants for `findPendingDelegation` over a random
`SubstepState[]`:
- **defined IFF** some substep matches `parsed.substep` AND `frameKey` AND
  `cancelledAt === null` AND `childRunId === null` AND `token != null`;
- when defined, the returned record is one of the matching substeps' delegations
  and `result.token` is a non-empty string;
- **determinism:** result is invariant under array reordering of the input
  (mirrors the existing `deriveDelegateFrontier` order-independence property).
  This directly underwrites the mutation-survivability claim for the predicate.

### CLI — `packages/cli/__tests__/commands/delegate.test.ts`

New / updated tests (use existing `setupAutoIssuedDelegation`, `setupDelegation`,
`injectDelegationOutcomeForActiveRun`, `parseCliJsonObject`):

- **NEW (req #1):** after `setupAutoIssuedDelegation()`,
  `rd delegate --step 1.1` → exit 0, `action: "already-delegated"`, `step: "1.1"`,
  `token` equals the auto-issued token, token starts with `rdtk_`.
- **NEW (req #2):** after `setupAutoIssuedDelegation()`,
  `rd delegate runbooks/child.runbook.md --step 1.1` → exit 0,
  `already-delegated`, same token.
- **NEW (req #3):** after `setupAutoIssuedDelegation()` plus a `child-b.runbook.md`
  on disk, `rd delegate runbooks/child-b.runbook.md --step 1.1` → exit ≠ 0,
  `code: "RD-804"`, message contains `in-flight delegation for a different
  runbook`, requested + existing paths, `sha256:`, and no `rdtk_`.
- **UPDATE `collection-pending guard` (req #5, currently lines 170–186):**
  `exempts a targeted delegate --step from the collection-pending guard` — after
  `setupAutoIssuedDelegation()` + `injectDelegationOutcomeForActiveRun()`,
  `rd delegate --step 1.1` now → exit 0, `action: "already-delegated"`, and
  assert `code !== "DELEGATION_COLLECTION_PENDING"` (proves the guard was
  bypassed and the targeted path reached delegation logic and echoed instead of
  erroring). Rewrite the explanatory comment accordingly.
- **UPDATE `inference` (currently lines 535–550):**
  `rd delegate --step 2.1 reports the existing auto-issued delegation as an
  error` → rename/repurpose to assert idempotent echo: exit 0,
  `already-delegated`, `step: "2.1"`, token equals the pre-issued frontier token,
  persisted token unchanged.
- **UPDATE `error cases` (currently lines 639–662):**
  `errors for an existing pending delegation on the same substep...` — the second
  identical `delegate runbooks/child.runbook.md --step 1.1` now echoes: exit 0,
  `already-delegated`, same token. Rename to reflect idempotency.
- **🔴 DELETE/UPDATE the duplicate at `inference` lines 563–587** (review BLOCKER):
  `explicit rd delegate child.runbook.md --step 1.1 reports the existing
  delegation as an error` asserts RD-804 on a *second identical* matching-runbook
  call — functionally the same scenario as lines 639–662 (only array-vs-string
  args differ). Under the new design it now echoes. **Delete it as a duplicate**
  of the (updated) 639–662 test. The original plan omitted this test entirely; a
  TDD executor would otherwise hit an unexplained red. (If kept instead of
  deleted, flip its expectation to echo — but deletion is preferred since it adds
  no coverage over 639–662.)
- **NEW (unresolvable requested + in-flight — review mutation gap):** after
  `setupAutoIssuedDelegation()`, `rd delegate runbooks/made-up-child.runbook.md
  --step 1.1` (a runbook that does **not** resolve) → exit ≠ 0, `code: "RD-804"`,
  no `rdtk_`. This is distinct from the existing `:714` test, which uses
  `setupDelegation()` (auto-token aborted → no in-flight delegation → RD-822).
  Here the in-flight delegation is present, so core returns `conflict` (RD-804).
  Without this case the `requested.kind === 'unresolvable'` → conflict branch is
  uncovered (and is the branch that prevents `sameRunbookRef(undefined, …)`).
- **KEEP unchanged (regression guards):**
  - `errors when an in-flight delegation targets a different runbook...`
    (lines 664–691) — still RD-804 (existing + different runbook).
  - `rejects explicit child runbook delegation when the requested runbook differs
    from the authored target` (lines 693–712) — still RD-822 (no existing +
    different).
  - `rejects explicit child runbook delegation when the requested runbook is not
    authored` (lines 714–728) — still RD-822.
  - `idempotent bare delegate` block (lines 219–243) — still passes (req #4).
  - The existing nested-delegation **RD-819** test (`delegate.test.ts` ~809–857,
    via `setupDelegation()` whose aborted token leaves no pending delegation) —
    must still error RD-819, pinning the fall-through reasoning above.
- **OPTIONAL (strong-idempotency guarantee):** after `setupAutoIssuedDelegation()`,
  delete the authored child runbook file on disk, then `rd delegate --step 1.1`
  → still exit 0, `already-delegated`, same token. Proves the echo path does not
  re-resolve the authored target (justifies the pinned reorder). Omit only if the
  reorder's stronger guarantee is dropped.

### CLI integration — `packages/cli/__tests__/integration/delegation-h3-runbook-substep.test.ts`

- **UPDATE** `does not issue a duplicate manual delegation after frontier
  creation` (lines 295–315): the `rd delegate --step 1.1` call after the bare
  idempotent echo should now also be idempotent — exit 0, output matches
  `already-delegated` and `rdtk_` (the existing token), not RD-804. Update the
  comment that says `--step` "still errors." **Also chain `rd claim <echoedToken>`**
  to prove the echoed token is live (the same delegation a child can claim), not a
  stale string — closes the loop end-to-end.

### Scenario suite — `runbooks/scenario-suite.yaml`

- **ADD a scenario** covering the `/rundown:planning` flow that motivated #468:
  `rd run` a DELEGATE runbook (auto-issues on entry) → `rd delegate --step 1.1`
  (now echoes) → `rd claim ${TOKEN}` → assert `result: COMPLETE`. No scenario
  currently runs `rd delegate --step` at all (verified). `${TOKEN}` is captured
  from the `rd run` entry frontier, so it remains valid after the echo.
  **Documented limitation:** the scenario harness captures delegate tokens only
  from `action === 'delegated'` (not `already-delegated`) and has no per-command
  stdout assertion, so the scenario proves the *workflow stays unbroken*
  (echo → claim → complete) but **cannot** assert the `already-delegated` echo
  JSON shape — that assertion stays at the command-test layer (the NEW req #1/#2
  tests above). Add the scenario for end-to-end coverage; do not rely on it for
  the echo-shape contract.

### Docs

- `packages/claude-code-plugin/skills/delegating-runbooks/SKILL.md` — scan for any
  statement that `--step` re-issues or errors on an already-delegated substep.
  Current quick-reference lines (29–34, 65–86) only document the happy path and
  do not contradict idempotency; add a one-line note that `rd delegate --step S`
  is idempotent (echoes the in-flight token) if it improves clarity. Low priority.

## Execution order (TDD)

1. Core: write `findPendingDelegation` + `resolveTargetedDelegation` unit tests
   (red) → implement both in `delegation-inference.ts` (green). Add the property
   test for `findPendingDelegation`.
2. Core barrel + CLI helper: export/re-export `resolveTargetedDelegation`,
   `findPendingDelegation`, and the new types.
3. CLI: write/upgrade `delegate.test.ts` cases (red) — including the BLOCKER
   delete/update at 563–587 and the unresolvable-requested case — → implement the
   `delegate.ts` reorder + core-driven resolution switch + `emitAlreadyDelegated`,
   remove the local scan, drop the unused `StepDelegation` import, resolve the
   `sameRunbookRef` single-source decision (green).
4. Update the integration test (+ claim-chaining).
5. Add the scenario-suite case.
6. Docs scan/touch-up.

## Verification

```bash
pnpm --filter @rundown-org/core test -- delegation-inference.test.ts
pnpm --filter @rundown-org/core test -- delegation-inference.properties.test.ts
pnpm --filter @rundown-org/cli test -- delegate.test.ts
pnpm --filter @rundown-org/cli test -- delegation-h3-runbook-substep.test.ts
pnpm --filter @rundown-org/cli test -- scenario   # scenario-suite runner (new case)
```

Then broaden:

```bash
pnpm --filter @rundown-org/core test
pnpm --filter @rundown-org/cli test
pnpm run verify   # before PR (format, spell, lint, test)
```

Consider scoped mutation runs on the changed surfaces if time allows:

```bash
pnpm run test:mutate:core -- --mutate packages/core/src/runbook/delegation-inference.ts
pnpm run test:mutate:cli -- --mutate packages/cli/src/commands/delegate.ts --testFiles packages/cli/__tests__/commands/delegate.test.ts
```

## Out of scope

- Actor-source / actor-context ingress plans (the unrelated dated plans under
  `docs/superpowers/plans/`).
- Any change to `--retry` resolution.
- Any persisted-state schema or migration work.
