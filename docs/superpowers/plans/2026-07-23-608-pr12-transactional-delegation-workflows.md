# 608 Controlled Rebuild — PR 12: Make delegate, collect, and abort transactional

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This task is TDD: RED, then implement, then GREEN, then mutation.

**Parent plan:** [2026-07-23-608-controlled-rebuild.md](2026-07-23-608-controlled-rebuild.md) — PR 12 of 14.

**Goal:** Give delegate, collect, and abort all-or-none transaction boundaries under core ownership; the CLI no longer holds `DelegationLock` or writes state/session records.

**Depends on:** PR 11 (`feat(core): route lifecycle commands through execution fencing`) merged. Branch from the freshly fetched merged `origin/main`. This is fresh work derived from the carried-forward tasks — **no salvage commit is replayed.**

**Tech Stack:** TypeScript, XState 5, SQLite (`node:sqlite` and sql.js), Jest, fast-check, Stryker, Biome, ESLint, pnpm 11 through Corepack, GitHub pull requests.

## Shared Constraints

- Fetch `origin/main` and record the then-current SHA before creating the branch. Never base work on `608-sqlite-claim-concurrency`, `608-integration`, or a closed PR branch.
- Salvage tag `608-salvage-2026-07-23` (peeled to `5364e3965`) is immutable: never force-update or delete it, and never prune the salvage branches.
- Open only one dependent implementation PR at a time. This PR must merge before PR 13 branches from the newly fetched `origin/main`.
- Every changed path must be listed in the Files block below. An unexpected path is a stop-and-review event, not an implicit addition. `git diff --check` must exit 0.
- All delegation, collection, and abort behavior stays owned by core/XState; frontends perform no shadow writes.
- Preserve terminal claim confirm/conflict semantics: a completed or stopped child remains resolvable as terminal evidence. Retry/token replacement, cancellation, parent deletion/terminalization, or unrelated parent cursor/substep advance supersedes mutation authority.
- Run the named tests, both exact scoped mutation commands, and `corepack pnpm run verify`. Expected result is exit 0; Stryker must report at least one instrumented source and at least one mutant per campaign. Never use `--allowEmpty`.
- The only scoped mutation form is `corepack pnpm --filter @rundown-org/<pkg> exec stryker run --mutate <package-relative-comma-separated-paths> --testFiles <package-relative-comma-separated-paths>`. Pass each option once, use package-relative paths, and never insert a pnpm `--` separator. Use the comma form, never a brace glob: Stryker splits `--mutate` and `--testFiles` on commas *before* brace expansion, so `{a,b}.ts` degrades into patterns that match nothing and the run reports `Instrumented 0 source file(s) with 0 mutant(s)` — a gate that cannot fail. Confirm that line reports a non-zero count before trusting any score, and delete `reports/stryker-incremental.json` first so an `incremental: true` cache cannot replay a previous run's aggregate over it.
- `RESULT`, `HANDLER`, and `ACTION` remain distinct. Lifecycle dispatch is type-driven; no frontend branches on raw action strings and no action is silently mapped to another action.
- Persisted `RunbookState.schemaVersion` remains `1`. Never migrate, import, hydrate, shim, or dual-read incompatible persisted JSON state.
- Runtime services, callables, `cwd`, and store instances flow through actor invoke-input/constructor DI, never persisted XState context.
- CLI tests cover default JSON and `--text` separately; bearer IDs stay redacted in both.
- `pnpm run verify` is mandatory before every push. Any red local or GitHub check is a hard stop.

## Task: Make delegate, collect, and abort transactional

