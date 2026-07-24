# 608 Controlled Rebuild — PR 9: Type every session ownership refusal

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Parent plan:** [2026-07-23-608-controlled-rebuild.md](2026-07-23-608-controlled-rebuild.md) — PR 9 of 14.

**Goal:** Introduce `SessionMutationResult<T>` and exhaustive command-facing `execution_in_progress` / `recovery_required` mappings, so no caller can confuse an ownership refusal with a domain `null` or status.

**Depends on:** PR 8 (`fix(core): harden SQLite recovery and storage lifecycle`) merged. Branch from the freshly fetched merged `origin/main`. This PR stands alone after hardening and before the atomic initial claim/link work in PR 10.

**Tech Stack:** TypeScript, XState 5, SQLite (`node:sqlite` and sql.js), Jest, Stryker, Biome, ESLint, pnpm 11 through Corepack, GitHub pull requests.

## Shared Constraints

- Fetch `origin/main` and record the then-current SHA before creating the branch. Never base work on `608-sqlite-claim-concurrency`, `608-integration`, or a closed PR branch — the source commits are evidence, not merge bases.
- Salvage tag `608-salvage-2026-07-23` (peeled to `5364e3965`) is immutable: never force-update or delete it, and never prune the salvage branches.
- Open only one dependent implementation PR at a time. This PR must merge before PR 10 branches from the newly fetched `origin/main`.
- Before editing, run the exact `git cherry-pick --no-commit` command below. Resolve conflicts in favor of current-main package scripts, CI, error helpers, docs guards, and test conventions; preserve this task's named behavior and tests.
- After conflict resolution, `git diff --name-only --diff-filter=U` must print nothing, `git diff --check` must exit 0, and every changed path must be in the derived 42-path allowlist. An unexpected path is a stop-and-review event, not an implicit addition.
- Run the named tests, both exact scoped mutation commands, and `corepack pnpm run verify`. Expected result is exit 0; Stryker must report at least one instrumented source and at least one mutant per campaign. Never use `--allowEmpty`.
- The only scoped mutation form is `corepack pnpm --filter @rundown-org/<pkg> exec stryker run --mutate <package-relative-comma-separated-paths> --testFiles <package-relative-comma-separated-paths>`. Pass each option once, use package-relative paths, and never insert a pnpm `--` separator. Use the comma form, never a brace glob: Stryker splits `--mutate` and `--testFiles` on commas *before* brace expansion, so `{a,b}.ts` degrades into patterns that match nothing and the run reports `Instrumented 0 source file(s) with 0 mutant(s)` — a gate that cannot fail. Confirm that line reports a non-zero count before trusting any score, and delete `reports/stryker-incremental.json` first so an `incremental: true` cache cannot replay a previous run's aggregate over it.
- `RESULT`, `HANDLER`, and `ACTION` remain distinct. Lifecycle dispatch is type-driven; no frontend branches on raw action strings and no action is silently mapped to another action.
- Persisted `RunbookState.schemaVersion` remains `1`. Never migrate, import, hydrate, shim, or dual-read incompatible persisted JSON state.
- Runtime services, callables, `cwd`, and store instances flow through actor invoke-input/constructor DI, never persisted XState context.
- CLI tests default to JSON output; bearer secrets stay redacted.
- `pnpm run verify` is mandatory before every push. Any red local or GitHub check is a hard stop.

## Commit Ownership

Owned in full: `a823892fe` (42 paths).

## Task: Type every session ownership refusal

**Files:**
- Derive the authoritative 42-path allowlist with `git diff-tree --no-commit-id --name-only -r a823892fe | sort -u > /tmp/rd608-pr9-allowed`; it includes `packages/core/src/runbook/storage/runbook-store.ts`, `session-service.ts`, `state.ts`, lifecycle/collection/inline services, `packages/core/src/events/types.ts`, `packages/core/src/runbook/index.ts`, CLI session callers, new `packages/cli/src/helpers/session-mutation-result.ts`, and the tests changed by the commit.

**Interfaces:**
- Produces:

  ```typescript
  type SessionMutationResult<T> =
    | { readonly status: 'committed'; readonly value: T }
    | { readonly status: 'execution-in-progress'; readonly runId: RunId; readonly message: string }
    | { readonly status: 'recovery-required'; readonly runId: RunId; readonly epoch: ExecutionEpoch; readonly message: string };
  ```

