# 608 PR 12 — review remediation addendum

<!-- cspell:words HMAC -->

> **Status:** Binding PR 12 correction after multi-agent review of the
> implementation branch.
>
> **Supersedes:** Nothing. Extends
> `2026-08-01-608-pr12-deterministic-delegation-credentials-addendum.md`, whose
> decisions, tasks, and stop conditions all remain in force. Where this document
> and that one appear to disagree, that one wins and this is the defect report.
>
> **Scope:** Findings against branch `issue-608/pr12-transactional-delegation-workflows`
> (merge-base `ea36ad426ba845bf229158d6e494589cee59f9ee`), and the design
> resolution for the retry idempotency contract that the credentials addendum
> left conditional.

## Why this addendum exists

The credentials addendum specified a retry identity contract (§ "Retry and
committed-result identity") and made it conditional:

> If this contract cannot be represented without ambiguity in the public retry
> forms, stop and raise a CLI idempotency-key design instead of silently minting
> twice.

Review found the contract unimplemented in every retry form, so that condition
had to be discharged one way or the other. **It is discharged: the contract is
representable, no CLI idempotency key is required, and no stop condition is
reached.** § "Retry idempotency contract" below is the binding design.

Review also found the credential coordinate inert on both machine-issuance
paths, a plaintext bearer reaching a JSON error envelope, and one core function
re-implemented in the CLI under divergent wire codes. Those are defects against
the credentials addendum, not new design.

## Verified findings

Confirmed by reading source. **↯** marks a violation of the credentials addendum
or the PR 11-head planning audit rather than a reviewer preference.

| # | Finding | Evidence |
| --- | --- | --- |
| F1 ↯ | No retry locator form (`token`/`step`/`active`) has an idempotent echo; all converge on unconditional re-mint | `lifecycle-command-service.ts:1645-1656`; locators `:187-190` |
| F2 ↯ | `supersedesTokenHash` has zero production readers; `findByToken` matches `tokenHash` only, so an old-token replay returns `token-not-found` | `delegation-scan.ts:58`; `lifecycle-command-service.ts:1396` |
| F3 | `retryDelegation`'s in-flight guard requires `childRunId !== null`, so a pending-unclaimed or cancelled attempt is force-cancelled and re-minted | `delegation-service.ts:971-981` → `:989-995` |
| F4 ↯ | Neither machine path can produce `parentEntry != 1`; the manual path can. Same logical delegation, divergent coordinates | `frame-entry.ts:15-22`; `compiler.ts:3853-3877`; `retry-hook.ts:82-85` (addendum L141) |
| F5 | Retry credential inherits `parentRunId` from the *old* persisted descriptor rather than the current run | `retry-hook.ts:166-169`; `delegation-service.ts:656-664` |
| F6 ↯ | CLI re-implements `projectAndConsumeReEntryFrontier`; identical conditions reported under different codes | `execution.ts:1451-1593` vs `collection-service.ts:411-473` |
| F7 | Resumed inline child receives no delegation runtime and stops at a DELEGATE step; a freshly launched child does not | `execution.ts:716-724` vs `runbook-pipeline.ts:1155-1165` |
| F8 ↯ | Full delegation token reaches stdout JSON via `details.context` | `abort.ts:38,49` → `core/errors/factory.ts:110,112` → `wrapper.ts:101-107` (addendum L170, L232) |
| F9 ↯ | `aggregate_recovery_required` collapsed onto single-run `RECOVERY_REQUIRED`; `details.runs` undeclared, surviving only via `.loose()` | `session-mutation-result.ts:149-153`; `zod-schemas.ts:283-299` |
| F10 | `abort` JSON omits `cleanup`; `force` reports the flag rather than what core did | `abort.ts:96-108` vs `:114-144` |
| F11 | Refusal→code map exists at 7 sites; the only one owning the full six-member union lacks a `never` guard | `session-mutation-result.ts:132-155` |
| F12 ↯ | Hand-restated core unions, de-branding `RunId`/`ExecutionEpoch` | vs `mutation-result.ts:223-234` (audit: no parallel result types) |
| F13 | ABORT round-trip omits the `runtime` argument it holds | `actor-service.ts:1231` |
| F14 | `MANUAL_DELEGATION_ABORT_PREPARED` is a context setter with no target, guard, or derivation | `compiler.ts:4679` |
| F15 | `optionalWhenClaimSuperseded` unapplied at the `beforeEffect` validation stage | `effectful-actor-mutation-runner.ts:365-373` |
| F16 ↯ | Automatic issuance gated on `mutate-run`, not run-control authority; safe only because RD-819 fires first | `lifecycle-command-service.ts:2082-2089` (addendum L153-156) |
| F17 | `requireFrontierToken` positional-guess fallback masked every id-attribution regression across 32 call sites | `test-utils.ts:721-730` |
| F18 | Lost coverage: locked-re-read timing and no-side-effect assertions for `invalid_index` | merge-base test `:921`, `:1681`, deleted |
| F19 | Lost coverage: `prompted-for` disjunct — test and fixture both gone; the mutant survives the whole suite | `lifecycle-command-service.ts:1010` |
| F20 | Lost coverage: named-step validation; the CLI fixture orders step "1" first, so a `steps[0]` mutant survives | `:1009`; `delegate.test.ts:161-176` |
| F21 | Property suite assigned one constant `tokenHash` to every generated delegation, disarming the pairing assertions | `delegation-inference.properties.test.ts:168` |
| F22 | The only delegation scenario minted its bearer in-process via `jest.spyOn`, bypassing the disclosure boundary | `scenario-snapshots.test.ts:13-46` |
| F23 | Derive-and-verify invariant implemented twice, throwing versus returning | `execution-observation.ts:135-146` vs `lifecycle-command-service.ts:418-442` |
| F24 | New machine and new machine event undocumented | `docs/internal/architecture.md` |
| F25 | Barrel exports with no external consumer, including `prepareManualDelegation` and `generateDelegationToken` | `runbook/index.ts` |

**Verified sound, recorded so a later reader does not re-litigate them:** HMAC
derivation matches the cryptographic contract exactly; `StepDelegation.token`
and frontier plaintext are gone; `.strict()` schemas reject the old shape rather
than migrating it; no bare-`finally` domain-lock release (RD-102) anywhere in
the diff; no `any`, `as unknown as`, or `@ts-expect-error` in any added line of
**production source** (`packages/*/src`) — test doubles do use them, 14 added
lines across five test files on the branch and three more in the remediation,
so do not read this as a whole-diff property.

## Retry idempotency contract

### Discriminator

```
unobservedReplacement(state, frameKey, D) :=
     D.credential.supersedesTokenHash !== undefined
  && D.childRunId === null
  && D.cancelledAt === null
  && D.credential.parentEntry === inferFrameEntryFromState(state, frameKey)
```

The fourth conjunct is required, not defensive. `substep-reset.ts:47-53`
preserves `delegation` across frame re-entry while
`execution-lifecycle-service.ts:322-329` bumps the entry counter, and row
identity is `(id, frameKey)` only. Without it, a replay after a GOTO echoes a
bearer `classifyDelegationLiveness` has already closed as `cursor-advanced` —
handing back an unclaimable token, strictly worse than rotating.

### BLOCKING — the fourth conjunct is not implementable as written (F26)

Verified by executable test, not inspection:
`packages/core/__tests__/runbook/entry-projection-ordering.investigation.test.ts`.

`deriveActiveEntry(prepared.nextState, previousState, true)` runs **after**
`prepareActorMutation` has already driven the machine and issued credentials
(`lifecycle-command-service.ts:3325-3341`, `:3168`). With `transitioned=true`,
`deriveActiveEntryProjection` (`execution-lifecycle-service.ts:304-341`) bumps
the entry on `switchedFrame` and on `reenteredSameFrame`. The machine reads
`RunbookContext.frameEntry`, seeded from **pre-transition** state. So every
machine-issued credential stamps `parentEntry` exactly one below
`inferFrameEntryFromState(committedState, frameKey)`.

| Path | Stamped | Inferred from committed | |
| --- | --- | --- | --- |
| Fresh issuance / frame switch (`#driveTopLevel`) | 1 | 2 | **lags** |
| `runRetryHook` re-issuance / same-frame re-entry (`#driveSubstepFenced`) | 2 | 3 | **lags** |
| GOTO into the delegating frame (`runNavigationMutation`) | 1 | 1 | agrees |
| Manual `issueDelegation({mode:'retry'})` (`#issueRetry`) | 2 | 2 | agrees |

Consequence: `entryCurrent` is **always false** for machine-issued credentials
and true for manually issued ones, with nothing distinguishing them. The
contract would degrade to today's unconditional re-mint on exactly the retry
case it exists for, while reading as implemented. Shipping it in that state is
worse than not shipping it.

This is **not** a Phase 1 regression. Before Phase 1 the machine paths produced
`parentEntry: 1` structurally — not as a literal: the compiler handed
`createDelegation` a synthetic state carrying `activeFrameKey` but no
`activeEntry` / `frameEntryCounts`, and `inferFrameEntryFromState` returns `1`
for exactly that shape (`frame-entry.ts:29-33`). Phase 1 made the value correct
relative to the mirror it reads. The mirror is what is stale.

Undetected until now because `credential.parentEntry` is **write-only**:
`rg 'credential\.parentEntry' packages/*/src` returns nothing. It is read only
by `deriveDelegationToken` as HMAC input, which re-derives from the same
persisted descriptor and so is self-consistent at any value. Every *state*
comparison — `classifyDelegationLiveness` (`targeting.ts:536-545`),
`delegationParentEntryRefusal` (`actor-service.ts:1285-1298`) — uses
`linkage.parentEntry`, built from committed state, so all existing consumers
compare committed against committed. The fourth conjunct would be the first
consumer to compare the stamped value against state.

**Root cause is two writers of frame entry.** `deriveActiveEntryProjection`
branches on `base.lastAction?.type === 'GOTO' | 'RETRY'` — machine-assigned
context — to re-derive a routing decision the machine already made, one module
and one step late. `deriveActorStatePatch` already persists `activeFrameKey`
from the machine cursor but not `activeEntry` / `frameEntryCounts`; that split
is the defect. Nine external `deriveActiveEntry` call sites exist, two of them
in the CLI (`packages/cli/src/services/execution.ts:1754,1770`) — a Category B
side effect outside core.

Resolution options, evaluated in full in the investigation report:

1. Project before the transition — **rejected**, needs the destination frame,
   which only the machine knows; predicting it shadows the machine's routing.
2. Stamp post-projection — **rejected**, reverses the Category C actor
   architecture and needs re-stamping per inner transition in the drain loop.
3. **Machine owns the entry bump; one writer.** Advance `context.frameEntry`
   inside the machine on frame-entering transitions so it is current before
   `delegationIssueActor` / `runRetryHook` read it, and persist `activeEntry` /
   `frameEntryCounts` from context in `deriveActorStatePatch` alongside the
   `activeFrameKey` it already persists. The `transitioned` flag disappears, as
   does the inline-launch double-bump hazard worked around in the comment at
   `lifecycle-command-service.ts:2397-2404`. This is what the "state machine
   drives Rundown logic" principle requires. Largest change: nine external
   `deriveActiveEntry` call sites (seven in `lifecycle-command-service.ts`, two
   in `packages/cli/src/services/execution.ts`), ten counting the internal
   self-call in `execution-lifecycle-service.ts`;
   bootstrap seeding becomes a machine entry action, derived tokens change
   (acceptable — no persisted-state compatibility contract).
4. Redefine the conjunct against a value that does not move — **explicit
   non-goal**; cannot express the conjunct's intent, and 4b (a redundant
   persisted entry field) leaves `credential.parentEntry` wrong but still
   load-bearing as HMAC input.

