# 608 Controlled Rebuild — PR 11: Route effectful lifecycle commands through execution fencing

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This task is TDD: RED, then implement, then GREEN, then mutation.

**Parent plan:** [2026-07-23-608-controlled-rebuild.md](2026-07-23-608-controlled-rebuild.md) — PR 11 of 14.

**Goal:** Make pass, fail, goto, complete, and stop run through core-owned execution fencing, returning `EffectfulLifecycleCommandResult<T>`; the CLI renders every discriminant and never executes a transition itself.

**Depends on:** PR 10 (`fix(core): make delegated claim and initial link atomic`) merged. Branch from the freshly fetched merged `origin/main`. This is fresh work derived from the carried-forward tasks — **no salvage commit is replayed.**

**Tech Stack:** TypeScript, XState 5, SQLite (`node:sqlite` and sql.js), Jest, Stryker, Biome, ESLint, pnpm 11 through Corepack, GitHub pull requests.

## Shared Constraints

- Fetch `origin/main` and record the then-current SHA before creating the branch. Never base work on `608-sqlite-claim-concurrency`, `608-integration`, or a closed PR branch.
- Salvage tag `608-salvage-2026-07-23` (peeled to `5364e3965`) is immutable: never force-update or delete it, and never prune the salvage branches.
- Open only one dependent implementation PR at a time. This PR must merge before PR 12 branches from the newly fetched `origin/main`.
- Every changed path must be listed in the Files block below. An unexpected path is a stop-and-review event, not an implicit addition. `git diff --check` must exit 0.
- All lifecycle behavior stays owned by core/XState; the CLI, MCP, and plugin only invoke typed core outcomes.
- Preserve terminal claim confirm/conflict semantics: a completed or stopped child remains resolvable as terminal evidence. Retry/token replacement, cancellation, parent deletion/terminalization, or unrelated parent cursor/substep advance supersedes mutation authority.
- Run the named tests, both exact scoped mutation commands, and `corepack pnpm run verify`. Expected result is exit 0; Stryker must report at least one instrumented source and at least one mutant per campaign. Never use `--allowEmpty`.
- The only scoped mutation form is `corepack pnpm --filter @rundown-org/<pkg> exec stryker run --mutate <package-relative-comma-separated-paths> --testFiles <package-relative-comma-separated-paths>`. Pass each option once, use package-relative paths, and never insert a pnpm `--` separator. Use the comma form, never a brace glob: Stryker splits `--mutate` and `--testFiles` on commas *before* brace expansion, so `{a,b}.ts` degrades into patterns that match nothing and the run reports `Instrumented 0 source file(s) with 0 mutant(s)` — a gate that cannot fail. Confirm that line reports a non-zero count before trusting any score, and delete `reports/stryker-incremental.json` first so an `incremental: true` cache cannot replay a previous run's aggregate over it.
- `RESULT`, `HANDLER`, and `ACTION` remain distinct. Lifecycle dispatch is type-driven; no frontend branches on raw action strings and no action is silently mapped to another action.
- Persisted `RunbookState.schemaVersion` remains `1`. Never migrate, import, hydrate, shim, or dual-read incompatible persisted JSON state.
- Runtime services, callables, `cwd`, and store instances flow through actor invoke-input/constructor DI, never persisted XState context.
- CLI tests cover default JSON and `--text` separately; bearer secrets stay redacted in both.
- `pnpm run verify` is mandatory before every push. Any red local or GitHub check is a hard stop.

## Task: Route effectful lifecycle commands through execution fencing

**Files:**
- Modify: `packages/core/src/runbook/{lifecycle-command-service,execution-lifecycle-service,execution-recovery-service,index}.ts`
- Modify: `packages/cli/src/helpers/{transitions,goto-workflow,terminal-command}.ts`, `packages/cli/src/services/execution.ts`
- Test: `packages/core/__tests__/runbook/{lifecycle-command-service,execution-recovery-service}.test.ts`
- Test: `packages/cli/__tests__/commands/{pass,fail,goto,complete,stop}.test.ts`
- Create: `packages/cli/__tests__/integration/lifecycle-execution-fencing.process.test.ts`
- Create: `packages/cli/__tests__/fixtures/lifecycle-execution-child.ts`
- Create: `packages/cli/__tests__/scenarios/execution-recovery.scenario.md`

**Interfaces:**
- Consumes `EffectfulMutationExecutor`, `CapturedAuthority`, `ExecutionRecoveryService`, and `SessionMutationResult<T>`.
- Produces this exported command-facing result in `lifecycle-command-service.ts`:

  ```typescript
  export type EffectfulLifecycleCommandResult<T> =
    | { readonly kind: 'committed'; readonly value: T }
    | { readonly kind: 'claim_superseded'; readonly runId: RunId; readonly message: string }
    | { readonly kind: 'concurrent_modification'; readonly runId: RunId; readonly message: string }
    | { readonly kind: 'execution_in_progress'; readonly runId: RunId; readonly message: string }
    | {
        readonly kind: 'recovery_required';
        readonly runId: RunId;
        readonly epoch: ExecutionEpoch;
        readonly message: string;
      }
    | { readonly kind: 'missing'; readonly runId: RunId; readonly message: string };
  ```

