# 608 Controlled Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the SQLite claim-concurrency work from current `main` as sequential, independently green pull requests, then complete the production lifecycle migration and single-store cutover required to close #608.

**Architecture:** Preserve the review branch as an annotated forensic tag, then restage each owned salvage commit onto a fresh branch made from the latest merged `main`. SQLite storage, execution fencing, recovery, claim liveness, and typed refusals land before frontends are migrated; all lifecycle and multi-record behavior remains owned by core/XState, while CLI, MCP, and plugin only invoke typed core outcomes. The final cutover removes residual legacy lock/frontend paths, adds typed refusal of obsolete JSON state, and establishes the SQLite store as the sole supported authority; there is no dual-read period or persisted-state migration.

**Tech Stack:** TypeScript, XState 5, SQLite (`node:sqlite` and sql.js), Jest, fast-check, Stryker, Biome, ESLint, pnpm 11 through Corepack, Playwright, GitHub pull requests.

## Global Constraints

- The planning baseline is `origin/main` at `a52fb4ae0`; execution must fetch `origin/main` and record the then-current SHA before creating each branch.
- Preserve salvage commit `5364e3965` with annotated tag `608-salvage-2026-07-23`; record both the tag-object SHA and peeled commit SHA, push the tag once, and never force-update or delete it.
- Open only one dependent implementation PR at a time. Merge it before branching the next PR from the newly fetched `origin/main`.
- The source commits below are evidence, not merge bases. Never base work on `608-sqlite-claim-concurrency`, `608-integration`, or a closed PR branch.
- Before editing each PR, run its exact `git cherry-pick --no-commit` sequence. Resolve conflicts in favor of current-main package scripts, CI, error helpers, docs guards, and test conventions; preserve the task's named behavior and tests.
- After conflict resolution, `git diff --name-only --diff-filter=U` must print nothing, `git diff --check` must exit 0, and every changed path must be listed in that task's ownership block. An unexpected path is a stop-and-review event, not an implicit addition.
- Every PR runs its named tests, its exact scoped mutation command when behavior-bearing, and `corepack pnpm run verify`. Expected result is exit 0; Stryker must report at least one instrumented source and at least one mutant. Never use `--allowEmpty`.
- The only scoped mutation form in this plan is `corepack pnpm --filter @rundown-org/<pkg> exec stryker run --mutate <package-relative-comma-separated-paths> --testFiles <package-relative-comma-separated-paths>`. Pass each option once, use package-relative paths, and never insert a pnpm `--` separator. Use the comma form, never a brace glob: Stryker splits `--mutate` and `--testFiles` on commas *before* brace expansion, so `{a,b}.ts` degrades into patterns that match nothing and the run reports `Instrumented 0 source file(s) with 0 mutant(s)` — a gate that cannot fail. Confirm that line reports a non-zero count before trusting any score, and delete `reports/stryker-incremental.json` first so an `incremental: true` cache cannot replay a previous run's aggregate over it.
- Preserve terminal claim confirm/conflict semantics: a completed or stopped child remains resolvable as terminal evidence. Retry/token replacement, cancellation, parent deletion/terminalization, or unrelated parent cursor/substep advance supersedes mutation authority.
- `RESULT`, `HANDLER`, and `ACTION` remain distinct. Lifecycle dispatch is type-driven; no frontend branches on raw action strings and no action is silently mapped to another action.
- Persisted `RunbookState.schemaVersion` remains `1`. SQLite storage schema versions are independent. Never migrate, import, hydrate, shim, or dual-read incompatible persisted JSON state.
- Runtime services, callables, `cwd`, and store instances flow through actor invoke-input/constructor DI, never persisted XState context.
- `pnpm run verify` is mandatory before every push. Any red local or GitHub check is a hard stop.

## File and Commit Ownership Map

