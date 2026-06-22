# Design Proposal: Substep `reset-on-reopen`

> Status: **Draft proposal** (not yet scheduled). Authored from an
> investigation + dual independent agent verification on 2026-06-05. Audience:
> contributors to `packages/core/src/runbook` (the XState compiler and
> completion/substep machinery).

## 1. Summary

A substep's persisted lifecycle status
(`SubstepState.status: 'pending' | 'running' | 'done'`) is **never reset when a
RETRY or intra-frame GOTO re-opens the substep**. The prior attempt's `done`
status (and its `result`) stay in place. This is not an execution bug — the
state machine re-walks and re-prompts re-opened substeps correctly — but it
leaves the **persisted projection stale**, which a handful of out-of-band
readers (CLI commands, a duplicate guard) can act on incorrectly.

The proposal: make a re-opened substep's status reflect that it is re-opened, so
`done` unambiguously means "resolved in the current attempt." This is done in
**two machine seams** (RETRY and GOTO) via a shared reset, optionally hardened
with a type-level entry stamp so a forgotten reset cannot lie.

## 2. Background — why this is subtle

Three facts combine to create the trap:

1. **Substep rows are created once per frame and never reset.**
   `initializeActiveSubsteps` (`packages/core/src/runbook/actor-service.ts:948`)
   is the only producer of substep rows. It is gated by `frameKey`
   (`alreadyInitialized`, ~`:967`) and skips re-initialization once a frame has
   rows. Even if it were re-invoked, `state.ts:707-717` _preserves_ existing
   same-frame rows. So nothing walks a `done` row back to `pending` except an
   explicit reset.

2. **RETRY and intra-frame GOTO stay in the same `frameKey`.** A RETRY of FOR
   iteration 1 keeps `frameKey = 1|1`; a self-loop / backward GOTO keeps the
   parent frame. So the re-opened substep's `done` row from the _previous_
   attempt survives. (A _new_ FOR iteration gets a fresh `frameKey` and a clean
   `pending` slate — which is why iterations work cleanly and retries do not.)

3. **Resolved completions are deleted on consume.**
   `buildConsumedCompletionPatch` (`actor-service.ts:898-915`, delete at `:913`)
   removes a completion once the actor applies it. After a substep resolves,
   `resolvedCompletions` is empty for it, so `substepStates.status` is the
   **only durable record** that the substep was ever resolved. That is why
   downstream code reads `status === 'done'` at all.

The live `done` write for a manual `rd pass` / `rd fail` flows through
`recordManualCompletion` → `upsertSubstepState(..., {status:'done', result})`
(`completion-service.ts:425`). (`state.ts completeSubstep` exists but has **no
production caller** on the current tree — test/repair only.)

## 3. Verified findings

These were confirmed by two independent agents, including empirical state dumps.

### 3.1 The machine is already correct on re-open (this is _not_ an execution bug)

Substep progression is **positional, not status-driven**:

- CONTINUE advances by index:
  `nextSubstep = currentStep.substeps[currentIndex + 1]` (`compiler.ts:1370`);
  parent-advance guards key on `substepCompletedCount`/position, not status.
- Aggregation fires **structurally** when the last substep resolves
  (`isLastSubstep`, `compiler.ts:957-958`).
- There is **no "skip if already done" guard** on substep nodes; each leaf state
  simply waits for a fresh `PASS`/`FAIL`/`RETRY`/`GOTO`.

Empirically confirmed: after a backward GOTO onto a stale-`done` substep, the
machine re-prompts it, accepts a fresh result, and **overwrites** the stale row.
So the stale `done` never corrupts execution — it only affects readers that
inspect the persisted projection _between_ transitions.

### 3.2 A partial reset already exists (delegated RETRY only)