- Produces exhaustive command-facing `execution_in_progress` and `recovery_required` mappings. Callers cannot confuse an ownership refusal with a domain `null` or status.
- The internal kebab-case statuses are never emitted. Commands map them onto the existing CLI error envelope, and a refusal stays a structured result — it is not flattened to `null` or to a lifecycle status. Wire codes are `SCREAMING_SNAKE_CASE` because they register in `CLISymbolicErrorCodeValues`, every member of which already uses that form (`ACTOR_CONTEXT_REQUIRED`, `RUN_TARGET_MISMATCH`, …):

  | Internal status | Wire code | Carries the run id |
  | --- | --- | --- |
  | `execution-in-progress` | `EXECUTION_IN_PROGRESS` | in the message |
  | `recovery-required` | `RECOVERY_REQUIRED` | in the message |

  The envelope is the established flat shape from `docs/spec/cli-output.md` — `error` is a message string, not a nested object, and there is no top-level `runbookId` field on errors (compare the documented `RUN_TARGET_MISMATCH` output, which names its run inside the message).

  `execution_in_progress` response:

  ```json
  {
    "kind": "error",
    "error": "Run rd_0123456789abcdef0123456789abcdef is being executed by another process.",
    "code": "EXECUTION_IN_PROGRESS",
    "command": "pass"
  }
  ```

  `recovery_required` response:

  ```json
  {
    "kind": "error",
    "error": "Run rd_0123456789abcdef0123456789abcdef ended execution with an unknown outcome at epoch 7; run recovery before continuing.",
    "code": "RECOVERY_REQUIRED",
    "command": "pass"
  }
  ```

  The internal union's `runId` and `epoch` are rendered into the message here rather than promoted to envelope fields. PR 14 owns the schema work; if it adds structured fields for either, it must extend the documented error envelope in `docs/spec/cli-output.md` at the same time rather than emitting fields no schema describes.

- [ ] Cherry-pick `a823892fe` without committing. Run `git diff HEAD --name-only | sort -u > /tmp/rd608-pr9-actual && test "$(wc -l < /tmp/rd608-pr9-actual)" -eq 42 && comm -3 /tmp/rd608-pr9-allowed /tmp/rd608-pr9-actual`; expected: exit 0 and no output. Keep the change as its own PR after hardening and before initial claim/link.
- [ ] Resolve all 42 paths exhaustively. Run `rg -n "SessionMutationResult|execution-in-progress|recovery-required" packages/core/src packages/cli/src` and inspect every switch; each must narrow the discriminant and contain a `never` exhaustiveness check where it maps outcomes.
- [ ] Run `corepack pnpm --filter @rundown-org/core exec jest __tests__/runbook/session-service.test.ts __tests__/runbook/claim-seen.test.ts __tests__/runbook/lifecycle-command-service.test.ts __tests__/runbook/collection-service.test.ts __tests__/runbook/inline-parent-advance.test.ts`. Expected: all pass.
- [ ] Run `corepack pnpm --filter @rundown-org/cli exec jest __tests__/helpers/claim-and-launch.test.ts __tests__/helpers/runbook-pipeline.test.ts __tests__/helpers/transition-orchestrator.test.ts __tests__/services/execution-loop.test.ts __tests__/commands/prune.test.ts`. Expected: JSON ownership refusals and redaction pass.
- [ ] Run `corepack pnpm --filter @rundown-org/core exec stryker run --mutate src/runbook/session-service.ts,src/runbook/lifecycle-command-service.ts,src/runbook/collection-service.ts,src/runbook/storage/runbook-store.ts --testFiles __tests__/runbook/session-service.test.ts,__tests__/runbook/lifecycle-command-service.test.ts,__tests__/runbook/collection-service.test.ts,__tests__/runbook/storage/runbook-store.test.ts` and `corepack pnpm --filter @rundown-org/cli exec stryker run --mutate src/helpers/session-mutation-result.ts,src/helpers/runbook-pipeline.ts,src/helpers/transition-orchestrator.ts,src/services/execution.ts --testFiles __tests__/helpers/claim-and-launch.test.ts,__tests__/helpers/runbook-pipeline.test.ts,__tests__/helpers/transition-orchestrator.test.ts,__tests__/services/execution-loop.test.ts`. Expected: both campaigns instrument non-zero sources/mutants and kill discriminant-mapping mutants.
- [ ] Run `corepack pnpm run verify`; commit `fix(core): type session ownership refusals`; open and merge PR 9.

## Self-Review Checklist

- [ ] Exactly 42 changed paths, matching the derived allowlist.
- [ ] Every mapping switch narrows the discriminant and ends in a `never` exhaustiveness check.
- [ ] No caller treats an ownership refusal as a domain `null` or status.
- [ ] Both mutation campaigns instrument non-zero sources and kill discriminant-mapping mutants.
- [ ] `corepack pnpm run verify` exited 0 before push; all GitHub checks green before merge.