| PR | Responsibility | Salvage commits owned in full unless an exclusion is stated |
| ---: | --- | --- |
| 1 | SQLite driver substrate | `5fdf7379c` |
| 2 | Transactional `RunbookStore` | `2b5eed7e2` |
| 3 | Execution ownership and XState recovery model | `50de92c2d`, `94f758aa0`, `739df3320` |
| 4 | Guarded actor commit seam | `64f840ded`, `a39701d6e`, `785a3eabb`, `e203ec905` |
| 5 | SQLite persistence staging, not production cutover | `e5f0b2154`, `1e0c67cb7`, `279bd599f`, `b9e23b561`, `53534f388`, `c3e9a38c1`, `fb2619d4d`, `2de7837d5`; exclude `4859a9c08` for PR 14 |
| 6 | Claim liveness, single-controller rule, typed claim taxonomy | `6e9ff79f3`, `2d0656b24`, `eec5246d3`, `6cf18277c`, `68bdbf62c` |
| 7 | Transaction-local guarded parent advance | `0f896b8b6`, `03d9144a1`, `63f469945`, `e21dab179`, `ee650ce7c`, `70a7082ec` |
| 8 | Recovery and storage hardening | `6f1e323fe`, `c1298a91d`, `9edfa08ef`, `ebc396411`, `2b86d2188`, `fdfb1c6aa`, `3c62faca9`, `401522b07`, `c3e0c156d`, `177e049ed`, `4b67d806b`, `5cd9566a4` |
| 9 | Typed session ownership refusals | `a823892fe` |
| 10 | Atomic initial claim and parent link | `0789b22d9`, `1cd2b38c0`, `56a23d4be`, `0066a614d`, `88ec8a832`, `0bf8674ab` |
| 11–14 | Production completion | Fresh work derived from the carried-forward Tasks 7–10; no unowned salvage commit is replayed |

The prospective commits `63077ea8f`, `957a4917f`, `702c752f4`, and `5364e3965` are forensic input only and never enter an implementation PR. Mutation-tooling commit `36e1ad621` is not replayed because current main's direct Stryker command is canonical. Commit `12dcc0dbe` is not replayed: format the owned implementation instead. Commit `21078e2b4` is not replayed: PR 14 rewrites descriptive comments and docs from the final implementation.

---

### Task 1: Preserve the salvage tip immutably

**Files:** None.

**Interfaces:**
- Consumes: salvage commit `5364e3965`.
- Produces: pushed annotated tag `608-salvage-2026-07-23` and a recorded tag-object/commit pair.

- [ ] Record, but do not clean or stash, `git status --short` in every existing worktree. Run `git worktree list --porcelain` and save the output with the issue evidence.
- [ ] Run:

  ```bash
  git tag -a 608-salvage-2026-07-23 5364e3965 \
    -m "Immutable forensic tip for issue 608 controlled rebuild"
  git rev-parse 608-salvage-2026-07-23
  git rev-parse 608-salvage-2026-07-23^{}
  ```

  Expected: the first SHA identifies an annotated tag object; the peeled SHA is the full form of `5364e3965`.
- [ ] Push exactly once with `git push origin refs/tags/608-salvage-2026-07-23` and verify `git ls-remote --tags origin 608-salvage-2026-07-23 '608-salvage-2026-07-23^{}'` reports the same two SHAs. Protect the tag pattern in the repository settings before deleting any branch.
- [ ] Run `git fsck --no-reflogs --unreachable` only as a read-only audit. Do not prune or delete the salvage branches during this plan.

### Task 2: PR 1 — Add the SQLite driver substrate

**Files:**
- Modify/Create: exactly the 12 paths reported by `git diff-tree --no-commit-id --name-only -r 5fdf7379c`: `eslint.config.js`, `packages/core/package.json`, `pnpm-lock.yaml`, `packages/core/src/runbook/storage/{sql-driver,native-sqlite-driver,sqljs-driver,driver-factory,schema}.ts`, `packages/core/__tests__/runbook/storage/{driver-contract,schema}.test.ts`, `site/src/pages/__sqlite-substrate-probe.astro`, `site/tests/sqlite-substrate.spec.ts`.
- **Probe path deviation:** the salvaged probe is committed at `site/src/pages/__sqlite-substrate-probe.astro` and can never execute — Astro excludes `_`-prefixed files in `src/pages/` from routing, so the route 404s. PR 1 lands it renamed to `site/src/pages/sqlite-substrate-probe.astro` (11 paths verbatim plus the rename) along with a regex fix. See `2026-07-23-608-pr01-sqlite-driver-substrate.md` for the recorded deviation and evidence; PR 14 owns the final location. Do not recreate the underscore-prefixed path.

