# 608 PR 12 — remediation handoff

Handoff for the review-remediation work on
`issue-608/pr12-transactional-delegation-workflows`. Companion to the findings
ledger in
`2026-08-03-608-pr12-review-remediation-addendum.md`, which holds the F1–F26
evidence, the retry idempotency contract, and the open design questions. This
document covers **what was done, what is blocked, and what to do next**.

Merge-base with `main`: `ea36ad426ba845bf229158d6e494589cee59f9ee`.

## 1. What this branch does

Makes delegation workflows transactional and replaces plaintext delegation
tokens with deterministically derived HMAC credentials. Its binding spec is
`2026-08-01-608-pr12-deterministic-delegation-credentials-addendum.md`, read
with `2026-08-01-608-pr12-planning-audit-pr11-head.md`.

Five review agents audited the diff; three verification agents re-checked every
load-bearing claim against source; one design agent resolved the retry contract.
The result was a 25-finding ledger, several of which are not reviewer preference
but the branch's own spec, unimplemented.

**Already correct — do not disturb.** HMAC derivation matches the cryptographic
contract exactly (domain/version labels, length-prefixed canonical encoding,
20-byte base32 truncation). `StepDelegation.token` and frontier plaintext are
gone. `.strict()` schemas reject the old shape rather than migrating it. Lock
discipline is clean — no bare-`finally` RD-102 defects. No `any`,
`as unknown as`, or `@ts-expect-error` in **production source**
(`packages/*/src`), and the remediation preserved that. This is not a whole-diff
property: test doubles use them, 14 added lines across five test files on the
branch plus three in the remediation (`execution-loop.test.ts` and the new
`entry-projection-ordering.investigation.test.ts`).

## 2. Status