**Status: decided — option 3, deferred to its own issue.** Filed as **#680**
under cluster #648, with Phase 2 (#681) depending on it.

Phase 2 is therefore **descoped from PR 12 entirely**, not shipped without the
fourth conjunct. Dropping the conjunct is not a deferred improvement but a
regression: a retry replay after a GOTO back into the delegating frame would
echo a bearer `classifyDelegationLiveness` has already closed as
`cursor-advanced` — unclaimable — where today's unconditional re-mint rotates
and works. Do not soften the conjunct to `>=` or a tolerance of one either;
that papers over the two-writer defect and makes the predicate un-analysable.
Note `parentFrameKey` does **not** lag; only the entry ordinal does.

Deferring is safe because nothing is broken today: `credential.parentEntry` is
write-only (`rg 'credential\.parentEntry' packages/*/src` returns nothing), its
sole consumer is HMAC derivation reading it back off the same descriptor, and
every state comparison uses `linkage.parentEntry`, built from committed state.

### Why this is not "guessing whether output was observed"

Each negative conjunct is committed evidence that the bearer was presented, not
an inference about it:

- `childRunId !== null` — written only by the claim transaction, which requires
  a raw bearer the caller presented.
- `cancelledAt !== null` — written only by `abortDelegation`, which is
  bearer-gated.