**Interfaces:**
- Produces: adapter-neutral SQL driver/factory and schema probe; neither run nor session persistence changes.

- [ ] Branch `608-rebuild-sqlite-substrate` from merged `origin/main`; run `git cherry-pick --no-commit 5fdf7379c`. Resolve only current-main dependency/lint drift; verify no unmerged or unexpected paths.
- [ ] Run `corepack pnpm --filter @rundown-org/core exec jest __tests__/runbook/storage/driver-contract.test.ts __tests__/runbook/storage/schema.test.ts`. Expected: both suites pass for native SQLite and sql.js.
- [ ] Build the WebContainer snapshot first — `corepack pnpm --filter site run build:snapshot` — otherwise `astro dev` refuses to serve and Playwright reports `Process from config.webServer exited early`. `site/public/rundown-snapshot.bin` is gitignored, so this is a local prerequisite, not a committed path.
- [ ] Run `corepack pnpm --filter site exec playwright test tests/sqlite-substrate.spec.ts`. Expected: probe passes or, if the current-main site command differs, stop and update this plan before proceeding.
- [ ] Run `corepack pnpm --filter @rundown-org/core exec stryker run --mutate src/runbook/storage/native-sqlite-driver.ts,src/runbook/storage/sqljs-driver.ts,src/runbook/storage/driver-factory.ts --testFiles __tests__/runbook/storage/driver-contract.test.ts,__tests__/runbook/storage/schema.test.ts`. Expected: non-zero instrumentation and no driver-contract survivors accepted without an issue.
- [ ] Run `corepack pnpm run verify`; commit `feat(core): add SQLite driver substrate`; open and merge PR 1.

### Task 3: PR 2 — Add the transactional repository

**Files:**
- Create/Modify: `packages/core/src/runbook/storage/{runbook-store,mutation-result,schema}.ts`
- Test: `packages/core/__tests__/runbook/storage/{runbook-store,runbook-store.properties}.test.ts`

**Interfaces:**
- Produces: `RunbookStore`, `CapturedAuthority`, typed guarded mutation results, and transaction-local repository operations. Runtime callers remain on their pre-existing persistence route.

- [ ] Branch from merged `origin/main`; run `git cherry-pick --no-commit 2b5eed7e2`; verify the five-path allowlist above, no unmerged paths, and `git diff --check`.
- [ ] Run `corepack pnpm --filter @rundown-org/core exec jest __tests__/runbook/storage/runbook-store.test.ts __tests__/runbook/storage/runbook-store.properties.test.ts`. Expected: unit and property suites pass.
- [ ] Run `corepack pnpm --filter @rundown-org/core exec stryker run --mutate src/runbook/storage/runbook-store.ts,src/runbook/storage/mutation-result.ts --testFiles __tests__/runbook/storage/runbook-store.test.ts,__tests__/runbook/storage/runbook-store.properties.test.ts`. Expected: non-zero instrumentation; no survivor may remove transaction rollback, generation, or claim/state compare-and-swap guards.
- [ ] Run `corepack pnpm run verify`; commit `feat(core): add transactional SQLite runbook repository`; open and merge PR 2.

### Task 4: PR 3 — Add execution ownership and machine recovery

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

### Task 5: PR 4 — Add the guarded actor commit seam

**Files:**
- Source: `packages/core/src/paths.ts`, `packages/core/src/runbook/{actor-service,effectful-mutation-executor,state,types}.ts`, `packages/core/src/runbook/storage/{execution-lease,runbook-store,schema,store-registry}.ts`
- Test: `packages/core/__tests__/runbook/actor-service-execution-fence.test.ts`, `packages/core/__tests__/runbook/storage/{execution-lease,runbook-store,store-registry}.test.ts`

**Interfaces:**
- Produces `EffectfulMutationExecutor.run<TPrepared,TResult>({ captured, compute, commit, recoveryReason?, wait? })` and actor-specific guarded committers. Persist happens only through `RunbookStore.commitOwnedState(captured, execution, next)`.

