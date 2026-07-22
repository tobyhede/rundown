# Handoff: independent audit of the SQLite claim-concurrency branch

**Date:** 2026-07-20
**Branch:** `608-sqlite-claim-concurrency` (worktree `.worktrees/608-atomic-claim-commit`)
**Base:** `63077ea8f`
**Plan under execution:** `docs/superpowers/plans/2026-07-19-claim-concurrency-sqlite-implementation-plan.md`

## Why you are being asked to do this

The agent that produced commits `5fdf7379c..53534f388` was caught making a confident, load-bearing claim that was false. It asserted that the plan's Task 7 had failed to anticipate the architecture — that the lifecycle seam does not own the command effect, and that Task 7 therefore required migrating the CLI execution loop into core. It recommended re-planning on that basis.

The underlying observations were accurate. The conclusion was not. The plan's Task 7 and Task 8 file lists already partition exactly along the boundary the agent believed it had discovered: `packages/cli/src/services/execution.ts` is listed under Task 8 (plan line 375), and the `sendAndSync` call sites split cleanly between the two task file lists. The agent inferred authorial oversight from an absence it never checked against the plan's own text.

The failure mode is specific and worth naming, because it is what you are looking for: **accurate low-level observation, followed by unverified high-level synthesis, asserted with unearned confidence.** Assume it recurred elsewhere. Do not assume it recurred everywhere — much of the branch may be sound. Your job is to determine which is which, from primary sources.

Treat every claim below as unverified, including this document's framing of what happened.

## Ground rules

1. **Verify against primary sources only** — the plan text, the code, and test runs you execute yourself. Do not trust commit messages, code comments, TSDoc, or this document as evidence of what the code does.
2. **Do not trust prior test-count claims.** Run the suites and record your own numbers.
3. **Where a comment explains *why* a design is safe, check the reasoning independently.** The suspect agent wrote extensive justifying prose. Persuasive prose is not evidence.
4. **Report what you cannot determine**, rather than filling gaps by inference. That is the exact failure being audited.
5. If you find the branch is largely sound, say so plainly. An audit that manufactures findings to look diligent is the same failure in a different direction.

## Scope

15 commits, ~10,155 insertions / ~2,035 deletions across 82 files.

```
5fdf7379c feat(core): add SQLite driver substrate and WebContainer probe
2b5eed7e2 feat(core): add transactional SQLite runbook repository
50de92c2d feat(core): add PID-aware execution ownership protocol
94f758aa0 feat(core): model uncertain execution recovery in XState
739df3320 fix(core): harden execution lease fencing
64f840ded refactor(core): fence actor computation and persistence
a39701d6e fix(core): recover from guarded commit failures
785a3eabb fix(core): scope claim triggers to resolution-affecting columns
e203ec905 feat(core): add guarded state RMW and shared store registry
e5f0b2154 refactor(core): move run and session state onto SQLite
1e0c67cb7 refactor(core): move session mutations onto SQLite transactions
279bd599f fix(core): stop the sqljs orphan sweep unlinking foreign lock temps
4859a9c08 fix(site): make the WebContainer SQLite probe actually runnable
b9e23b561 test(core): pin cross-process session write contention
53534f388 feat(core): capture run authority for callers presenting no claim
```

The plan's Tasks 1–6 are claimed complete; Task 6 is claimed "substantially complete" with parent-terminalization → linkage row updates outstanding. Tasks 7–10 are not started. Verify that mapping rather than accepting it.

## Priority findings to verify

Ordered by consequence if the claim is wrong.

### 1. The removal of `SessionLock` from `runGuardedParentAdvance`

**Highest priority — this is a deliberate weakening of a concurrency guarantee, justified by prose.**

In `packages/core/src/runbook/session-service.ts`, `runGuardedParentAdvance` previously held a lock across its check-then-advance sequence. The lock was removed on the argument that the `advance` callback is async, no transaction can span an `await`, and the widened window "admits no new outcome class" because `listOpenClaimsForParent` excludes claims whose parent substep is `done`.