- Adds `RunbookLifecycleCommandService.runEffectful<TPrepared, TResult>(input: EffectfulMutationInput<TPrepared, TResult>): Promise<EffectfulLifecycleCommandResult<TResult>>`; its result is shape-compatible with `GuardedMutationResult<TResult>`. Pass, fail, goto, complete, and stop call this method after their existing typed policy/target resolution. CLI renders every discriminant and never executes a transition itself.

- [ ] **RED — pin the production seam and crash boundaries.** In `lifecycle-command-service.test.ts`, add a structural double whose `EffectfulMutationExecutor.run` records `captured.claimKey`, compute calls, and commit calls; assert pass/fail/goto/complete/stop each call it once and exhaustively map `committed`, `claim_superseded`, `concurrent_modification`, `execution_in_progress`, `recovery_required`, and `missing`. In `lifecycle-execution-fencing.process.test.ts`, use `lifecycle-execution-child.ts` and an IPC barrier to assert: two pass processes produce one shell-effect marker, one committed transition, and one `execution_in_progress`; kill after `claimed`/before effect reclaims then executes once; kill after `effect_started`/before commit yields JSON `recovery_required`, reaches `RECOVERY_TAG`, and retry does not append a second marker; kill after commit/before clear does not append a second marker. Add default JSON and `--text` redaction assertions to the five command tests.
- [ ] Run RED:

  ```bash
  corepack pnpm --filter @rundown-org/core exec jest \
    __tests__/runbook/lifecycle-command-service.test.ts \
    __tests__/runbook/execution-recovery-service.test.ts
  corepack pnpm --filter @rundown-org/cli exec jest \
    __tests__/integration/lifecycle-execution-fencing.process.test.ts \
    __tests__/commands/pass.test.ts __tests__/commands/fail.test.ts \
    __tests__/commands/goto.test.ts __tests__/commands/complete.test.ts \
    __tests__/commands/stop.test.ts
  ```

  Expected: FAIL because `runEffectful`/`EffectfulLifecycleCommandResult` do not exist and the current CLI path permits duplicate or unclassified execution.
- [ ] **Implement the minimal core-owned vertical slice.** Add `runEffectful` as a thin adapter over `EffectfulMutationExecutor.run`: pass through `committed`, `claim_superseded`, `concurrent_modification`, `execution_in_progress`, and `missing`; on `recovery_required`, call `ExecutionRecoveryService.recover()` before returning and assert the recovered actor snapshot has `RECOVERY_TAG`; finish the switch with a `never` check. Route each command's already-prepared state-machine computation into `input.compute` and its `RunbookStore.commitOwnedState` binding into `input.commit`. Derive claim activity only from `input.captured.claimKey`. Update `transitions.ts`, `goto-workflow.ts`, `terminal-command.ts`, and `execution.ts` to invoke the core service once and render the returned union.
- [ ] **GREEN.** Re-run every suite in the two RED command blocks, then `corepack pnpm run build && corepack pnpm run test:scenarios:raw`. Expected: all pass; `execution-recovery.scenario.md` observes `recovery_required` followed by a typed reconcile/retry/stop transition.
- [ ] Run mutation:

  ```bash
  corepack pnpm --filter @rundown-org/core exec stryker run \
    --mutate src/runbook/lifecycle-command-service.ts,src/runbook/execution-lifecycle-service.ts,src/runbook/execution-recovery-service.ts,src/runbook/effectful-mutation-executor.ts \
    --testFiles __tests__/runbook/lifecycle-command-service.test.ts,__tests__/runbook/execution-recovery-service.test.ts,__tests__/runbook/actor-service-execution-fence.test.ts
  corepack pnpm --filter @rundown-org/cli exec stryker run \
    --mutate src/helpers/transitions.ts,src/helpers/goto-workflow.ts,src/helpers/terminal-command.ts,src/services/execution.ts \
    --testFiles __tests__/commands/pass.test.ts,__tests__/commands/fail.test.ts,__tests__/commands/goto.test.ts,__tests__/commands/complete.test.ts,__tests__/commands/stop.test.ts,__tests__/integration/lifecycle-execution-fencing.process.test.ts
  ```

  Expected: non-zero instrumentation; crash-boundary, claim-key, recovery, and outcome-switch mutants are killed.
- [ ] Run `corepack pnpm run verify`; expected exit 0. Commit `feat(core): route lifecycle commands through execution fencing`; open and merge PR 11.

## Mandatory Review Checkpoint (after this PR)

Demonstrate a real effect under two processes and all three crash boundaries; verify `RECOVERY_TAG` is reached through the machine.

## Self-Review Checklist

- [ ] RED was observed failing for the stated reason before implementing.
- [ ] The CLI invokes the core service once per command and executes no transition itself.
- [ ] Every discriminant of `EffectfulLifecycleCommandResult` is rendered; the mapping switch ends in a `never` check.
- [ ] All three crash boundaries are proven not to duplicate the effect marker.
- [ ] Both mutation campaigns instrument non-zero sources; crash-boundary, claim-key, recovery, and outcome-switch mutants are killed.
- [ ] `corepack pnpm run verify` exited 0 before push; all GitHub checks green before merge.