- [ ] Cherry-pick without committing, in order: `64f840ded a39701d6e 785a3eabb e203ec905`. Do not add any CLI lifecycle dispatch in this PR.
- [ ] Run `corepack pnpm --filter @rundown-org/core exec jest __tests__/runbook/actor-service-execution-fence.test.ts __tests__/runbook/storage/execution-lease.test.ts __tests__/runbook/storage/runbook-store.test.ts __tests__/runbook/storage/store-registry.test.ts`. Expected: all pass, including commit refusal and registry reuse/close behavior.
- [ ] Run `corepack pnpm --filter @rundown-org/core exec stryker run --mutate src/runbook/effectful-mutation-executor.ts,src/runbook/actor-service.ts,src/runbook/storage/store-registry.ts --testFiles '__tests__/runbook/actor-service-execution-fence.test.ts,__tests__/runbook/storage/store-registry.test.ts'`. Expected: non-zero instrumentation and no survivor that skips effect-boundary marking, guarded commit, or recovery routing.
- [ ] Run `corepack pnpm run verify`; commit `refactor(core): fence actor computation and persistence`; open and merge PR 4.

### Task 6: PR 5 — Stage run and session persistence on SQLite

**Files:**
- Derive the authoritative allowlist with `for c in e5f0b2154 1e0c67cb7 279bd599f b9e23b561 53534f388 c3e9a38c1 fb2619d4d 2de7837d5; do git diff-tree --no-commit-id --name-only -r "$c"; done | sort -u > /tmp/rd608-pr5-allowed`.
- Exclude all three paths from `4859a9c08`; PR 14 owns the runnable WebContainer probe correction.

**Interfaces:**
- Produces SQLite-backed `RunbookStateManager` and `SessionService`, shared through `StoreRegistry`, with transactional session writes and foreign keys enabled in both adapters.
- This is persistence staging, not production cutover: SQLite backs the staged state services, but legacy lock/frontend paths remain until PR 13 and obsolete JSON detection is not yet the typed entry gate. No PR description may claim complete one-store authority yet.

- [ ] Cherry-pick without committing, in exact order: `e5f0b2154 1e0c67cb7 279bd599f b9e23b561 53534f388 c3e9a38c1 fb2619d4d 2de7837d5`. Run `git diff HEAD --name-only | sort -u > /tmp/rd608-pr5-actual && comm -3 /tmp/rd608-pr5-allowed /tmp/rd608-pr5-actual`; expected: no output. Keep current-main mutation scripts, docs guards, and error helpers authoritative.
- [ ] Preserve `2de7837d5`'s deterministic contention witness in `session-service.process.test.ts`: each worker reports entry after `t0`; the parent waits for every report; the parent releases the workers; assertions require overlapping attempts, every domain write present, and no lock-timeout or partial state. Do not restore the historical scheduler/timing-based witness.
- [ ] Run `corepack pnpm --filter @rundown-org/core exec jest __tests__/runbook/state.test.ts __tests__/runbook/session-service.test.ts __tests__/runbook/session-service.process.test.ts __tests__/runbook/storage/driver-contract.test.ts __tests__/runbook/storage/runbook-store.test.ts`. Expected: all pass and the process test proves overlap rather than relying on sleeps.
- [ ] Run `corepack pnpm --filter @rundown-org/cli exec jest __tests__/commands/run.test.ts __tests__/commands/status.test.ts __tests__/commands/stash-pop.test.ts __tests__/commands/prune.test.ts __tests__/commands/claim.test.ts`. Expected: default JSON contracts pass.
- [ ] Run `corepack pnpm --filter @rundown-org/core exec stryker run --mutate src/runbook/state.ts,src/runbook/session-service.ts,src/runbook/storage/runbook-store.ts,src/runbook/storage/sqljs-driver.ts --testFiles __tests__/runbook/state.test.ts,__tests__/runbook/session-service.test.ts,__tests__/runbook/storage/runbook-store.test.ts,__tests__/runbook/storage/driver-contract.test.ts`. Expected: non-zero instrumentation; FK, session transaction, and guarded-state mutants are killed.
- [ ] Run `corepack pnpm run verify`; commit `refactor(core): stage run and session persistence on SQLite`; open and merge PR 5.

### Task 7: PR 6 — Add claim liveness and the single-controller rule

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

### Task 8: PR 7 — Make parent advance transaction-local and atomic

