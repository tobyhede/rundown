# 608 Controlled Rebuild — PR 13: Single production cutover and domain-lock deletion

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This task is TDD: RED, then implement, then GREEN, then mutation.

**Parent plan:** [2026-07-23-608-controlled-rebuild.md](2026-07-23-608-controlled-rebuild.md) — PR 13 of 14.

**Goal:** Make `.rundown/rundown.db` the sole run/session authority, delete the four domain locks, and refuse obsolete JSON state with a typed `RD-305` error. No dual-read period, no persisted-state migration.

**Depends on:** PR 12 (`refactor(core): make delegation and collection workflows transactional`) merged. Branch from the freshly fetched merged `origin/main`. This is fresh work derived from the carried-forward tasks — **no salvage commit is replayed.**

**Tech Stack:** TypeScript, XState 5, SQLite (`node:sqlite` and sql.js), Jest, Stryker, Biome, ESLint, pnpm 11 through Corepack, GitHub pull requests.

## Shared Constraints

- Fetch `origin/main` and record the then-current SHA before creating the branch. Never base work on `608-sqlite-claim-concurrency`, `608-integration`, or a closed PR branch.
- Salvage tag `608-salvage-2026-07-23` (peeled to `5364e3965`) is immutable: never force-update or delete it, and never prune the salvage branches.
- Open only one dependent implementation PR at a time. This PR must merge before PR 14 branches from the newly fetched `origin/main`.
- Every changed path must be listed in the Files block below or in the generated `/tmp/rd608-pr13-fixtures` manifest. An unexpected path is a stop-and-review event. `git diff --check` must exit 0.
- **Legacy state is refused, never migrated.** Do not add import, fallback, warning-only, hydration, shim, or dual-read code. Persisted `RunbookState.schemaVersion` stays `1`; SQLite storage schema versions are independent.
- File locks survive only for sql.js durable replacement and artifact-manifest synchronization, with `await using` non-masking release (RD-102).
- Run the named tests, the exact scoped mutation command, and `corepack pnpm run verify`. Expected result is exit 0; Stryker must report at least one instrumented source and at least one mutant. Never use `--allowEmpty`.
- The only scoped mutation form is `corepack pnpm --filter @rundown-org/<pkg> exec stryker run --mutate <package-relative-comma-separated-paths> --testFiles <package-relative-comma-separated-paths>`. Pass each option once, use package-relative paths, and never insert a pnpm `--` separator. Use the comma form, never a brace glob: Stryker splits `--mutate` and `--testFiles` on commas *before* brace expansion, so `{a,b}.ts` degrades into patterns that match nothing and the run reports `Instrumented 0 source file(s) with 0 mutant(s)` — a gate that cannot fail. Confirm that line reports a non-zero count before trusting any score, and delete `reports/stryker-incremental.json` first so an `incremental: true` cache cannot replay a previous run's aggregate over it.
- `RESULT`, `HANDLER`, and `ACTION` remain distinct. Lifecycle dispatch is type-driven; no frontend branches on raw action strings and no action is silently mapped to another action.
- Runtime services, callables, `cwd`, and store instances flow through actor invoke-input/constructor DI, never persisted XState context.
- CLI tests default to JSON output. `pnpm run verify` is mandatory before every push; any red local or GitHub check is a hard stop.

## Task: Perform the single production cutover and delete domain locks

**Files:**
- Delete: `packages/core/src/runbook/{run-state-lock,session-lock,completion-lock,delegation-lock}.ts`
- Delete: `packages/core/__tests__/runbook/{run-state-lock,session-lock,completion-lock,delegation-lock}.test.ts`
- Create: `packages/core/src/runbook/storage/legacy-state-refusal.ts`
- Create: `packages/core/__tests__/runbook/storage/{legacy-state-refusal,store-initialization.process}.test.ts`
- Create: `packages/core/__tests__/runbook/storage/fixtures/store-initialization-child.ts`
- Modify: `packages/core/src/errors/factory.ts` (add an `RD-305` legacy-state factory without changing the existing schema-version factory)
- Modify: `packages/core/src/runbook/file-lock.ts`, `packages/core/src/paths.ts`, `packages/core/src/runbook/index.ts`, `packages/core/src/index.ts`
- Modify current production constructor sites: `packages/core/src/runbook/{actor-service,delegation-service,session-reader,session-service,state}.ts`; `packages/cli/src/commands/{artifact,claim,delegate,ls,pop,prune,run,stash,status}.ts`; `packages/cli/src/helpers/{actor-service-factory,delegation-completion,echo-command,lifecycle-seam-factory,terminal-command,transitions}.ts`; `packages/cli/src/services/execution.ts`
- Modify: `packages/core/src/events/types.ts`, `packages/core/__tests__/runbook/state-schema-version.test.ts`, and every CLI/MCP/plugin fixture emitted at execution time by `rg -l "session\\.json|\\.rundown/runs/|new (RunbookStateManager|SessionService|RunbookActorService)" packages/{cli,mcp,claude-code-plugin}/__tests__ | sort -u > /tmp/rd608-pr13-fixtures`.

