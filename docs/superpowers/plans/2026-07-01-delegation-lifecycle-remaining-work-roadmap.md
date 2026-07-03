# Delegation Lifecycle — Remaining-Work Roadmap

- **Date:** 2026-07-01
- **Branch audited:** `delegate-lifecycle-command-seam`
- **Model in force:** single-level report-then-collect
- **Status:** prospective plan (roadmap). Findings below are traced to
  `file:line` against current code; this document orders the remaining work by
  (severity, dependency). It is not a conformance grade.

## Confirmed model

Report-then-collect (single-level) is genuinely implemented:

- Child terminal close is **report-only** (`delegation-completion.ts:290-301` →
  `reportTerminalToDelegatingRun` `:70-94` → `recordChildCompletion`). Parent
  becomes collection-pending; it does not auto-advance.
- Parent advances **only** via `rd collect` →
  `collectDelegationOutcomes` → `drainResolvedCompletions`
  (`collection-service.ts:347-356`).
- Bare mutation refusal gate is real and correct
  (`rejectBareMutationIfCollectionPending`, `command-policy.ts:284-305`), reading
  **live unconsumed** outcome rows. Targeted `--step`/`--claim-id` intentionally
  exempt.
- N-level blocked at `createDelegation` step 0 (`delegation-service.ts:468-474`).

**Deltas that constitute the remaining work:**

- Refusal + actor-context gates cover pass/fail/delegate but **not** terminal
  commands complete/stop.
- Outcome derivation for the close path is CLI-hand-rolled; core trusts
  `args.result`.
- The `issued→active` link write lives in the CLI, not core.
- No persisted lifecycle-status union; `superseded` is absent, and manual retry
  does not supersede a pending outcome (the sharpest correctness hole).

## Remaining-work items (prioritized)

| # | Item | Area | Verdict | Severity | Locus | Issue |
|---|------|------|---------|----------|-------|-------|
| 1 | Manual `rd delegate --retry` after `abort --force` does not supersede the prior outcome → `rd collect` drains a **stale attempt-1 FAIL** | e | STILL-PRESENT | Correctness (high) | `delegation-service.ts:621-625`; retry gate `lifecycle-command-service.ts:729-735` | #509-P2 |
| 2 | Bare `complete`/`stop` bypass actor-context gate on **every** front end; subprocess can force-terminate ancestor run | f | STILL-PRESENT | Trust (high) | `complete.ts:61-148/211`, `stop.ts:54-127/188`, `force-terminal-workflow.ts:197`; `subprocess-mutation-boundary.ts:24-30` | #510-P1/P2 |
| 3 | Same-substep **double-mint TOCTOU** — no `DelegationLock` around decide→mint→persist | b | NOT-DONE | Race/correctness | `lifecycle-command-service.ts:483,611`; blind merge overwrite | #508 |
| 4 | complete/stop **delete the terminal-claim tombstone** pass/fail retain → non-idempotent repeat + destroys confirm/conflict evidence | h | NOT-DONE | Correctness | delete `complete.ts:201,231`, `stop.ts:177,204`; retain `lifecycle-command-service.ts:1248` | #510-P3 |
| 5 | resolve→record→drain spans **three separate lock acquisitions**; concurrent writer orphans a row | c | MITIGATED-RESIDUAL | Correctness/race | record `completion-service.ts:419-422` + drain `:606-608`; unlocked guards `lifecycle-command-service.ts:830,850` | #500 |
| 6 | Subprocess `rd collect` mints orchestrator trust with **no independent evidence** | f | PARTIAL | Trust | `collect.ts:428-434`; collect ∉ withhold set | #509-P1 |
| 7 | Single-source issuance incomplete: positional `rd delegate <rb>` throws **RD-813 instead of echo/RD-804**; `--step` can re-mint over a **claimed** child | a | PARTIAL/STILL-PRESENT | Correctness | `inferDelegationTarget` throws `delegation-inference.ts:172`; `createDelegation` step 7 skips claimed | #496 |
| 8 | Bare complete/stop skip the **collection-pending refusal** → discard pending outcomes | f | MITIGATED-RESIDUAL | Correctness | complete/stop have no `CommandIntent`; never call `command-policy.ts:284-305` | #510 |
| 9 | Delegation-outcome derivation split: CLI hand-rolls `completed?pass:fail`; core trusts `args.result` (no live divergence today — every CLI site is terminal-guarded, so the CLI ternary and `lifecycleToDelegationOutcome` agree; the duplication is the defect) | d | PARTIAL | Architecture (latent correctness) | core fallback `completion-service.ts:556`; CLI `transition-command.ts:147`, `claim.ts:228`, `complete.ts:236`, `stop.ts:117,215` | #510 |
| 10 | `rd collect` readiness (`missing_outcomes`) reads cached `substepState.status`, not live outcomes | d | PARTIAL | Correctness (diagnostic) | `collection-service.ts:140-156`; status not reset on RETRY | #509-P3 |
| 11 | Claimed-child **post-collect window**: no process-level barrier; child is effective parent-orchestrator | g | MITIGATED-RESIDUAL | Trust/architecture | no `handoffPending`; `lifecycle-command-service.ts:884-886` | #460 |
| 12 | Plugin delegation-closure: unlocked RMW loses tokens; consume-before-verify; CLI fails open on malformed SubagentStop | — | STILL-PRESENT | Correctness (plugin) | `subagent-stop.ts:115` vs `:186`; `cli.ts:37-64,95-105` | #470 |
| 13 | `superseded` lifecycle state entirely absent; retry overwrites in place | i | NOT-DONE | Architecture / spec | zero `supersed*`; retry replaces `.delegation` wholesale | #509-P2 |
| 14 | `issued→active` child-link write lives in CLI, not core | i | PARTIAL | Architecture | `runbook-pipeline.ts:1102-1127` | — |
| 15 | Narrow cross-process race: child-terminal set before outcome row written | g | PARTIAL | Race (low) | `sendAndSync` then outcome under `DelegationLock`; `runGuardedParentAdvance` session-scoped | subsumed by 11 |