- stale `parentEntry` — a committed machine counter advanced.

The predicate asserts "no committed evidence this bearer was used" and biases to
refusing a second mint. No timestamps, process ids, or latest-attempt
heuristics. The credentials addendum's stop condition is therefore not reached.

### Decision table

Let `Hc = D.tokenHash`, `Hs = D.credential.supersedesTokenHash`,
`H = identity.tokenHash`, `entryCurrent = D.credential.parentEntry === inferFrameEntryFromState(state, frameKey)`.

| Locator | Captured attempt | Resolution | Outcome | Writes |
| --- | --- | --- | --- | --- |
| token | row or delegation absent | `rotatable` | RD-801 | no |
| token | `H === Hc` | `rotatable` | `retried` | yes |
| token | `H === Hs`, unobserved, `entryCurrent` | `already-replaced` | `retry-already-applied` | no |
| token | `H === Hs`, `childRunId !== null` | `replacement-consumed('claimed')` | RD-826 | no |
| token | `H === Hs`, `cancelledAt !== null` | `replacement-consumed('cancelled')` | RD-826 | no |
| token | `H === Hs`, `!entryCurrent` | `replacement-consumed('entry_superseded')` | RD-826 | no |
| token | matches neither | `identity-unmatched` | RD-827 | no |
| token | multiple rows supersede `H` | — | RD-828 | no |
| token | not located | — | `token-not-found` | no |
| step / active | `Hs === undefined` | `rotatable` | `retried` | yes |
| step / active | `Hs` set, unobserved, `entryCurrent` | `already-replaced` | `retry-already-applied` | no |
| step / active | `Hs` set, live linked child | `rotatable` | RD-823 | no |
| step / active | `Hs` set, terminal linked child | `rotatable` | `retried` | yes |
| step / active | `Hs` set, cancelled | `rotatable` | `retried` | yes |
| step / active | `Hs` set, `!entryCurrent` | `rotatable` | `retried` | yes |

