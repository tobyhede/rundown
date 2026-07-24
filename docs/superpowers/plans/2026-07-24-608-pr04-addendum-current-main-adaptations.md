# 608 PR 4 addendum — adaptations to current `main`

**Amends:** [2026-07-23-608-pr04-guarded-actor-commit-seam.md](2026-07-23-608-pr04-guarded-actor-commit-seam.md). That plan is write-once and unchanged; read it first, then apply the deltas below. Where the two disagree, this file wins.

**Tracked in:** [#648](https://github.com/tobyhede/rundown/issues/648).

**Why this exists:** the PR 4 plan was written against the salvage history. PR 2 and PR 3 have since merged, and three of the four owned commits no longer apply as-is against what they landed. A full trial replay of `64f840ded a39701d6e 785a3eabb e203ec905` onto `464e94ee1` produced one merge conflict, three failing tests, and one hard `tsc` error. None of them change PR 4's intent; all three are adaptations to work already on `main`.

Nothing here relaxes the parent plan's constraints. The ownership block, the "no CLI lifecycle dispatch" rule, the named-test command, the scoped Stryker command, and `corepack pnpm run verify` all stand exactly as written.

## Delta 1 — resolve the `schema.ts` conflict in favour of `HEAD`

`785a3eabb` conflicts on `packages/core/src/runbook/storage/schema.ts`. The parent plan's rule — resolve "in favor of current-main package scripts, CI, error helpers, docs guards, and test conventions" — does not reach this case: the conflict is on production SQL semantics, not on any of those categories. Resolve it as follows.

The commit narrows `claims_guard_update` and `claims_bump_gen_update` to resolution-affecting columns, so that a `last_seen_at` refresh (#519 claim-activity liveness) is neither refused under execution ownership nor bumps `claim_generation`. Current `main` already achieves that: `9080c1849` (PR 2) landed both triggers as `... UPDATE OF key, controlled_run, secret_hash, issued_generation, status, parent_run_id, parent_linkage_version, delegation_json, grants_json`, which already excludes `last_seen_at` and `updated_at`.

The incoming column list is a strict narrowing of main's — it additionally drops `key` and `issued_generation`. Taking the incoming side would weaken a guard `main` deliberately holds: rotating a claim's lookup key or its issued generation while an execution owner holds the run would stop being refused, and would stop bumping `claim_generation`.

- **Keep `HEAD`'s column list on both triggers.** Do not adopt the incoming list.
- Optionally graft the commit's two explanatory comments above the triggers; they document why `last_seen_at` and `updated_at` are excluded, which main's version leaves implicit.
- **Keep the commit's tests.** They pass against main's schema unmodified once Delta 2 is applied, and they are what actually pins the liveness behaviour.

## Delta 2 — route the cherry-picked ownership tests through `takeOwnership`

`785a3eabb` and `e203ec905` each add tests that simulate an execution owner with a bare `UPDATE runs SET exec_token = 'sha256:live' WHERE id = :id`. PR 3 made the execution-identity columns all-or-nothing under a schema CHECK — `exec_epoch`, `exec_pid`, and `exec_token` move together, and the epoch must name a real `execution_attempts` row — so all three fail with `CHECK constraint failed`:

- `mutateState (transactional replacement for the per-run lock) › refuses immediately while an execution owns the run`
- `session persistence and run listing › refuses to delete a run with an active execution owner`
- `tombstone preservation (#519 lastSeenAt survives) › records claim activity even while the run has an active execution owner`

Replace each of the three inline `UPDATE` blocks with `takeOwnership(txn.tx, state.id)`. That helper is already in `packages/core/__tests__/runbook/storage/runbook-store.test.ts`, added by PR 3, and its docblock warns against exactly this pattern. This is mechanical and does not alter what any of the three tests assert.

## Delta 3 — widen `readRunWithVersion` to `SqlReadTransaction`

`e203ec905` adds `RunbookStore.mutateState`, which calls `this.readRunWithVersion(tx, runId)` inside `this.driver.read(...)` but declares the helper's parameter as `SqlTransaction`. PR 1 and PR 3 introduced the narrower `SqlReadTransaction` that `driver.read` supplies, so this is a hard compile error:

```
src/runbook/storage/runbook-store.ts(705,79): error TS2345: Argument of type
'SqlReadTransaction' is not assignable to parameter of type 'SqlTransaction'.
  Property 'exec' is missing in type 'SqlReadTransaction' but required in type 'SqlTransaction'.
```

Change the parameter to `SqlReadTransaction`. The helper only prepares and reads, and every other read helper in the file (`readRun`, `readSession`, `readStack`, `readResolvedCompletions`, `readOps`) already takes the narrow type. No call site changes.

## Revised step list

Replaces the four checkboxes in the amended plan. Everything else in that plan — shared constraints, commit ownership, review checkpoint, self-review checklist — is unchanged.

- [ ] Fetch `origin/main`, record the SHA, and branch from it. Cherry-pick without committing, in order: `64f840ded a39701d6e 785a3eabb e203ec905`. Add no CLI lifecycle dispatch.
- [ ] Resolve the `schema.ts` conflict per Delta 1, then apply Delta 2 and Delta 3. Confirm `git diff --name-only --diff-filter=U` prints nothing, `git diff --check` exits 0, and every changed path is in the amended plan's ownership block — 12 paths, no more.
- [ ] Run `corepack pnpm --filter @rundown-org/core exec tsc --noEmit -p tsconfig.json`. Expected: exit 0, no output. Delta 3 is the only reason this fails.
- [ ] Run `corepack pnpm --filter @rundown-org/core exec jest __tests__/runbook/actor-service-execution-fence.test.ts __tests__/runbook/storage/execution-lease.test.ts __tests__/runbook/storage/runbook-store.test.ts __tests__/runbook/storage/store-registry.test.ts`. Expected: 121 pass across 4 suites, including commit refusal and registry reuse/close behaviour.
- [ ] Run `corepack pnpm --filter @rundown-org/core exec stryker run --mutate src/runbook/effectful-mutation-executor.ts,src/runbook/actor-service.ts,src/runbook/storage/store-registry.ts --testFiles '__tests__/runbook/actor-service-execution-fence.test.ts,__tests__/runbook/storage/store-registry.test.ts'`. Delete `reports/stryker-incremental.json` first. Expected: non-zero instrumentation and no survivor that skips effect-boundary marking, guarded commit, or recovery routing.
- [ ] Run `corepack pnpm run verify`; commit `refactor(core): fence actor computation and persistence`; open and merge PR 4. Record all three deltas in the PR description.

## Trial-replay evidence

Measured on a throwaway worktree at `464e94ee1` with the three deltas applied. These are the numbers the real PR should reproduce.

| Gate | Result |
| --- | --- |
| Named tests (4 suites) | 121 passed |
| `tsc --noEmit` on `@rundown-org/core` | clean |
| Full `@rundown-org/core` suite | 4525 passed, 2 skipped, 198 suites |
| Workspace `build` | clean |
| Full `@rundown-org/cli` suite | 3112 passed, 143 suites |
| Changed paths | exactly the 12 owned paths; no CLI lifecycle dispatch |

Not exercised in the trial: the scoped Stryker command and `corepack pnpm run verify`. Both remain mandatory gates on the real PR.
