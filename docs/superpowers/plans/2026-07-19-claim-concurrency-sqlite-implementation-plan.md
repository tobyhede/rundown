# Claim Concurrency SQLite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Rundown's JSON run/session persistence and four ranked domain locks with one transactional SQLite store, generation/state CAS, and a fail-closed per-run execution protocol that never automatically repeats an ambiguous shell effect.

**Architecture:** Build the SQL substrate and both drivers as unused, independently tested infrastructure first. Then add structural version/lease guards, cross-run parent invalidation, machine-owned recovery, and one shared core effectful-mutation executor before migrating any production mutator. Migrate every state-only and effectful path on one stacked integration branch and expose the new store only at a single release cutover; no released commit may mix JSON and SQLite authority.

**Tech Stack:** TypeScript 6, XState 5, Node `node:sqlite`, `sql.js` WASM, Jest 30, fast-check, Playwright/WebContainer, pnpm workspaces.

## Global Constraints

- The design specification is `docs/superpowers/specs/2026-07-18-claim-concurrency-sqlite-design.md`; it is authoritative when this plan and implementation differ.
- Persisted run state is never migrated. Existing `.rundown/runs/*.json` or `.rundown/session.json` causes a typed incompatible-state refusal at cutover; there is no import, dual-read, fallback parser, or compatibility shim.
- Runbook lifecycle and recovery behavior lives in the XState machine. Storage and CLI code may detect an interrupted execution, but must send the typed `EXECUTION_OUTCOME_UNKNOWN` event rather than synthesizing `recovery_required` state.
- The CLI, MCP server, and Claude Code plugin remain thin frontends. They invoke core mutation APIs and render typed outcomes; they do not reproduce claim, lease, retry, or recovery rules.
- SQLite write transactions are short. No process spawn, command, helper call, delegation preparation, filesystem discovery, or actor-effect wait occurs inside `BEGIN IMMEDIATE`.
- A random execution token identifies one acquisition. Monotonic `exec_epoch` orders attempts. Neither guarantees exactly-once external effects.
- `runs.claim_generation` is authoritative. Claim rows carry immutable issuance generation only; delegated acquire/commit also re-check parent lifecycle and linkage.
- Claim-generation bump writers and state-version writers structurally respect active execution ownership. Parent terminalization updates linked child claim/linkage rows, whose trigger owns the child generation bump.
- A live or conservatively unknown PID is never age-reclaimed. `ESRCH` is dead; `EPERM` and unknown results are treated as alive.
- `effect_started` interrupted attempts become machine-owned `recovery_required`; they are never automatically re-executed. Only a `claimed` pre-effect attempt may be reclaimed and retried automatically.
- `recoveryRequired` is a non-final top-level machine state with persisted lifecycle still `running`; child-to-parent projection is open with reason `recovery_required`.
- All affected runs in a multi-run operation are acquired in one all-or-none transaction. Exact row counts are mandatory; partial acquisition never commits.
- Project/session stack and stash read-modify-write operations remain inside one transaction. Any future cross-transaction session RMW requires a `session_version` CAS.
- Database lease conflicts refuse immediately. Any optional wait retries the whole short transaction outside SQLite with a finite budget; no transaction or trigger waits.
- The native and WASM adapters execute the same schema and SQL. `sql.js` additionally holds the retained file lock only across each short `load → transaction → export → file fsync → rename → directory fsync` cycle and releases it during effects.
- Runtime selection is positive: `sql.js` only for a positively identified WebContainer. Native SQLite unavailability on a normal multi-process host is a startup error.
- All exported symbols require TSDoc. Use `isError()`, `isNodeError()`, and `getErrorMessage()` rather than direct `Error.isError()`.
- Every behavior-bearing task follows red-green-refactor and ends with focused tests plus `pnpm --filter @rundown-org/core run check:types` where core types changed.
- Only Task 1 is independently mergeable to the release branch. Tasks 2–9 form a stacked integration sequence and are released together at Task 9's cutover.

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/core/src/runbook/storage/sql-driver.ts` | Minimal common statement/transaction interface shared by native SQLite and sql.js. |
| `packages/core/src/runbook/storage/schema.ts` | Schema version, DDL, structural lease/version triggers, and schema validation. |
| `packages/core/src/runbook/storage/native-sqlite-driver.ts` | `node:sqlite` adapter, WAL, busy timeout, and `BEGIN IMMEDIATE`. |
| `packages/core/src/runbook/storage/sqljs-driver.ts` | sql.js load/export persistence under the retained file lock. |
| `packages/core/src/runbook/storage/driver-factory.ts` | Positive capability selection; no fallback downgrade. |
| `packages/core/src/runbook/storage/runbook-store.ts` | Typed run/session/claim/completion repository over SQL. |
| `packages/core/src/runbook/storage/execution-lease.ts` | Token/epoch acquisition, exact-tuple liveness recovery, phases, and multi-run acquisition. |
| `packages/core/src/runbook/storage/mutation-result.ts` | Exhaustive mutation outcome and captured-authority types. |
| `packages/core/src/runbook/effectful-mutation-executor.ts` | Sole core owner of capture/acquire/effect-boundary/compute/commit orchestration. |
| `packages/core/src/runbook/state.ts` | Existing public manager becomes a thin facade over `RunbookStore`; JSON IO and run-state locking are removed at cutover. |
| `packages/core/src/runbook/session-service.ts` | Session/claim APIs route to state-only store transactions; lock-scoped twins disappear. |
| `packages/core/src/runbook/compiler.ts` | Adds `EXECUTION_OUTCOME_UNKNOWN` and transitionable top-level `recoveryRequired` machine state without widening persisted lifecycle. |
| `packages/core/src/runbook/actor-service.ts` | Separates actor computation from token/epoch-guarded persistence. |
| `packages/core/src/runbook/lifecycle-command-service.ts` | Maps command policy/results onto the shared core effectful-mutation executor. |
| `packages/core/src/runbook/completion-service.ts` | Transactional completion recording without Completion/Delegation lock twins. |
| `packages/core/src/runbook/collection-service.ts` | One target-run transaction for completion drain/advance, atomic terminal cleanup, and separate idempotent upward reporting. |
| `packages/core/src/runbook/execution-recovery-service.ts` | Resumes `recovery_pending`, sends the pure machine event, and commits `recovery_required`. |
| `packages/core/src/runbook/index.ts`, `packages/core/src/index.ts` | Export only public storage/recovery outcome types needed by frontends. |
| `packages/cli/src/helpers/lifecycle-seam-factory.ts` | Constructs the single core service graph using one store/driver instance. |
| `packages/cli/src/commands/*.ts`, `packages/cli/src/helpers/*.ts` | Remove direct locks/mutations and render typed core outcomes. |
| `site/scripts/build-snapshot.ts`, `site/tests/runbook-runner.spec.ts` | Bundle sql.js and verify the WebContainer adapter. |

---

### Task 1: Prove and land the storage substrate

**Release gate:** Independently mergeable. It adds unused infrastructure and probes; production persistence remains JSON.

**Files:**
- Create: `packages/core/src/runbook/storage/sql-driver.ts`
- Create: `packages/core/src/runbook/storage/schema.ts`
- Create: `packages/core/src/runbook/storage/native-sqlite-driver.ts`
- Create: `packages/core/src/runbook/storage/sqljs-driver.ts`
- Create: `packages/core/src/runbook/storage/driver-factory.ts`
- Create: `packages/core/__tests__/runbook/storage/schema.test.ts`
- Create: `packages/core/__tests__/runbook/storage/driver-contract.test.ts`
- Create: `site/tests/sqlite-substrate.spec.ts`
- Modify: `packages/core/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

```typescript
export interface SqlRunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

export interface SqlStatement {
  run(params?: Readonly<Record<string, unknown>>): SqlRunResult;
  get<T>(params?: Readonly<Record<string, unknown>>): T | undefined;
  all<T>(params?: Readonly<Record<string, unknown>>): readonly T[];
}

export interface SqlTransaction {
  prepare(sql: string): SqlStatement;
  exec(sql: string): void;
}

export interface SqlDriver extends AsyncDisposable {
  readonly kind: 'native' | 'sqljs';
  readonly capabilities: { readonly multiProcess: boolean };
  read<T>(work: (tx: SqlTransaction) => T): Promise<T>;
  immediate<T>(work: (tx: SqlTransaction) => T): Promise<T>;
}
```

- [ ] Write failing contract tests proving commit, rollback, `SQLITE_BUSY` retry limits, named parameters, `RETURNING`, and schema-version rejection on both adapters.
- [ ] Run `pnpm --filter @rundown-org/core exec jest __tests__/runbook/storage/driver-contract.test.ts`; expect failure because the drivers do not exist.
- [ ] Implement the interface and schema version `1`. The schema must include `runs`, `claims`, `session_stack`, `stash_slot`, `resolved_completions`, and `execution_attempts`; `runs` carries `state_version`, authoritative `claim_generation`, active execution identity, and authoritative `state_json` with coordinated fields excluded. `execution_attempts` is keyed by `(run_id, exec_epoch)` and explicitly carries `exec_token` plus the single authoritative phase column; phase is not duplicated on `runs`.
- [ ] Implement native pragmas: `journal_mode=WAL`, `busy_timeout`, `foreign_keys=ON`, and short `BEGIN IMMEDIATE` transactions with explicit rollback on every error.
- [ ] Implement sql.js durability under `file-lock.ts`: acquire an in-process async mutex and the non-reentrant file lock for one short transaction, load, execute, export to a unique mode-`0600` same-directory temp file, fsync the temp, rename, fsync the parent directory where supported, then report success. Release both locks before caller computation and reclaim only identity-proven orphan temp files.
- [ ] Implement positive adapter selection with one named, tested StackBlitz/WebContainer marker. The only sql.js branch is that positive detector; native initialization failure elsewhere throws a typed startup error.
- [ ] Add a Playwright substrate probe that verifies WebAssembly/sql.js persistence across sequential WebContainer processes and confirms the native module is not selected.
- [ ] Run the two Jest files, `pnpm --filter @rundown-org/core run check:types`, and `pnpm --filter site exec playwright test tests/sqlite-substrate.spec.ts`.
- [ ] Commit: `feat(core): add SQLite driver substrate and WebContainer probe`.

### Task 2: Implement the typed SQL repository without production wiring

**Release gate:** Stacked integration branch begins. Do not release until Task 9.

**Files:**
- Create: `packages/core/src/runbook/storage/runbook-store.ts`
- Create: `packages/core/src/runbook/storage/mutation-result.ts`
- Create: `packages/core/__tests__/runbook/storage/runbook-store.test.ts`
- Create: `packages/core/__tests__/runbook/storage/runbook-store.properties.test.ts`
- Modify: `packages/core/src/runbook/types.ts`
- Modify: `packages/core/src/runbook/claim-id.ts`

**Interfaces:**

```typescript
export interface CapturedAuthority {
  readonly runId: RunId;
  readonly claimKey: ClaimLookupKey;
  readonly claimGeneration: ClaimGeneration;
  readonly stateVersion: StateVersion;
  readonly parent?: {
    readonly runId: RunId;
    readonly linkageVersion: number;
  };
}

export type GuardedMutationResult<T> =
  | { readonly kind: 'committed'; readonly value: T }
  | { readonly kind: 'claim_superseded' }
  | { readonly kind: 'concurrent_modification' }
  | { readonly kind: 'execution_in_progress'; readonly runId: RunId }
  | { readonly kind: 'recovery_required'; readonly runId: RunId; readonly epoch: ExecutionEpoch }
  | { readonly kind: 'missing' };
```

- [ ] Write failing round-trip tests for every `RunbookState` field, claims/tombstones, stack ordering, stash, completions, create/load/list/delete, and incompatible DB schema rejection.
- [ ] Write properties showing that claim-table and stash changes structurally bump the controlled run's `claim_generation`, parent-terminal linkage updates trigger child-generation bumps exactly through that mechanism, and ordinary state writes only bump `state_version`.
- [ ] Implement JSON codecs for nested state values with Zod validation at the repository edge. Do not duplicate claims, resolved completions, stack, or stash inside `state_json`; those tables are their sole authority.
- [ ] Measure representative and worst-fixture snapshot sizes and sql.js export time. Keep snapshots inline unless the measured WebContainer write cost breaches the existing interaction budget; if it does, add an immutable content-addressed blob writer whose DB reference commits after the blob fsync and whose unreferenced blobs are pruned explicitly. Never create a mutable snapshot sidecar.
- [ ] Implement branded `ClaimGeneration`, `StateVersion`, and `ExecutionEpoch`; `captureAuthority`; state-only transactions; and one total `classifyCommitRow`. Non-delegated claims accept NULL parent columns; delegated claims require matching active parent/linkage. A classified-success followed by any zero-row authoritative UPDATE rolls back as an invariant error. Bearer secrets remain hashed; errors and diagnostics carry only `ClaimLookupKey`.
- [ ] Make `transaction()` the sole store write path. Add structural tests proving claim/stash triggers immediately abort under any active owner and every unowned run-state update requires `exec_token IS NULL`. Owner commit clears its exact active reference before related trigger-guarded writes in the same transaction.
- [ ] Keep stack/stash resolve/read/write inside one transaction and test concurrent operations for lost updates. Do not add `session_version` unless a workflow is deliberately split across transactions.
- [ ] Run focused unit/property tests and core type checking.
- [ ] Commit: `feat(core): add transactional SQLite runbook repository`.

### Task 3: Implement execution ownership and crash-boundary tests

**Files:**
- Create: `packages/core/src/runbook/storage/execution-lease.ts`
- Create: `packages/core/__tests__/runbook/storage/execution-lease.test.ts`
- Create: `packages/core/__tests__/runbook/storage/execution-lease.process.test.ts`
- Create: `packages/core/__tests__/runbook/storage/execution-lease.properties.test.ts`

**Interfaces:**

```typescript
export interface ExecutionAttempt {
  readonly runId: RunId;
  readonly token: string;
  readonly epoch: ExecutionEpoch;
  readonly ownerPid: number;
  readonly phase: 'claimed' | 'effect_started' | 'recovery_pending';
}

export interface ExecutionLeaseService {
  acquire(captured: CapturedAuthority, ownerPid: number): Promise<GuardedMutationResult<ExecutionAttempt>>;
  markEffectStarted(attempt: ExecutionAttempt): Promise<GuardedMutationResult<ExecutionAttempt>>;
  recoverDeadOwner(runId: RunId): Promise<'reclaimed_pre_effect' | 'recovery_pending' | 'alive' | 'missing'>;
  acquireAll(captured: readonly CapturedAuthority[], ownerPid: number): Promise<GuardedMutationResult<readonly ExecutionAttempt[]>>;
}
```

- [ ] Write red tests for one-winner contention, token/epoch ABA, attempt-row token matching, live-PID non-reclamation regardless of age, `EPERM` fail-closed behavior, pre-effect reclamation, post-effect `recovery_pending`, and `{A,B}` versus `{B,C}` all-or-none acquisition.
- [ ] Add delegated acquire/commit races: parent terminalization while the child owns execution refuses immediately without a generation bump; after child commit, the parent transaction updates linkage and triggers the child bump; parent-first makes child acquisition fail before effects.
- [ ] Add real child-process fault injection at every boundary: before acquire commit, after `claimed`, after `effect_started`, while a child survives its coordinator, after a fake external write, and after atomic commit/clear.
- [ ] Implement liveness outside SQLite followed by exact `(pid, processStartIdentity?, token, epoch, phase)` tuple CAS. Never place PID liveness in a SQL predicate.
- [ ] Require exact changed-row counts for every phase transition, release, and multi-run acquisition. A disposer may clear only its exact `claimed` tuple; it must never clear `effect_started`.
- [ ] Run the focused Jest files repeatedly with `--runInBand` for process tests and the property suite with its configured seed reporting.
- [ ] Commit: `feat(core): add PID-aware execution ownership protocol`.

### Task 4: Add machine-owned interrupted-execution recovery

**Files:**
- Modify: `packages/core/src/runbook/compiler.ts`
- Modify: `packages/core/src/runbook/types.ts`
- Modify: `packages/core/src/schemas.ts`
- Create: `packages/core/src/runbook/execution-recovery-service.ts`
- Create: `packages/core/__tests__/runbook/execution-recovery-service.test.ts`
- Modify: `packages/core/__tests__/runbook/compiler-machine-structural-snapshot.test.ts`
- Modify: `packages/core/__tests__/runbook/state-schema-version.test.ts`

**Interfaces:**

```typescript
export type ExecutionRecoveryEvent = {
  readonly type: 'EXECUTION_OUTCOME_UNKNOWN';
  readonly epoch: ExecutionEpoch;
  readonly reason: string;
};
// Add ExecutionRecoveryEvent as a member of the existing RunbookEvent union.
```

- [ ] Write a red structural test requiring a top-level non-final `recoveryRequired` state and a transition from every effect-capable running state on `EXECUTION_OUTCOME_UNKNOWN`.
- [ ] Write red service tests proving `recovery_pending` resumes after a second recovery-worker crash and never invokes command/delegation/helper actors.
- [ ] Add machine context fields for the interrupted epoch/reason and the event. Entry persists the recovery snapshot while lifecycle remains `running`, without frontmatter output capture or terminal result synthesis; typed reconcile/retry/stop events can leave the state.
- [ ] Implement `ExecutionRecoveryService.recover(runId)` to load the snapshot, send only `EXECUTION_OUTCOME_UNKNOWN`, and commit the new snapshot plus attempt record under exact token/epoch/phase CAS.
- [ ] Project a recovery-required child upward as `{ kind: 'not_terminal', reason: 'recovery_required' }`, update status/collection JSON schemas exhaustively, and do not widen `Lifecycle` or map recovery to `stopped`/`failed`.
- [ ] Run compiler, recovery, schema, persisted-context-hygiene, and type tests.
- [ ] Commit: `feat(core): model uncertain execution recovery in XState`.

### Task 5: Refactor actor persistence into a guarded compute/commit seam

**Files:**
- Create: `packages/core/src/runbook/effectful-mutation-executor.ts`
- Modify: `packages/core/src/runbook/actor-service.ts`
- Create: `packages/core/__tests__/runbook/actor-service-execution-fence.test.ts`
- Modify: `packages/core/__tests__/runbook/actor-service-pending-effects.test.ts`
- Modify: `packages/core/__tests__/runbook/subprocess-mutation-boundary.test.ts`

**Interfaces:**

```typescript
export interface PreparedActorMutation {
  readonly previousState: RunbookState;
  readonly nextState: RunbookState;
  readonly snapshot: unknown;
  readonly effects: readonly ExecutionObservationEffect[];
}

export interface ActorMutationCommitter {
  commit(attempt: ExecutionAttempt, prepared: PreparedActorMutation): Promise<GuardedMutationResult<ActorSyncResult>>;
}

export interface EffectfulMutationExecutor {
  run<TPrepared, TResult>(input: {
    readonly captured: CapturedAuthority;
    readonly compute: () => Promise<TPrepared>;
    readonly commit: (attempt: ExecutionAttempt, prepared: TPrepared) => Promise<TResult>;
  }): Promise<GuardedMutationResult<TResult>>;
}
```

- [ ] Write a red test showing the current `sendAndSync()` can execute a fake effect before a stale persistence write; pin that the replacement refuses stale commit and records recovery rather than retrying the effect.
- [ ] Extract actor creation/send/effect waiting into a computation method that returns `PreparedActorMutation` without calling `RunbookStateManager.update`.
- [ ] Implement `EffectfulMutationExecutor` as the sole core owner of capture/acquire/mark-effect/compute/commit/recovery choreography. Tokens never cross into CLI, MCP, or plugin code, and command services do not hand-roll the five steps.
- [ ] Route successful persistence through `ActorMutationCommitter.commit`, which updates run state, consumes any resolved completion, marks the attempt committed, and clears ownership in one transaction.
- [ ] Replace the existing best-effort `lifecycle: 'stopped'` write after effect-wait failure with the typed recovery path when the effect boundary was crossed.
- [ ] Keep `initializeState` on a dedicated no-external-effect transactional path; do not acquire an execution attempt merely to hydrate a new actor.
- [ ] Run all actor-service, command-exec-actor, subprocess-boundary, and type tests.
- [ ] Commit: `refactor(core): fence actor computation and persistence`.

### Task 6: Migrate state-only state and claim operations

**Files:**
- Modify: `packages/core/src/runbook/state.ts`
- Modify: `packages/core/src/runbook/session-service.ts`
- Modify: `packages/core/src/runbook/command-target-resolver.ts`
- Modify: `packages/core/__tests__/runbook/state.test.ts`
- Modify: `packages/core/__tests__/runbook/session-service.test.ts`
- Modify: `packages/core/__tests__/runbook/command-target-resolver.test.ts`

- [ ] Write race tests for mint, rotate, claim, stash, pop/unstash, release, `releaseRunbooks`, and `pruneClaimsForChildren`. Before execution acquisition they may commit and make capture stale; after acquisition they return `execution_in_progress`; against recovery state they return `recovery_required`.
- [ ] Turn `RunbookStateManager` into the SQL repository facade while retaining its public read API. Remove JSON save/load/update internals only when all tests in this task use a database fixture.
- [ ] Replace `SessionService.withLock` mutations with repository state-only transactions. Triggers refuse immediately under execution ownership; any optional wait is a finite caller-level retry outside SQLite. Delete private lock-held twins rather than recreating `*Unlocked` methods over SQL.
- [ ] Make parent stop/complete/prune update all linked child claim/linkage rows in the terminal transaction. The structural trigger—not direct service code—owns child `claim_generation` bumps.
- [ ] Preserve terminal claim tombstones and exact existing refusal taxonomy. Add exhaustive handling for `execution_in_progress` and `recovery_required` without leaking bearer secrets.
- [ ] Run state, session, targeting, claim property tests, and core types.
- [ ] Commit: `refactor(core): move metadata mutations onto SQLite transactions`.

### Task 7: Migrate simple effectful commands as the vertical slice

**Files:**
- Modify: `packages/core/src/runbook/lifecycle-command-service.ts`
- Modify: `packages/core/src/runbook/execution-lifecycle-service.ts`
- Modify: `packages/cli/src/helpers/transitions.ts`
- Modify: `packages/cli/src/helpers/goto-workflow.ts`
- Modify: `packages/cli/src/helpers/terminal-command.ts`
- Modify: `packages/cli/__tests__/commands/pass.test.ts`
- Modify: `packages/cli/__tests__/commands/fail.test.ts`
- Modify: `packages/cli/__tests__/commands/goto.test.ts`
- Modify: `packages/cli/__tests__/commands/complete.test.ts`
- Modify: `packages/cli/__tests__/commands/stop.test.ts`

- [ ] Start with one end-to-end `pass` fixture whose transition enters a shell-command step. Race a second process and prove one effect, one committed state transition, and an `execution_in_progress` loser.
- [ ] Add kill-after-effect-before-commit coverage and assert default JSON output is `recovery_required`; assert a repeated bare/claim command does not run the effect again.
- [ ] Route capture, acquire, effect boundary, compute, and guarded commit through `EffectfulMutationExecutor`. Frontends call one typed core API and only render its discriminated result.
- [ ] Convert fail, goto, complete, and stop through the same core primitive. Keep command-specific policy/result mapping typed; do not branch on raw action strings in the frontend.
- [ ] Cover JSON and text rendering separately, including immediate `execution_in_progress` and `recovery_required` with redacted claim identifiers. If an explicit wait option is included, test its finite budget, backoff, cancellation, and progress diagnostics separately; never wait inside SQLite.
- [ ] Run focused core and CLI command suites plus core/CLI type checks.
- [ ] Commit: `feat(core): route lifecycle commands through execution fencing`.

### Task 8: Migrate multi-record workflows and remove lock-domain twins

**Files:**
- Modify: `packages/core/src/runbook/completion-service.ts`
- Modify: `packages/core/src/runbook/collection-service.ts`
- Modify: `packages/core/src/runbook/lifecycle-command-service.ts`
- Modify: `packages/core/src/runbook/abort-command-service.ts`
- Modify: `packages/cli/src/commands/delegate.ts`
- Modify: `packages/cli/src/commands/collect.ts`
- Modify: `packages/cli/src/commands/abort.ts`
- Modify: `packages/cli/src/services/execution.ts`
- Modify: `packages/cli/src/helpers/runbook-pipeline.ts`
- Modify: `packages/core/__tests__/runbook/completion-service.test.ts`
- Modify: `packages/core/__tests__/runbook/collection-service.test.ts`
- Modify: `packages/core/__tests__/runbook/lifecycle-command-service.test.ts`
- Modify: `packages/cli/__tests__/commands/delegate.test.ts`
- Modify: `packages/cli/__tests__/commands/collect.test.ts`
- Modify: `packages/cli/__tests__/commands/abort.test.ts`

- [ ] Write failure-injection tests proving delegate retry's supersede/child release/issued-substep persistence is all-or-none and collect's target-run multi-completion drain/advance commits once.
- [ ] Write overlapping multi-run races for operations that genuinely own multiple affected runs and assert no partial lease ownership or partial domain writes remain after refusal/crash. Do not lease completed child runs merely because collect consumes reports already stored on the target.
- [ ] Move expensive `createDelegation`, child resolution, variable preparation, and helper/filesystem work outside transactions; pass only validated results into the final SQL commit.
- [ ] Replace completion and collection lock-held twins with transaction-local repository functions callable only from the owning aggregate operation. If collect terminalizes its target, include session release and linked-child invalidation in that transaction; report the committed outcome to its own parent in a separate idempotent parent transaction.
- [ ] Route abort through core mutation APIs; remove CLI ownership of DelegationLock and direct state mutation.
- [ ] Run completion/collection/delegation properties, focused CLI integration tests, and type checks.
- [ ] Commit: `refactor(core): make delegation and collection workflows transactional`.

### Task 9: Perform the single production cutover and delete old locks

**Files:**
- Delete: `packages/core/src/runbook/run-state-lock.ts`
- Delete: `packages/core/src/runbook/session-lock.ts`
- Delete: `packages/core/src/runbook/completion-lock.ts`
- Delete: `packages/core/src/runbook/delegation-lock.ts`
- Delete: corresponding `packages/core/__tests__/runbook/*-lock.test.ts`
- Modify: `packages/core/src/runbook/file-lock.ts`
- Modify: `packages/core/src/paths.ts`
- Modify: `packages/core/src/runbook/index.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/cli/src/helpers/lifecycle-seam-factory.ts`
- Modify: every constructor site returned by `rg -n "new RunbookStateManager|new SessionService|new RunbookActorService" packages`
- Modify: `packages/core/__tests__/runbook/state-schema-version.test.ts`
- Modify: CLI/MCP/plugin fixtures that write JSON state directly
- Test: relevant command-contract suites under `packages/mcp/__tests__/` and `packages/claude-code-plugin/__tests__/`

- [ ] Add a cutover test that starts with legacy JSON state and no DB; assert a typed refusal instructing finish/stop/prune/restart and assert no JSON import or DB creation occurs.
- [ ] Add a clean-install test that creates only `.rundown/rundown.db`; assert no `session.json` or `runs/*.json` authority files are written.
- [ ] Wire every frontend/service graph to one capability-selected driver/store. Remove constructor paths that silently instantiate independent managers for one command.
- [ ] Delete all four domain locks and every lock-only twin. Retain `file-lock.ts` for sql.js persistence and the existing artifact-manifest synchronization; preserve the `await using` non-masking release policy for those remaining consumers.
- [ ] Search for stale imports, `.rundown/session.json`, `.rundown/runs/*.json`, old lock-rank comments, and direct JSON test fixtures; update user-facing paths to the DB/recovery commands where applicable.
- [ ] Run `pnpm test`, `pnpm run test:integration`, `pnpm run test:property`, `pnpm run check:types`, and `pnpm run lint`.
- [ ] Commit: `feat: cut runbook state authority over to SQLite`.

### Task 10: Bundle WebContainer support, document current architecture, and verify release

**Files:**
- Modify: `site/scripts/build-snapshot.ts`
- Modify: `site/tests/runbook-runner.spec.ts`
- Modify: `docs/internal/architecture.md`
- Modify: `CLAUDE.md`
- Modify: `docs/reference/cli.md`
- Modify: `docs/spec/cli-output.md`
- Modify: `packages/core/src/errors/codes.ts`
- Modify: `packages/core/src/errors/factory.ts`
- Modify: `packages/cli/src/schemas/output-schemas.ts`
- Modify: `packages/cli/src/services/schema-service.ts`

- [ ] Add WebContainer smoke coverage for run/pass/fail/goto on sql.js and verify the bundled snapshot contains sql.js JavaScript and WASM without runtime installation.
- [ ] Add CLI contract tests for the recovery UX selected during implementation. Reconcile/retry/stop must be typed machine transitions; no generic command automatically crosses the gate. A false-live PID force-reconcile path displays recorded process identity and the effect-ambiguity warning and never silently executes the original effect.
- [ ] Rewrite `docs/internal/architecture.md` descriptively: one SQLite authority store, short state-only/effectful boundaries, structural lease respect, cross-run parent invalidation, execution phases, exact-tuple PID recovery, sql.js file-lock exception, and no exactly-once-effect claim.
- [ ] Rewrite root `CLAUDE.md` concurrent-write guidance: remove deleted domain-lock examples, retain artifact-manifest/sql.js file-lock guidance and RD-102 non-masking cleanup, and point run/session state writers to the transactional store.
- [ ] Update reference JSON schemas and human rendering for the two new refusal/recovery outcomes.
- [ ] Run the checked-in WebContainer probe and homepage Playwright suite.
- [ ] Run scoped mutation testing over `storage/execution-lease.ts`, the guarded actor committer, and outcome switches; verify the log reports non-zero instrumented files/mutants.
- [ ] Run `pnpm run verify`, then `pnpm run test:all`. Record exact pass/failure counts in the PR description; do not claim release readiness from a partial suite.
- [ ] Commit: `docs: describe SQLite concurrency and execution recovery`.

## Review and Release Checkpoints

1. **Substrate review after Task 1:** approve driver parity, sql.js durability, dependency/bundle cost, and positive environment selection before domain work begins.
2. **Protocol review after Task 4:** adversarially review crash histories, machine ownership of recovery, PID/process-tree limitations, token versus epoch language, and automatic-retry prohibitions.
3. **Vertical-slice review after Task 7:** demonstrate a real effect under two processes and a crash after effect/before commit. Stop if either duplicate execution or silent state loss is observed.
4. **Atomic-workflow review after Task 8:** inspect delegate/collect/abort transaction boundaries and all-or-none multi-run acquisition. No frontend may retain a shadow mutation path.
5. **Cutover review after Task 9:** use repository-wide searches to prove there is one authority store and no released mixed mode.
6. **Release review after Task 10:** full verification, WebContainer parity, docs, CLI schemas, mutation signal, and explicit recovery UX.

## Sequencing Summary

```text
mergeable substrate
    ↓
typed SQL repository
    ↓
execution lease + crash tests
    ↓
XState recovery
    ↓
shared effectful mutation executor + guarded actor commit
    ↓
state-only transactions
    ↓
simple effectful vertical slice
    ↓
delegate / collect / abort multi-record workflows
    ↓
single production cutover and old-lock deletion
    ↓
WebContainer, documentation, and full release verification
```

The ordering is safety-driven: storage alone cannot ship the new mutation paths; the lease cannot ship without recovery; metadata invalidators cannot ship without respecting the lease; and the old locks cannot be removed until every consumer uses the transactional replacement.
