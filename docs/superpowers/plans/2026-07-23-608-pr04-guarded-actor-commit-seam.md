# 608 Controlled Rebuild — PR 4: Guarded actor commit seam

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Parent plan:** [2026-07-23-608-controlled-rebuild.md](2026-07-23-608-controlled-rebuild.md) — PR 4 of 14.

**Goal:** Fence actor computation from persistence: `EffectfulMutationExecutor.run` plus actor-specific guarded committers, with persistence flowing only through `RunbookStore.commitOwnedState`.

**Depends on:** PR 3 (`feat(core): add fenced execution ownership and recovery`) merged. Branch from the freshly fetched merged `origin/main`.

**Tech Stack:** TypeScript, XState 5, SQLite (`node:sqlite` and sql.js), Jest, Stryker, Biome, ESLint, pnpm 11 through Corepack, GitHub pull requests.

## Shared Constraints

- Fetch `origin/main` and record the then-current SHA before creating the branch. Never base work on `608-sqlite-claim-concurrency`, `608-integration`, or a closed PR branch — the source commits are evidence, not merge bases.
- Salvage tag `608-salvage-2026-07-23` (peeled to `5364e3965`) is immutable: never force-update or delete it, and never prune the salvage branches.
- Open only one dependent implementation PR at a time. This PR must merge before PR 5 branches from the newly fetched `origin/main`.
- Before editing, run the exact `git cherry-pick --no-commit` sequence below. Resolve conflicts in favor of current-main package scripts, CI, error helpers, docs guards, and test conventions; preserve this task's named behavior and tests.
- After conflict resolution, `git diff --name-only --diff-filter=U` must print nothing, `git diff --check` must exit 0, and every changed path must be listed in the ownership block below. An unexpected path is a stop-and-review event, not an implicit addition.
- This PR adds no CLI lifecycle dispatch. No production lifecycle caller may claim the seam is live yet; that is PR 11.
- Run the named tests, the exact scoped mutation command, and `corepack pnpm run verify`. Expected result is exit 0; Stryker must report at least one instrumented source and at least one mutant. Never use `--allowEmpty`.
- The only scoped mutation form is `corepack pnpm --filter @rundown-org/<pkg> exec stryker run --mutate <package-relative-comma-separated-paths> --testFiles <package-relative-comma-separated-paths>`. Pass each option once, use package-relative paths, and never insert a pnpm `--` separator. Use the comma form, never a brace glob: Stryker splits `--mutate` and `--testFiles` on commas *before* brace expansion, so `{a,b}.ts` degrades into patterns that match nothing and the run reports `Instrumented 0 source file(s) with 0 mutant(s)` — a gate that cannot fail. Confirm that line reports a non-zero count before trusting any score, and delete `reports/stryker-incremental.json` first so an `incremental: true` cache cannot replay a previous run's aggregate over it.
- `RESULT`, `HANDLER`, and `ACTION` remain distinct. Lifecycle dispatch is type-driven; no frontend branches on raw action strings and no action is silently mapped to another action.
- Persisted `RunbookState.schemaVersion` remains `1`. SQLite storage schema versions are independent. Never migrate, import, hydrate, shim, or dual-read incompatible persisted JSON state.
- Runtime services, callables, `cwd`, and store instances flow through actor invoke-input/constructor DI, never persisted XState context.
- `pnpm run verify` is mandatory before every push. Any red local or GitHub check is a hard stop.

## Commit Ownership

Owned in full, replayed in this order: `64f840ded`, `a39701d6e`, `785a3eabb`, `e203ec905`.

## Task: Add the guarded actor commit seam

**Files:**
- Source: `packages/core/src/paths.ts`, `packages/core/src/runbook/{actor-service,effectful-mutation-executor,state,types}.ts`, `packages/core/src/runbook/storage/{execution-lease,runbook-store,schema,store-registry}.ts`
- Test: `packages/core/__tests__/runbook/actor-service-execution-fence.test.ts`, `packages/core/__tests__/runbook/storage/{execution-lease,runbook-store,store-registry}.test.ts`

**Interfaces:**
- Produces `EffectfulMutationExecutor.run<TPrepared,TResult>({ captured, compute, commit, recoveryReason?, wait? })` and actor-specific guarded committers. Persist happens only through `RunbookStore.commitOwnedState(captured, execution, next)`.

- [ ] Cherry-pick without committing, in order: `64f840ded a39701d6e 785a3eabb e203ec905`. Do not add any CLI lifecycle dispatch in this PR.
- [ ] Run `corepack pnpm --filter @rundown-org/core exec jest __tests__/runbook/actor-service-execution-fence.test.ts __tests__/runbook/storage/execution-lease.test.ts __tests__/runbook/storage/runbook-store.test.ts __tests__/runbook/storage/store-registry.test.ts`. Expected: all pass, including commit refusal and registry reuse/close behavior.
- [ ] Run `corepack pnpm --filter @rundown-org/core exec stryker run --mutate src/runbook/effectful-mutation-executor.ts,src/runbook/actor-service.ts,src/runbook/storage/store-registry.ts --testFiles '__tests__/runbook/actor-service-execution-fence.test.ts,__tests__/runbook/storage/store-registry.test.ts'`. Expected: non-zero instrumentation and no survivor that skips effect-boundary marking, guarded commit, or recovery routing.
- [ ] Run `corepack pnpm run verify`; commit `refactor(core): fence actor computation and persistence`; open and merge PR 4.

## Mandatory Review Checkpoint (after this PR)

Verify machine-owned recovery, exact execution fencing, and that no production lifecycle caller yet claims the seam is live.

## Self-Review Checklist

- [ ] All changed paths are inside the ownership list; no CLI lifecycle dispatch added.
- [ ] Persistence happens only through `RunbookStore.commitOwnedState`.
- [ ] No survivor skips effect-boundary marking, guarded commit, or recovery routing.
- [ ] `corepack pnpm run verify` exited 0 before push; all GitHub checks green before merge.
