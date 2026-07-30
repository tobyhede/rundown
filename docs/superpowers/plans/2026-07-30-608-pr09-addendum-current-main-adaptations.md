# 608 PR 9 addendum — typed session refusals over current main

**Amends:** [2026-07-23-608-pr09-typed-session-refusals.md](2026-07-23-608-pr09-typed-session-refusals.md), as further corrected by [2026-07-27-608-pr09-pr14-correction-ledger.md](2026-07-27-608-pr09-pr14-correction-ledger.md). Both are write-once and unchanged; read the plan, then the ledger, then this file. Where they disagree, this file wins.

**Tracked in:** [#648](https://github.com/tobyhede/rundown/issues/648).

**Base:** `b5ba0c92bd6669096af53784aec8139e0254b323`, the merge of #663. This is **not** PR 8's merge commit — four further behaviour commits landed after #661. Re-fetch `origin/main` and record the actual base before branching; if it differs, re-audit every adaptation below before applying it.

**Why this exists:** PR 9 was written as a verbatim replay of `a823892fe` over 42 paths, gated on the cherry-pick producing no conflicts. Against the recorded base it produces **10 conflicted paths**, and every conflict resolves against the salvage — current `main` is newer in each. Two would silently regress merged behaviour. The result type the plan proposes introducing already exists, the plan's mutation commands are forbidden by current policy, and its allowlist is seven paths short of what compiles.

PR 9 remains the typed-refusal slice only. The atomic claim-aware stash work that the ledger added to PR 9 is **split to [#666](https://github.com/tobyhede/rundown/issues/666)** under the ledger's own split clause; see Delta 6. The sequence is unchanged: PR 9 → PR 10 → PR 11 → PR 12 → PR 13 → PR 14.

## Delta 1 — the salvage is a shape change, not a body replacement

Do not resolve conflicts by taking the salvage side. `a823892fe` predates #655, #656, and #663. Its value is the mechanical transformation `T` → `SessionMutationResult<T>` across call sites; its bodies are stale.

Re-apply the wrapper over `main`'s bodies. A correct PR 9 diff shows changed signatures, changed indentation, and added committed/refusal branches — not rewritten logic. Two conflicts are regression traps:

- **`session-service.ts:1369` `unstashForClaimId`.** `HEAD` carries the post-#655/#656 taxonomy: tombstone-aware `ctx.claim(parsed.claimKey)`, `superseded` / `missing-child` / `terminal-child` / `child-linkage-mismatch` / `parent-missing`, `classifyDelegationLiveness`, `touchClaimUpdatedAt`. Keep that body verbatim; change only the `this.mutate(...)` → `this.mutateGuarded(runIdSelector, ...)` wrapper and the return type.
- **`lifecycle-command-service.ts:1901`.** The salvage drops `code` from the `stale_claim` return — an RD-825/#663 regression. Keep `HEAD`'s four-field return and apply only the `if (release.status !== 'committed') return sessionMutationRefusalOutcome(release)` guard around `releaseRunbook`. There are 11 such call sites in that file.

Full conflict dispositions:

| Path | Resolution |
| --- | --- |
| `packages/core/src/runbook/state.ts` | Union the import list. |
| `packages/core/src/runbook/session-service.ts` | `HEAD` wins both hunks. `describeSupersession` / `supersededStashedClaim` are pure `HEAD` additions the salvage predates. |
| `packages/core/src/runbook/lifecycle-command-service.ts` | `HEAD` wins both discriminants. Keep the named `StaleClaimRefusal` and `ClaimBearerMismatchRefusal`; **add** the `SessionMutationRefusalOutcome` arm. |
| `packages/cli/src/helpers/runbook-pipeline.ts` | Union. `HEAD`'s `parent-missing` / `delegation-superseded` arms and the salvage's refusal arms are disjoint. Rename the salvage's discriminants to `main`'s snake_case. |
| `packages/cli/src/commands/pop.ts` | Union, and **keep `claimPopRefusal`** (`pop.ts:23-57`) — it maps `superseded` to `describeSupersededClaim`, the RD-825 no-retry signal. Wrap it in the committed/refusal split rather than replacing it with a flat `CLAIMED_RUNBOOK_UNAVAILABLE`. |
| `packages/core/__tests__/runbook/session-service.test.ts:1794` | `HEAD` wins — asserts `'superseded'` / `'parent-ended'`; the salvage asserts `'missing-claim'`. |
| `packages/core/__tests__/runbook/claim-seen.test.ts` | `HEAD` wins — uses `patchPersistedClaim`, because `saveSession` no longer persists an existing claim and the salvage's in-memory edit would not reach the row. |
| `packages/core/__tests__/runbook/lifecycle-command-service.test.ts:2610,2663` | Keep `HEAD`'s `claimed ??=` first-call-only injection; the salvage's unconditional `=` masks a wrong-reason guard. Add the unwrap inside it. |
| `packages/core/__tests__/runbook/session-service.process.test.ts:15` | Union the import list. |
| `packages/core/__tests__/runbook/storage/driver-contract.test.ts:276` | Both-added, no overlap. Keep both — see Delta 5. |

## Delta 2 — derive the result type, do not introduce one

`GuardedMutationResult<T>` (`packages/core/src/runbook/storage/mutation-result.ts:223-234`) already defines both refusal arms field-for-field against the plan's proposed union; only `status`→`kind` and kebab→snake differ. `GuardedMutationRefusalKind` exists at `:237`, and `ExecutionEpoch` is already branded by #664.

Define `SessionMutationResult<T>` as an `Extract<>`-derived alias over `GuardedMutationResult<T>` so the two cannot drift. Do not create a parallel union in `runbook-store.ts`. Keep the existing internal snake_case spelling and discard the salvage's kebab-case `'execution-in-progress'` / `'recovery-required'` entirely.

Genuinely new and safe to replay: `mutateSessionGuarded`, `pendingRecovery`, `executionOwned`. Note that PR 8's schema triggers already do the enforcement half — `claims_guard_*` and `stash_guard_*` (`storage/schema.ts:228-306`) already `RAISE(ABORT, 'execution_in_progress')` under ownership, and `claim_generation` already bumps on every claim/stash write. `mutateSessionGuarded`'s job is classification and preflight, not enforcement.

## Delta 3 — register and document the two codes in this PR

Neither `EXECUTION_IN_PROGRESS` nor `RECOVERY_REQUIRED` is registered. Follow the #663 precedent exactly (`5bb99d002`), which added `CLAIM_BEARER_MISMATCH`:

- append both to `CLISymbolicErrorCodeValues` (`packages/core/src/output/zod-schemas.ts:48-90`), which feeds `ErrorCodeSchema` at `:193-194`;
- add both documented error fences to `docs/spec/cli-output.md`, following the `CLAIM_BEARER_MISMATCH` block at `:1160-1169`;
- add the rows to the error table in `docs/reference/cli.md`.

Emit **uppercase** codes. The salvage's helper emits lowercase `'execution_in_progress'` / `'recovery_required'` and passes `{ runId }` / `{ runId, epoch }` as a third argument; discard both. The run id goes in the message only — the documented envelope is flat, and promoting fields no schema describes hands PR 14 unschematised output.

**This change gets zero mutation signal.** `packages/core/src/output/**` is inside core's Stryker exclusion, and `OutputEmitter.error` takes a bare `string`, so an unregistered code typechecks and passes `verify`. The only gate is `packages/core/__tests__/output/docs-error-code-drift.repo-asset.test.ts`, which asserts documented ⊆ registered. Documenting without registering fails; registering without documenting does not. Do both.

No intersection with [#662](https://github.com/tobyhede/rundown/issues/662) — its twelve unregistered codes are disjoint from these two, so PR 9 adds no new debt.

## Delta 4 — allowlist is 49 paths, not 42

The plan's self-review item "Exactly 42 changed paths" would block correct work. Seven paths beyond the derived allowlist are required — five break on `tsc` as direct callers of changed-signature methods, two are mandated by Delta 3:

| Path | Why |
| --- | --- |
| `packages/claude-code-plugin/__tests__/helpers/test-utils.ts:306` | destructures `issueRunControlClaim` |
| `packages/core/__tests__/runbook/guarded-drain-composition.test.ts:152,183` | destructures `issueRunControlClaim`; direct `claimRunbook` |
| `packages/core/__tests__/runbook/storage/fixtures/session-writer-child.ts:70-81` | cross-process fixture returns raw results over the wire |
| `packages/core/__tests__/runbook/storage/fixtures/child-protocol.ts` | result-shape types for the above |
| `packages/core/__tests__/testing/session-fixtures.test.ts:39` | asserts through `issueRunControlClaimFor` |
| `packages/core/src/output/zod-schemas.ts` | Delta 3 registration |
| `docs/spec/cli-output.md` | Delta 3 documentation |

CLI integration and command tests need no expansion — they route through the local `issueRunControlClaim` helper at `packages/cli/__tests__/helpers/test-utils.ts:429-434`, which is already in the allowlist and which the salvage already patches to unwrap.

Treat the 49-path list as the gate. An unexpected 50th path remains a stop-and-review event.

## Delta 5 — prove the trigger-abort message before relying on it

`mutateSessionGuarded` normalizes on **exact** string equality against `execution_in_progress`. Main's only assertion of that text is a regex (`runbook-store.test.ts:199`) against the *store-thrown* `Error` (`runbook-store.ts:1405`, whose message is `execution_in_progress: run … has active execution ownership`) — not against the SQLite `RAISE(ABORT)`.

Retain the salvage's added `driver-contract.test.ts` case asserting `thrown.message` is exactly `execution_in_progress` across both the native and sql.js drivers, and **land it before or with the normalizer**. If either driver decorates the raise text, exact equality degrades to a rethrow and the typed refusal becomes a crash.

## Delta 6 — atomic claim-aware stash is out of scope

The ledger (lines 60-68) added an atomic claim-aware stash slice to PR 9 and permitted splitting it. It is **split to [#666](https://github.com/tobyhede/rundown/issues/666)**, blocked on this PR.

Do not implement `stashForClaimId` here, and do not rewire `packages/cli/src/commands/stash.ts`. PR 9 is a zero-behaviour-change slice; the stash work is a new authority protocol with new refusal semantics and would make this diff unreviewable against its own allowlist gate. It also consumes `mutateSessionGuarded`, which this PR introduces, so it sequences after.

The ledger's attached condition is discharged: #666 was filed before PR 9, is linked from #648 and #608, and #608's closure guarantee was narrowed in the same action to exclude `stash --claim-id` and point at #666.

## Delta 7 — corrected verification sequence

The plan's §85 whole-file Stryker campaigns are forbidden by current repository policy: `runbook-store.ts` is ~1450 LOC, `session-service.ts` ~1500, `lifecycle-command-service.ts` ~2300, and `CLAUDE.md` records that a whole-file scope on `runbook-store.ts` alone ran 17+ minutes without finishing. The plan's instruction to delete `reports/stryker-incremental.json` is likewise forbidden as a `--force` substitute.

Build ordering is absent from the plan entirely and is required: PR 9 changes core's public type surface, and `packages/cli/src/helpers/session-mutation-result.ts` imports from `@rundown-org/core` through `dist`.

```bash
git fetch origin && git rev-parse origin/main     # re-audit if ≠ b5ba0c92b

pnpm --filter @rundown-org/core exec jest \
  __tests__/runbook/session-service.test.ts \
  __tests__/runbook/session-service.process.test.ts \
  __tests__/runbook/claim-seen.test.ts \
  __tests__/runbook/lifecycle-command-service.test.ts \
  __tests__/runbook/collection-service.test.ts \
  __tests__/runbook/inline-parent-advance.test.ts \
  __tests__/runbook/storage/driver-contract.test.ts \
  __tests__/runbook/guarded-drain-composition.test.ts \
  __tests__/testing/session-fixtures.test.ts

pnpm run build                                    # NEW — CLI resolves core via dist

pnpm --filter @rundown-org/cli exec jest \
  __tests__/helpers/claim-and-launch.test.ts \
  __tests__/helpers/runbook-pipeline.test.ts \
  __tests__/helpers/transition-orchestrator.test.ts \
  __tests__/services/execution-loop.test.ts \
  __tests__/commands/prune.test.ts
pnpm --filter @rundown-org/core exec jest __tests__/output/docs-error-code-drift.repo-asset.test.ts
pnpm --filter @rundown-org/claude-code-plugin exec jest

pnpm run test:mutate:changed                      # REPLACES both §85 campaigns
pnpm run verify
```

Forbidden for PR 9: the plan's §85 `--mutate` commands, deleting the incremental report, any `--` separator after `exec stryker run`, and repo-relative `--mutate` paths.

## Task order

1. Derive the `SessionMutationResult<T>` alias over `GuardedMutationResult<T>` (Delta 2).
2. Land the driver-contract trigger-abort test, then `mutateSessionGuarded` / `pendingRecovery` / `executionOwned` (Delta 5).
3. Rewrap the `SessionService` methods to `mutateGuarded`, preserving every body verbatim (Delta 1).
4. Thread committed/refusal through the core call sites, keeping `stale_claim.code` and `ClaimBearerMismatchRefusal` intact (Delta 1).
5. Register and document the two codes (Delta 3) — must precede step 7.
6. Add the CLI refusal renderer with uppercase codes; preserve `claimPopRefusal` (Deltas 1, 3).
7. Fix the five out-of-allowlist callers (Delta 4).
8. Adapt tests, keeping `HEAD`'s assertions in all five conflicted files (Delta 1).
9. Verify per Delta 7.
