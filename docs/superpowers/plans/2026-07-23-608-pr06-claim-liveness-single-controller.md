# 608 Controlled Rebuild — PR 6: Claim liveness and the single-controller rule

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Parent plan:** [2026-07-23-608-controlled-rebuild.md](2026-07-23-608-controlled-rebuild.md) — PR 6 of 14.

**Goal:** Enforce durable claim supersession, one active controlling claim per run, and an exhaustive typed claim refusal taxonomy.

**Depends on:** PR 5 (`refactor(core): stage run and session persistence on SQLite`) merged. Branch from the freshly fetched merged `origin/main`.

**Tech Stack:** TypeScript, XState 5, SQLite (`node:sqlite` and sql.js), Jest, Stryker, Biome, ESLint, pnpm 11 through Corepack, GitHub pull requests.

## Shared Constraints

- Fetch `origin/main` and record the then-current SHA before creating the branch. Never base work on `608-sqlite-claim-concurrency`, `608-integration`, or a closed PR branch — the source commits are evidence, not merge bases.
- Salvage tag `608-salvage-2026-07-23` (peeled to `5364e3965`) is immutable: never force-update or delete it, and never prune the salvage branches.
- Open only one dependent implementation PR at a time. This PR must merge before PR 7 branches from the newly fetched `origin/main`.
- **Preserve terminal claim confirm/conflict semantics:** a completed or stopped child remains resolvable as terminal evidence. Retry/token replacement, cancellation, parent deletion/terminalization, or unrelated parent cursor/substep advance supersedes mutation authority. `missing` is never a substitute for `terminal-child` or `superseded`.
- Before editing, run the exact `git cherry-pick --no-commit` sequence below. Resolve conflicts in favor of current-main package scripts, CI, error helpers, docs guards, and test conventions; preserve this task's named behavior and tests.
- After conflict resolution, `git diff --name-only --diff-filter=U` must print nothing, `git diff --check` must exit 0, and every changed path must be in the derived allowlist. An unexpected path is a stop-and-review event, not an implicit addition.
- Run the named tests, the exact scoped mutation command, and `corepack pnpm run verify`. Expected result is exit 0; Stryker must report at least one instrumented source and at least one mutant. Never use `--allowEmpty`.
- The only scoped mutation form is `corepack pnpm --filter @rundown-org/<pkg> exec stryker run --mutate <package-relative-comma-separated-paths> --testFiles <package-relative-comma-separated-paths>`. Pass each option once, use package-relative paths, and never insert a pnpm `--` separator. Use the comma form, never a brace glob: Stryker splits `--mutate` and `--testFiles` on commas *before* brace expansion, so `{a,b}.ts` degrades into patterns that match nothing and the run reports `Instrumented 0 source file(s) with 0 mutant(s)` — a gate that cannot fail. Confirm that line reports a non-zero count before trusting any score, and delete `reports/stryker-incremental.json` first so an `incremental: true` cache cannot replay a previous run's aggregate over it.
- `RESULT`, `HANDLER`, and `ACTION` remain distinct. Lifecycle dispatch is type-driven; no frontend branches on raw action strings and no action is silently mapped to another action.
- Persisted `RunbookState.schemaVersion` remains `1`. Never migrate, import, hydrate, shim, or dual-read incompatible persisted JSON state.
- Runtime services, callables, `cwd`, and store instances flow through actor invoke-input/constructor DI, never persisted XState context.
- Bearer secrets stay redacted in every output path.
- `pnpm run verify` is mandatory before every push. Any red local or GitHub check is a hard stop.

## Commit Ownership

Owned in full, replayed in this order: `6e9ff79f3`, `2d0656b24`, `eec5246d3`, `6cf18277c`, `68bdbf62c`.

## Task: Add claim liveness and the single-controller rule

**Files:**
- Derive the authoritative allowlist with `for c in 6e9ff79f3 2d0656b24 eec5246d3 6cf18277c 68bdbf62c; do git diff-tree --no-commit-id --name-only -r "$c"; done | sort -u > /tmp/rd608-pr6-allowed`.
- Required implementation paths include `packages/core/src/runbook/storage/{runbook-store,schema,mutation-result}.ts` and `packages/core/src/runbook/{session-service,command-target-resolver}.ts`; the allowlist also names every core/CLI test owned by the commits.

**Interfaces:**
- Produces durable claim supersession, one active controlling claim per run, and exhaustive claim refusal results.
- A terminal child claim remains queryable as terminal evidence. `missing` is not a substitute for `terminal-child` or `superseded`.

- [ ] Before replay, run `corepack pnpm --filter @rundown-org/core exec jest __tests__/runbook/session-service.test.ts __tests__/runbook/command-target-resolver.test.ts` and `corepack pnpm --filter @rundown-org/cli exec jest __tests__/commands/pass.test.ts __tests__/commands/fail.test.ts __tests__/commands/stop.test.ts __tests__/commands/prune.test.ts __tests__/commands/delegate.test.ts __tests__/commands/collect.test.ts`; expected: exit 0. Record test counts as the baseline.
- [ ] Cherry-pick `6e9ff79f3 2d0656b24 eec5246d3 6cf18277c 68bdbf62c` in that order. Run `git diff HEAD --name-only | sort -u > /tmp/rd608-pr6-actual && comm -3 /tmp/rd608-pr6-allowed /tmp/rd608-pr6-actual`; expected: no output. Correct the R2 historical behavior while resolving: invalidation retains claims for `completed`/`stopped` controlled children; retry/replacement, cancellation, parent end/deletion, or unrelated parent advance latches supersession. The claim-status update is the single owner of the generation bump.
- [ ] Add/retain raw-row assertions for `{ terminal child, original bearer } -> terminal evidence`, `{ replaced bearer } -> superseded`, and `{ parent deleted } -> refused`; never expect the first case to become missing.
- [ ] Run `corepack pnpm --filter @rundown-org/core exec jest __tests__/runbook/session-service.test.ts __tests__/runbook/command-target-resolver.test.ts __tests__/runbook/storage/runbook-store.test.ts` and `corepack pnpm --filter @rundown-org/cli exec jest __tests__/commands/pass.test.ts __tests__/commands/fail.test.ts __tests__/commands/stop.test.ts __tests__/commands/prune.test.ts __tests__/commands/delegate.test.ts __tests__/commands/collect.test.ts`. Expected: all pass with terminal evidence retained and bearer secrets redacted.
- [ ] Run `corepack pnpm --filter @rundown-org/core exec stryker run --mutate src/runbook/storage/runbook-store.ts,src/runbook/session-service.ts,src/runbook/command-target-resolver.ts --testFiles __tests__/runbook/storage/runbook-store.test.ts,__tests__/runbook/session-service.test.ts,__tests__/runbook/command-target-resolver.test.ts`. Expected: non-zero instrumentation; controller uniqueness, terminal retention, supersession, and redaction mutants are killed.
- [ ] Run `corepack pnpm run verify`; commit `fix(core): enforce delegated claim liveness and one controller`; open and merge PR 6.

## Self-Review Checklist

- [ ] Baseline test counts recorded before replay.
- [ ] `comm -3` between allowlist and actual changed paths printed nothing.
- [ ] Terminal evidence and superseded live authority are distinct tested outcomes; neither collapses to `missing`.
- [ ] Exactly one owner of the invalidation generation bump.
- [ ] Controller uniqueness, terminal retention, supersession, and redaction mutants are killed.
- [ ] `corepack pnpm run verify` exited 0 before push; all GitHub checks green before merge.
