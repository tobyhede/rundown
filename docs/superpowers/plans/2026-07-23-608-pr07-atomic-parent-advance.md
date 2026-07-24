# 608 Controlled Rebuild — PR 7: Transaction-local guarded parent advance

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Parent plan:** [2026-07-23-608-controlled-rebuild.md](2026-07-23-608-controlled-rebuild.md) — PR 7 of 14.

**Goal:** Make the open-delegated-child guard transaction-local: the open-child query and the decisive parent update occur in the same `RunbookStore` transaction.

**Depends on:** PR 6 (`fix(core): enforce delegated claim liveness and one controller`) merged. Branch from the freshly fetched merged `origin/main`.

**Tech Stack:** TypeScript, XState 5, SQLite (`node:sqlite` and sql.js), Jest, Stryker, Biome, ESLint, pnpm 11 through Corepack, GitHub pull requests.

## Shared Constraints

- Fetch `origin/main` and record the then-current SHA before creating the branch. Never base work on `608-sqlite-claim-concurrency`, `608-integration`, or a closed PR branch — the source commits are evidence, not merge bases.
- Salvage tag `608-salvage-2026-07-23` (peeled to `5364e3965`) is immutable: never force-update or delete it, and never prune the salvage branches.
- Open only one dependent implementation PR at a time. This PR must merge before PR 8 branches from the newly fetched `origin/main`.
- **No CLI or pre-transaction check may act as authority.** Compute may occur outside SQL, but the open-child recheck must immediately precede the decisive update in the same transaction.
- Preserve terminal claim confirm/conflict semantics: a completed or stopped child remains resolvable as terminal evidence. Retry/token replacement, cancellation, parent deletion/terminalization, or unrelated parent cursor/substep advance supersedes mutation authority.
- Before editing, run the exact `git cherry-pick --no-commit` sequence below. Resolve conflicts in favor of current-main package scripts, CI, error helpers, docs guards, and test conventions; preserve this task's named behavior and tests.
- After conflict resolution, `git diff --name-only --diff-filter=U` must print nothing, `git diff --check` must exit 0, and every changed path must be in the derived allowlist. An unexpected path is a stop-and-review event, not an implicit addition.
- Run the named tests, the exact scoped mutation command, and `corepack pnpm run verify`. Expected result is exit 0; Stryker must report at least one instrumented source and at least one mutant. Never use `--allowEmpty`.
- The only scoped mutation form is `corepack pnpm --filter @rundown-org/<pkg> exec stryker run --mutate <package-relative-comma-separated-paths> --testFiles <package-relative-comma-separated-paths>`. Pass each option once, use package-relative paths, and never insert a pnpm `--` separator. Use the comma form, never a brace glob: Stryker splits `--mutate` and `--testFiles` on commas *before* brace expansion, so `{a,b}.ts` degrades into patterns that match nothing and the run reports `Instrumented 0 source file(s) with 0 mutant(s)` — a gate that cannot fail. Confirm that line reports a non-zero count before trusting any score, and delete `reports/stryker-incremental.json` first so an `incremental: true` cache cannot replay a previous run's aggregate over it.
- `RESULT`, `HANDLER`, and `ACTION` remain distinct. Lifecycle dispatch is type-driven; no frontend branches on raw action strings and no action is silently mapped to another action.
- Persisted `RunbookState.schemaVersion` remains `1`. Never migrate, import, hydrate, shim, or dual-read incompatible persisted JSON state.
- Runtime services, callables, `cwd`, and store instances flow through actor invoke-input/constructor DI, never persisted XState context.
- `pnpm run verify` is mandatory before every push. Any red local or GitHub check is a hard stop.

## Commit Ownership

Owned in full, replayed in this order: `0f896b8b6`, `03d9144a1`, `63f469945`, `e21dab179`, `ee650ce7c`, `70a7082ec`.

## Task: Make parent advance transaction-local and atomic

**Files:**
- Derive the authoritative allowlist with `for c in 0f896b8b6 03d9144a1 63f469945 e21dab179 ee650ce7c 70a7082ec; do git diff-tree --no-commit-id --name-only -r "$c"; done | sort -u > /tmp/rd608-pr7-allowed`.
- Required implementation paths include `packages/core/src/runbook/{state,actor-service,completion-service}.ts` and `packages/core/src/runbook/storage/runbook-store.ts`; the allowlist also names the associated tests and TSDoc.

**Interfaces:**
- Produces a transaction-local open-delegated-child guard on the decisive parent update. The open-child query and update occur in the same `RunbookStore` transaction.

- [ ] Cherry-pick `0f896b8b6 03d9144a1 63f469945 e21dab179 ee650ce7c 70a7082ec` in that order. Run `git diff HEAD --name-only | sort -u > /tmp/rd608-pr7-actual && comm -3 /tmp/rd608-pr7-allowed /tmp/rd608-pr7-actual`; expected: no output. Reject any resolution that restores a CLI or pre-transaction check as authority; compute may occur outside SQL, but the open-child recheck must immediately precede the decisive update in the same transaction.
- [ ] Run `corepack pnpm --filter @rundown-org/core exec jest __tests__/runbook/storage/guarded-parent-advance.test.ts __tests__/runbook/storage/runbook-store.test.ts __tests__/runbook/state.test.ts __tests__/runbook/completion-service.test.ts`. Expected: both claim-before-advance and advance-before-claim races pass across processes.
- [ ] Run `corepack pnpm --filter @rundown-org/core exec stryker run --mutate 'src/runbook/storage/runbook-store.ts,src/runbook/state.ts' --testFiles __tests__/runbook/storage/guarded-parent-advance.test.ts,__tests__/runbook/storage/runbook-store.test.ts,__tests__/runbook/state.test.ts`. Expected: non-zero instrumentation; removing the in-transaction query or its decisive-write predicate is killed.
- [ ] Run `corepack pnpm run verify`; commit `fix(core): make guarded parent advance atomic`; open and merge PR 7.

## Self-Review Checklist

- [ ] `comm -3` between allowlist and actual changed paths printed nothing.
- [ ] The open-child recheck sits inside the same transaction as the decisive update, immediately preceding it.
- [ ] Both race orderings (claim-before-advance, advance-before-claim) are proven across processes.
- [ ] Removing the in-transaction query or its write predicate is killed by mutation.
- [ ] `corepack pnpm run verify` exited 0 before push; all GitHub checks green before merge.
