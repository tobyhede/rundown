# 680/681 — Frame entry single writer, and retry idempotency

<!-- cspell:words HMAC -->

> **Status:** Design, approved for planning.
>
> **Issues:** [#680](https://github.com/tobyhede/rundown/issues/680) (frame entry
> has two writers in the wrong order) and
> [#681](https://github.com/tobyhede/rundown/issues/681) (retry idempotency),
> delivered on one branch. Cluster [#648](https://github.com/tobyhede/rundown/issues/648),
> epic [#564](https://github.com/tobyhede/rundown/issues/564).
>
> **Base:** `issue-608/pr12-transactional-delegation-workflows` (PR 673) at
> `4ca59e6f8`. Every file and line reference below is against that tree.
>
> **Binding prior art:** `docs/superpowers/plans/2026-08-03-608-pr12-review-remediation-addendum.md`
> § "Retry idempotency contract" is the ratified contract for Part B. This
> document does not restate its decisions; it resolves the blocker that descoped
> it and specifies how both halves land together.

## Problem

Frame entry has two writers running in the wrong order.

The XState machine stamps `credential.parentEntry` **during** a transition, from
`RunbookContext.frameEntry` — a mirror of *pre-transition* persisted state seeded
at actor bootstrap (`actor-service.ts:578`, `:931`, `compiler.ts:4742`). A
projection running **after** the machine, `deriveActiveEntryProjection`
(`execution-lifecycle-service.ts:304-340`), then bumps the committed entry on a
frame switch or a same-frame GOTO/RETRY re-entry. Both machine-owned issuance
paths therefore stamp a value exactly one below what the same transaction
commits:

| Path | Stamped | Committed | |
| --- | --- | --- | --- |
| Fresh issuance / frame switch (`compiler.ts:3896`) | 1 | 2 | **lags** |
| `runRetryHook` re-issuance / same-frame re-entry (`retry-hook.ts:374`) | 2 | 3 | **lags** |
| GOTO into the delegating frame | 1 | 1 | agrees |
| Manual `issueDelegation({mode:'retry'})` | 2 | 2 | agrees |

Verified executable, not by inspection:
`packages/core/__tests__/runbook/entry-projection-ordering.investigation.test.ts`
drives real transitions through `RunbookLifecycleCommandService` and asserts the
observed numbers. It passes on the base tree (5/5). The two agreeing rows are the
two paths that do not re-project after the machine runs.

**Nothing is broken today.** `credential.parentEntry` is write-only —
`rg 'credential\.parentEntry' packages/*/src` returns nothing; its only consumer
is HMAC derivation, which reads it back off the same descriptor and is
self-consistent at any value. Every state comparison uses `linkage.parentEntry`,
built from committed state.

**What it blocks.** #681's `unobservedReplacement` predicate is the first
consumer to compare a stamped value against committed state:

```
unobservedReplacement(state, frameKey, D) :=
     D.credential.supersedesTokenHash !== undefined
  && D.childRunId === null
  && D.cancelledAt === null
  && D.credential.parentEntry === inferFrameEntryFromState(state, frameKey)
```

With the lag, the fourth conjunct is always false for machine-issued credentials
and always true for manually issued ones, with nothing distinguishing them. The
contract would work for `rundown delegate --retry` and silently not work after a
machine-driven RETRY — the case it exists for — degrading to today's
unconditional re-mint while reading as implemented.

**Root cause.** Half the frame coordinate comes from the machine and half from a
projection running after it. `deriveActorStatePatch` already persists
`activeFrameKey` from the machine cursor (`actor-service.ts:766`, `:780`) but not
`activeEntry` / `frameEntryCounts`. Meanwhile `deriveActiveEntryProjection`
branches on `lastAction?.type === 'GOTO' | 'RETRY'` — machine-assigned context —
re-deriving a routing decision the machine already made, one module and one step
late.

## Approach

Option 1 from #680, ratified in the remediation handoff § "The decision — taken":
**the machine owns the entry bump.** Options 2 (predict the destination frame
outside the machine), 3 (move issuance out of the Category C actor), and 4
(redefine or soften the conjunct) were rejected there and are not revisited.

Both issues land on one branch. B's tests assert entry ordinals that only A makes
correct, so the order is forced; splitting them would mean writing B's expected
values twice.

## Part A — the machine owns the entry bump (#680)

### A1. One bump rule, one frame-key derivation

`frame-entry.ts` gains two pure functions beside the existing
`inferFrameEntryFromState`.

`advanceFrameEntry(coords, frameKey, reentered) → FrameEntryCoordinates` holds
the bump arithmetic, preserving today's semantics exactly:

- No `activeFrameKey` yet (bootstrap): `entry = frameEntryCounts[frameKey] ?? 1`.
- Frame switch (`frameKey !== coords.activeFrameKey`) or `reentered`:
  `entry = max(frameEntryCounts[frameKey] ?? 0, coords.activeEntry ?? 0) + 1`.
- Otherwise unchanged.
- Always: `frameEntryCounts[frameKey] = max(frameEntryCounts[frameKey] ?? 0, entry)`.

The `max(perFrameCount, previousActiveEntry) + 1` form makes the entry ordinal
run-global and monotonic rather than per-frame-local — entering frame 2 from
frame 1 at entry 5 yields 6, not 1. That is what the code does today and what
`classifyDelegationLiveness` (`targeting.ts:536-545`) and completion-key scoping
are calibrated against. **Preserve it.** This change is about *ordering*, not
about renumbering.

`frameKeyForCursor(stepName, forStack) → FrameKey` becomes the single frame-key
derivation, replacing three subtly different ones:

| Site | Rule today |
| --- | --- |
| `deriveActiveFrame` (`targeting.ts:254`) | `getActiveForContext` — top of stack, rejected if implicit **or** `stepId !== step` |
| `deriveActorStatePatch` (`actor-service.ts:766`) | filter implicit, take last, **no `stepId` check** |
| `buildDelegationIssueInvokeBlock` (`compiler.ts:3874`) | `peekForStack`, `!implicit`, **no `stepId` check** |

They agree today only by accident: `initForStack` (`compiler.ts:1324-1337`)
returns a single-element array rather than pushing, and every frame-exit
transition assigns `EMPTY_FOR_STACK`. Once the machine's entry ordinal depends on
the frame key matching what committed-state readers compute, that accident is
load-bearing and must become a guarantee. Unify on the `deriveActiveFrame` rule
(implicit **and** `stepId` checked) and route all three through it.

### A2. `RunbookContext.frameEntry` becomes authoritative

It stops being a bootstrap mirror of persisted state and becomes the single
writer. Alongside it, a one-shot marker:

```ts
readonly frameReentry?: { readonly cause: 'GOTO' | 'RETRY' };
```

Persisted context carries data only, per the actor-dependency rule — both fields
are plain data and serialise cleanly.

### A3. `syncFrameEntry` as a leaf entry action

An `assign` appended **after** the existing `entryActions.entry` on every
step/substep leaf state node (`buildLeafSubstateConfig`, `compiler.ts:4123`),
parameterised with the state's `stepName`. It computes
`frameKeyForCursor(stepName, context.forStack)`, calls `advanceFrameEntry` with
`reentered = context.frameReentry !== undefined`, writes `context.frameEntry`,
and clears `context.frameReentry`.

Two ordering facts make this work, both checked rather than assumed:

- **After `initForStack`.** FOR-stack initialisation and iteration advance
  already live in that same entry-action slot, so appending puts the sync after
  the iteration is current. This is what makes FOR-iteration frame switches fall
  out for free: the loop-back re-enters the first substep state, `initForStack`
  advances the iteration, `frameKeyForCursor` returns the new key, and the frame
  switch branch bumps.
- **Before the child's `invoke`.** Verified empirically against the workspace's
  own xstate build with a probe machine: a compound state's `entry` assign runs
  before its initial child's `invoke` input factory is read
  (`entry:b` → `entry:b.inner` → `invoke:input-read n=1`). So the sync lands
  before `__issue-delegations` (`compiler.ts:4416`) reads `context.frameEntry`.

**Not attached** to `step::N::__parent-entry::X` states (`compiler.ts:4104`).
Those are same-frame artifact-resolution pass-throughs that route on to the real
leaf; bumping there would double-count.

### A4. The re-entry split

GOTO and RETRY transitions assign `frameReentry`; `syncFrameEntry` consumes and
clears it.

This is deliberately **not** a read of `lastAction`, which is what the projection
does today and what #680 names as the root cause. Two concrete reasons it cannot
be:

1. **`lastAction` double-bumps.** A GOTO into a substep of a parent that declares
   artifacts routes through `__parent-entry::X` and then `step::N::X`
   (`routeThroughParentArtifactsIfNeeded`, `compiler.ts:1050`). That is two state
   entries in one frame under one `lastAction`. The projection gets away with
   reading `lastAction` because it runs once per CLI-level mutation; an entry
   action runs once per state entry. A one-shot marker is consumed by the first
   sync and is therefore immune.
2. **The transition does not yet know the frame.** Transition actions run before
   entry actions, so a bump computed at transition time would read the FOR
   iteration before `initForStack` updates it — wrong for any GOTO into a FOR
   step. The split is exact: the transition declares *that* this is a re-entry;
   the entry action, running later, resolves *which frame*.

### A5. Persist from context

`deriveActorStatePatch` emits `activeEntry` and `frameEntryCounts` (the latter as
`replace(...)`, matching what the projection did) alongside the `activeFrameKey`
it already derives. Keep deriving `activeFrameKey` from the cursor rather than
mirroring `context.frameEntry.activeFrameKey`, and add an invariant test that the
two agree — a cheap standing check that A1's unification holds.

### A6. Delete the second writer

`deriveActiveEntryProjection`, `ExecutionLifecycleService.deriveActiveEntry`, and
`ExecutionLifecycleService.ensureActiveEntry` are removed, with all twelve call
sites:

| File | Sites |
| --- | --- |
| `core/src/runbook/lifecycle-command-service.ts` | `:2389`, `:2403`, `:3137`, `:3173`, `:3199`, `:3359`, `:3367` |
| `cli/src/services/execution.ts` | `:934`, `:1261`, `:1754`, `:1770` |
| `core/src/runbook/completion-service.ts` | `:1046` |

Each becomes a direct read of coordinates the captured or prepared state already
carries. Three things fall out:

- The `transitioned` parameter disappears entirely.
- The inline-launch double-bump workaround at `lifecycle-command-service.ts:2397-2404`
  disappears — it exists only because two writers could each score one `rd goto`.
- The four CLI sites were Category B logic sitting outside core (listed among PR
  12's deferred refactors, #675, but belonging to this decision). That leak
  closes here rather than there.

### A7. Behaviour changes, stated

- **`rundown goto` into a new frame now bumps the entry.** `runNavigationMutation`
  deliberately passes `transitioned=false` so one navigation cannot be scored
  twice; with a single writer that workaround goes and the GOTO row moves from
  "agrees at 1" to "agrees at 2". 2 is the correct number under the stated rule
  ("entry increments when execution enters a frame from another frame"); today's
  1 is the artefact.
- **Derived tokens change.** `parentEntry` is HMAC input, so bearers for
  machine-issued delegations differ. Acceptable — there is no persisted-state
  compatibility contract, and the recovery path is finish/stop/prune/restart.
- **Roughly 36 test files** assert entry numbers, completion keys, or mock the
  removed methods. `actor-service.test.ts`, `execution-loop.test.ts`,
  `lifecycle-command-service.test.ts`, `delegation-lifecycle-read-model.test.ts`,
  and `claim-and-launch.test.ts` carry the most.
- **`entry-projection-ordering.investigation.test.ts`** flips its `not.toBe`
  assertions to `toBe`, drops the arithmetic-lag assertion, and is renamed off
  `.investigation.` — it becomes the regression pin for the fix.

## Part B — retry idempotency (#681)

The contract, decision table, placement argument, and ratified couplings are
fixed by the addendum § "Retry idempotency contract" and are not re-derived here.
What follows is what the implementation needs beyond that text.

### B1. Locate by superseded hash

`DelegationScanService.findByToken` matches `tokenHash` only
(`delegation-scan.ts:58`), and `supersedesTokenHash` has zero production readers
(F2). A replayed retry naming T1 — now superseded by T2 — therefore returns
`token-not-found` today, before any predicate could run.

Add `findBySupersededToken(rawToken)` returning **all** matching rows. Five rows
of the decision table depend on it:

- Rows 3–6 (`token`, `H === Hs`) are unreachable without it.
- Row 8 (RD-828, "multiple rows supersede `H`") is only expressible if the scan
  returns a collection rather than the first hit. It is unreachable by
  construction; it is refused, never resolved.

Row 9 (`token | not located → token-not-found`) is the fallthrough once both
lookups miss.

### B2. `resolveRetryIssuance`

A pure resolver in `delegation-inference.ts` implementing the 15-row table
verbatim, over `unobservedReplacement` with **all four conjuncts**. Returns a
discriminated union — `rotatable | already-replaced | replacement-consumed(reason)
| identity-unmatched | ambiguous` — so the caller narrows on the variant rather
than re-checking predicates. No I/O, never throws.

The fourth conjunct is required, not defensive: a delegation row is keyed
`(id, frameKey)` with no entry component and `substep-reset.ts` preserves
`delegation` across frame re-entry, so without it a replay after a GOTO echoes a
bearer `classifyDelegationLiveness` has already closed as `cursor-advanced` — an
unclaimable token, strictly worse than rotating. **Do not soften it to `>=` or a
one-entry tolerance.**

### B3. Placement

Called from `#issueRetry`'s `beforeEffect` (`lifecycle-command-service.ts:1598`),
after the `exactChildRunId !== linkedChildRunId` guard and the child-liveness
guard, and **before** `const overrides = await input.resolveOverrides?.()`
(`:1691`).

Both boundaries are load-bearing. It may not live in `retryDelegation`, because
`runRetryHook` calls that for every delegated substep in a frame and RETRY is
universal per spec — an echo arm there would return an unhandled result and roll
back the whole machine transition. And it must precede `resolveOverrides`,
which is deliberately deferred so a bad `--input-file` cannot mask a
higher-priority precondition; committed-result recovery is higher priority. This
mirrors the fresh path, where `resolveDelegationIssuance` already decides
echo-versus-issue in `beforeEffect`.

### B4. Surface

- RD-826 `DELEGATION_REPLACEMENT_CONSUMED`, RD-827
  `DELEGATION_RETRY_IDENTITY_UNMATCHED`, RD-828
  `DELEGATION_SUPERSESSION_AMBIGUOUS` registered in `errors/codes.ts`, replacing
  the reservation comment at `:403-406`.
- A new `retry-already-applied` member of `DelegationIssuanceOutcome`
  (`lifecycle-command-service.ts:288`), carrying the re-derived current bearer so
  the caller can rotate by naming it. `createDelegationTokenDeriver` is already in
  scope at that point.
- Rendering in `packages/cli/src/commands/delegate.ts` (both the JSON default and
  `--text`), and documentation in `docs/reference/cli.md` and
  `docs/spec/cli-output.md`.
- No schema change and no derivation change: `supersedesTokenHash` is already
  optional on `DelegationCredentialDescriptorSchema` and already excluded from
  the HMAC input.

### B5. Ratified coupling

Machine-driven RETRY also stamps `supersedesTokenHash` (`retry-hook.ts:164` →
`delegation-service.ts:1088`), so the first manual
`rundown delegate --retry --step X` after a step-level `rundown retry` **echoes**
rather than rotating; the caller rotates by naming the current token, which the
echo response carries. Accepted deliberately: refusal-biased, never double-mints,
remedy in the response. The rejected alternative — a persisted
`retryOrigin: 'manual' | 'transition'` discriminant — adds schema surface under
the no-migration rule to separate two cases whose conservative fallback is
already safe.

## Testing

- **Unit.** `advanceFrameEntry` and `frameKeyForCursor` as pure functions,
  including bootstrap, frame switch, declared re-entry, and the monotonic
  `max(...)` form. `resolveRetryIssuance` gets one case per decision-table row.
- **Machine.** Compiler tests that a frame-entering transition bumps before
  `__issue-delegations` fires; that `__parent-entry::` routing does not
  double-bump; that a FOR iteration advance bumps exactly once; that
  `frameReentry` is consumed by the first sync and not the second.
- **Integration.** `entry-projection-ordering.*.test.ts` flipped to `toBe` on all
  five cases — the direct regression pin. Plus the edge cases #681 lists: frame
  re-entry with a surviving replacement, retry-of-a-retry chains, foreign-claim
  replay, rotated issuing claim, `--run` with a superseded token, and a
  replacement claimed by a terminal versus a live child.
- **Property.** Extend the existing delegation-credential coordinate properties
  to assert stamped-equals-committed across both machine issuance paths, which is
  the invariant Part A establishes and Part B consumes.
- **Mutation.** `pnpm run test:mutate:changed --package core` over the changed
  ranges, judged on in-scope survivors.
- **Manual end-to-end**, per #681's acceptance list — two rotations committed, the
  echo writes no persisted state, no full token in any refusal envelope.

## Risks

| Risk | Mitigation |
| --- | --- |
| A single `prepareActorMutation` drives several state entries, so a per-entry bump could count where the per-mutation projection counted once | Enumerate the multi-entry paths (`__parent-entry::` routing, aggregation RETRY into `firstSubstepStateId`, FOR loop-back, BREAK/NEXT chains) and pin each with a compiler test asserting the entry delta |
| The three frame-key derivations diverge under some FOR shape not covered today | A1 unifies them; A5's invariant test keeps them unified |
| Entry-number churn across ~36 test files hides a real regression in the noise | Land A's production change and test updates as separate commits, so the diff that changes expected numbers is reviewable on its own |
| RD-828 is unreachable by construction and therefore untestable through the public surface | Test `resolveRetryIssuance` directly with a two-row fixture; the resolver is pure |

## Non-goals

- **Q1 — rotated issuing claim dead-ends both echo surfaces.** Recorded in the
  addendum § "Open design questions"; latent, since run-control rotation has no
  production caller. Not addressed here.
- **Q2 / #677 — `retryDelegation` re-mints over a cancelled delegation.** Decided
  to leave; revisit with a step-located abort. The decision table's
  "step / active, `Hs` set, cancelled → `retried`" row is that decision made
  explicit.
- Splitting `lifecycle-command-service.ts`, migrating
  `manual-delegation-machine.ts`'s issuance arms, and the other PR 12 deferred
  refactors (#675).
- Any migration, fallback parser, or compatibility shim for persisted state whose
  entry ordinals were written by the old two-writer model. Finish, stop, prune,
  or restart.