**Files:**
- Derive the authoritative allowlist with `for c in 0f896b8b6 03d9144a1 63f469945 e21dab179 ee650ce7c 70a7082ec; do git diff-tree --no-commit-id --name-only -r "$c"; done | sort -u > /tmp/rd608-pr7-allowed`.
- Required implementation paths include `packages/core/src/runbook/{state,actor-service,completion-service}.ts` and `packages/core/src/runbook/storage/runbook-store.ts`; the allowlist also names the associated tests and TSDoc.

**Interfaces:**
- Produces a transaction-local open-delegated-child guard on the decisive parent update. The open-child query and update occur in the same `RunbookStore` transaction.

- [ ] Cherry-pick `0f896b8b6 03d9144a1 63f469945 e21dab179 ee650ce7c 70a7082ec` in that order. Run `git diff HEAD --name-only | sort -u > /tmp/rd608-pr7-actual && comm -3 /tmp/rd608-pr7-allowed /tmp/rd608-pr7-actual`; expected: no output. Reject any resolution that restores a CLI or pre-transaction check as authority; compute may occur outside SQL, but the open-child recheck must immediately precede the decisive update in the same transaction.
- [ ] Run `corepack pnpm --filter @rundown-org/core exec jest __tests__/runbook/storage/guarded-parent-advance.test.ts __tests__/runbook/storage/runbook-store.test.ts __tests__/runbook/state.test.ts __tests__/runbook/completion-service.test.ts`. Expected: both claim-before-advance and advance-before-claim races pass across processes.
- [ ] Run `corepack pnpm --filter @rundown-org/core exec stryker run --mutate 'src/runbook/storage/runbook-store.ts,src/runbook/state.ts' --testFiles __tests__/runbook/storage/guarded-parent-advance.test.ts,__tests__/runbook/storage/runbook-store.test.ts,__tests__/runbook/state.test.ts`. Expected: non-zero instrumentation; removing the in-transaction query or its decisive-write predicate is killed.
- [ ] Run `corepack pnpm run verify`; commit `fix(core): make guarded parent advance atomic`; open and merge PR 7.

### Task 9: PR 8 — Harden recovery and storage lifecycle

**Files:**
- Derive the authoritative allowlist with `for c in 6f1e323fe c1298a91d 9edfa08ef ebc396411 2b86d2188 fdfb1c6aa 3c62faca9 401522b07 c3e0c156d 177e049ed 4b67d806b 5cd9566a4; do git diff-tree --no-commit-id --name-only -r "$c"; done | sort -u > /tmp/rd608-pr8-allowed`.
- The allowlist covers storage adapters, `runbook-store.ts`, `store-registry.ts`, `execution-recovery-service.ts`, event/output schema and rendering consumers, site probe sources, docs changed by those commits, and their named tests. No path outside `/tmp/rd608-pr8-allowed` belongs in PR 8.

**Interfaces:**
- Produces deterministic recovery hydration, strict row validation, canonical delegation linkage parsing, serialized store close/reopen, and proof that recovery never repeats a persisted effect.

- [ ] Cherry-pick in exact order: `6f1e323fe c1298a91d 9edfa08ef ebc396411 2b86d2188 fdfb1c6aa 3c62faca9 401522b07 c3e0c156d 177e049ed 4b67d806b 5cd9566a4`. Run `git diff HEAD --name-only | sort -u > /tmp/rd608-pr8-actual && comm -3 /tmp/rd608-pr8-allowed /tmp/rd608-pr8-actual`; expected: no output. Retain source TSDoc and descriptive docs changed by these commits; the prospective plan commits remain excluded.
- [ ] Run `corepack pnpm --filter @rundown-org/core exec jest __tests__/runbook/execution-recovery-service.test.ts __tests__/runbook/storage/driver-contract.test.ts __tests__/runbook/storage/runbook-store.test.ts __tests__/runbook/storage/store-registry.test.ts`. Expected: all pass, including close-all/reopen serialization and no-repeat recovery.
- [ ] Run `corepack pnpm --filter @rundown-org/core exec stryker run --mutate src/runbook/execution-recovery-service.ts,src/runbook/storage/runbook-store.ts,src/runbook/storage/store-registry.ts,src/runbook/storage/sqljs-driver.ts --testFiles __tests__/runbook/execution-recovery-service.test.ts,__tests__/runbook/storage/runbook-store.test.ts,__tests__/runbook/storage/store-registry.test.ts,__tests__/runbook/storage/driver-contract.test.ts`. Expected: non-zero instrumentation and no accepted survivor in recovery classification, row guards, close serialization, or durable sql.js replacement.
- [ ] Run `corepack pnpm run verify`; commit `fix(core): harden SQLite recovery and storage lifecycle`; open and merge PR 8.