The addendum's three sentences map to rows 10, 11, and 2 respectively.

### Placement

The decision is a pure core resolver (`resolveRetryIssuance`, in
`delegation-inference.ts`) called from `#issueRetry`'s `beforeEffect`, after the
linked-child guards and **before** `resolveOverrides`. Two hard reasons it may
not live in `retryDelegation`:

1. `runRetryHook` calls `retryDelegation` for every delegated substep in a
   frame, and spec requires RETRY to be universal. An echo arm there would
   return an unhandled result and roll back the whole machine transition.
2. `lifecycle-command-service.ts:269-276` defers `resolveOverrides` so a bad
   `--input-file` cannot mask a higher-priority precondition. A decision inside
   `retryDelegation` runs after that thunk, so a malformed input file would mask
   committed-result recovery — the highest-priority outcome available there.

This mirrors the fresh path, where `resolveDelegationIssuance` already decides
echo-versus-issue in `beforeEffect` and the machine is invoked only on the
issuable branch.

### Ratified behavioural coupling

Machine-driven RETRY also stamps `supersedesTokenHash`
(`retry-hook.ts:164` → `delegation-service.ts:1088`). Consequently, the first
manual `rundown delegate --retry --step X` following a step-level `rundown retry`
**echoes** rather than rotating; the caller rotates by naming the current token,
which the echo response carries.

Accepted deliberately. It is refusal-biased, never double-mints, and the remedy
is in the response. The rejected alternative — persisting a
`retryOrigin: 'manual' | 'transition'` discriminant — adds persisted schema
surface under the no-migration rule to separate two cases whose conservative
fallback is already safe.