**Files:**
- Core: `packages/core/src/runbook/{completion-service,collection-service,lifecycle-command-service,abort-command-service,inline-parent-advance,index}.ts`
- CLI: `packages/cli/src/{commands/delegate,commands/collect,commands/abort,services/execution,helpers/runbook-pipeline,helpers/delegation-completion}.ts`
- Test: `packages/core/__tests__/runbook/{completion-service,collection-service,lifecycle-command-service,abort-command-service,inline-parent-advance,inline-propagation-guard.properties}.test.ts`
- Create: `packages/core/__tests__/runbook/multi-record-workflows.process.test.ts`
- Create: `packages/core/__tests__/runbook/storage/fixtures/multi-record-workflow-child.ts`
- Test: `packages/cli/__tests__/commands/{delegate,collect,abort}.test.ts`, `packages/cli/__tests__/helpers/runbook-pipeline.test.ts`
- Scenario: `runbooks/delegation/delegate-claim-superseded.runbook.md`, `runbooks/delegation/delegate-abort.runbook.md`, `runbooks/delegation/delegate-keyword-collect-pass.runbook.md`, `runbooks/delegation/delegate-keyword-collect-fail.runbook.md`

**Interfaces:**
- Produces:

  ```typescript
  export type DelegationWorkflowResult<T> =
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

  export type InlinePropagationResult =
    | { readonly kind: 'propagated' }
    | { readonly kind: 'not_terminal' }
    | {
        readonly kind: 'recovery_required';
        readonly runId: RunId;
        readonly epoch: ExecutionEpoch;
        readonly message: string;
      }
    | { readonly kind: 'linkage-cycle'; readonly trip: LinkageCycleTrip };
  ```

- Collection keeps its own union. `DelegationWorkflowResult` carries only the transaction-level outcomes, so routing collect through it unchanged would erase the seven collection-specific variants the CLI renders today (`collect.ts` cases for `collection_applied`, `already_collected`, `collection_frame_not_active`, `missing_outcomes`, `actor_context_required`, `claim_grant_required`, `collection_failed`) by collapsing them into `committed` or `missing` — a silent mapping this plan must not introduce:

  ```typescript
  export type CollectionWorkflowResult =
    | Exclude<DelegationWorkflowResult<never>, { kind: 'committed' }>
    | { readonly kind: 'collection_applied'; readonly outcomes: readonly CollectedOutcome[] }
    | { readonly kind: 'already_collected'; readonly runId: RunId; readonly message: string }
    | { readonly kind: 'collection_frame_not_active'; readonly runId: RunId; readonly message: string }
    | { readonly kind: 'missing_outcomes'; readonly runId: RunId; readonly pending: readonly StepId[] }
    | { readonly kind: 'actor_context_required'; readonly runId: RunId; readonly message: string }
    | { readonly kind: 'claim_grant_required'; readonly runId: RunId; readonly message: string }
    | { readonly kind: 'collection_failed'; readonly runId: RunId; readonly message: string };
  ```

- Adds `AbortCommandService.abortDelegation(input: AbortCommandAuthorizationInput): Promise<DelegationWorkflowResult<AbortDelegationResult>>`; widens `collectDelegationOutcomes` to `Promise<CollectionWorkflowResult>` and the lifecycle service's delegate operation to `DelegationWorkflowResult`. CLI no longer holds `DelegationLock` or writes state/session records, and its `collect` rendering stays exhaustive over `CollectionWorkflowResult` with each variant's existing policy, exit code, and output preserved.

- [ ] **RED — pin all-or-none behavior.** In `completion-service.test.ts`, `collection-service.test.ts`, `lifecycle-command-service.test.ts`, and `abort-command-service.test.ts`, inject failure after each write candidate and assert no claim supersession, child release, issued substep, resolved completion, substep state, abort state, or session release remains partially committed. In `multi-record-workflows.process.test.ts`, use the fixture and IPC barrier to overlap two delegate retries, two collects, and two aborts; assert exactly one committed winner, a typed loser, and no partial lease. In `inline-propagation-guard.properties.test.ts`, replace sink call-count assertions with the returned `{ kind: 'linkage-cycle', trip }`. In the four listed CLI tests assert default JSON and `--text` for `execution_in_progress`/`recovery_required`, byte-identical `INLINE_PARENT_CYCLE`, and redacted bearer IDs.
- [ ] Run RED:

  ```bash
  corepack pnpm --filter @rundown-org/core exec jest \
    __tests__/runbook/completion-service.test.ts __tests__/runbook/collection-service.test.ts \
    __tests__/runbook/lifecycle-command-service.test.ts __tests__/runbook/abort-command-service.test.ts \
    __tests__/runbook/inline-parent-advance.test.ts \
    __tests__/runbook/inline-propagation-guard.properties.test.ts \
    __tests__/runbook/multi-record-workflows.process.test.ts
  corepack pnpm --filter @rundown-org/cli exec jest \
    __tests__/commands/delegate.test.ts __tests__/commands/collect.test.ts \
    __tests__/commands/abort.test.ts __tests__/helpers/runbook-pipeline.test.ts
  ```

  Expected: FAIL because abort still authorizes without owning mutation, lock-domain twins can split writes, and inline propagation does not return the cycle trip/recovery arm.