## Issue disposition

| Issue | Disposition |
|-------|-------------|
| #494 ActorContext.source removal | **FIXED / closeable** |
| #460 claimed child drives parent | **MITIGATED-RESIDUAL** (residual = items 11, 7) |
| #496 single-source issuance | **STILL-PRESENT** (item 7) |
| #500 explicit-cursor TOCTOU | **MITIGATED-RESIDUAL** (item 5) |
| #508 issuance/retry atomicity | **STILL-PRESENT** (item 3) |
| #509 collect trust + freshness | **STILL-PRESENT** (items 1, 6, 10) |
| #510 complete/stop behind seam | **STILL-PRESENT** (items 2, 4, 8, 9) |
| #470 plugin closure defects | **STILL-PRESENT** (item 12) |
| #499 seed frame-key fixtures | STILL-PRESENT (test-only) |
| #498 scenario capture-from-output | STILL-PRESENT (prospective/test-infra) |

**Green tests that pin the bug (must be flipped when fixed):**
`subprocess-mutation-boundary.test.ts:78-82` (item 2),
`complete.test.ts:361-367` + `stop.test.ts:433-435` (item 4),
`session.test.ts:180-199` + `cli.integration.test.ts:55-93` (item 12),
`collection-service.test.ts` status-only readiness (item 10).

**Claim-vs-code conflicts:** any spec/plan text asserting "uniform
actor-context enforcement" or "single-source issuance resolution" as LANDED is
contradicted by code (items 2 and 7). Trust the code.

## Could-not-resolve from static reading

- **#470-D3 fail-open** — needs an e2e check under real Claude Code (feed a
  malformed `SubagentStop`; only `exit 2` on stdout blocks). Static evidence
  already supports STILL-PRESENT: on a malformed/empty payload the CLI
  (`cli.ts:37-64,95-105`) writes its `{continue:false}` block intent to
  **stderr** and exits **`1`** (a non-blocking code — not `exit 2`, and a
  `continue:false` decision is honored only on stdout with exit 0), so the stop
  is not blocked. The e2e check would only confirm this channel/exit-code
  behavior under the real host.
- **#508 / #500 races** — representable statically; a demonstrating repro needs
  an interleaved multi-process test. Absence of that test is itself the gap.

## Fix sequence (dependency-ordered clusters)

**Cluster A — `#510` complete/stop core seam** *(items 2, 4, 8, 9)* — highest
leverage. Add a core terminal-seam method that (a) takes `CallerEvidence` and
runs `resolveCommandIntent`, (b) derives `completed→pass`/`stopped→fail` in core
via `lifecycleToDelegationOutcome`, (c) records **before** release with
`retainClaimsAsTerminal:true`, (d) honors `rejectBareMutationIfCollectionPending`.
Add complete/stop to the subprocess withhold set. Flip the bug-pinning tests.

Status: In progress
Plan: docs/superpowers/plans/2026-07-01-cluster-a-complete-stop-core-seam-plan.md


**Cluster B — retry supersession** *(items 1, 10, 13)*. Make manual
`retryDelegation`/`createDelegation` reset the substep to
`{status:'pending', result:undefined}` — mirroring the machine-hook path
(`retry-hook.ts:171-175`, which resets substep `status`/`result`, **not** the
`resolvedCompletions` row itself) — and additionally consume/clear the pending
`resolvedCompletions` row for `(frameKey, entry, substep)`. (Today collect
readiness keys on `substepState.status`, so the status reset is what makes a
stale outcome uncollectable; the row-clear closes the gap once readiness reads
live outcomes.) Base collect readiness on live outcomes, not
`substepState.status`. Decide `superseded`: implement a retained marker or strike
it from the spec. Preserve the machine-hook re-entry re-completion
(`completion-service.test.ts:1048`). Add the `abort --force → --retry → collect`
regression test.