### New error codes

| Code | Constant | Meaning |
| --- | --- | --- |
| RD-826 | `DELEGATION_REPLACEMENT_CONSUMED` | The named bearer's replacement shows committed evidence of use |
| RD-827 | `DELEGATION_RETRY_IDENTITY_UNMATCHED` | The named bearer identifies neither the current attempt nor one it superseded |
| RD-828 | `DELEGATION_SUPERSESSION_AMBIGUOUS` | More than one attempt records this bearer as superseded (unreachable by construction; refused, never resolved) |

No schema change and no derivation change: `supersedesTokenHash` is already
optional on `DelegationCredentialDescriptorSchema` and already excluded from the
HMAC input.

## Open design questions

Neither is resolved here. Both are recorded so the decision is explicit rather
than implied by silence.

### Q1 — Rotated issuing claim dead-ends both echo surfaces

A credential is bound to `issuerClaimKey`, and `createDelegationTokenDeriver`
refuses any other claim (`delegation-credential.ts:55-57`). The credentials
addendum anticipated this (L178-182) and prescribed that a mismatch "fail closed
and require explicit cancel/reissue".

**That remedy is unreachable.** `abortDelegation` is token-located only — it
opens with `findDelegationByToken(input.token)`, and the CLI exposes a positional
token plus `--claim-id`, `--force`, `--text`. Cancelling requires the bearer;
producing the bearer requires the rotated-away claim. Fail-closed becomes
stuck-closed, and unrecoverably so when rotation lands between issuance and
delivery — the crash window deterministic derivation exists to serve.

**Currently latent.** Run-control rotation has no production caller:
`installRunControlClaim`'s supersede loop only fires when a prior claim exists,
and the sole production path is `pushRunbookWithPreparedRunControlClaim` at
launch. `issueRunControlClaim` is referenced only by
`src/testing/session-fixtures.ts:255`; `pushRunbookWithRunControlClaim` has no
caller at all. The hole opens the day a rotate command is wired.

Recommended: add a step/run-located abort gated by `--claim-id`, giving the
prescribed remedy a real path — and arguably the correct authority model, since
a run controller should be able to cancel delegations it owns without holding
the bearer. Interim: a guard test pinning that the rotating entry points have no
production caller.

### Q2 — `retryDelegation` re-mints over a cancelled delegation

Out of scope for this addendum, deliberately. `createDelegation`'s sibling guard
(`delegation-service.ts:615`) also permits re-issue after cancel, so plain
`rundown delegate --step` already mints following an abort; making `--retry`
refuse would leave two public forms disagreeing with no stated reason. Abort is
bearer-gated and performs full teardown, so a later re-delegate is a new
operation identity, not a replay of one.

The dangerous half is closed by the discriminator: a *cancelled replacement* is
never echoed, and a token-located retry naming one returns RD-826 `cancelled`.
Revisit jointly with Q1 — a step-located abort makes cancel-then-re-delegate a
common flow, at which point consistency between the two forms starts to matter.

## Remediation sequencing

Ordered so test-integrity and spec violations land before refactors. Phase 1
precedes Phase 2 because the discriminator reads `parentEntry`.

| Phase | Content | Findings | Status |
| --- | --- | --- | --- |
| 0 | Test integrity — no production change | F17, F21, F22 | done |
| 1 | Credential coordinate correctness | F4, F5 | done |
| 1.5 | Entry-projection ordering investigation | F26 | done — decision pending |
| 2 | Retry identity and idempotency; shared derive-and-verify helper | F1, F2, F23 | blocked by F26 |
| 3 | Authority propagation | F7, F13, F15, F16 | pending |
| 4 | Redaction and output contract | F8, F9, F10, F11, F12 | in progress |
| 5 | Thin-wrapper consolidation | F6 | done |
| 6 | Restore lost coverage | F18, F19, F20, F26a | done |
| 7 | Documentation and API surface | F24, F25 | pending |

Deviations from the original phase briefs, recorded per the cluster convention:

