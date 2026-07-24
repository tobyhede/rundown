# 608 Controlled Rebuild — PR 2: Transactional `RunbookStore`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Parent plan:** [2026-07-23-608-controlled-rebuild.md](2026-07-23-608-controlled-rebuild.md) — PR 2 of 14.

**Goal:** Add the transactional repository (`RunbookStore`, `CapturedAuthority`, typed guarded mutation results) on top of the driver substrate. Runtime callers remain on their pre-existing persistence route.

**Depends on:** PR 1 (`feat(core): add SQLite driver substrate`) merged. Branch from the freshly fetched merged `origin/main`.

**Tech Stack:** TypeScript, SQLite (`node:sqlite` and sql.js), Jest, fast-check, Stryker, Biome, ESLint, pnpm 11 through Corepack, GitHub pull requests.

## Shared Constraints

- Fetch `origin/main` and record the then-current SHA before creating the branch. Never base work on `608-sqlite-claim-concurrency`, `608-integration`, or a closed PR branch — the source commits are evidence, not merge bases.
- Salvage tag `608-salvage-2026-07-23` (peeled to `5364e3965`) is immutable: never force-update or delete it, and never prune the salvage branches.
- Open only one dependent implementation PR at a time. This PR must merge before PR 3 branches from the newly fetched `origin/main`.
- Before editing, run the exact `git cherry-pick --no-commit` sequence below. Resolve conflicts in favor of current-main package scripts, CI, error helpers, docs guards, and test conventions; preserve this task's named behavior and tests.
- After conflict resolution, `git diff --name-only --diff-filter=U` must print nothing, `git diff --check` must exit 0, and every changed path must be listed in the ownership block below. An unexpected path is a stop-and-review event, not an implicit addition.
- Run the named tests, the exact scoped mutation command, and `corepack pnpm run verify`. Expected result is exit 0; Stryker must report at least one instrumented source and at least one mutant. Never use `--allowEmpty`.
- The only scoped mutation form is `corepack pnpm --filter @rundown-org/<pkg> exec stryker run --mutate <package-relative-comma-separated-paths> --testFiles <package-relative-comma-separated-paths>`. Pass each option once, use package-relative paths, and never insert a pnpm `--` separator. Use the comma form, never a brace glob: Stryker splits `--mutate` and `--testFiles` on commas *before* brace expansion, so `{a,b}.ts` degrades into patterns that match nothing and the run reports `Instrumented 0 source file(s) with 0 mutant(s)` — a gate that cannot fail. Confirm that line reports a non-zero count before trusting any score, and delete `reports/stryker-incremental.json` first so an `incremental: true` cache cannot replay a previous run's aggregate over it.
- `RESULT`, `HANDLER`, and `ACTION` remain distinct. Lifecycle dispatch is type-driven; no frontend branches on raw action strings and no action is silently mapped to another action.
- Persisted `RunbookState.schemaVersion` remains `1`. SQLite storage schema versions are independent. Never migrate, import, hydrate, shim, or dual-read incompatible persisted JSON state.
- Runtime services, callables, `cwd`, and store instances flow through actor invoke-input/constructor DI, never persisted XState context.
- `pnpm run verify` is mandatory before every push. Any red local or GitHub check is a hard stop.

## Commit Ownership

Owned in full: `2b5eed7e2`.

## Task: Add the transactional repository

**Files:**
- Create/Modify: `packages/core/src/runbook/storage/{runbook-store,mutation-result,schema}.ts`
- Test: `packages/core/__tests__/runbook/storage/{runbook-store,runbook-store.properties}.test.ts`

**Interfaces:**
- Produces: `RunbookStore`, `CapturedAuthority`, typed guarded mutation results, and transaction-local repository operations. Runtime callers remain on their pre-existing persistence route.

- [ ] Branch from merged `origin/main`; run `git cherry-pick --no-commit 2b5eed7e2`; verify the five-path allowlist above, no unmerged paths, and `git diff --check`.
- [ ] Run `corepack pnpm --filter @rundown-org/core exec jest __tests__/runbook/storage/runbook-store.test.ts __tests__/runbook/storage/runbook-store.properties.test.ts`. Expected: unit and property suites pass.
- [ ] Run `corepack pnpm --filter @rundown-org/core exec stryker run --mutate src/runbook/storage/runbook-store.ts,src/runbook/storage/mutation-result.ts --testFiles __tests__/runbook/storage/runbook-store.test.ts,__tests__/runbook/storage/runbook-store.properties.test.ts`. Expected: non-zero instrumentation; no survivor may remove transaction rollback, generation, or claim/state compare-and-swap guards.
- [ ] Run `corepack pnpm run verify`; commit `feat(core): add transactional SQLite runbook repository`; open and merge PR 2.

## Self-Review Checklist

- [ ] Only the five owned paths changed.
- [ ] Unit and property suites both pass.
- [ ] No survivor removes transaction rollback, generation, or compare-and-swap guards.
- [ ] Runtime callers still use their pre-existing persistence route — this PR does not cut anything over.
- [ ] `corepack pnpm run verify` exited 0 before push; all GitHub checks green before merge.