`retrySingleSubstep` (`retry-hook.ts`) already resets a re-opened substep to
`{status:'pending', result:undefined}` (`:168-171`) — **but only when the
substep carries a `delegation` record** (gated at `:153`
`if (!ss.delegation) return {status:'skipped'}`). Non-delegated substeps are
skipped ("the cursor-re-entry machinery handles their re-execution"). The GOTO
path resets nothing: `buildSimpleGotoAssign` (`compiler.ts:1261-1290`) reassigns
the cursor + retry counters but never touches `substepStates`.

So "reset-on-reopen" is **completing a half-built mechanism**, not greenfield.

### 3.3 The readers (smaller than first thought)

Live readers of `SubstepState.status` that a stale `done` can affect:

| #   | Reader                                                          | Affected by stale `done`?                                                        |
| --- | --------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | `delegation-inference.ts:111` `isSubstepDone`                   | Yes — could mis-infer "already done" for delegate targeting                      |
| 2   | `packages/cli/src/commands/run.ts:421` delegation pre-check     | Yes, but **partially self-guarded** by a cursor-advance check (`run.ts:427-439`) |
| 3   | `packages/cli/src/commands/collect.ts:231` all-resolved check   | Yes — could treat a re-opened substep as resolved                                |
| 4   | `completion-service.ts` duplicate guard (**unmerged**, PR #383) | Yes — the original symptom; see §6                                               |

Corrections to earlier framing discovered during verification:

- `evaluateSubstepAggregation` (`transition-handler.ts:158/164`) is **dead
  code** (test-only; no production caller). The live ALL/ANY aggregation runs
  off `deferredResults` (`compiler.ts:678`), **not** `substepStates`.
- Consequently **`SubstepState.result` has zero live readers.**
- `snapshot-utils.ts:21,33` (`snapshot.status === 'done'`) is the **XState
  actor** status, not `SubstepState` — a false positive in any grep.

Net: the genuine live exposure is `delegation-inference` and `collect` (with
`run.ts` partially self-guarded), plus the unmerged #383 duplicate guard.

### 3.4 Data model

`SubstepState` (`types.ts:602-609`):

```ts
interface SubstepState {
  readonly id: string;
  readonly frameKey: FrameKey;     // buildFrameKey(step, iteration?)
  readonly status: 'pending' | 'running' | 'done';
  readonly result?: 'pass' | 'fail';
  readonly delegation?: StepDelegation;
  readonly inline?: StepInlineChild;
}
```

No entry/attempt stamp — so a `done` from a prior attempt is structurally
indistinguishable from a `done` in the current attempt within the same frame.
The precedent for an entry stamp already exists elsewhere:
`ResolvedCompletion.targetEntry` (`types.ts:629`) + `RunbookState.activeEntry`
(`types.ts:962`). Two Zod schemas validate `SubstepState`: `schemas.ts:481-488`
and `schemas.ts:951-960`.

## 4. The design

### 4.1 Behavioral reset (required)

On **re-open**, reset the affected substep rows to
`{status:'pending', result:undefined}`, scoped to the active `frameKey`, via a
single shared helper:

```ts
// pseudocode — lives in core, called from the machine assigns
function resetReopenedSubsteps(
  step: ResolvedStep,
  frameKey: FrameKey,
  fromSubstepId: string,            // inclusive
  substepStates: readonly SubstepState[],
): readonly SubstepState[]
```

Two call sites:

- **RETRY** — generalize the existing reset in `retrySingleSubstep` so it covers
  _non-delegated_ substeps too, while preserving PR #382's delegated-path
  coordination (`allowLinkedChildRun` / `in_flight` / RD-823). Practically: lift
  the `substepStates` mutation out of the delegation branch into the shared
  helper; keep the delegation re-issue logic where it is.
- **GOTO** — add a `substepStates` assign to the intra-frame substep-GOTO path
  (around `buildSimpleGotoAssign`, `compiler.ts:1261`). Gate it to intra-frame
  substep targets only (cross-step GOTO lands in a different frame handled by
  `initializeActiveSubsteps`).

Reset is **pure computation over context** (Category B in `CLAUDE.md`), so it
belongs in the machine via `runbookSetup.assign(...)` — not in `actor-service`
(a mirror) or the CLI. Use a named/parameterized assign (target id + frameKey
via dynamic `params`); do **not** `switch(event.type)` inside one shared action.

### 4.2 Entry stamp (optional, for a by-construction guarantee)

The behavioral reset alone fixes the bug **by convention**: if a future re-open
path forgets to call the reset, a stale `done` is still perfectly well-typed and
the readers silently consume it. To make stale-`done` **unrepresentable**, add
an entry stamp to the resolved variant and have readers compare it to the live
cursor:

```ts
type SubstepState =
  | { id; frameKey; status: 'pending'; ... }
  | { id; frameKey; status: 'running'; ... }
  | { id; frameKey; status: 'done'; result: 'pass' | 'fail'; resolvedAtEntry: number };
// readers gate on: status === 'done' && resolvedAtEntry === state.activeEntry
```

This mirrors the existing `ResolvedCompletion.targetEntry` pattern. A stale
`done` carries a stale `resolvedAtEntry` and fails the comparison, so a
forgotten reset cannot produce a false positive. Cost: changes the persisted
`SubstepState` shape (both Zod schemas) → a `schemaVersion` bump. Per
`CLAUDE.md`'s no-migration policy, breaking active runs is acceptable and
preferred over compatibility shims.

Recommendation: ship §4.1 first (it closes the live exposure and consolidates
the existing partial reset); treat §4.2 as a follow-up hardening increment.

## 5. GOTO frame-scope semantics (the decision)

When an intra-frame GOTO lands on substep **N**, reset **N through
end-of-frame** (`index ≥ N`), scoped to the active `frameKey`. Leave substeps
before N untouched. Leave other frames untouched.

Rationale: the machine resumes at N and walks _forward_, re-prompting N, N+1, …,
last. Resetting only N would leave N+1..last showing stale `done` to out-of-band
readers in the window before they are re-resolved — a projection state **no
execution path produces** (the machine never resumes at N while treating N+1 as
final). Resetting N..end keeps the projection consistent with the machine's
positional forward-walk, which is the entire justification for doing the reset.

Cases:

| Case                        | Behavior                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------- |
| Self-loop `GOTO N→N`        | reset N..end (just N if N is last)                                                 |
| Backward `at 1.3, GOTO 1.1` | reset 1.1,1.2,1.3 — full re-walk                                                   |
| FOR iteration               | reset only the active frame's N..end; sibling iterations untouched                 |
| Cross-step GOTO             | **no substep reset** — different frame; reset gated to intra-frame substep targets |

Out of scope: **forward GOTO** (`at 1.1, GOTO 1.3`) skips 1.2, which stays
`pending` forever — a pre-existing forward-skip quirk independent of reset.
Reset N..end neither fixes nor worsens it. Track separately.

## 6. Interaction with in-flight work

- **PR #382** (`codex/issue-374-retry-linked-child-guard`, **merged into
  `main`**): adds `allowLinkedChildRun` + an `in_flight`/RD-823 path to the
  **delegation** re-issue in `retrySingleSubstep`. It does **not** touch the
  substepStates reset. Interaction is **textual only** (shared function): the
  §4.1 RETRY refactor must factor the status mutation out while leaving #382's
  delegation coordination intact.

