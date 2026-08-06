# 608 PR 12 — transactional collect addendum

**Date:** 2026-08-05 · **PR:** 673 · **Base head at audit:** `4ca59e6f8`

This addendum records the final remediation round on PR 673: making
`rundown collect` transactional, consolidating the delegation runtime capability
shape, deleting the orphaned `AbortCommandService`, and the deviations each
introduced. It supersedes nothing — the two earlier addenda
([credentials](./2026-08-01-608-pr12-deterministic-delegation-credentials-addendum.md),
[review remediation](./2026-08-03-608-pr12-review-remediation-addendum.md)) stand
as written.

## Why collect blocked the merge

`collectDelegationOutcomes` made its authorization decision at
`collection-service.ts:254` and then performed a sequence of separately
committed writes: one `sendAndSync` transaction per drained completion
(`completion-service.ts:1116`), a `DELEGATE_FRONTIER_CONSUMED` commit
(`re-entry-frontier.ts:185`), a terminal `releaseRunbook`, and an upward
propagation. None re-checked the collector's captured `claim_generation`.

That is not an incidental gap. `writeStateAtVersion`'s own docstring
(`runbook-store.ts:1204-1210`) states it guards on `state_version` and **not**
`claim_generation`, and that callers "MUST NOT treat a `committed` result as
evidence that their authority was still valid at commit time." The generation
check lives in `classifyCommitRow` (`:413`), which the collect path never
reached. A bearer removed or replaced after the authorization gate could still
land every one of those writes.

The later bearer verification in `recordClaimSeen` was not a second fence:
`recordPresenterLiveness` types itself `Promise<void>` and never inspects the
returned `ClaimSeenRecordResult`, so `no-claim` was discarded.

Seven lifecycle seams already routed through
`EffectfulActorMutationRunner.runAll`; collect was the sole outlier.

## What was built

**One transaction.** The whole collection now derives in memory from the state
captured under the lease and commits once through `commitOwnedRunSet`, which
re-checks the captured authority. Two properties follow directly: commit-time
supersession is reportable (`claim_superseded` → `STALE_CLAIM`), and partial
collection is unrepresentable — applies, frontier consumption, the terminal
session release, and a delegating grandparent's outcome row either all land or
none do.

**Three new pure seams**, each the fenced twin of an existing persisted one:

| New | Twin of | Substitution |
| --- | --- | --- |
| `RunbookCompletionService.prepareResolvedCompletionDrain` | `drainResolvedCompletionsUnlocked` | `ensureActiveEntry` → `deriveActiveEntry` (projection carried forward, not written); store reads → in-state reads; `sendAndSync` → `prepareActorMutation` |
| `prepareReEntryFrontierConsume` | `projectAndConsumeReEntryFrontier` | consume is derived, not committed; observation deferred to the caller's post-commit step |
| `delegationRuntimeCapabilities` | `createDelegationCredentialIssuer` + `createDelegationTokenDeriver` used in pairs | one branded value with a module-private symbol; the sole producer |

**The wrapper union.** `CollectionWorkflowResult` (`command-policy.ts`) composes
`DelegationPolicyOutcome` with the transactional refusal arms rather than
widening it. `DelegationPolicyOutcome` is shared with
`lifecycle-command-service.ts:348`; widening it in place would force unrelated
consumers to handle refusals they can never receive, and — as plan line 69
records — collapsing collect into a bare `DelegationWorkflowResult` would erase
the collection-specific variants the CLI renders. Every existing policy arm
keeps its JSON/text shape, exit code, and code mapping unchanged.

## Deviations

### D1 — The per-completion commit rationale is answered, not reversed

`completion-service.ts:1124-1131` documents a deliberate trade-off: only the
first apply in a drain carries the parent-advance guard, because re-arming it on
a follow-on apply would let an unrelated child claiming mid-drain abort a pass
whose earlier applies had already committed, stranding them behind a bare
refusal.

That trade-off is a **consequence of partial commits**, and it does not transfer.
The prepared drain commits once, so a refusal leaves nothing committed and there
is no stranded prefix to protect. The case the comment names — applies stranded
behind a refusal — becomes unreachable rather than newly accepted.

The prepared seam accepts no guard at all, for a related reason: its sole caller
passes none today, and an aggregate guard belongs on the commit rather than on an
individual derivation.

### D2 — The shared drain was NOT made atomic in place

