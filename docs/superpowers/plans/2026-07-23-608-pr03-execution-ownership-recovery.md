# 608 Controlled Rebuild — PR 3: Execution ownership and machine recovery

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Parent plan:** [2026-07-23-608-controlled-rebuild.md](2026-07-23-608-controlled-rebuild.md) — PR 3 of 14.

**Goal:** Add PID/start-identity-aware execution leases and machine-owned recovery (`ExecutionRecoveryService.recover()`), driving `EXECUTION_OUTCOME_UNKNOWN` into XState with snapshots tagged `RECOVERY_TAG`.

**Depends on:** PR 2 (`feat(core): add transactional SQLite runbook repository`) merged. Branch from the freshly fetched merged `origin/main`.

**Tech Stack:** TypeScript, XState 5, SQLite (`node:sqlite` and sql.js), Jest, fast-check, Stryker, Biome, ESLint, pnpm 11 through Corepack, GitHub pull requests.

## Shared Constraints

- Fetch `origin/main` and record the then-current SHA before creating the branch. Never base work on `608-sqlite-claim-concurrency`, `608-integration`, or a closed PR branch — the source commits are evidence, not merge bases.
- Salvage tag `608-salvage-2026-07-23` (peeled to `5364e3965`) is immutable: never force-update or delete it, and never prune the salvage branches.
- Open only one dependent implementation PR at a time. This PR must merge before PR 4 branches from the newly fetched `origin/main`.
- Before editing, run the exact `git cherry-pick --no-commit` sequence below. Resolve conflicts in favor of current-main package scripts, CI, error helpers, docs guards, and test conventions; preserve this task's named behavior and tests.
- After conflict resolution, `git diff --name-only --diff-filter=U` must print nothing, `git diff --check` must exit 0, and every changed path must be listed in the ownership block below. An unexpected path is a stop-and-review event, not an implicit addition.
- All lifecycle and recovery behavior stays owned by core/XState. No CLI, MCP, or plugin path re-implements it.
- Run the named tests, the exact scoped mutation command, and `corepack pnpm run verify`. Expected result is exit 0; Stryker must report at least one instrumented source and at least one mutant. Never use `--allowEmpty`.
- The only scoped mutation form is `corepack pnpm --filter @rundown-org/<pkg> exec stryker run --mutate <package-relative-comma-separated-paths> --testFiles <package-relative-comma-separated-paths>`. Pass each option once, use package-relative paths, and never insert a pnpm `--` separator. Use the comma form, never a brace glob: Stryker splits `--mutate` and `--testFiles` on commas *before* brace expansion, so `{a,b}.ts` degrades into patterns that match nothing and the run reports `Instrumented 0 source file(s) with 0 mutant(s)` — a gate that cannot fail. Confirm that line reports a non-zero count before trusting any score, and delete `reports/stryker-incremental.json` first so an `incremental: true` cache cannot replay a previous run's aggregate over it.
- `RESULT`, `HANDLER`, and `ACTION` remain distinct. Lifecycle dispatch is type-driven; no frontend branches on raw action strings and no action is silently mapped to another action.
- Persisted `RunbookState.schemaVersion` remains `1`. SQLite storage schema versions are independent. Never migrate, import, hydrate, shim, or dual-read incompatible persisted JSON state.
- Runtime services, callables, `cwd`, and store instances flow through actor invoke-input/constructor DI, never persisted XState context.
- `pnpm run verify` is mandatory before every push. Any red local or GitHub check is a hard stop.

## Commit Ownership

Owned in full, replayed in this order: `50de92c2d`, `94f758aa0`, `739df3320`.

## Task: Add execution ownership and machine recovery

**Files:**
- Source: `packages/core/src/runbook/{actor-service,compiler,execution-recovery-service,types}.ts`, `packages/core/src/runbook/storage/{execution-lease,runbook-store,sqljs-driver}.ts`
- Test: `packages/core/__tests__/runbook/{compiler-machine-structural-snapshot,execution-recovery-service,graph-invariants.properties}.test.ts`, `packages/core/__tests__/runbook/storage/{driver-contract,execution-lease,execution-lease.process,execution-lease.properties,runbook-store}.test.ts`, and `packages/core/__tests__/runbook/storage/fixtures/lease-owner-child.mjs`

**Interfaces:**
- Produces: PID/start-identity-aware execution leases and `ExecutionRecoveryService.recover()` that drives `EXECUTION_OUTCOME_UNKNOWN` into XState and leaves snapshots tagged with `RECOVERY_TAG`.
- Recovery never retries an ambiguous external effect automatically.

- [ ] Cherry-pick without committing, in order: `50de92c2d 94f758aa0 739df3320`. Resolve current XState/compiler drift while retaining machine-owned recovery; verify changed paths are within the ownership list.
- [ ] Run `corepack pnpm --filter @rundown-org/core exec jest __tests__/runbook/storage/execution-lease.test.ts __tests__/runbook/storage/execution-lease.process.test.ts __tests__/runbook/execution-recovery-service.test.ts __tests__/runbook/compiler-machine-structural-snapshot.test.ts`. Expected: all pass, including exact PID/start-identity mismatch and unknown-outcome recovery.
- [ ] Run `corepack pnpm --filter @rundown-org/core exec stryker run --mutate 'src/runbook/storage/execution-lease.ts,src/runbook/execution-recovery-service.ts' --testFiles __tests__/runbook/storage/execution-lease.test.ts,__tests__/runbook/storage/execution-lease.properties.test.ts,__tests__/runbook/execution-recovery-service.test.ts`. Expected: non-zero instrumentation; lease-token/epoch and no-repeat-effect mutants are killed.
- [ ] Run `corepack pnpm run verify`; commit `feat(core): add fenced execution ownership and recovery`; open and merge PR 3.

## Self-Review Checklist

- [ ] All changed paths are inside the ownership list.
- [ ] Recovery is driven through the state machine, not a service-side shortcut.
- [ ] Recovery never automatically retries an ambiguous external effect.
- [ ] Lease-token/epoch and no-repeat-effect mutants are killed.
- [ ] `corepack pnpm run verify` exited 0 before push; all GitHub checks green before merge.