Determine independently:

- Is the exclusion claim true of the current code, on every path?
- Does the widened window admit an interleaving the prior lock excluded? Construct the interleaving explicitly rather than reasoning about it abstractly.
- The replacement test is claimed to "drive a claim through the interleave and pin the recovery." Read it. Does it exercise the dangerous ordering, or only a benign one?
- Was a mutual-exclusion test deleted or weakened as part of this? Check `git log -p` for the test file.

### 2. `captureRunAuthority` (commit `53534f388`)

The most recent commit, written after the hallucination was identified, and therefore not more trustworthy than the rest.

It adds a path for callers that present no claim (bare `rundown pass`), resolving the run's own active controlling claim and capturing against it. The commit message argues this is not a #613 violation because #613 forbids resolving a *presented* claim onto a different target, and nothing is presented here.

Determine:

- Is that reading of #613 correct? Check the issue and the `captureAuthority` tests that pin #613.
- `resolveControllingClaim` selects `ORDER BY key LIMIT 1` from active claims on the run. Is "at most one active controlling claim per run" actually invariant? If two can exist, this silently picks one by key order. Look for a schema constraint enforcing it; if none exists, the invariant is assumed, not enforced.
- Does the bare-caller authorization gate (`#refuseBareMutationOnExposedTarget`) actually run before this on every path that reaches it?

### 3. Cross-process race tests (commit `b9e23b561`)

The agent claims it independently verified these tests can fail, by patching `pushRunbook` to a lossy read-modify-write and observing 4 of 5 pushes lost. That verification was not committed and cannot be checked from the tree.

Determine:

- Re-run the mutation yourself. `packages/core/__tests__/runbook/session-service.process.test.ts` with `packages/core/__tests__/runbook/storage/fixtures/session-writer-child.ts`. Break the production path and confirm the tests fail.
- The agent notes properties 1–4 rely on genuine overlap that is "not guaranteed every run" because the critical section is sub-millisecond, and claims the assertions are interleaving-invariant so a missed overlap costs sensitivity but never correctness. Verify that claim — a test that silently passes without contention is close to no test at all.
- Run the suite repeatedly (≥20×) and check for flakiness in both directions.

### 4. Deleted scenario runbook

`runbooks/delegation/delegate-claim-corruption.runbook.md` (50 lines) was **deleted** in `e5f0b2154`, a commit whose stated purpose is moving state onto SQLite.

This is the single most suspicious change in the branch: a scenario that specifically exercised claim corruption, removed inside an unrelated refactor. Establish whether its coverage was migrated elsewhere or simply dropped. If dropped, that is a coverage regression in precisely the area this branch touches.

### 5. Standing user constraints — check for violations

Three constraints were stated by the user during the engagement and are binding:

- **"UNDER NO CIRCUMSTANCES SHOULD SCENARIO MAKE SQL CALLS."** Grep the scenario infrastructure and every `runbooks/**` scenario for direct SQL, store, or driver access.
- **No state migration, ever.** Persisted state from an older version must produce a hard error, never automatic conversion, fallback parsing, or compatibility shims. Check the SQLite cutover path for any tolerance of legacy JSON state. This is also `CLAUDE.md` policy, not merely a session preference.
- The user asked for concise, bulleted reporting with concrete problems and clear calls to action, and explicitly asked that the `AskUserQuestion` tool not be used.

### 6. Architectural conformance

Against `CLAUDE.md`:

- **State machine drives runbook logic; the CLI is a thin wrapper.** The branch moves persistence but reportedly leaves `goto` mutating via its own actor service outside the lifecycle seam (`packages/cli/src/helpers/goto-workflow.ts:305`), the CLI acquiring `DelegationLock` directly (`packages/cli/src/services/execution.ts:482`), and session release/pop duplicated between `execution.ts:264` and `transition-orchestrator.ts:123`. Confirm these, and confirm whether the plan assigns each to a later task or whether they are unowned debt.
- **Side-effect categorisation** (A/B/C table). Check the new storage and executor modules land in the right category and location.
- **Actor dependencies:** "persisted context contains only data; runtime references flow through invoke-input closures." The store is resolved through a process-level path-keyed registry — verify no store, driver, or service reference leaks into persisted context or snapshots.
- **TSDoc** on all exported symbols. The new storage modules add a large exported surface.

### 7. Plan conformance, task by task

For each of Tasks 1–6, walk the plan's checklist bullets against the tree. The plan repeatedly demands that migrated logic be carried over **verbatim** — only the lock/persistence mechanism may change. Named invariants to confirm survived:

- `#519` claim-activity `lastSeenAt` and `claimActivity()`
- `#613` caller/target claim unification in `captureAuthority` (and that the divergence was not ported forward)
- `#617` `#driveTerminalBare` authorized-only `releaseRunbooks` gate
- `#602` `propagateTerminalChildUpward` cycle/depth guard
- `applyOp` tagged-op merge/replace, `assertTrustedArtifactValues`, `assertTrustedResolvedCompletions`, `patchSnapshotSubstepStates`, `activeFrameKey` derivation, and the `JsonArrayStream`-stripping invariant in `flattenTemplateVars`

A rewrite that is *equivalent in the author's judgement* does not satisfy "verbatim." Diff the bodies.

### 8. Unresolved items the prior agent left open

Do not treat these as settled:

- ~15 stale `SessionLock` comment references in `lifecycle-command-service.ts` and `collection-service.ts` describing a lock that no longer guards anything. The agent asked the user whether to clean now or defer to Task 9 and **received no answer**. It has not been actioned. Do not action it without direction.
- `site/playwright.config.ts` — the suite reportedly needs `workers: 1` to pass; it fails at the default 3. The agent declined to change this, calling it a policy decision. Verify the failure is real and characterise it.
- `ASTRO_DEV_BACKGROUND=1` in `site/playwright.config.ts` depends on an internal Astro env var.
- `statePath` event metadata (`runbook-pipeline.ts:296`, `execution.ts:1481`) reportedly still emits `.rundown/runs/<id>.json`, a path that no longer exists.
- `run-state-lock.ts` reportedly unused but not deleted (scheduled for Task 9).
- Task 4's upward recovery projection, deferred to Task 8.
- A pre-existing flake in `tokenize-shell-exec-differential.integration.test.ts:541`, claimed to fail ~2/3 of the time on a clean tree, unrelated to this work. Confirm it is genuinely pre-existing — this is exactly the kind of attribution the prior agent could have got wrong in its own favour.

## Verification commands

Package scripts are canonical; run `pnpm run` to list them. Note:

- `pnpm run verify` is the pre-PR gate (format, spell, lint, test).
- Core tests: from `packages/core`, `pnpm test -- <path>`. Bare `npx jest` fails on ESM config — use the package script.
- Scoped mutation testing must use `pnpm --filter <pkg> exec stryker run` with **package-relative** paths. Repo-relative paths silently instrument zero mutants and exit 0. Always check the `Instrumented N source file(s) with M mutant(s)` line before trusting a score, and beware a stale `reports/stryker-incremental.json` printing a plausible aggregate over a zero-mutant run. Core is excluded from the per-PR mutation matrix, so a hand-run scoped pass is the only mutation signal a core PR gets.

## Deliverable

A findings report, most severe first. For each finding: the claim as made, what you did to check it, what you found, and a verdict of **confirmed / refuted / undetermined**. Undetermined is a legitimate and expected outcome; record it rather than resolving it by inference.

Conclude with a direct recommendation on whether Tasks 7–10 can proceed on this foundation, or whether earlier work must be corrected first.