### Task 10: PR 9 — Type every session ownership refusal

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

- [ ] Cherry-pick `a823892fe` without committing. Run `git diff HEAD --name-only | sort -u > /tmp/rd608-pr9-actual && test "$(wc -l < /tmp/rd608-pr9-actual)" -eq 42 && comm -3 /tmp/rd608-pr9-allowed /tmp/rd608-pr9-actual`; expected: exit 0 and no output. Keep the change as its own PR after hardening and before initial claim/link.
- [ ] Resolve all 42 paths exhaustively. Run `rg -n "SessionMutationResult|execution-in-progress|recovery-required" packages/core/src packages/cli/src` and inspect every switch; each must narrow the discriminant and contain a `never` exhaustiveness check where it maps outcomes.
- [ ] Run `corepack pnpm --filter @rundown-org/core exec jest __tests__/runbook/session-service.test.ts __tests__/runbook/claim-seen.test.ts __tests__/runbook/lifecycle-command-service.test.ts __tests__/runbook/collection-service.test.ts __tests__/runbook/inline-parent-advance.test.ts`. Expected: all pass.
- [ ] Run `corepack pnpm --filter @rundown-org/cli exec jest __tests__/helpers/claim-and-launch.test.ts __tests__/helpers/runbook-pipeline.test.ts __tests__/helpers/transition-orchestrator.test.ts __tests__/services/execution-loop.test.ts __tests__/commands/prune.test.ts`. Expected: JSON ownership refusals and redaction pass.
- [ ] Run `corepack pnpm --filter @rundown-org/core exec stryker run --mutate src/runbook/session-service.ts,src/runbook/lifecycle-command-service.ts,src/runbook/collection-service.ts,src/runbook/storage/runbook-store.ts --testFiles __tests__/runbook/session-service.test.ts,__tests__/runbook/lifecycle-command-service.test.ts,__tests__/runbook/collection-service.test.ts,__tests__/runbook/storage/runbook-store.test.ts` and `corepack pnpm --filter @rundown-org/cli exec stryker run --mutate src/helpers/session-mutation-result.ts,src/helpers/runbook-pipeline.ts,src/helpers/transition-orchestrator.ts,src/services/execution.ts --testFiles __tests__/helpers/claim-and-launch.test.ts,__tests__/helpers/runbook-pipeline.test.ts,__tests__/helpers/transition-orchestrator.test.ts,__tests__/services/execution-loop.test.ts`. Expected: both campaigns instrument non-zero sources/mutants and kill discriminant-mapping mutants.
- [ ] Run `corepack pnpm run verify`; commit `fix(core): type session ownership refusals`; open and merge PR 9.

### Task 11: PR 10 — Make initial claim and parent link atomic

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

### Task 12: PR 11 — Route effectful lifecycle commands through execution fencing

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

### Task 13: PR 12 — Make delegate, collect, and abort transactional

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

- Adds `AbortCommandService.abortDelegation(input: AbortCommandAuthorizationInput): Promise<DelegationWorkflowResult<AbortDelegationResult>>`; widens `collectDelegationOutcomes` and the lifecycle service's delegate operation to the same result discipline. CLI no longer holds `DelegationLock` or writes state/session records.

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

### Task 14: PR 13 — Perform the single production cutover and delete domain locks

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

### Task 15: PR 14 — Bundle WebContainer support, schemas, descriptive docs, and release evidence