**Cluster C — issuance atomicity + single-source** *(items 3, 7)* — `#508`+`#496`.
Hold `DelegationLock(parentRunId)` across re-read→echo/conflict→persist (add an
unlocked persist twin); re-run the RD-804 existence check inside the lock.
Consolidate the three echo evaluators onto one predicate; route positional
issuance through the shared resolver instead of `inferDelegationTarget`. Add
same-substep concurrency + positional-echo tests.

**Cluster D — explicit-cursor lock span** *(items 5, 15)* — `#500`. Hold one
`CompletionLock` across record+drain for the explicit-target path; re-validate
resolved step/frame identity inside the record lock after the `:448` reload. Seed
real `buildFrameKey` fixtures (`#499`). Same lock-scope pattern as Cluster C.

**Cluster E — collect trust** *(item 6)* — `#509-P1`. Thread caller evidence
through `collect.ts` / withhold bare subprocess collect. Composes with Cluster A's
withhold-set change.

**Cluster F — plugin closure** *(item 12)* — `#470`. File-lock the hook RMW;
verify-before-consume; make the CLI fail **closed** on malformed payloads.
Package-isolated; independent.

**Cluster G — claimed-child barrier** *(item 11, `#460`)* — **blocked on a design
decision**: process-scoped `handoffPending` barrier vs. scoping bare commands out
of the parent's default-active stack, reconciled with report-then-collect. The
`claim-handoff-barrier` branch is reference only (stale, not rebasable).

**Cluster H — architecture cleanup** *(item 14 + doc reconciliation)*. Extract a
core `linkDelegationChild` primitive (frame-scoped) and dispatch from CLI. Correct
the design doc so the delegation lifecycle (`issued→active→cancelled`, `closed` as
a derived overlay) is separated from session-level `stashed`/`pruned`.

**Ordering rationale.** A and B are the two live wrong-outcome/trust defects with
no blockers → first. C and D share the lock-scope pattern; proceed after B (both
touch retry/record state reset). E composes with A. F is package-isolated (any
time). G needs a decision before code. H is non-urgent cleanup. Items 8/9/10 ride
along in A/B rather than as standalone work.

## Addendum (2026-07-02) — post-roadmap issues from planning-runbook friction report

Four issues (#519–#522) were filed from a planning-pipeline friction report
(`.work/2026-07-02-planning-runbook-friction-report.md`) after this roadmap was
written. None is covered by items 1–15 above. Crossover was assessed against the
**implemented (unmerged)** Cluster A (`worktree-cluster-a-complete-stop-seam`) and
Cluster B (`cluster-b-retry-supersession`) branches.

| Issue | Nature | Roadmap relationship |
|-------|--------|----------------------|
| **#519** — parent-side detection of abandoned/idle claims (genuinely crashed/gone child; no `SubagentStop` fires) | New | Sibling of Cluster G / #460 (item 11), but distinct: items 11/15 cover a claimed child *driving* the parent post-close; #470 (item 12) is child-side plugin closure. **No item covers parent-side liveness/lease detection of a dead child.** Cluster A's `stale_claim`/`CLAIMED_RUNBOOK_UNAVAILABLE` handling is command-side targeting, not background abandonment detection — no overlap that resolves it. |
| **#520** — command-step tool-error/timeout (RD-999) is an unmapped third outcome; secondary: command stdout/stderr interleaved into `rd collect` JSON | New | **Out of scope for this roadmap.** Items 1/6/10 (#509) are delegation collect trust/freshness; Cluster B's collect-readiness change is scoped to delegation substeps (`agentId === 'delegation'`). #520 is command-step execution, not delegation lifecycle — no crossover. |
| **#521** — inline-composed child left `status: active` after `runbook_completed` | New; adjacent to Cluster A + #518 | Cluster A pulls inline composition into scope (multi-run FORCE cascade; wires `cleanupOrphanedActiveStack` into bare `complete`/`stop`, `terminal-command.ts:~1163,~1229`) but does **not** touch the normal-completion path, so #521's root cause is unfixed. **Interaction:** Cluster A widens #518's blast radius (`cleanupOrphanedActiveStack` now on every bare terminal command) → fix #518 before/with Cluster A. |
| **#522** — docs: `rd delegate` is an idempotent confirm/re-issue, not the minting step | New (docs) | Docs complement to item 7 / #496 (code). Also adjacent to Cluster B, which changes what `rd delegate --retry` *does* (now supersedes the prior outcome via `#supersedePendingOutcome`) — the docs update could note the supersession behavior. No conflict. |

**No new issue's framing contradicts a roadmap finding**, with one correction:
#521's original "not currently in #510's scope" wording is now inaccurate — Cluster A
(= #510) does touch the inline terminal lifecycle and orphan cleanup, though not the
normal-completion marking that #521 targets. #521 has been updated accordingly.