- **PR #383** (`codex/issue-375-error-envelope-registry`, **unmerged**): the
  tactical fix that started this thread. It wraps the original
  `substepStates.status === 'done'` duplicate guard in an `isActiveCursorTarget`
  gate (so the check is skipped when the cursor is _on_ the target — the
  retry/goto re-open case). This is a **reader-side workaround for the exact
  stale-`done` that reset fixes at the source.** With reset-on-reopen, a
  re-opened substep is no longer `done`, so the gate becomes redundant and the
  guard collapses back to the **plain** `status === 'done'` check (still
  required for the double-pass case, since `resolvedCompletions` is consumed).
  Reset **subsumes** #383's gate; the two are layered fixes for one bug, not
  conflicting.

## 7. Implementation plan (sequenced)

1. **Land PR #383 first.** It fixes live CI failures; the gate is correct and
   self-contained. Do not block it on this design.
2. **reset-on-reopen** (single change, on `main` after #383 merges):
   1. Add `resetReopenedSubsteps(step, frameKey, fromSubstepId, substepStates)`
      helper in core (pure).
   2. **RETRY seam:** call it from `retrySingleSubstep` for all substeps (not
      only delegated); preserve #382's delegation re-issue/`in_flight` handling.
   3. **GOTO seam:** call it from the intra-frame substep-GOTO assign
      (`buildSimpleGotoAssign` path), scope `index ≥ N` within the active
      `frameKey`, gated to intra-frame substep targets.
   4. **Revert #383's gate** back to the plain `status === 'done'` duplicate
      guard — **atomically** with 2.2 + 2.3 landing and the scenario suite green
      (see §9 risk).
3. **(Optional follow-up) Entry stamp** (§4.2): add `resolvedAtEntry` to the
   `done` variant, update both Zod schemas, bump `schemaVersion`, switch the
   readers to compare against `activeEntry`.

## 8. Test plan

- **Machine-level (primary), pure `transition()`** — per
  `docs/internal/xstate-patterns.md` Testing: send `RETRY` / `GOTO` into a
  compiled machine and assert `nextSnapshot.context.substepStates` has the
  re-opened entries reset to `{status:'pending', result:undefined}` and
  earlier-than-N / other-frame entries untouched. No actor, no persistence
  round-trip.
- **New scenario fixtures** under `runbooks/for-loops/*retry*`,
  `runbooks/goto/*`, `runbooks/transitions/*`: a RETRY/GOTO over a
  **non-delegated** substep that carried a prior `done` result, asserting it
  re-executes rather than being skipped — these guard the `run.ts` /
  `collect.ts` exposures end-to-end.
- **Regression:** the goto/retry scenario suite must stay green **after the
  gate-revert** (step 2.4) — this is the gate that proves the source-side reset
  replaces the reader-side workaround.
- **Existing:** `packages/core/__tests__/runbook/completion-service.test.ts`
  (the retry-vs-duplicate tests that pin the discriminator) — once the gate is
  reverted, the cursor-gate-specific cases relocate to the machine-level reset
  tests.

## 9. Risks & open decisions

- **Atomic gate-revert (highest risk).** Step 2.4 is only safe once **both**
  reset seams (non-delegated RETRY _and_ GOTO) are in place and the goto/retry
  scenarios pass without the cursor-gate. Revert with only the RETRY seam reset
  and GOTO re-opens re-expose the exact "suppress legitimate re-completion" bug
  #383 fixed.
- **GOTO frame-scope** (decided in §5: N..end) — confirm no consumer wants
  "patch N, keep N+1's result"; none found.
- **#382 shared function.** Keep the delegation re-issue/`in_flight` logic
  intact when factoring the status mutation out of `retrySingleSubstep`.
- **No-migration.** Only the entry-stamp increment (§4.2) changes persisted
  shape; bump `schemaVersion`, reject old state, no shim. The behavioral reset
  (§4.1) changes field _values_ within the existing shape — no migration
  concern.
- **Forward-skip GOTO** quirk (§5) is pre-existing and out of scope; track
  separately.

## 10. Alternatives considered

- **Keep `substepStates` as a result-log; readers consult the cursor.** This is
  what PR #383's gate does. Legitimate under the documented "`substepStates` is
  a mirror; cursor is source-of-truth" contract, and cheaper — but the contract
  stays _implicit_, so the next reader added repeats the bug (which is exactly
  how #383's regression arose). Acceptable only paired with loud documentation
  at the `status` type and each reader.
- **Add a `'reopened'` status variant.** Buys little: the readers are
  `=== 'done'` equality checks, not exhaustive switches, so a new member just
  evaluates `false` silently while still leaving stale `done` representable.
  More surface for less safety than the entry stamp.
