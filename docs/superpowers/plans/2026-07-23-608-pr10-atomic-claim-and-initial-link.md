# 608 Controlled Rebuild — PR 10: Make initial claim and parent link atomic

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Parent plan:** [2026-07-23-608-controlled-rebuild.md](2026-07-23-608-controlled-rebuild.md) — PR 10 of 14.

**Goal:** `SessionService.claimAndInitialLink` — claim insertion and initial parent link either both commit or both roll back, with the CLI performing no shadow parent write.

**Depends on:** PR 9 (`fix(core): type session ownership refusals`) merged; consumes `SessionMutationResult<T>` from it. Branch from the freshly fetched merged `origin/main`.

**Tech Stack:** TypeScript, XState 5, SQLite (`node:sqlite` and sql.js), Jest, fast-check, Stryker, Biome, ESLint, pnpm 11 through Corepack, GitHub pull requests.

## Shared Constraints

- Fetch `origin/main` and record the then-current SHA before creating the branch. Never base work on `608-sqlite-claim-concurrency`, `608-integration`, or a closed PR branch — the source commits are evidence, not merge bases.
- Salvage tag `608-salvage-2026-07-23` (peeled to `5364e3965`) is immutable: never force-update or delete it, and never prune the salvage branches.
- Open only one dependent implementation PR at a time. This PR must merge before PR 11 branches from the newly fetched `origin/main`.
- **Preserve terminal claim confirm/conflict semantics:** a completed or stopped child remains resolvable as terminal evidence. Retry/token replacement, cancellation, parent deletion/terminalization, or unrelated parent cursor/substep advance supersedes mutation authority. Exactly one invalidation generation bump.
- Before editing, run the exact `git cherry-pick --no-commit` sequence below. Resolve conflicts in favor of current-main package scripts, CI, error helpers, docs guards, and test conventions; preserve this task's named behavior and tests. Resolve only within the listed files.
- After conflict resolution, `git diff --name-only --diff-filter=U` must print nothing, `git diff --check` must exit 0, and every changed path must be listed in the ownership block below. An unexpected path is a stop-and-review event, not an implicit addition.
- Run the named tests, the exact scoped mutation command, and `corepack pnpm run verify`. Expected result is exit 0; Stryker must report at least one instrumented source and at least one mutant. Never use `--allowEmpty`.
- The only scoped mutation form is `corepack pnpm --filter @rundown-org/<pkg> exec stryker run --mutate <package-relative-comma-separated-paths> --testFiles <package-relative-comma-separated-paths>`. Pass each option once, use package-relative paths, and never insert a pnpm `--` separator. Use the comma form, never a brace glob: Stryker splits `--mutate` and `--testFiles` on commas *before* brace expansion, so `{a,b}.ts` degrades into patterns that match nothing and the run reports `Instrumented 0 source file(s) with 0 mutant(s)` — a gate that cannot fail. Confirm that line reports a non-zero count before trusting any score, and delete `reports/stryker-incremental.json` first so an `incremental: true` cache cannot replay a previous run's aggregate over it.
- `RESULT`, `HANDLER`, and `ACTION` remain distinct. Lifecycle dispatch is type-driven; no frontend branches on raw action strings and no action is silently mapped to another action.
- Persisted `RunbookState.schemaVersion` remains `1`. Never migrate, import, hydrate, shim, or dual-read incompatible persisted JSON state.
- Runtime services, callables, `cwd`, and store instances flow through actor invoke-input/constructor DI, never persisted XState context.
- `pnpm run verify` is mandatory before every push. Any red local or GitHub check is a hard stop.

## Commit Ownership

Owned in full, replayed in this order: `0789b22d9`, `1cd2b38c0`, `56a23d4be`, `0066a614d`, `88ec8a832`, `0bf8674ab`.

## Task: Make initial claim and parent link atomic

**Files:**
- Core: `packages/core/src/runbook/{claim-id,session-service}.ts`, `packages/core/src/runbook/storage/{mutation-result,runbook-store,schema}.ts`
- CLI: `packages/cli/src/helpers/runbook-pipeline.ts`
- Tests: `packages/core/__tests__/runbook/{completion-service,session-service}.test.ts`, `packages/core/__tests__/runbook/storage/{delegated-claim-invalidation.integration,delegated-parent-authority,driver-contract,guarded-parent-advance,runbook-store,runbook-store.properties}.test.ts`, `packages/cli/__tests__/helpers/claim-and-launch.test.ts`, `runbooks/delegation/delegate-claim-superseded.runbook.md`

**Interfaces:**
- Consumes `SessionMutationResult<T>` from PR 9.
- Produces `SessionService.claimAndInitialLink(input): Promise<SessionMutationResult<ClaimAndInitialLinkResult>>`; claim insertion and initial parent link either both commit or both roll back.

- [ ] Cherry-pick in order: `0789b22d9 1cd2b38c0 56a23d4be 0066a614d 88ec8a832 0bf8674ab`. Resolve only within the listed files. Preserve terminal evidence, parent-deletion refusal, idempotence, and exactly one invalidation generation bump.
- [ ] Run `corepack pnpm --filter @rundown-org/core exec jest __tests__/runbook/storage/delegated-claim-invalidation.integration.test.ts __tests__/runbook/storage/delegated-parent-authority.test.ts __tests__/runbook/storage/guarded-parent-advance.test.ts __tests__/runbook/storage/runbook-store.test.ts __tests__/runbook/session-service.test.ts`. Expected: rollback, idempotence, terminal evidence, parent deletion, and generation invariants pass.
- [ ] Run `corepack pnpm --filter @rundown-org/cli exec jest __tests__/helpers/claim-and-launch.test.ts __tests__/helpers/runbook-pipeline.test.ts`. Expected: the CLI calls `claimAndInitialLink` once and performs no shadow parent write.
- [ ] Run `corepack pnpm --filter @rundown-org/core exec stryker run --mutate 'src/runbook/storage/runbook-store.ts,src/runbook/session-service.ts' --testFiles __tests__/runbook/storage/runbook-store.test.ts,__tests__/runbook/storage/delegated-parent-authority.test.ts,__tests__/runbook/session-service.test.ts`. Expected: non-zero instrumentation; atomicity, terminal retention, liveness, and generation guard mutants are killed.
- [ ] Run `corepack pnpm run verify`; commit `fix(core): make delegated claim and initial link atomic`; open and merge PR 10.

## Mandatory Review Checkpoint (after this PR)

Verify terminal evidence versus superseded authority, single-controller enforcement, typed session refusals, transaction-local parent guarding, and atomic initial claim/link.

## Self-Review Checklist

- [ ] Only the listed files changed.
- [ ] Claim insertion and initial parent link commit or roll back together.
- [ ] The CLI calls `claimAndInitialLink` once and performs no shadow parent write.
- [ ] Terminal evidence, parent-deletion refusal, idempotence, and the single generation bump all hold.
- [ ] Atomicity, terminal retention, liveness, and generation guard mutants are killed.
- [ ] `corepack pnpm run verify` exited 0 before push; all GitHub checks green before merge.