- [ ] **Implement short aggregate transactions.** Resolve children, variables, helpers, and files before SQL. Add transaction-local repository functions for delegate retry, completion drain, collect terminalization, and abort; each accepts only validated data and runs under the already acquired run-set lease. Carry forward cursor branding, `buildCompletionKey`, atomic `resolvedCompletions`+`substepStates`, collect gate order, readiness rules, terminal reload/release/propagate order, parent claim revalidation, #617 refused-bearer cleanup, and #602 cycle/depth/severity behavior. Recheck open children inside `commitOwnedState` before the parent update. Reuse `claimAndInitialLink`. Change inline propagation to return `InlinePropagationResult`, delete `OnLinkageCycle`, and adapt `delegation-completion.ts` to render its trip.
- [ ] **GREEN.** Re-run both RED commands and `corepack pnpm run test:scenarios:all`. Expected: all listed tests and the four listed delegation scenarios pass; each failure injection rolls back fully and each race has one winner.
- [ ] Run mutation:

  ```bash
  corepack pnpm --filter @rundown-org/core exec stryker run \
    --mutate src/runbook/completion-service.ts,src/runbook/collection-service.ts,src/runbook/lifecycle-command-service.ts,src/runbook/abort-command-service.ts,src/runbook/inline-parent-advance.ts \
    --testFiles __tests__/runbook/completion-service.test.ts,__tests__/runbook/collection-service.test.ts,__tests__/runbook/lifecycle-command-service.test.ts,__tests__/runbook/abort-command-service.test.ts,__tests__/runbook/inline-parent-advance.test.ts,__tests__/runbook/inline-propagation-guard.properties.test.ts
  corepack pnpm --filter @rundown-org/cli exec stryker run \
    --mutate src/commands/delegate.ts,src/commands/collect.ts,src/commands/abort.ts,src/helpers/runbook-pipeline.ts \
    --testFiles __tests__/commands/delegate.test.ts,__tests__/commands/collect.test.ts,__tests__/commands/abort.test.ts,__tests__/helpers/runbook-pipeline.test.ts
  ```

  Expected: non-zero instrumentation; rollback, authorization ordering, cycle-trip, and result-switch mutants are killed.
- [ ] Run `corepack pnpm run verify`; expected exit 0. Commit `refactor(core): make delegation and collection workflows transactional`; open and merge PR 12.

## Mandatory Review Checkpoint (after this PR)

Inspect delegate/collect/abort transaction boundaries, multi-run acquisition, linkage-cycle return shape, and absence of frontend shadow writes.

## Self-Review Checklist

- [ ] RED was observed failing for the stated reasons before implementing.
- [ ] Every injected failure rolls back fully — no partial claim, release, substep, completion, abort, or session state.
- [ ] Each overlapping race has exactly one committed winner and a typed loser; no partial lease.
- [ ] Inline propagation returns `InlinePropagationResult`; `OnLinkageCycle` is deleted and `INLINE_PARENT_CYCLE` output is byte-identical.
- [ ] The CLI holds no `DelegationLock` and writes no state/session records.
- [ ] Rollback, authorization ordering, cycle-trip, and result-switch mutants are killed.
- [ ] `corepack pnpm run verify` exited 0 before push; all GitHub checks green before merge.
