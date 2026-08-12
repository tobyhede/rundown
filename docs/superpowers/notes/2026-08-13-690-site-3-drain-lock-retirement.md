# #690 site 3 — retiring the drain's CompletionLock

**Date:** 2026-08-13 **Supersedes parts of:**
[2026-08-12-690-site-3-drain-lock-finding.md](2026-08-12-690-site-3-drain-lock-finding.md)

## Corrections to the 2026-08-12 note

That note is accurate about the **problem** and wrong about the **cost of the
fix**. Three claims in its "Option A" section do not hold:

| Claim in the earlier note                                                                                        | Correction                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A fold requires reworking `sendAndSync`, which is shared with `EXECUTE_COMMAND` and spawns processes              | Wrong. The fold uses `prepareActorMutation`, not `sendAndSync`. `sendAndSync` was never touched.                                                                     |
| Option A is "larger than the remaining CLI sites combined"                                                       | Wrong, and it followed from the claim above. It is a normal-sized change of the same shape as sites 1 and 2, plus an interface narrowing.                            |
| #690's transaction-ownership item "collides" with the documented per-completion commit                           | Overstated. One apply per commit is exactly what the replacement preserves. Only making the _whole drain_ one transaction would overturn that, and nothing proposed it. |

Its still-valid core finding stands: each apply performed three independent
loads and one blind write, and the compare-and-swap prevented a lost version but
not a stale derivation.

## What the defect actually was

Worth stating precisely, because "the lock was load-bearing" undersells it and
"the CAS handles it" is wrong.

The drain selected a completion against `args.currentState`, validated it
against that same state, and then called `sendAndSync`, which **loads its own
state** and applies to that. Nothing checked the two agreed.

Reproduced against the pre-change code: seed a run at substep `1` with rows for
`1` and `2`; let another writer advance the cursor to `2`; drain with the
original captured state. Result — the row for substep `1` is consumed, substep
`1` is still `running`, the row for `2` is untouched, and the PASS landed on
substep `2`. The completion was applied to the wrong substep.

The lock hid this in practice by serialising drains. It was never a fix: nothing
about a file lock makes a caller's captured state fresh.

## The two verifications that gated the design

**Is `waitForMachineEffects` effect-free for the apply event?** Not quite, and
the answer needs stating rather than assuming. `APPLY_CURRENT_RESOLVED_COMPLETION`
is handled only in a leaf's `idle` child and raises PASS/FAIL, so the reachable
actors are whatever the next state's entry invokes. Of the machine's six:

- `commandExecActor` and `outputCaptureActor` are **unreachable** — entered only
  by `EXECUTE_COMMAND` and `COMMAND_RESULT`, and an apply raises neither. No
  spawn, no output capture.
- `forIterateActor` reads only; a `JsonArrayStream` is re-opened per call and
  carries no cursor.
- `delegationIssueActor` and `inlineLaunchIntentActor` persist nothing.
- `artifactResolveActor` **writes**: `mkdir -p` plus a manifest append on
  producer declarations.

That last one is the accepted deviation. Both writes are idempotent by identity
— `appendArtifactManifestRecord` collapses an equivalent row, pinned by
`artifact-manifest.test.ts` — and the machine already repeats them whenever
RETRY re-enters a step, which is why that idempotency check exists. A losing
attempt can leave a directory and a row for a transition that never committed;
read-side selector and other-run matching gate on
`isExistingRegularArtifactFile`, so an orphan naming an unwritten file does not
match.

The tension worth recording: `CoreEffectfulMutationExecutor` marks an
`effect_started` boundary before calling `compute` and records recovery rather
than retrying, because "the ambiguous effect must never repeat" — and `compute`
is a `prepareActorMutation` span. That stance is generic (the same executor
carries `EXECUTE_COMMAND` spans, which really do spawn) and does not survive
contact with this event's reachable set. It is also why `#driveSubstep` is
**not** precedent for re-runnability: `compute` runs exactly once there.

**Does any production caller arm the drain's guard?** No. The CLI wrapper never
destructured `guard`, `runGuardedParentAdvance` reaches only the fenced
lifecycle paths, and `maxApplied: 1` made the first-apply rule a no-op on the
only live path anyway. It was test-only surface and was deleted.

## The design, and the part worth copying

Sites 1 and 2 moved a classification inside the `mutateState` build callback.
Site 3 needed that **and** an interface change, because the gap was expressible
through the interface: as long as a caller can hand in a `currentState`, folding
the write fixes nothing.

- `selectNextResolvedCompletionApply` — pure, module-private, shared with the
  prepared twin. Its `apply` arm carries the branded completion, so a successful
  selection is proof the row matches the cursor it was selected against.
- `applyNextResolvedCompletion` — one apply, no `currentState`, everything inside
  one `mutateStateReturning` cycle.
- The core loop is **deleted**, not reproduced. Its only production caller passed
  `maxApplied: 1`. The real loop is the CLI's, which needs it to observe and emit
  each transition (Category A).

**A lock retirement that leaves a `currentState` parameter in place has fixed the
write and kept the defect.**

## Considered and rejected

Keeping the derivation outside the callback: commit with `attempts: 1` so a
stale version refuses without re-running `build`, and own the reload /
re-derive / retry loop in the module. This keeps `build` trivially pure and makes
the repeat explicit. Rejected because `mutateBackoffMs` is module-private to
`runbook-store.ts`, so it means either exporting the jitter CLAUDE.md calls
load-bearing or re-implementing it — trading a documented, bounded deviation for
a duplicated retry protocol in a consumer. Worth revisiting if the artifact
write ever stops being idempotent.

## Consequences

- `RunbookStateManager.mutateStateReturning` — a CAS whose callback returns a
  whole state. An async derivation that already produces one cannot be expressed
  as a patch.
- `recordManualCompletion` deleted (zero production callers since the fenced seam
  landed); its classification coverage moved onto `prepareManualCompletion`.
- `ExecutionLifecycleService.listResolvedCompletions` and two private readers
  deleted with the loop that was their only caller. `RunbookCompletionService` no
  longer takes an `ExecutionLifecycleService`.
- Two tests in `lifecycle-command-service.test.ts` were mocking methods the seam
  under test does not call, so they pinned nothing; they now inject at
  `prepareActorMutation` and were confirmed to fail when
  `reconcileFencedTerminalObservation` is broken.

## Still open

- CLI sites 3a (`run.ts`), 3b (`runbook-pipeline.ts`, gated on #732) and 3c
  (`execution.ts`). Different shape — they fence a launch/claim race, not a
  read-derive-write gap — so this recipe does not transfer unmodified.
- The `CompletionLock` / `DelegationLock` modules and RD-810, for #690 phase 4.
- `completion-service.test.ts` leaks memory under Stryker (18–22 OOM events per
  run, with worker restarts and occasional SIGABRT). Pre-existing, unrelated to
  this branch, and it makes that file's mutation gate unreliable.