- **Phase 1** mirrors all three frame-entry fields as one
  `FrameEntryCoordinates` (`Pick<RunbookState, 'activeFrameKey' | 'activeEntry' | 'frameEntryCounts'>`)
  rather than the two the brief named. `invoke.input` must keep
  `activeFrameKey: frameKey` for `inferAllDelegateSubsteps`, so a raw
  `activeEntry` beside a different frame key silently attributes one frame's
  entry to another. The cross-path property test fails under the two-field
  design.
- **Phase 1** adds **RD-903 `RETRY_HOOK_MISSING_RUN_ID`** rather than the
  brief's `assertRunId` throw, matching the file's three existing returned
  retry-hook refusals (RD-902/904/905). Gated on `hasDelegationToRetry` so
  RETRY stays universal — load-bearing for Phase 2's placement argument.
- **Phase 6** additionally restored the unparsable-indexed-target guard tests
  (**F26a**, `lifecycle-command-service.ts:1008`), deleted by the same rewrite.
  Removing that guard turns a malformed `--step` + `--index` into a `TypeError`
  escaping the seam. `invalidDelegationIndexMessage` now has zero survivors.
- **Phase 3** inherits one survivor from Phase 6: `:1242` `command: 'delegate'`
  can be flipped to `retry-delegation` with no test failing, because every
  fixture uses a run-control claim holding both grants. The narrower-grant
  fixture belongs with F16's gate rework, not before it.
- **Phase 5** consolidates onto **condition-named** codes rather than keeping
  either surface's existing one: a refused re-entry projection is now `RD-821`
  on both `collect` and the execution loop (it was `COLLECT_OPERATION_FAILED` on
  `collect`), and a failed frontier consume is a new **RD-829
  `DELEGATION_FRONTIER_CONSUME_FAILED`** on both (it was
  `COLLECT_OPERATION_FAILED` on `collect` and uncoded in the loop). Neither
  incumbent could be carried honestly by both surfaces —
  `COLLECT_OPERATION_FAILED` names a command the loop is not running, and RD-821
  documents a remediation ("retrying refuses identically") that inverts the
  consume failure's. RD-826..828 stay reserved for Phase 2, so the frontier code
  takes RD-829. `COLLECT_OPERATION_FAILED` now covers only a drain target
  mismatch.

### Deferred to follow-up issues

Large, mechanical, and would bury the correctness work. Tracked under
**#564 Epic: Delegation lifecycle hardening**.

- Split `lifecycle-command-service.ts` (3565 lines, four command families) into
  `DelegationCommandService` + `TerminalCommandService` over a shared base;
  extract `resolveRetryCursor` first (the cursor ladder is written twice).
- Migrate `manual-delegation-machine.ts`'s `ISSUE`/`RETRY` arms to the existing
  `fromPromise` actor — three shadow issuance implementations become one, and
  `invoke.onError` replaces the hand-rolled outcome capture. Reassess F14 after.
- One `DelegationRuntimeCapabilities` carrier type, replacing the
  `{issuer, deriver}` pair re-declared inline ten times under two field names.
- Move runtime closures off `DelegationPolicyOutcome` (`command-policy.ts:274-281`).
- Collapse the two byte-identical `StepDelegation` Zod schemas.
- Rename `buildNonDelegatingLifecycleSeam`, now built by the
  delegation-mutating `abort.ts`.

## Stop-condition audit

| Stop condition | Status |
| --- | --- |
| persisting a raw token, bearer, secret, key, or reversible seed | Clear — only the existing `supersedesTokenHash` and descriptors are read |
| deriving from a persisted hash or public coordinate without a live verified secret | Clear — every echo derives through a verified authority |
| claim id or derivation callable in persisted XState context | Clear — the resolver is pure; the deriver stays in the seam closure |
| bare status or unauthorized echo delivering a credential | Clear — the issuer check makes a foreign-claim echo structurally impossible |
| minting a second run-control claim after initialization used the first | Not applicable |
| guessing whether a retry response was observed | Clear — see "Why this is not guessing" above |
| retaining a frontend-owned lifecycle or persistence decision | Clear — decision core-pure, mint machine-owned, CLI renders |
| weakening PR 11 authority, execution, aggregate commit, or recovery checks | Clear — the echo returns through `beforeEffect`, which still runs `validateCapturedRunSet` |
