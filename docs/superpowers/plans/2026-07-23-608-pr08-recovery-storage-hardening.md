# 608 Controlled Rebuild — PR 8: Harden recovery and storage lifecycle

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Parent plan:** [2026-07-23-608-controlled-rebuild.md](2026-07-23-608-controlled-rebuild.md) — PR 8 of 14.

**Goal:** Deterministic recovery hydration, strict row validation, canonical delegation linkage parsing, serialized store close/reopen, and proof that recovery never repeats a persisted effect.

**Depends on:** PR 7 (`fix(core): make guarded parent advance atomic`) merged. Branch from the freshly fetched merged `origin/main`.

**Tech Stack:** TypeScript, XState 5, SQLite (`node:sqlite` and sql.js), Jest, Stryker, Biome, ESLint, pnpm 11 through Corepack, Playwright, GitHub pull requests.

## Shared Constraints

- Fetch `origin/main` and record the then-current SHA before creating the branch. Never base work on `608-sqlite-claim-concurrency`, `608-integration`, or a closed PR branch — the source commits are evidence, not merge bases.
- Salvage tag `608-salvage-2026-07-23` (peeled to `5364e3965`) is immutable: never force-update or delete it, and never prune the salvage branches.
- Open only one dependent implementation PR at a time. This PR must merge before PR 9 branches from the newly fetched `origin/main`.
- Prospective plan commits (`63077ea8f`, `957a4917f`, `702c752f4`, `5364e3965`) remain excluded; retain only the source TSDoc and descriptive docs changed by the owned commits.
- Before editing, run the exact `git cherry-pick --no-commit` sequence below. Resolve conflicts in favor of current-main package scripts, CI, error helpers, docs guards, and test conventions; preserve this task's named behavior and tests.
- After conflict resolution, `git diff --name-only --diff-filter=U` must print nothing, `git diff --check` must exit 0, and every changed path must be in the derived allowlist. An unexpected path is a stop-and-review event, not an implicit addition.
- Run the named tests, the exact scoped mutation command, and `corepack pnpm run verify`. Expected result is exit 0; Stryker must report at least one instrumented source and at least one mutant. Never use `--allowEmpty`.
- The only scoped mutation form is `corepack pnpm --filter @rundown-org/<pkg> exec stryker run --mutate <package-relative-comma-separated-paths> --testFiles <package-relative-comma-separated-paths>`. Pass each option once, use package-relative paths, and never insert a pnpm `--` separator. Use the comma form, never a brace glob: Stryker splits `--mutate` and `--testFiles` on commas *before* brace expansion, so `{a,b}.ts` degrades into patterns that match nothing and the run reports `Instrumented 0 source file(s) with 0 mutant(s)` — a gate that cannot fail. Confirm that line reports a non-zero count before trusting any score, and delete `reports/stryker-incremental.json` first so an `incremental: true` cache cannot replay a previous run's aggregate over it.
- Recovery never automatically retries an ambiguous external effect.
- `RESULT`, `HANDLER`, and `ACTION` remain distinct. Lifecycle dispatch is type-driven; no frontend branches on raw action strings and no action is silently mapped to another action.
- Persisted `RunbookState.schemaVersion` remains `1`. Never migrate, import, hydrate, shim, or dual-read incompatible persisted JSON state.
- Runtime services, callables, `cwd`, and store instances flow through actor invoke-input/constructor DI, never persisted XState context.
- `pnpm run verify` is mandatory before every push. Any red local or GitHub check is a hard stop.

## Commit Ownership

Owned in full, replayed in this order: `6f1e323fe`, `c1298a91d`, `9edfa08ef`, `ebc396411`, `2b86d2188`, `fdfb1c6aa`, `3c62faca9`, `401522b07`, `c3e0c156d`, `177e049ed`, `4b67d806b`, `5cd9566a4`.

## Task: Harden recovery and storage lifecycle

**Files:**
- Derive the authoritative allowlist with `for c in 6f1e323fe c1298a91d 9edfa08ef ebc396411 2b86d2188 fdfb1c6aa 3c62faca9 401522b07 c3e0c156d 177e049ed 4b67d806b 5cd9566a4; do git diff-tree --no-commit-id --name-only -r "$c"; done | sort -u > /tmp/rd608-pr8-allowed`.
- The allowlist covers storage adapters, `runbook-store.ts`, `store-registry.ts`, `execution-recovery-service.ts`, event/output schema and rendering consumers, site probe sources, docs changed by those commits, and their named tests. No path outside `/tmp/rd608-pr8-allowed` belongs in PR 8.

**Interfaces:**
- Produces deterministic recovery hydration, strict row validation, canonical delegation linkage parsing, serialized store close/reopen, and proof that recovery never repeats a persisted effect.

- [ ] Cherry-pick in exact order: `6f1e323fe c1298a91d 9edfa08ef ebc396411 2b86d2188 fdfb1c6aa 3c62faca9 401522b07 c3e0c156d 177e049ed 4b67d806b 5cd9566a4`. Run `git diff HEAD --name-only | sort -u > /tmp/rd608-pr8-actual && comm -3 /tmp/rd608-pr8-allowed /tmp/rd608-pr8-actual`; expected: no output. Retain source TSDoc and descriptive docs changed by these commits; the prospective plan commits remain excluded.
- [ ] Run `corepack pnpm --filter @rundown-org/core exec jest __tests__/runbook/execution-recovery-service.test.ts __tests__/runbook/storage/driver-contract.test.ts __tests__/runbook/storage/runbook-store.test.ts __tests__/runbook/storage/store-registry.test.ts`. Expected: all pass, including close-all/reopen serialization and no-repeat recovery.
- [ ] Run `corepack pnpm --filter @rundown-org/core exec stryker run --mutate src/runbook/execution-recovery-service.ts,src/runbook/storage/runbook-store.ts,src/runbook/storage/store-registry.ts,src/runbook/storage/sqljs-driver.ts --testFiles __tests__/runbook/execution-recovery-service.test.ts,__tests__/runbook/storage/runbook-store.test.ts,__tests__/runbook/storage/store-registry.test.ts,__tests__/runbook/storage/driver-contract.test.ts`. Expected: non-zero instrumentation and no accepted survivor in recovery classification, row guards, close serialization, or durable sql.js replacement.
- [ ] Run `corepack pnpm run verify`; commit `fix(core): harden SQLite recovery and storage lifecycle`; open and merge PR 8.

## Mandatory Review Checkpoint (after this PR)

Verify adapter parity, deterministic contention, row validation, and recovery no-repeat semantics.

## Self-Review Checklist

- [ ] `comm -3` between allowlist and actual changed paths printed nothing.
- [ ] Adapter parity holds for native SQLite and sql.js.
- [ ] Recovery is proven never to repeat a persisted effect.
- [ ] No accepted survivor in recovery classification, row guards, close serialization, or durable sql.js replacement.
- [ ] `corepack pnpm run verify` exited 0 before push; all GitHub checks green before merge.