**Files:**
- Apply/adapt: `4859a9c08` only to `site/playwright.config.ts`, `site/src/pages/dev/sqlite-substrate-probe.astro`, `site/tests/sqlite-substrate.spec.ts`
- Modify: `site/scripts/build-snapshot.ts`, `site/tests/runbook-runner.spec.ts`
- Modify: `docs/internal/architecture.md`, `CLAUDE.md`, `docs/reference/cli.md`, `docs/spec/cli-output.md`
- Modify: `packages/core/src/errors/{codes,factory}.ts`, `packages/core/src/output/zod-schemas.ts`, `packages/cli/src/{schemas/output-schemas,services/schema-service}.ts`
- Modify: `packages/core/stryker.config.mjs`, `packages/cli/stryker.config.mjs` only to register the final implementation/outcome targets
- Test: `packages/core/__tests__/output/schema.test.ts`, `packages/cli/__tests__/commands/{schema-validation,output-format}.test.ts`

**Interfaces:**
- Produces bundled sql.js JS/WASM and extends `CLISymbolicErrorCodeValues`, `RundownErrorCodeValues`, core Zod output unions, and CLI schema-service output with exactly `execution_in_progress`, `concurrent_modification`, `recovery_required`, `claim_superseded`, and `missing`.

- [ ] **RED — pin bundle and schema contracts.** In `site/tests/sqlite-substrate.spec.ts`, assert the dev probe executes sql.js; in `site/tests/runbook-runner.spec.ts`, assert the snapshot contains sql.js JS and WASM and run/pass/fail/goto work with no runtime install. In core `schema.test.ts` and CLI `schema-validation.test.ts`/`output-format.test.ts`, table-test the five symbolic codes in default JSON and text; assert false-live PID recovery includes process identity and effect-ambiguity warning; assert `runbook_started` has `runbookId`/source and no `statePath`.
- [ ] Run RED:

  ```bash
  corepack pnpm --filter site exec playwright test \
    tests/sqlite-substrate.spec.ts tests/runbook-runner.spec.ts
  corepack pnpm --filter @rundown-org/core exec jest __tests__/output/schema.test.ts
  corepack pnpm --filter @rundown-org/cli exec jest \
    __tests__/commands/schema-validation.test.ts __tests__/commands/output-format.test.ts
  ```

  Expected: FAIL because the snapshot lacks the complete sql.js bundle and the five result codes are not registered through every schema/rendering layer.
- [ ] **Implement bundle and contracts.** Cherry-pick `4859a9c08` without committing and verify `git diff HEAD --name-only` is exactly `site/playwright.config.ts`, `site/src/pages/sqlite-substrate-probe.astro`, and `site/tests/sqlite-substrate.spec.ts` — the probe is still at PR 1's path at this point, and the four-path check after `git mv` covers the `dev/` destination; then teach `build-snapshot.ts` to include sql.js JS/WASM. Register the five values in core error/output enums and Zod schemas, CLI output schemas, and schema service; map false-live recovery without executing the original effect. Add the final core/CLI source targets to package-relative Stryker configs without changing thresholds.
- [ ] **Document the merged implementation.** Rewrite `docs/internal/architecture.md` to describe one SQLite authority store, short state/effect transactions, leases, cross-run invalidation, execution phases, exact PID identity recovery, sql.js file-lock exception, and absence of an exactly-once-effect guarantee. Update `CLAUDE.md` to remove domain-lock guidance but retain RD-102 scoped non-masking release. Update CLI/output references for typed `RD-305`, the five results, storage-agnostic `runbook_started`, and the distinction between SQLite schema version and `RunbookState.schemaVersion === 1`.
- [ ] **GREEN.** Re-run the three RED commands. Expected: every test passes; the snapshot runs offline and all five codes validate/render. Run `corepack pnpm run check:docs:cli-help`; expected exit 0.
- [ ] Run final scoped campaigns:

  ```bash
  corepack pnpm --filter @rundown-org/core exec stryker run \
    --mutate src/runbook/storage/execution-lease.ts,src/runbook/storage/runbook-store.ts,src/runbook/effectful-mutation-executor.ts,src/runbook/execution-recovery-service.ts,src/runbook/session-service.ts,src/runbook/lifecycle-command-service.ts,src/runbook/collection-service.ts,src/runbook/inline-parent-advance.ts \
    --testFiles __tests__/runbook/storage/execution-lease.test.ts,__tests__/runbook/storage/runbook-store.test.ts,__tests__/runbook/actor-service-execution-fence.test.ts,__tests__/runbook/execution-recovery-service.test.ts,__tests__/runbook/session-service.test.ts,__tests__/runbook/lifecycle-command-service.test.ts,__tests__/runbook/collection-service.test.ts,__tests__/runbook/inline-parent-advance.test.ts

  corepack pnpm --filter @rundown-org/cli exec stryker run \
    --mutate src/commands/claim.ts,src/commands/pop.ts,src/commands/prune.ts,src/commands/stash.ts,src/helpers/runbook-pipeline.ts,src/helpers/active-runbook-cleanup.ts,src/helpers/transition-orchestrator.ts,src/services/execution.ts \
    --testFiles __tests__/commands/claim.test.ts,__tests__/commands/stash-pop.test.ts,__tests__/commands/prune.test.ts,__tests__/helpers/claim-and-launch.test.ts,__tests__/helpers/active-runbook-cleanup.test.ts,__tests__/helpers/transition-orchestrator.test.ts,__tests__/services/execution.test.ts

  corepack pnpm --filter @rundown-org/core exec stryker run \
    --mutate src/errors/codes.ts,src/errors/factory.ts,src/output/zod-schemas.ts \
    --testFiles '__tests__/output/schema.test.ts,__tests__/cli/output.test.ts'

  corepack pnpm --filter @rundown-org/cli exec stryker run \
    --mutate 'src/schemas/output-schemas.ts,src/services/schema-service.ts' \
    --testFiles __tests__/commands/schema-validation.test.ts,__tests__/commands/output-format.test.ts
  ```

  Expected: all eight implementation core files, all eight implementation CLI files, and every schema/error target are reported as instrumented; mutant counts are non-zero; any survivor/timeout is killed before merge or linked to an explicit accepted-risk issue.