`drainResolvedCompletions` is also driven by the CLI execution loop
(`execution.ts:1094`, `:1115`, `:1405`) and `helpers/delegation-completion.ts:202`.
Making it atomic would change behaviour for all of them, including the guard
semantics D1 describes. The prepared drain is a **separate seam** used only by
collect; the persisted drain is untouched.

### D3 — The INLINE upward advance stays outside the transaction

`advanceInlineParent` is a CLI-supplied callable that spawns the composing
parent's execution loop — Category A, an external effect a fence cannot own or
re-run. It runs post-commit, as before.

The DELEGATION arm **did** move inside: `prepareChildCompletion` is a pure state
projection, so a delegating grandparent's outcome row now commits in the same
transaction as the terminal lifecycle that earned it. That closes the window
where a child could be terminal while its parent held no record of it.

The grandparent is named as an aggregate target with
`optionalWhenClaimSuperseded: true`. A delegating parent legitimately has no
controlling claim of its own (released or pruned while its delegation is still
live); treating it as required would let a released parent veto the collect and
strand the child with no way to close.

### D4 — Frontier observation moved after the commit, strengthening disclosure

The unfenced seam guarantees "no bearers disclosed unless the consume committed"
by committing the consume first — which leaves it exposed to a consume that
commits while the surrounding collect does not. The fenced twin cannot observe
until its one commit has landed, so a refused transaction consumes nothing and
discloses nothing.

**Consequence: `RD-829` (`frontier_consume_failed`) is no longer reachable from
`rundown collect`.** A derivation cannot half-commit; the only way the consume
does not land is that the enclosing transaction refused, reported under the
transactional code with the frontier likewise untouched. Both
`docs/spec/cli-output.md` and `docs/reference/cli.md` record this.

The `collection_failed` **reason** `frontier_consume_failed` and the
`DELEGATION_FRONTIER_CONSUME_FAILED` member of that arm's `code` union were
therefore **removed** from `DelegationPolicyOutcome`
(`command-policy.ts:300-331`) rather than left in place. That arm's own docstring
promises "Every member has a real producer (no dead arms)"; retaining an arm
nothing can construct would have made the promise false. A repo-wide grep
confirms no producer survives.

`RD-829` itself stays live on a **different shape**: the execution loop emits its
own envelope from the unfenced `projectAndConsumeReEntryFrontier`
(`packages/cli/src/services/execution.ts:1645`), which still commits its consume
separately. So the error code keeps a producer; the collection reason does not.

### D5 — `AggregateTerminalRelease` gained a `when` discriminator

`runAll`'s `releases` were unconditional, which suits force-abort (it knows
statically that it force-stops the child). Collect does not: whether it reaches
terminal is decided by the drain inside `beforeEffect`, long after the input is
built, and an unconditional release would drop a still-running target off session
targeting on every ordinary collect. `when: 'terminal'` gates the release on the
prepared lifecycle, mirroring the single-run path's existing
`terminalRelease.onComplete` / `onStopped` flags. Default `'always'` preserves
abort's behaviour exactly.

### D6 — The delegation capability pair is one branded value, in four places

CodeRabbit thread #28 was anchored on the `CollectionWorkflowResult` pair. Two
further instances existed (`TransitionDelegationRuntime`,
`PreparedRunControlClaim`), and the CLI option bags carried a fourth. All are now
`DelegationRuntimeCapabilities`.

The brand is load-bearing, not decorative. The thread's own standard was that "if
the type promises same-authority provenance, construct it through a factory or
opaque brand; merely placing two arbitrary functions in an object does not prove
they share authority." A module-private `unique symbol` and a sole producer that
builds both callables from one `authority` argument is what makes the promise
structural.

The concrete defect it removes: `execution.ts` tested
`delegationTokenDeriver === undefined` as a proxy for "do we hold authority to
disclose a frontier" — a question the deriver's absence could only answer by
coincidence. `goto-workflow.ts` forwarded the issuer alone.

### D7 — `AbortCommandService` deleted; abort ownership reallocated

Plan line 83 assigns abort authorization to `AbortCommandService`. This PR moved
it to `RunbookLifecycleCommandService.abortDelegation`
(`lifecycle-command-service.ts:1769`), which authorizes inline at `:1777-1783`
and drives the aggregate through `runAll` at `:1816`, fully subsuming
`authorizeAbortCommand`. Zero production callers remained.

