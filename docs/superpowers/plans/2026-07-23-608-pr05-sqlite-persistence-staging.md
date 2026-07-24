# 608 Controlled Rebuild — PR 5: Stage run and session persistence on SQLite

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Parent plan:** [2026-07-23-608-controlled-rebuild.md](2026-07-23-608-controlled-rebuild.md) — PR 5 of 14.

**Goal:** Back `RunbookStateManager` and `SessionService` with SQLite through `StoreRegistry`, with transactional session writes and foreign keys enabled in both adapters.

**Depends on:** PR 4 (`refactor(core): fence actor computation and persistence`) merged. Branch from the freshly fetched merged `origin/main`.

**Tech Stack:** TypeScript, XState 5, SQLite (`node:sqlite` and sql.js), Jest, Stryker, Biome, ESLint, pnpm 11 through Corepack, GitHub pull requests.

## Shared Constraints

- Fetch `origin/main` and record the then-current SHA before creating the branch. Never base work on `608-sqlite-claim-concurrency`, `608-integration`, or a closed PR branch — the source commits are evidence, not merge bases.
- Salvage tag `608-salvage-2026-07-23` (peeled to `5364e3965`) is immutable: never force-update or delete it, and never prune the salvage branches.
- Open only one dependent implementation PR at a time. This PR must merge before PR 6 branches from the newly fetched `origin/main`.
- **This is persistence staging, not production cutover.** SQLite backs the staged state services, but legacy lock/frontend paths remain until PR 13 and obsolete JSON detection is not yet the typed entry gate. No PR description may claim complete one-store authority yet.
- Before editing, run the exact `git cherry-pick --no-commit` sequence below. Resolve conflicts in favor of current-main package scripts, CI, error helpers, docs guards, and test conventions; preserve this task's named behavior and tests.
- After conflict resolution, `git diff --name-only --diff-filter=U` must print nothing, `git diff --check` must exit 0, and every changed path must be in the derived allowlist. An unexpected path is a stop-and-review event, not an implicit addition.
- Run the named tests, the exact scoped mutation command, and `corepack pnpm run verify`. Expected result is exit 0; Stryker must report at least one instrumented source and at least one mutant. Never use `--allowEmpty`.
- The only scoped mutation form is `corepack pnpm --filter @rundown-org/<pkg> exec stryker run --mutate <package-relative-comma-separated-paths> --testFiles <package-relative-comma-separated-paths>`. Pass each option once, use package-relative paths, and never insert a pnpm `--` separator. Use the comma form, never a brace glob: Stryker splits `--mutate` and `--testFiles` on commas *before* brace expansion, so `{a,b}.ts` degrades into patterns that match nothing and the run reports `Instrumented 0 source file(s) with 0 mutant(s)` — a gate that cannot fail. Confirm that line reports a non-zero count before trusting any score, and delete `reports/stryker-incremental.json` first so an `incremental: true` cache cannot replay a previous run's aggregate over it.
- `RESULT`, `HANDLER`, and `ACTION` remain distinct. Lifecycle dispatch is type-driven; no frontend branches on raw action strings and no action is silently mapped to another action.
- Persisted `RunbookState.schemaVersion` remains `1`. SQLite storage schema versions are independent. Never migrate, import, hydrate, shim, or dual-read incompatible persisted JSON state.
- Runtime services, callables, `cwd`, and store instances flow through actor invoke-input/constructor DI, never persisted XState context.
- CLI tests default to JSON output; `--text` only where the test is explicitly about human-readable rendering.
- `pnpm run verify` is mandatory before every push. Any red local or GitHub check is a hard stop.

## Commit Ownership

Owned in full, replayed in this order: `e5f0b2154`, `1e0c67cb7`, `279bd599f`, `b9e23b561`, `53534f388`, `c3e9a38c1`, `fb2619d4d`, `2de7837d5`.

Excluded: `4859a9c08` — all three of its paths belong to PR 14, which owns the runnable WebContainer probe correction.

## Task: Stage run and session persistence on SQLite

**Files:**
- Derive the authoritative allowlist with `for c in e5f0b2154 1e0c67cb7 279bd599f b9e23b561 53534f388 c3e9a38c1 fb2619d4d 2de7837d5; do git diff-tree --no-commit-id --name-only -r "$c"; done | sort -u > /tmp/rd608-pr5-allowed`.
- Exclude all three paths from `4859a9c08`; PR 14 owns the runnable WebContainer probe correction.

**Interfaces:**
- Produces SQLite-backed `RunbookStateManager` and `SessionService`, shared through `StoreRegistry`, with transactional session writes and foreign keys enabled in both adapters.
- This is persistence staging, not production cutover: SQLite backs the staged state services, but legacy lock/frontend paths remain until PR 13 and obsolete JSON detection is not yet the typed entry gate. No PR description may claim complete one-store authority yet.

- [ ] Cherry-pick without committing, in exact order: `e5f0b2154 1e0c67cb7 279bd599f b9e23b561 53534f388 c3e9a38c1 fb2619d4d 2de7837d5`. Run `git diff HEAD --name-only | sort -u > /tmp/rd608-pr5-actual && comm -3 /tmp/rd608-pr5-allowed /tmp/rd608-pr5-actual`; expected: no output. Keep current-main mutation scripts, docs guards, and error helpers authoritative.
- [ ] Preserve `2de7837d5`'s deterministic contention witness in `session-service.process.test.ts`: each worker reports entry after `t0`; the parent waits for every report; the parent releases the workers; assertions require overlapping attempts, every domain write present, and no lock-timeout or partial state. Do not restore the historical scheduler/timing-based witness.
- [ ] Run `corepack pnpm --filter @rundown-org/core exec jest __tests__/runbook/state.test.ts __tests__/runbook/session-service.test.ts __tests__/runbook/session-service.process.test.ts __tests__/runbook/storage/driver-contract.test.ts __tests__/runbook/storage/runbook-store.test.ts`. Expected: all pass and the process test proves overlap rather than relying on sleeps.
- [ ] Run `corepack pnpm --filter @rundown-org/cli exec jest __tests__/commands/run.test.ts __tests__/commands/status.test.ts __tests__/commands/stash-pop.test.ts __tests__/commands/prune.test.ts __tests__/commands/claim.test.ts`. Expected: default JSON contracts pass.
- [ ] Run `corepack pnpm --filter @rundown-org/core exec stryker run --mutate src/runbook/state.ts,src/runbook/session-service.ts,src/runbook/storage/runbook-store.ts,src/runbook/storage/sqljs-driver.ts --testFiles __tests__/runbook/state.test.ts,__tests__/runbook/session-service.test.ts,__tests__/runbook/storage/runbook-store.test.ts,__tests__/runbook/storage/driver-contract.test.ts`. Expected: non-zero instrumentation; FK, session transaction, and guarded-state mutants are killed.
- [ ] Run `corepack pnpm run verify`; commit `refactor(core): stage run and session persistence on SQLite`; open and merge PR 5.

## Self-Review Checklist

- [ ] `comm -3` between allowlist and actual changed paths printed nothing.
- [ ] `4859a9c08` paths are absent from this PR.
- [ ] The contention witness is deterministic (barrier-based), not timing-based.
- [ ] The PR description calls this staging, not production cutover.
- [ ] FK, session transaction, and guarded-state mutants are killed.
- [ ] `corepack pnpm run verify` exited 0 before push; all GitHub checks green before merge.