- [ ] Run `corepack pnpm run verify`, then `corepack pnpm run test:all`, then `corepack pnpm run test:scenarios:all`, then the eight-hour `corepack pnpm run test:mutate`. Record commit SHA, exact pass/failure counts, duration, package mutation scores, timeouts, and survivors. No partial suite is release evidence.
- [ ] Run `corepack pnpm run verify`; expected exit 0. Commit `docs: describe SQLite concurrency and execution recovery`; open and merge PR 14. Update #608 with all merged PRs and evidence, then validate the release containing the change before considering salvage branch cleanup.

## Mandatory Review Checkpoints

1. After PR 4: verify machine-owned recovery, exact execution fencing, and no production lifecycle caller yet claims the seam is live.
2. After PR 8: verify adapter parity, deterministic contention, row validation, and recovery no-repeat semantics.
3. After PR 10: verify terminal evidence versus superseded authority, single-controller enforcement, typed session refusals, transaction-local parent guarding, and atomic initial claim/link.
4. After PR 11: demonstrate a real effect under two processes and all three crash boundaries; verify `RECOVERY_TAG` is reached through the machine.
5. After PR 12: inspect delegate/collect/abort transaction boundaries, multi-run acquisition, linkage-cycle return shape, and absence of frontend shadow writes.
6. After PR 13: prove one authority store, typed `RD-305`, no mixed mode, no domain locks, and retained sql.js/artifact file-lock safety.
7. After PR 14: require WebContainer parity, schema/docs parity, scenarios, scoped mutation, full mutation, and ordinary release gates.

## Self-Review Checklist

- [ ] Every salvage implementation/test commit is assigned once or explicitly excluded.
- [ ] The production work omitted by the salvage tip is covered by PRs 11–14.
- [ ] `a823892fe` is a standalone PR after hardening and before atomic initial link.
- [ ] Every behavior PR uses the canonical direct Stryker command with package-relative scope and a non-zero instrumentation requirement.
- [ ] SQLite persistence staging is not called production cutover.
- [ ] Terminal evidence and superseded live authority are distinct tested outcomes.
- [ ] State-machine/core ownership is explicit for lifecycle, recovery, delegate, collect, and abort.
- [ ] Legacy state is refused, never migrated or silently adapted.
- [ ] No dependent PR is open before its predecessor merges.
- [ ] Every implementation and verification instruction names its owned commit/path set, command, and expected result.