Recorded as a **public API surface change** — five exported symbols removed from
`packages/core/src/runbook/index.ts` — even though there are no repository
production callers and Rundown is unreleased. Retaining the module would have
left a misleading second architectural home.

### D8 — `run.ts` carries unlisted delegation-runtime plumbing

`git diff --stat main...HEAD` shows `packages/cli/src/commands/run.ts` modified,
adding delegation-runtime plumbing onto the `--step --prompted` goto context.
Under plan constraint line 18 an unlisted path is a stop-and-review event in its
own right; recorded here as such. It is a two-line forward of capabilities core
already returns, not new logic.

### D9 — The remaining `run.ts` state write is explicitly deferred

`packages/cli/src/commands/run.ts:242` (`manager.update(link.parentRunId, {
substepStates: updated })`) is the only remaining `manager.update` in
`packages/cli/src` outside tests. It marks the composing parent's substep
`running` under `DelegationLock` after an inline child's engine initialises, and
fires only on the `rundown run --step` inline-launch path.

It is **not** moved here, and the reason is stronger than a layering argument:
`substepStates` is mirrored into the persisted XState snapshot, so
`applyRunbookStateUpdate` silently rewrites machine context via
`patchSnapshotSubstepStates` (`state.ts:64-82`, `:266-273`) whenever
`substepStates` is updated without an explicit snapshot. `run.ts:242` is
therefore already a back-door write into machine context and cannot be relocated
as a plain core helper without carrying the same defect. Moving it requires a new
machine event and compiler wiring. The machine-owned equivalent exists for
authored INLINE steps (`actors/inline-launch-intent-actor.ts:194-203`, wired at
`compiler.ts:3963`) but has no operator-initiated counterpart.

Task 6 of
[the planning audit](./2026-08-01-608-pr12-planning-audit-pr11-head.md#L307-L314)
scopes CLI write removal to delegate, collect, and abort, and its final bullet
independently sanctions leaving the `DelegationLock` span at `run.ts:231`.

**The plan's broad "CLI writes no state" criterion is therefore NOT complete at
this PR**, and must not be represented as such.

## Separately tracked defects

Both predate PR 673 and are filed independently rather than expanding this PR.

**Unfenced stale-derivation lost update.** `sendAndSync` loads state at
`actor-service.ts:1681` capturing no version, but the CAS window does not open
until `runbook-store.ts:1231`; `manager.update` passes a `() => updates` builder
that ignores `current` (`state.ts:622`), so the same stale patch is re-applied
identically on every retry. A concurrent terminal writer can commit first and
then be overwritten back to `running`. Blast radius exceeds the `lifecycle`
field: `snapshot` is replaced wholesale, erasing a concurrent writer's
substep-state and delegation-linkage changes.

PR 673 **widens the exposure**: `re-entry-frontier.ts` is a new file here and
adds a new unfenced `sendAndSync` caller at `:185`
(`DELEGATE_FRONTIER_CONSUMED`), reachable from `rundown run` concurrently. Note
that the transactional collect above removes `rundown collect` from that
caller's reach — collect now derives its consume — so the remaining live callers
are `execution.ts:559`, `:572`, `re-entry-frontier.ts:185` (run only), and
`completion-service.ts:1116`.

**`ensureActiveEntry` stale replacement.** The projection is derived inside
`ensureActiveEntry` at `execution-lifecycle-service.ts:111`, builds the full
`frameEntryCounts` map at `:113` from `base`, then replaces it wholesale through
a later `manager.update` (`:129-133`). The `unchanged` short-circuit compares
against `base`, not against the state the CAS reads. `Math.max` at `:329` maxes
against the stale local read, so a counter can go **retrograde** — and since
completion keys are `frame|entry|substep`, that aliases a completion resolved for
entry 2 onto entry 1. `deriveActiveEntry`'s own docstring (`:71-77`) already
names `ensureActiveEntry` as the unfenced legacy path.

The transactional collect does not fix this defect, but it does stop
participating in it: the prepared drain uses `deriveActiveEntry` and carries the
projection forward on the chained state, so the collect path performs no
unfenced read-modify-write of `frameEntryCounts` at all.

## Stacked delivery

1. Complete this checklist on PR 673.
2. Rebase PR 674 onto the completed PR 673 head.
3. Keep PR 674 limited to the SQLite-only authority cutover and removal of
   obsolete JSON persistence paths, `RunStateLock`, and `SessionLock`.
4. Address the separately tracked stale-derivation defects against the
   post-PR-674 SQLite-only architecture.