**Interfaces:**
- Produces one capability-selected store per process graph and `.rundown/rundown.db` as the sole run/session authority.
- Produces typed `RD-305` refusal when legacy `.rundown/session.json` or `.rundown/runs/*.json` exists; refusal includes paths in `details.context` and creates no DB.
- Retains file locks only for sql.js durable replacement and artifact-manifest synchronization, with `await using` non-masking release.
- Produces `Errors.legacyRunbookState(legacyPaths: readonly string[]): RundownError`, which constructs `INCOMPATIBLE_STATE_SCHEMA`/`RD-305` with `legacyPaths` in its context while leaving `Errors.incompatibleStateSchema(foundVersion, expectedVersion)` unchanged. Produces `detectLegacyRunbookState(cwd: string): Promise<readonly string[]>` and `openAuthoritativeRunbookStore(input: { readonly cwd: string; readonly openDriver?: typeof openRunbookDriver }): Promise<RunbookStore>`. The opener calls detection before `openDriver(dbPath)`, defaults that seam to `openRunbookDriver`, and throws `Errors.legacyRunbookState(legacyPaths)` when the list is non-empty.

- [ ] **RED — pin refusal and initialization.** In `legacy-state-refusal.test.ts`, create `session.json` and one `runs/*.json`; assert `openAuthoritativeRunbookStore` rejects with `RD-305`, `details.context.legacyPaths` contains both canonical paths, and `rundown.db` is absent. Assert a clean open creates only `rundown.db`. In `store-initialization.process.test.ts`, release two child processes through one IPC barrier and assert one schema install, one observation of that schema, one valid DB, and no JSON authority files. In CLI `run.test.ts`, assert the default JSON envelope carries `RD-305` and never suggests the new binary can finish old state.
- [ ] Run RED:

  ```bash
  corepack pnpm --filter @rundown-org/core exec jest \
    __tests__/runbook/storage/legacy-state-refusal.test.ts \
    __tests__/runbook/storage/store-initialization.process.test.ts \
    __tests__/runbook/state-schema-version.test.ts
  corepack pnpm --filter @rundown-org/cli exec jest __tests__/commands/run.test.ts
  ```

  Expected: FAIL because the legacy detector/authoritative opener do not exist and current graphs still expose JSON/domain-lock authority.
- [ ] **Implement the one-store graph.** Generate `/tmp/rd608-pr13-fixtures` with the Files command and save it in PR evidence. Implement detection with canonical, project-contained paths and no JSON parsing. Call it before driver creation. Pass one capability-selected `RunbookStore` through all listed production constructor sites and every fixture in that manifest; remove hidden manager construction. Delete the four domain locks and lock-held twins; keep `file-lock.ts` only for sql.js replacement and artifact manifests. Remove `runbook_started.statePath` while retaining `runbookId` and source. Keep `RunbookState.schemaVersion` at `1`; do not add import, fallback, warning, or dual-read code.
- [ ] **GREEN.** Re-run both RED commands, then run `rg -n "RunStateLock|SessionLock|CompletionLock|DelegationLock|session\.json|\.rundown/runs/" packages`. Expected: tests pass; search hits are limited to `legacy-state-refusal.ts` and its tests. Separately save the same search over `docs/internal CLAUDE.md` as PR 14's required documentation input. Run `corepack pnpm run test:all && corepack pnpm run test:scenarios:all && corepack pnpm run check:types && corepack pnpm run lint`; expected exit 0.
- [ ] Run mutation:

  ```bash
  corepack pnpm --filter @rundown-org/core exec stryker run \
    --mutate src/errors/factory.ts,src/runbook/state.ts,src/runbook/session-service.ts,src/runbook/file-lock.ts,src/runbook/storage/legacy-state-refusal.ts,src/runbook/storage/runbook-store.ts,src/runbook/storage/store-registry.ts \
    --testFiles __tests__/runbook/state.test.ts,__tests__/runbook/session-service.test.ts,__tests__/runbook/file-lock.test.ts,__tests__/runbook/storage/legacy-state-refusal.test.ts,__tests__/runbook/storage/runbook-store.test.ts,__tests__/runbook/storage/store-registry.test.ts
  ```

  Expected: non-zero instrumentation; legacy-refusal ordering, single-store wiring, and remaining file-lock safety mutants are killed.
- [ ] Run `corepack pnpm run verify`; expected exit 0. Commit `feat: cut runbook state authority over to SQLite`; open and merge PR 13.

## Mandatory Review Checkpoint (after this PR)

Prove one authority store, typed `RD-305`, no mixed mode, no domain locks, and retained sql.js/artifact file-lock safety.

## Self-Review Checklist

- [ ] RED was observed failing for the stated reason before implementing.
- [ ] `/tmp/rd608-pr13-fixtures` was generated and saved as PR evidence; every fixture in it takes the single store.
- [ ] Legacy detection runs before driver creation and creates no DB on refusal.
- [ ] The four domain locks and their lock-held twins are deleted; `file-lock.ts` remains only for sql.js replacement and artifact manifests, with non-masking release.
- [ ] `runbook_started` no longer carries `statePath`; `runbookId` and source are retained.
- [ ] The residual-search output is limited to `legacy-state-refusal.ts` and its tests; the docs-side search is saved for PR 14.
- [ ] `corepack pnpm run verify` exited 0 before push; all GitHub checks green before merge.