| Phase | Content | Findings | Status |
| --- | --- | --- | --- |
| 0 | Test integrity — no production change | F17, F21, F22 | done |
| 1 | Credential coordinate correctness | F4, F5 | done |
| 1.5 | Entry-projection ordering investigation | F26 | done — **decided, filed as [#680]** |
| 2 | Retry identity and idempotency | F1, F2, F23 | **descoped to [#681]**, blocked by [#680] |
| 3 | Authority propagation | F7, F13, F15, F16 | done |
| 4 | Redaction and output contract | F8–F12 | done |
| 5 | Thin-wrapper consolidation | F6 | done |
| 6 | Restore lost coverage | F18, F19, F20, F26a | done |
| 7 | Documentation and API surface | F24, F25 | done |

## 3. The blocking issue — F26 (resolved: descoped)

**Phase 2's central predicate cannot work as specified.** Full analysis is in
the addendum under "BLOCKING — the fourth conjunct is not implementable as
written"; the short form:

The retry idempotency contract decides echo-vs-rotate with

```
unobservedReplacement(state, frameKey, D) :=
     D.credential.supersedesTokenHash !== undefined
  && D.childRunId === null
  && D.cancelledAt === null
  && D.credential.parentEntry === inferFrameEntryFromState(state, frameKey)
```

The fourth conjunct exists because a delegation row is keyed by
`(substepId, frameKey)` with no entry component, and `substep-reset.ts`
deliberately preserves `delegation` across frame re-entry. Without it, a replay
after a GOTO echoes a bearer `classifyDelegationLiveness` has already closed as
`cursor-advanced` — an unclaimable token, strictly worse than rotating.

**Frame entry has two writers, running in the wrong order.** The machine reads
`RunbookContext.frameEntry`, seeded from pre-transition state, and stamps
credentials during the transition. Afterwards
`deriveActiveEntry(…, transitioned: true)` bumps the entry for a frame switch or
same-frame re-entry. Measured on real transitions
(`packages/core/__tests__/runbook/entry-projection-ordering.investigation.test.ts`):

| Path | Stamped | Committed | |
| --- | --- | --- | --- |
| Fresh issuance / frame switch | 1 | 2 | **lags** |
| `runRetryHook` re-issuance / same-frame re-entry | 2 | 3 | **lags** |
| GOTO into the delegating frame | 1 | 1 | agrees |
| Manual `issueDelegation({mode:'retry'})` | 2 | 2 | agrees |

So the conjunct is **always false for machine-issued credentials and true for
manually issued ones**, with nothing distinguishing them. The contract would
work for `rundown delegate --retry` and silently not work after a machine-driven
RETRY — the case it exists for — degrading to today's unconditional re-mint
while reading as implemented.

Undetected until now because `credential.parentEntry` is **write-only**:
`rg 'credential\.parentEntry' packages/*/src` returns nothing. Its only consumer
is HMAC derivation, which reads it back off the same descriptor and is therefore
self-consistent at any value. Every state comparison uses `linkage.parentEntry`,
built from committed state — committed against committed.

**Not a Phase 1 regression.** The machine previously hardcoded `parentEntry: 1`,
which is what `inferFrameEntryFromState` returns for an unrecorded frame. Phase
1 made the value correct relative to the mirror it reads; the mirror lags.

**Root cause.** `deriveActiveEntryProjection` branches on
`lastAction?.type === 'GOTO' | 'RETRY'` — machine-assigned context — re-deriving
a routing decision the machine already made, one module and one step late. And
`deriveActorStatePatch` already persists `activeFrameKey` from the machine
cursor but not `activeEntry` / `frameEntryCounts`. Half the frame coordinate
comes from the machine, half from a projection running after it.

### The decision — taken

**The machine owns the entry bump (one writer). Filed as [#680]; Phase 2 is
descoped from this PR and filed as [#681], depending on it.** Advance
`context.frameEntry` inside the machine on frame-entering transitions so it is
current before `delegationIssueActor` / `runRetryHook` read it, and persist
`activeEntry` / `frameEntryCounts` from context in `deriveActorStatePatch`
alongside the `activeFrameKey` it already persists. The `transitioned` flag
disappears, as does the inline-launch double-bump hazard worked around in the
comment at `lifecycle-command-service.ts:2397-2404`.

Cost: nine external `deriveActiveEntry` call sites — seven in
`lifecycle-command-service.ts` and two in the CLI
(`packages/cli/src/services/execution.ts:1754,1770`), the latter themselves a
Category B side effect outside core; ten counting the internal self-call in
`execution-lifecycle-service.ts`. Bootstrap seeding becomes a machine entry
action; derived tokens change, which is acceptable because there is no
persisted-state compatibility contract.

The bump must land as an entry action / transition assign on the frame's state
so XState runs it **before** that state's `invoke` fires.

Rejected alternatives, with reasons, are in the addendum. The three
non-recommended options are each something `CLAUDE.md` forbids: predicting the
destination frame outside the machine, reversing the Category C actor
architecture, or redefining the conjunct against a value that cannot express its
intent.

**Phase 2 ships nowhere until [#680] lands** — not even without the fourth
conjunct. Dropping the conjunct is a regression, not a deferral: a retry replay
after a GOTO back into the delegating frame would echo a bearer
`classifyDelegationLiveness` has already closed as `cursor-advanced` —
unclaimable — where today's unconditional re-mint rotates and works. Do **not**
soften it to `>=` or a one-entry tolerance either; that papers over the
two-writer defect and makes the predicate un-analysable. Note `parentFrameKey`
does not lag; only the entry ordinal does.

Deferring is safe because nothing is broken today: `credential.parentEntry` is
write-only, and its only consumer re-derives from the same descriptor.

## 4. What each completed phase did

### Phase 0 — test integrity (test-only)

Nothing downstream was trustworthy until the suite could fail.

- **F17** removed the regex-scrape fallback from `requireFrontierToken`
  (`packages/cli/__tests__/helpers/test-utils.ts`). The positional guess
  (`'1.1'` → index 0) re-found the same token from raw stdout, so every
  *id-attribution* mutant was invisible at 32 call sites across 13 suites.
  Resolution is now exclusively through an emitted
  `step_entered.delegateFrontier`.
- Corrected a dishonest call site at `delegate-workflow.test.ts:1503` — `'1.1'`
  → `'1.1.1'`, since FOR frames advertise the canonical three-level
  `${step}.${iteration}.${substep}` id.
- **F21** replaced the constant `tokenHash` in
  `delegation-inference.properties.test.ts` with an index-derived one, making it
  a discriminating field, and added a property pairing each frontier entry with
  the verifier of the substep that issued it. Proven by controlled experiment:
  production was mutated to mis-pair verifiers, the mutant survived under the
  constant hash, three tests killed it under index-derived hashes, and
  production was restored byte-clean.
- **F22** removed the `jest.spyOn(SessionService.prototype, …)` token-minting
  bypass from `scenario-snapshots.test.ts`; it now reads the product's actual
  disclosure boundary, and the text variant asserts no `rdtk_` appears at all.

### Phase 1 — credential coordinate correctness

Machine-owned issuance no longer hardcodes `parentEntry: 1`; both issuance paths
resolve through the shared `inferFrameEntryFromState` helper (credentials
addendum L141).

**Deviation — one nested field, not two flat ones.** `invoke.input` must keep
`activeFrameKey: frameKey` because `inferAllDelegateSubsteps` depends on it, so
a raw `activeEntry` beside a *different* frame key silently attributes one
frame's entry to another. The mirror is therefore
`RunbookContext.frameEntry: FrameEntryCoordinates`
(`Pick<RunbookState, 'activeFrameKey' | 'activeEntry' | 'frameEntryCounts'>`),
resolved through the helper at the machine boundary. A cross-path property test
(manual vs machine issuance at the same coordinate) fails under the two-field
design.

**Deviation — RD-903 `RETRY_HOOK_MISSING_RUN_ID`** instead of an `assertRunId`
throw, matching the file's three existing *returned* retry-hook refusals
(RD-902/904/905). Gated on `hasDelegationToRetry` so RETRY stays universal —
load-bearing for Phase 2's placement argument.

### Phase 3 — authority propagation

- **F16** — issuance was gated on whatever authorized the transition
  (`mutate-run`), never `delegate-from-run`. Both sites now gate on
  `delegate-from-run` via a new module-local pure `transitionDelegationRuntime`.
- **F16 rider** — the surviving `command: 'delegate'` mutant (`:1242` → `:1289`)
  is now killed by a narrow-grant fixture.
- **F13** — the prepared-abort round-trip now forwards the runtime it holds
  (`actor-service.ts:1231` → `:1256`).
- **F15** — `optionalWhenClaimSuperseded` applied at the write-free pre-effect
  stage, so a write-free refusal is no longer reported as `claim_superseded`.
  Invariant guards pinned; `:360` is unreachable by construction (it needs zero
  targets, which the length guard already rejects) and was documented as such
  rather than faked into reach.
- **F7 — the original characterisation was wrong.** The resumed inline child
  does *not* stop silently: `delegationIssueActor` returns
  `actor_context_required`, the machine routes to STOPPED, and the CLI emits a
  typed `runbook_stopped`. The real defect is the asymmetry with fresh launch.

  Fixed by re-establishing the child's **own** authority through a new core seam
  `SessionService.adoptRunControlClaim(state)`. Unconditional rotation was
  rejected: it hits the credentials addendum's stop condition, and because a
  replacement claim cannot reproduce credentials the old one issued,
  `createDelegationTokenDeriver` would refuse every echo — fail-closed becomes
  stuck-closed. Adoption therefore mints only when the run carries **no** issued
  delegation, and the adopted bearer is re-announced through
  `runbook_started.claim_id` so the orchestrator can still address the child.

  **This is the first production caller of run-control rotation.** See §7.

### Phase 4 — redaction and output contract

- **F8 (security)** — a full bearer reached stdout JSON via `details.context`.
  Truncation now happens inside the three bearer-carrying factories
  (`invalidToken`, `tokenNotFound`, `tokenCancelled`), closing the class rather
  than the instance. The leak was JSON-only: `token` is not one of
  `formatMessage`'s rendered keys, so it never appeared in `error.message`.
- **F9** — `AGGREGATE_RECOVERY_REQUIRED` registered **symbolically** alongside
  its siblings, **not** as an RD-NNN code. Every sibling the renderer emits
  (`RECOVERY_REQUIRED`, `STALE_CLAIM`, `RUN_TARGET_UNAVAILABLE`) is a CLI
  symbolic code; minting an RD number would have created a `RundownError` entry
  no factory constructs while the wire code stayed symbolic. `runs` is now
  declared on `ErrorDetailsSchema` rather than surviving via `.loose()`.
- **F10** — `cleanup` added to abort JSON; `force` derived, because core's
  `cancelled` arm has no `force` field. The existing test actively pinned the
  defect (`expect(output).not.toHaveProperty('cleanup')`) and was rewritten.
- **F11** — six sites, not seven. `runbook-pipeline.ts` maps refusal kinds to
  *pipeline reasons* and `claim.ts` maps a different union; neither is a
  duplicate, both left alone. The missing `never` guard was added.
- **F12** — worse than recorded: the hand-restated arm collapsed
  `claim_superseded | concurrent_modification | missing` into one member with a
  union `kind`, so `Extract<…, {kind:'claim_superseded'}>` resolved to `never` —
  structurally unaddressable, not merely de-branded.

### Phase 5 — thin-wrapper consolidation

`runExecutionLoop` carried a hand-rolled copy of core's
`projectAndConsumeReEntryFrontier`. Promoted to a shared core seam,
`packages/core/src/runbook/re-entry-frontier.ts`; both `collection-service.ts`
and the loop now call it and switch on the same arms, and the CLI keeps only
emitter wiring and exit mapping.

Consolidating forced a choice on each divergent condition, decided from the
docs rather than from edit cost:

- **Projection refusal → RD-821 on both paths** (was `COLLECT_OPERATION_FAILED`
  via `collect`, RD-821 via `run`). The architecture doc's disclosure-boundaries
  section defines this as a class-level invariant, and a class-level invariant
  must not change code with the command driving it.
  `COLLECT_OPERATION_FAILED` was a multi-condition bucket that
  also covered drain `target_mismatch`, and `reason` is not part of the
  documented collect error envelope, so an agent branching on `code` could not
  distinguish a credential refusal from a cursor mismatch at all.
- **Consume failure → new RD-829 `DELEGATION_FRONTIER_CONSUME_FAILED` on both**
  (was `COLLECT_OPERATION_FAILED` via `collect`, and **completely uncoded** via
  `run`, with no CLI test at all). RD-821 is ruled out by the architecture doc's
  own words: this is retryable, and RD-821's documented remediation is that
  retrying refuses identically. **RD-826/827/828 remain reserved for Phase 2**,
  and the registry now carries a comment recording that reservation.
- **Malformed persisted frontier → `InvalidRunbookStateError` on both.** The CLI
  copy did not zod-validate the persisted blob and accepted garbage; it gains
  the validation from the seam.

Two changes worth knowing about:

- **A deliberate behaviour change:** the consume now commits *before* the tokens
  are emitted. Both orders satisfy the property the affected test names, but
  committing first means a failed consume discloses **nothing** — which is what
  `rundown collect` already did, and what the RED output showed `rundown run`
  violating.
- The CLI read the frontier via `actorService.getContextSnapshot(...)` while
  core read `state.snapshot.context.delegateFrontier`. The seam uses the core
  read on both paths, so **`getContextSnapshot` now has no remaining CLI
  caller** — a dead-surface candidate.

### Phase 6 — restore lost coverage

All deletions from the `lifecycle-command-service.test.ts` rewrite (733
insertions / 725 deletions) restored, **adapted** to `beforeEffect`'s in-fence
`capturedSteps` load rather than transplanted. The deleted lock seam is replaced
by a typed `runnerWithFenceEntryHook` decorator; the no-side-effect assertions
re-target `prepareManualDelegationMutation` plus persisted-state inspection.

Each restored test proven by hand-applied mutant. For F19 and F20 the restored
test is the **only** failure across 146 tests. **F26a** (added during the phase)
restores the unparsable-target guard at `:1008`, whose removal turns a malformed
`--step` + `--index` into a `TypeError` escaping the seam as a rejection rather
than a typed outcome. `invalidDelegationIndexMessage` now has **zero
survivors**.

### Phase 7 — documentation and API surface

- `docs/internal/architecture.md`: `DELEGATION_ISSUANCE_FAILED` reason table; new
  "Manual delegation preparation machine" section (rationale moved out of the
  `manual-delegation-machine.ts` header); new "Credential disclosure boundaries
  and RD-821" section; events table extended and its "small and stable" closing
  claim reworded, since it was no longer honest.
- `docs/reference/cli.md`: same-issuer echo correction (credentials addendum
  Task 9, previously applied to `cli-output.md` only), plus RD-821 and
  `COLLECT_OPERATION_FAILED` rows.
- Barrel trimmed. `prepareManualDelegation` removed — publishing it invites a
  front end to drive delegation around the actor service.
  `generateDelegationToken` moved to `packages/core/src/testing/delegation-fixtures.ts`
  (exposed as the separate `./testing/delegation-fixtures` subpath) and
  reimplemented over `deriveDelegationToken`, since a *random* token minter in
  the public API of a deterministic credential model is a foot-gun.
- `Errors.tokenCancelled` **kept**: RD-809 *is* wired — `claim.ts:64-72` emits
  `DELEGATION_CANCELLED` from the typed claim-failure arm. What is unused is a
  second, throw-shaped constructor. Deleting it would also gut a third of Phase
  4's redaction guard, which asserts by name that it truncates.
- Separately, RD-821's registry description in `codes.ts` was corrected: it
  claimed "an unreachable result branch", but two of its three emitters are the
  operator-reachable echo-verification failures at
  `lifecycle-command-service.ts:428,436`.

## 5. Next steps, in order

Steps 1–4 are done; what remains is the follow-up work now tracked in GitHub.

1. ~~Decide F26.~~ Done — option 3, filed as [#680] (§3).
2. ~~Run the gates.~~ Done, and both failed on first run; see §6.
3. ~~File Phase 2.~~ Descoped to [#681], blocked by [#680].
4. **Carry the deviations into the PR description** — the cluster convention
   requires deviations in the dated addendum, the cluster issue, and the PR
   body.
5. **Implement [#680]**, then flip the `not.toBe` assertions in
   `entry-projection-ordering.investigation.test.ts` to `toBe` as the regression
   pin and rename the file off `.investigation.`.
6. **Implement [#681]** per the addendum's contract, decision table and
   placement rationale, including the manual end-to-end proof in its acceptance
   checklist. RD-826/827/828 remain reserved and free.
7. **File the remaining follow-ups to #675** (§7).

## 6. Gates — run, and both failed on first run

Every phase ran a mutation scope over its own diff, but neither repo-level gate
had run over the combined branch. Running `verify` found two blockers that no
targeted suite could have caught, exactly the failure mode the gate exists for:

- `check:spell` — two unknown words in comments the remediation added
  (`miscomputation`, `undisclosable` in
  `delegation-inference.properties.test.ts`). Added to `cspell-dictionary.txt`.
- `check:types:cli` — `TS2345` in `execution-loop.test.ts`, where the
  `adoptRunControlClaim` double declared a narrower `{ readonly id: string }`
  parameter than the `Record<string, unknown>` state fixture every other double
  in that file takes. Jest transpiles past this, so the suite was green while
  `tsc` was not. Declaration widened to the file's convention.

`pnpm run verify` now exits 0 — 5081 tests, 1 skipped, 0 failures.

`verify` is not optional and is not substitutable by scoped `jest` runs —
`cspell` and the typed lint rules (`jsdoc/require-throws` and friends) run
**only** there, so a change can be green in every targeted suite and still fail
the gate. Both of the above prove it.

`pnpm run test:mutate:changed` plans **42 Stryker invocations** across core, CLI
and plugin, with very large scopes (33 ranges on
`lifecycle-command-service.ts`, 28 on `execution.ts`, 24 on `actor-service.ts`).
Note Phase 1 deliberately scoped its mutation run `--base HEAD` rather than the
merge-base for this reason. Budget hours, not minutes, and use
`--print` first to see the plan. It is advisory in CI (`continue-on-error`
throughout, no required check), so it does not block the PR — but every in-scope
Survived / NoCoverage still needs a disposition.

## 7. Open items and tracking

**Filed out of this branch:** [#680] (single-writer frame entry, F26's fix) and
[#681] (Phase 2 retry idempotency, blocked by #680). Both are sub-issues of
cluster #648.

**Open design questions**, both in the addendum and both with GitHub issues:

- **Q1 / [#676]** — a rotated run-control claim leaves a delegation underivable
  *and* uncancellable. Phase 3 changed this from latent to **reachable but
  gated**: `adoptRunControlClaim` is now the first production caller of
  rotation, bounded so it only replaces a claim that provably issued nothing.
  The interim guard test originally proposed (pinning that rotation has no
  production caller) is now wrong; replace it with one pinning that the *only*
  production rotation is the credential-free adoption path. **#676's body and
  option 4 have been amended accordingly**, with a comment recording the change.
- **Q2 / [#677]** — `retryDelegation` re-mints over a cancelled delegation.
  Decided: leave; revisit with step-located abort.

**Deferred refactors** are tracked under **#675**. Add these, surfaced during
remediation and not yet filed:

- `ErrorDetailsSchema` is still `.loose()`; roughly eight structured payloads
  ride through undeclared. F9 fixed one instance; the class is open.
- `unknown_run` and transactional `missing` share `RUN_TARGET_UNAVAILABLE` —
  16 occurrences across nine files in `packages/*/src` — despite different
  provenance, so a JSON consumer cannot distinguish "never resolvable" from
  "lost a CAS race".
- `packages/core/src/output/zod-schemas.ts` is mutation-dead by construction
  (~1500 lines of module-level declarations no mutant can activate); its
  inclusion in the per-PR matrix is reporting noise.
- `execution.ts` fenced-command refusal branch has no dedicated-test coverage.
- A resumed child's `prompted` mode is unpinned (`execution.ts:749`).
- `RunbookActorService.getContextSnapshot` has no remaining CLI caller after
  Phase 5 — dead surface, or a seam that should be internal.
- **Category B/C logic still in `runExecutionLoop`**, named by Phase 5 and left
  in place: the CLI's own `drainResolvedCompletions` copy, a second
  drain/advance orchestration alongside `RunbookCompletionService`'s, mixing
  emitter wiring (A) with transition sequencing (B); `launchInlineChildFromIntent`,
  whose linkage, session push and runtime propagation are B/C with only the
  spawn and render parts genuinely A; and the frontier authority precondition at
  `execution.ts:1529-1533`, which reuses core's validating reader but does
  mirror the seam's own two-term gate. The alternative there — an
  `authority_required` arm on `ReEntryProjection` — would force an unreachable
  branch into `collectDelegationOutcomes`, which was judged the worse trade.
  The two CLI `deriveActiveEntry` call sites are also Category B, but they are
  F26's root cause and belong to [#680], not here.
- **F14 confirmed and unfixed**: two of the three "machine-owned" manual
  delegation commands do not re-enter the compiled machine — `ISSUE` and
  `RETRY` return state directly, and only `ABORT` sends an event, and only when
  the captured state has a snapshot. `MANUAL_DELEGATION_ABORT_PREPARED` is a
  bare context setter with no target, guard or derivation. The already-deferred
  migration of those arms to the existing `fromPromise` actor is what resolves
  it.

**Progress records:** cluster issue **#648** carries the remediation record and
phase checklist, plus [#680] and [#681] as sub-issues; epic **#564** links the
follow-up issues.

## 8. Traps for whoever picks this up

These cost time during remediation and are all documented in `CLAUDE.md`, but
they are easy to rediscover the hard way.

- **Jest must be invoked through pnpm's filter** —
  `pnpm --filter @rundown-org/<pkg> exec jest …`. A bare `npx jest` from the
  package directory fails on the ESM setup file.
- **Never run Prettier on TypeScript.** Biome owns TS/JS/JSON/CSS; Prettier is
  Markdown-only. Biome will not undo Prettier's reformatting, so the damage has
  to be reverted by hand.
- **Stryker scopes are package-relative.** A repo-relative `--mutate` path
  matches nothing, reports `Instrumented 0 source file(s)`, and **exits 0** — a
  gate that cannot fail. Always check the `Instrumented N` line. `--force` is
  mandatory on a source-change scope because configs set `incremental: true`.
  Never lower `timeoutMS`: a timeout counts as *detected*, so shrinking it
  inflates the score with kills no test performed.
- **A test that reads a file outside its own package must be named
  `*.repo-asset.test.ts`** — otherwise it hard-aborts the entire mutation
  campaign with "There were failed tests in the initial test run", invisibly,
  because the shard step is `continue-on-error`. Phase 4 hit this.
- **The CLI Stryker sandbox structurally excludes `__tests__/integration/`**
  (`packages/cli/jest.config.shared.js:65-69`), so a mutant killed only by an
  integration test reports as *survived*. Say so explicitly rather than treating
  it as a real gap.
- **Known harness artifacts, verified against untouched neighbours:**
  `ArrowFunction ⇒ undefined` mutants on module-level object-literal property
  initializers always survive with `covered: 0`; module-level Zod schema
  declarations are mutation-dead.
- **A stale `reports/stryker-incremental.json` can print a plausible aggregate
  over a zero-mutant run.** Phase 6 had a report polluted by other phases' data
  and had to clear the cache and re-run cold.
- **Two core suites flake under the default worker count** (`executor.test.ts`,
  `session-service.process.test.ts`) — different tests each run, all pass under
  `--maxWorkers=2`. They cover sandbox detection and cross-process lock
  contention.

## 9. Working-tree state at handoff

52 modified files (~3.2k insertions / ~0.6k deletions) plus these eight new
files:

```
docs/superpowers/plans/2026-08-03-608-pr12-review-remediation-addendum.md
docs/superpowers/plans/2026-08-03-608-pr12-remediation-handoff.md
packages/core/src/runbook/re-entry-frontier.ts                       (Phase 5)
packages/core/__tests__/errors/bearer-factory-fixtures.ts            (Phase 4)
packages/core/__tests__/errors/token-redaction.test.ts               (Phase 4)
packages/core/__tests__/errors/token-redaction-coverage.source-text.test.ts
packages/core/__tests__/runbook/delegation-credential-coordinate.properties.test.ts
packages/core/__tests__/runbook/entry-projection-ordering.investigation.test.ts
```

`packages/core/src/testing/delegation-fixtures.ts` is **not** new — it predates
the branch and is a tracked modification (Phase 7 moved `generateDelegationToken`
into it and reimplemented it over `deriveDelegationToken`).

`.serena/project.yml` is modified but unrelated to this work — it was already
dirty at the start, and is excluded from the commit.
