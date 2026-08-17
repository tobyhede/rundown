# #781 — claim retention has no owner: the release-cause design

> **Status:** Prospective design note for [#781](https://github.com/tobyhede/rundown/issues/781). No code written. Produced by a design-it-twice pass (three independent interface designs under different constraints), reconciled into one recommendation, then **revised after verification against the code and against a running CLI**. Read this before implementing #781; the issue's own "what to decide" section asks a narrower question than the code turns out to pose.

## Revision — what verification changed

The first draft of this note was written from reading. Everything below was then checked against the code, and the defect was reproduced with a built CLI. Five things changed, and they are marked **[revised]** where they appear:

1. **§5's recommendation.** Design C was recommended as the base. Both of its distinguishing mechanisms — the `ReleaseScope` field-arity invariant and the ESLint ban — are now rejected, and the third graft is dropped. What survives is the role vocabulary and the placement in core.
2. **§2's census is a third too small.** At least six dispositions never reach `SessionService` at all. They call `projectRunbookRelease` directly inside the mutation runner.
3. **§6 was wrong about `popRunbookIfActive`.** The failure it describes cannot occur as written. Two independent blockers, both recorded there.
4. **§7's idempotence property is false against the code.**
5. **§8's implementation order preserved the defect.** Step 3 as written moves the call sites while keeping the derivation that causes #781.

One thing did not change: the diagnosis in §1–§3. It held on every check.

## TL;DR

1. **#781 is not a disagreement between two dispositions. It is a policy with no owner.** No module decides what happens to a run's claims when that run reaches terminal. Sixteen call sites each derive the answer independently and pass a boolean, and the rule itself is written down only in comments — three of which are wrong.
2. **The consequence is worse than #781 states, and it is reachable in one command.** A released claim is not deleted. It is tombstoned `superseded`, and the orchestrator is told `reason: 'claim-rotated'` — a rotation that never happened.
3. **The rule already exists, latent, and holds at fifteen of sixteen sites.** It is _not_ the natural-vs-explicit rule the code comments claim. It is **addressed vs collateral** — and at the one violating site it is not a policy at all but a stale precondition (§3.1).
4. **The fix is to invert the parameter**, not to flip a boolean. Callers should state the fact they hold ("I addressed this run") and the module should own the conclusion ("therefore the claim survives"). The bug class — a call site deciding policy by omitting an option — then becomes unrepresentable.
5. **But inverting the parameter alone does not fix #781** [revised]. The stale premise lives in two mode derivations upstream of the call site, and they will compute the new vocabulary from the same false input.
6. **The same bug class has two other instances.** `popRunbookIfActive` (§6, now [#788](https://github.com/tobyhede/rundown/issues/788)) and the loop's release of non-terminal runs (§9, now [#789](https://github.com/tobyhede/rundown/issues/789)).

---

## 1. Three corrections to the issue

### 1.1 A released claim is tombstoned, not deleted

`#781` says `stack-pop` "**deletes** every claim controlling the run." Verified against the store, that is not what happens.

`RunbookStore.applySession` (`packages/core/src/runbook/storage/runbook-store.ts:1558-1585`) reconciles the written session against the `claims` table. Any claim row that is `active` in the table but absent from the snapshot is passed to `txn.tombstoneClaim` — it is marked `superseded`, not removed:

```
// Only active claims are droppable; re-marking an existing tombstone would
// fire the resolution-affecting claim triggers for no change.
```

So after a `stack-pop` release, resolution finds the row and returns `{ status: 'superseded', claimId, reason: 'claim-rotated' }` (`session-service.ts:700`, `:750`). `missing` (`:770-772`) is reached only later, once `rd prune` deletes the run and the `ON DELETE CASCADE` takes the claim row with it.

**This makes the defect worse, not milder.** An orchestrator asking about its finished run is not told "no such claim" — it is told the claim was **rotated**, which is a specific and false account of what happened. `missing` at least reads as absence; `claim-rotated` reads as a competing issuance.

It also means the word "delete" in the current call sites and comments is itself part of the defect. Any new vocabulary should say `revoke`, and should reserve "tombstone" for the superseded row rather than for the retained one.

### 1.2 The rule is addressed-vs-collateral, not natural-vs-explicit

`execution.ts:372-375` states the rule as:

> Natural child completion: retain the claim as a terminal tombstone … Explicit teardown (abort/stop/complete) keeps deleting the claim.

The code contradicts it. `lifecycle-command-service.ts:2998`, `:3015`, and `:3106` are the `complete` / `stop` / terminal-confirm paths — explicit teardown by any reading — and all three retain. Teardown-vs-natural is not the axis and never was.

The axis that fits is **addressed vs collateral**: the run the caller acted _on_ keeps its claim; a run swept up so that the addressed run could close loses its own. `lifecycle-command-service.ts:3365` states it almost literally, as `retainClaimsAsTerminal: runId === plan.targetState.id`.

A more useful phrasing of the same rule, because it classifies future cases without re-deriving from call sites: **a claim survives its run iff someone can still come back and read that run's outcome as the answer to what they asked for.**

### 1.3 The reachable trigger is narrower than the issue implies [revised]

The issue implies that every run not addressed by a claim takes the revoking path. It does not.

A run that reaches terminal through the fenced command mutation returns at `execution.ts:1849` and never calls `applyExecutionTerminalRelease` at all — the fence already released it, with retention. Confirmed by test: a runbook that completes normally under `rundown run` keeps its claim `active`, and `rundown pass --claim-id` reports `already-resolved`.

`execution.ts:398` is reached from the **entry-time** terminal checks — `:1258 → :1309` and `:1318 → :1325` — that is, runs already terminal when the loop is entered.

Reproduced with a built CLI. Two `rundown run` invocations, both ending `runbook_stopped`:

| How the run ended | Path | Claim row afterwards |
| --- | --- | --- |
| command exits 1, handler `FAIL STOP` | fence, `execution.ts:1740` | `active` — resolves `terminal` |
| the delegation runbook does not resolve | entry check → `:398` | `superseded` — resolves `claim-rotated` |

In the second case the run row survives with `lifecycle = stopped` and the session stack is empty, so this is the release and not a prune. The CLI tells the holder:

```
Claim id rdclk_0629… was released or replaced and is no longer authority.
Claim the parent's current delegation instead of reusing this id.
```

That delegation does not exist. This is the user-visible shape of the defect, and it needs no race, no second process, and no successful delegation.

**Consequence for the test plan.** A characterisation test built on a plain completion pins the *fence's* retention and passes for the wrong reason. It has to construct an already-terminal loop entry.

---

## 2. The census

Sixteen retention decisions in `packages/*/src`, plus discard-path releases that decide by omission.

| Disposition | Count | Role classification |
| --- | --- | --- |
| Retain (`true`) | 13 | addressed — all of them |
| Revoke (explicit `false`) | 2 | collateral — `lifecycle-command-service.ts:1865`, `:2267` |
| Revoke (by omission) | 1 | **addressed** — `execution.ts:398` ← #781 |

Sites the issue's list omits: `collection-service.ts:735` (retain, addressed), `transition-orchestrator.ts:136` (retain, addressed — but see §3), `session-service.ts:2031` (revoke by omission, see §6).

Destroy-path releases that also decide by omission: `prune.ts:180`, `runbook-pipeline.ts:1015`, `active-runbook-cleanup.ts:110`.

**The rule holds at fifteen of sixteen.** The single violation is `execution.ts:398`.

The decisive evidence that it is a defect rather than an undocumented policy is internal to a single `rundown run`: the fence at `execution.ts:1740` retains the claim for the very same run that `:398` revokes it for, and the fence's comment says so explicitly —

> That applies to the run-control claim `rd run` mints over a 'stack-pop' root just as much as to a delegated child's bearer, so this must not be keyed on the mode.

Two paths, one execution, one run, opposite dispositions. One is wrong, and the one that is wrong reached its answer by saying nothing.

### 2.1 Six dispositions never reach `SessionService` [revised]

The census counts call sites, but they do not all travel through the same seam, and the first draft assumed they did.

`SessionService.releaseRunbook` / `releaseRunbooks` is one route. The other is data: `EffectfulActorMutationRunnerInput.terminalRelease` and `AggregateTerminalRelease` carry the boolean into the mutation runner, which calls `projectRunbookRelease` **directly** inside a synchronous, in-place session callback (`effectful-actor-mutation-runner.ts:355`, `:541`, wired through `commitOwnedState({ updateSession })`). `execution.ts:1740`, `lifecycle-command-service.ts:1865`, `:2267`, `:3363-3366` and `collection-service.ts:735` are all on that route.

Three consequences for any design here:

- A design that unifies only `SessionService.release(...)` states the rule in two places, which is the thing this note objects to.
- The policy function's contract is stricter than "pure inside a `mutateState` callback". It must be **synchronous and in-place**, because that is what `commitOwnedState({ updateSession })` accepts.
- `runAll` throws when a release names a run outside the owned target set (`effectful-actor-mutation-runner.ts:382-386`). A batch of discarded runs cannot route through it, so `prune.ts:180` stays on the `SessionService` path.

---

## 3. Why this is a design problem

`releaseRunbook(runId, { retainClaimsAsTerminal?: boolean })` is a **shallow interface**. The implementation behind it is four lines (`session-service.ts:151-156`): branch on the flag, keep or drop. Everything hard — _deciding_ the flag — is pushed back across the seam to the caller.

The caller holds a **fact**: "I am releasing the run I addressed," or "I am releasing a child as collateral." The interface asks for a **conclusion**: "should this claim survive?" Converting the fact into the conclusion is domain logic. Sixteen callers each performing that conversion is the defect; #781 is what it looks like when one of them converts differently.

- **The parameter is load-bearing at the wrong altitude.** Apply the deletion test and it passes — remove `retainClaimsAsTerminal` and complexity reappears at sixteen sites. That is why it looks fine. The test it fails is the altitude one.
- **A retention decision in `packages/cli` is a real concern, but not the one the first draft named** [revised]. `transition-orchestrator.ts:135` is unreachable: both production callers of `orchestrateTransition` pass `releaseRunbook: false` (`execution.ts:217-222`, `delegation-completion.ts:179-180`), and the `true` policies from `createPass/FailTransitionConfig` go to core's fenced `terminalRelease` instead (`transitions.ts:646`). The live CLI decisions are `execution.ts:376` and `:1740`.

### 3.1 The defect is a derivation, not an omission [revised]

`execution.ts:398` never chose `stack-pop`. Two derivations chose it for it:

- `runbook-pipeline.ts:1158` — from `options.sessionActivation?.kind`, a launch input rather than a fact about the run. `default-stack` **always** mints a run-control claim (`:993-995`, `:1088`), so this arm asserts the exact inverse of the truth.
- `goto-workflow.ts:196-205` — loads the session and returns `stack-pop` when the run has _no_ claim. One caller, `run.ts:375`, whose launch already holds the answer.

The same rule appears at `transitions.ts:253` and `lifecycle-command-service.ts:2606` / `:2902`: the retaining mode iff the target was resolved through a claim.

So `stack-pop` encoded "this run is unclaimed". That was true until `rundown run` began minting a run-control claim over every default-stack root. This is the primary cause, and it is upstream of the parameter. A design that renames the parameter and preserves each site's current disposition carries the defect across the refactor wearing new vocabulary.

---

## 4. The three designs

Three interfaces were designed independently against one constraint set (rule stated once; callers state facts not conclusions; three loop behaviours preserved; new cases must be compile errors; policy in core; batch release covered; `not-found` stays a no-op; no ports — the dependency is in-process; no migrations).

**A — minimal interface.** A five-arm `ReleaseCause` (`ran-to-terminal`, `commanded-terminal`, `collateral`, `discarded`, `deferred`) and a `RELEASE_POLICY` table mapping each cause to `{ claims, fires }`. One `projectRelease` plus one `SessionService.release(releases)` replacing both `releaseRunbook` and `releaseRunbooks`. Single and batch share one shape. Enforces one-cause-per-run with a runtime throw.

**B — maximal flexibility.** `ReleaseCause` as a payload-carrying union (`collateral` carries `of: RunId`; `discarded` carries a reason), and an opaque branded `ReleaseSet` obtainable only through `addressed()` / `discarded()` constructors, so an incoherent set is unrepresentable rather than validated. Policy as a mapped type over the discriminant. Conceded that its `DiscardReason` dispatches nothing today and its `DeferredReleaseOwner` is documentation with one inhabitant.

**C — trivial common case.** The invariant lives in field arity: `ReleaseScope { addressedRunId: RunId; runIds: readonly RunId[] }`, so "exactly one addressed run" is structural. `ReleaseScopeInput = RunId | ReleaseScope` lets the dominant caller write `release(runId)`. Splits _whether_ a release fires (`ReleaseTrigger`) from _what it does to claims_ (role).

---

## 5. Recommendation [revised]

The first draft recommended **C as the base, with three grafts**. Verification removed both of C's distinguishing mechanisms and the third graft, so what remains is A's shape with B's vocabulary and C's placement argument.

### What survives

- **The role vocabulary, three arms:** `addressed | collateral | discarded`. The third is required — C's two-role union cannot express the destroy paths (`prune.ts:180`, `runbook-pipeline.ts:1015`, `active-runbook-cleanup.ts:110`), and classifying them `addressed` would retain claims for runs being destroyed.
- **B's disposition names:** `'retain-as-terminal-evidence' | 'revoke'`. C's `'tombstone'` for the _retained_ case collides with the superseded row that revoking actually produces. Every docblock promising `missing` must be corrected to `superseded` / `claim-rotated`.
- **B's invariant that a claim's disposition depends only on its own run's role** — never on ordering, never on other members of the set. That is what allows `claimDisposition(role)` to widen to `claimDisposition(role, claim)` later, when a run-control claim and a delegated bearer over the same run want different treatment, without touching a caller. Pin it as a property test.
- **The policy lives in core**, and the two derivations in §3.1 are deleted rather than translated.
- **C's argument on the default**, which is the load-bearing one, because the current design also has a trivial default and that default is what causes the bug:

  > `release(runId)` does not mean "do the usual thing" — it means "I addressed this run." The failure mode of a defaulted policy is silently inheriting a rule that changed underneath you; that mode does not exist for a defaulted fact, because the caller keeps asserting something still true. The old default failed for the opposite reason: it asserted nothing, and omission was silently read as the destructive direction.

  Paired with an observation the other designs missed: **retention is the recoverable direction.** A retained claim is garbage-collected when its run is pruned; a revocation cannot be reconstructed. So the majority case and the fail-safe case are the same case.

### What is rejected

- **`ReleaseScope` field arity.** It encodes the _count_ of addressed runs, which was never in doubt, not the disposition, which is the actual invariant. Adding the third role makes the role a per-run property that arity cannot carry, so C's base and its own first graft are mutually exclusive. And `prune.ts:180` releases N runs with **no** addressed run, which a mandatory `addressedRunId` cannot express. Use `readonly RunRelease[]`.
- **The ESLint ban on `retainClaimsAsTerminal`.** An admission, not enforcement. The `Error.isError` precedent bans a platform global that cannot be deleted; this identifier is repo-owned, and once it is gone the exhaustive union _is_ the enforcement. The ban would also have to enumerate `retainClaimsAsTerminalRunId` and the `AggregateTerminalRelease` field, and it stops nobody adding `retainClaimsAsX`. Keep it as a cheap tripwire if you like — not as the reason to prefer a design.
- **Returning `retainedClaimKeys` / `revokedClaimKeys`.** §7 argues the assertion belongs at the resolution seam, not the projection, which is an argument against returning them. The payload is nearly dead already: `ReleaseRunbookResult.status` has exactly one reader in the tree (`session-service.ts:1873`, building `releasedRunIds`), and `releasedRunIds` / `nextDefaultRunbookId` are read by nobody — `prune.ts:180` and `lifecycle-command-service.ts:3251` / `:3480` check only `.kind`. Delete `ReleaseRunbookResult` rather than widen it. (The first draft said the projection "computes both and discards them"; it uses them, for the `not-found` decision.)
- **A `deferred` role.** "Release nothing" is the empty array. `execution.ts` already spells it `onComplete: false`.

### The interface

```ts
// packages/core/src/runbook/session-release.ts — sync, in-place, no IO
export type ReleaseRole = 'addressed' | 'collateral' | 'discarded';
export type ClaimDisposition = 'retain-as-terminal-evidence' | 'revoke';
export function claimDisposition(role: ReleaseRole): ClaimDisposition;

export interface RunRelease {
  readonly runId: RunId;
  readonly role: ReleaseRole;
}

/** In-place projection onto a session snapshot. Replaces projectRunbookRelease. */
export function projectRunRelease(session: SessionData, release: RunRelease): boolean;

/** Stack-only removal, no claim disposal. Serves popRunbookIfActive (#788). */
export function projectStackDeactivation(
  session: SessionData,
  runId: RunId,
): { readonly status: 'removed'; readonly nextTopId: RunId | null } | { readonly status: 'absent' };
```

```ts
// SessionService — one method replaces releaseRunbook + releaseRunbooks
release(releases: readonly RunRelease[]): Promise<SessionMutationResult<ReleaseOutcome>>;

// the mutation-runner seam (§2.1), which must take the same vocabulary
readonly terminalRelease?: { onComplete: boolean; onStopped: boolean; role: ReleaseRole };
readonly releases?: readonly (RunRelease & { when?: 'always' | 'terminal' })[];
```

Note that C's "split the trigger from the role" is not new. The trigger axis already exists, as `onComplete` / `onStopped` and `when: 'always' | 'terminal'`. It must be reconciled with those rather than introduced, and `onComplete` / `onStopped` are equal at every live call site and look collapsible.

### The CLI mode union collapses with it

Both releasing arms of `ExecutionTerminalReleaseMode` make the same call to the same address and differ by one boolean, and that boolean is a property of how the run ended, not of the caller. The fence already hard-codes retention in both modes and says the decision must not be keyed on the mode (`execution.ts:1732-1740`).

```ts
/** Who commits the terminal session release for the run this loop drives. */
export type ExecutionReleaseOwner = 'loop' | 'caller';
```

The comment at `:366-368` guards against "not release-runbook" coming to mean "stack-pop". Deleting the arm removes the hazard rather than defending against it; keep the exhaustive `switch` / `never`.

Core already owns this decision — `LifecycleTerminalReleaseMode`, decided at `lifecycle-command-service.ts:2606` / `:2902` and returned on the seam outcome. The CLI derivations duplicate or contradict it, and `goto-workflow.ts:196-205` is a Category-B side effect stranded in the CLI: pure `loadSession` plus a lifecycle decision, no external dependency.

**The drain gap closes as a by-product.** `execution.ts:1411` and `:1431` test the mode where they mean to ask who owns the release, so in `stack-pop` mode a run that reaches terminal inside the drain is never released and stays on the default stack — the drain's core primitive touches only run state (`completion-service.ts:1431-1500`). With a two-arm union both become `owner === 'loop'`. Moving the drain's release _inside_ the completion service's transaction, the way the command fence does, remains a separate change; combining the two risks a double release.

---

## 6. `popRunbookIfActive` — a separate defect, with a corrected account [revised]

`session-service.ts:2031` calls `this.releaseFromSession(ctx.session, expected)` with no options, so it revokes by omission — structurally the same shape as `execution.ts:398`. Filed as [#788](https://github.com/tobyhede/rundown/issues/788).

### 6.1 The undo does strictly more than the operation

`pushRunbookIfNotActive` (`session-service.ts:1224-1232`) touches exactly one structure:

```ts
ctx.session.defaultStack.push(id);
```

It mints nothing. It does not read or write `session.claims`.

Its undo routes through `releaseFromSession` → `projectRunbookRelease`, which filters the default stack, clears the stash slot, **and revokes every claim controlling the run**. The undo of a stack push disposes of authority the push never created.

That asymmetry is the defect, and it is visible without reference to any retention rule. The comment above the call (`:2024-2030`) discusses only the stack and the new top; claim disposal is not mentioned, which is consistent with it being incidental — `projectRunbookRelease` was the available primitive, not a chosen policy.

There is a second asymmetry the first draft missed: `pushRunbookIfNotActive` appends whenever the run is not the **top**, even when the stack already holds it lower down, while `projectRunbookRelease` filters **every** occurrence. The undo can therefore remove an entry the push did not add.

### 6.2 The failure chain in the first draft cannot occur

The first draft described a chain in which an inline child issues a delegation, its owner dies, a second process reclaims the launch, the consume throws, and the rollback revokes a bearer that can never be re-minted. Two independent blockers make that chain unreachable, and both were checked against the code.

**The child cannot have issued a delegation while the intent is unconsumed.** The consume runs before the child's execution loop on both branches — `runbook-pipeline.ts:1135` then `:1150` for a fresh launch, `execution.ts:702` then `:769` for a resumed one. Executing an authored `DELEGATE` needs that loop. Once the consume commits, the machine clears the intent (`compiler.ts:5264`), `persistedInlineLaunchIntentMatches` returns false and the latch reports `superseded` (`inline-launch-latch.ts:462-463`), so `:725` is never reached. A frame re-entry does not rescue it either: the entry counter advances and the child is refused `superseded-entry` (`inline-launch-latch.ts:78-84`).

**The undo is gated, and push+mint is atomic.** The rollback needs `activation.status === 'pushed'` (`execution.ts:719`), and `runbook-pipeline.ts:1088` writes the stack entry and mints the claim in one transaction. That splits the crash window, and both halves are harmless:

| Owner dies | Child claimed? | Child is stack top? | Outcome |
| --- | --- | --- | --- |
| after `manager.create`, before push+mint | no | no | the push happens, but there is no claim to revoke |
| after push+mint, before the consume | yes | yes | `already-active` — no undo runs at all |

So the harm needs conditions the chain did not state: something pushed above the child (or the child stashed) so the push returns `pushed`, **and** someone driving the child with its bearer into a `DELEGATE` while the launch is stranded. Reachable, but contrived. #788 is labelled accordingly.

### 6.3 The disposition, and the seam

Neither `retain-as-terminal-evidence` nor `discarded` is right. Retention is meaningless for a non-terminal run, and the run is not discarded — it survives and is resumed.

**An activation undo must not touch claims at all.** Undo exactly what the operation did: the push wrote one stack entry, so the pop removes one stack entry — the **topmost occurrence**, not every occurrence.

This wants `projectStackDeactivation` (§5), a sibling of the release rather than a fourth role on it. Do not decompose `projectRunbookRelease` into stack / claims / stash primitives instead: every call site would then re-assemble the invariant, which is this same defect by assembly rather than by omission, with no single default left to audit.

Three further findings, all verified:

- **The stash clear does not belong there either.** The push never wrote the slot, and the clear is nearly unreachable: `stash()` pops the stack when it sets the slot (`session-service.ts:2079-2080`), so the top and the slot are disjoint except through a duplicate entry.
- **The guard should go with it.** A stack-only projection issues zero guarded statements: `session_stack` has no triggers (only `claims_guard_*` and `stash_guard_*` exist, `schema.ts:250-330`), `setStack` is an unguarded DELETE+INSERT (`runbook-store.ts:2398`), and `setStash` writes nothing when the slot is unchanged (`:2422-2425`). Today's `execution_in_progress` / `recovery_required` therefore come only from `mutateSessionGuarded`'s application-level preflight (`runbook-store.ts:1490-1527`), which refuses on `exec_token IS NOT NULL` with no liveness probe — and the undo's only caller is the crash-recovery path where the child provably holds a lease naming a dead pid. The guard refuses precisely when the undo must run. This is the argument the push's own docblock already makes for being unguarded (`session-service.ts:1208-1218`).
- **Do not add `UNIQUE(run_id)` to `session_stack`** to solve the duplicate. That is a persisted-state invariant change, and an existing session carrying a duplicate becomes unloadable with only `prune` as recovery.

`projectStackDeactivation` is a **prerequisite** of the work in §8, not a follow-up: if the role vocabulary lands first without it, `popRunbookIfActive` stays on the release primitive and #788 becomes a second edit to the same seam.

---

## 7. What must be tested [revised]

**Characterise before changing.** The current answer is `superseded` / `claim-rotated`, not `missing`. A test asserting `missing` would be pinning a state that is only reachable after a prune, and would pass for the wrong reason.

- **The regression pin, at the resolution seam and not the projection.** Drive a run to an **already-terminal loop entry** — a delegation-resolution failure during initialization is the cheapest (§1.3) — then resolve the run-control claim. Today: `superseded` / `claim-rotated`. After: `terminal`. Note that a plain completion does **not** exercise this: the fence retains, and the assertion would pass under both old and new code.
- **One case per role**, asserting the resolved status rather than the stored shape.
- **Order-independence:** a member's disposition is invariant under permuting the other members of a set.
- **Repeated release.** The first draft asserted that applying the same release twice commits, the second time all-`not-found`. That is false: `projectRunbookRelease` counts retained claims in its `not-found` test (`session-service.ts:163-170`), so a repeated `addressed` release reports `released`. Nothing in product code reads that status, so the safety argument survives — but the property to pin is "the second application changes nothing", not "the second application reports `not-found`".
- **Multi-process**, per CLAUDE.md: unit suites that mock the session boundary cannot observe the tombstone surviving a process boundary. One integration case — complete a root in one process, resolve its claim from another.

---

## 8. Implementation order [revised]

The first draft's step 3 said "move call sites, each preserving today's disposition". That preserves #781: the two derivations in §3.1 compute the new role from the same stale premise, and the defect crosses the refactor wearing new vocabulary. The order below fixes that, and adds the prerequisite from §6.3.

1. Land the characterisation tests against **current** behaviour, asserting `superseded` / `claim-rotated` from an already-terminal loop entry. They must pass before anything moves.
2. Land `projectStackDeactivation` and move `popRunbookIfActive` onto it (#788). Self-contained, and a prerequisite for the rest.
3. Add the role vocabulary and `claimDisposition` in core, with no callers. Sync, in-place, no IO — safe both inside a `mutateState` build callback and inside `commitOwnedState({ updateSession })`.
4. Move both seams onto it — `SessionService.release(releases)` **and** the mutation-runner route from §2.1 — each preserving today's disposition. Behaviour-neutral; the step-1 tests do not move.
5. **Delete the two mode derivations** (`runbook-pipeline.ts:1158`, `goto-workflow.ts:196-205`) and collapse `ExecutionTerminalReleaseMode` to the ownership union. This is the #781 fix and the only commit in which the characterisation test changes. It also fixes #789 and closes the drain gap.
6. Delete `retainClaimsAsTerminal`, `retainClaimsAsTerminalRunId` and `ReleaseRunbookResult`.
7. Handle the drain's in-transaction release as its own commit with its own test.

Steps 4 and 5 stay separate for the same reason PR #780 held claim disposition constant while changing addressing: a regression in either must remain traceable to one of them.

---

## 9. The loop releases runs that are not terminal [revised]

Filed as [#789](https://github.com/tobyhede/rundown/issues/789).

`applyExecutionTerminalRelease` is also called for runs that are still live — `execution.ts:1561` (no delegation deriver, `ACTOR_CONTEXT_REQUIRED`), `:1612` (frontier projection refused, RD-821) and `:1638` (frontier consume failed, RD-829, documented as retryable). In `stack-pop` mode each revokes the claims of a live run.

Such a run has always issued delegations, because a persisted frontier holds one entry per re-issued delegation (`retry-hook.ts:35`). So `adoptRunControlClaim` refuses a replacement (`session-service.ts:880-898`), and for a root run nothing would mint one anyway — `issueRunControlClaim` has no product caller.

No command sequence reaches these arms today: a bare mutation on a run with delegation activity is refused before the loop, and every `--claim-id` route selects the retaining mode. The defect is in the code with no demonstrated caller, and the unit tests assert it as intended (`execution-loop.test.ts:2947-2968`, `:3090-3109`, `:3193-3194`).

Step 5 of §8 fixes it. Retention is already what a live run needs: `retainClaimsAsTerminal: true` writes nothing, so the row stays `active` and the run resolves `claimed` (`session-service.ts:1628`). The remaining work there is a naming split — `releaseTerminalRun` and `releaseRefusedContinuation` — so the function's name matches its callers.
