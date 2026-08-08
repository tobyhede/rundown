# 608 PR 13 planning audit — current status and cutover boundaries

**Audited:** 2026-08-02

**Tracks:** [#648](https://github.com/tobyhede/rundown/issues/648)
**Amends:**
[2026-07-23-608-pr13-single-store-cutover.md](2026-07-23-608-pr13-single-store-cutover.md)
and
[2026-07-27-608-pr09-pr14-correction-ledger.md](2026-07-27-608-pr09-pr14-correction-ledger.md)

This is a planning audit, not a PR 13 implementation branch. The original dated
plans remain immutable. Where current code has drifted, this document records the
required adaptation for the eventual PR 13 addendum.

## Verified status

- `origin/main` is `ea36ad426`, the merge of PR #671, the PR 11 mutation-gap
  follow-up.
- PRs 1 through 11 of the controlled rebuild are merged. PR 10 is #668; PR 11
  is #669 plus its merged test-only follow-up #671.
- The current PR 12 checkpoint is local commit `c4b034131` on
  `issue-608/pr12-transactional-delegation-workflows`.
- `c4b034131` and current `origin/main` both descend from `44a62d1ac`; PR 12 is
  one commit ahead of that base and four commits behind current main. The
  overlapping paths are:
  - `packages/cli/__tests__/services/execution-loop.test.ts`;
  - `packages/core/__tests__/runbook/completion-service.test.ts`;
  - `packages/core/__tests__/runbook/effectful-actor-mutation-runner.test.ts`;
  - `packages/core/__tests__/runbook/session-service.test.ts`.
- PR 12 has not been pushed or merged. PR 13 must not branch until PR 12 is
  rebased onto current main, completed, validated, reviewed, and merged.

## Blocking PR 12 work

PR 13 cannot delete the four core domain locks from the current PR 12
checkpoint. Two are still live, and the collection workflow still has the
multi-write failure shape PR 12 owns.

### Collection is not transactional yet

The current collection path still persists a sequence of independently durable
operations:

1. drain each resolved completion;
2. release a terminal run from the session;
3. report terminal completion upward;
4. project a retry frontier;
5. persist `DELEGATE_FRONTIER_CONSUMED`;
6. perform additional inline-parent drain/run/release/report work in the CLI.

PR 12 must replace this prefix-visible sequence with one core-owned aggregate
commit, buffer observations until commit, and settle committed-before-output
retry-frontier replay without persisting a bearer or claim secret.

### Locks still in production

- `CompletionLock` remains active in manual completion recording and completion
  draining.
- `DelegationLock` remains active in child completion reporting and three CLI
  flows: initial inline parent linking, `claimAndLaunch`, and inline child
  launch.
- The PR 12 acceptance criterion that the CLI holds no `DelegationLock` is
  therefore not met at `c4b034131`.

Finish those paths in PR 12. Moving them into PR 13 would merge behavior and
storage cutover into one review and would violate the controlled-rebuild split.

## Current architecture that PR 13 should preserve

The repository already has a sole production driver/store opener:
`packages/core/src/runbook/storage/store-registry.ts`.

- `RunbookStateManager` lazily obtains the shared project store through
  `getRunbookStore`.
- `EffectfulActorMutationRunner` obtains the paired driver/store through
  `openRunbookStore`.
- No production code outside the registry directly calls `openRunbookDriver`
  or constructs `RunbookStore`.
- The registry shares one in-flight or opened store per canonical project key.

PR 13 must not add a parallel `openAuthoritativeRunbookStore` function and must
not mechanically inject stores through every manager constructor. The cutover
belongs in `openRunbookStore`, before its first directory creation or driver
open. Constructor inventories remain verification evidence, not a mandate for
unnecessary dependency churn.

## Planned PR 13 scope after PR 12 merges

### 1. Refuse obsolete JSON authority before database creation

Add legacy detection to the registry's sole open path.

- Detect `.rundown/session.json` and direct legacy
  `.rundown/runs/*.json` state files without parsing or adapting them.
- Do not treat `.rundown/runs/<run-id>/outputs/**` as legacy run state; captured
  output directories remain legitimate filesystem artifacts.
- Return canonical paths in `details.context.legacyPaths`.
- Return paths in deterministic sorted order, treat missing legacy directories
  as clean, and propagate permission or I/O failures.
- Throw `Errors.legacyRunbookState(legacyPaths)`, using public code
  `INCOMPATIBLE_STATE_SCHEMA` and `RD-305`, while leaving
  `Errors.incompatibleStateSchema(foundVersion, expectedVersion)` unchanged.
- Run detection before `mkdir`, `openRunbookDriver`, schema installation, or
  any database/sidecar creation.
- Refusal creates no `rundown.db`, `-wal`, or `-shm` file and offers no import,
  migration, finish-old-state, fallback, hydration, or dual-read path.
- Preserve `RunbookState.schemaVersion === 1`; the SQLite schema version is a
  separate concern. The currently audited SQLite schema version is `2`; PR 13
  adds no DDL and does not change it.
- Preserve the registry's existing failed-open eviction so a refused open is not
  cached permanently after the legacy files are removed.

RED coverage belongs in `store-registry.test.ts`, a focused legacy-refusal test,
the cross-process initialization test, and CLI default-JSON error-envelope
coverage. Include clean open, session-only, run-file-only, both present,
canonical path spellings, deterministic ordering, ignored artifact-output
directories, concurrent clean open, and refusal-before-open tests.

### 2. Delete only obsolete core domain locks

After precise searches prove no production caller remains, delete:

- `RunStateLock` and its path helper/tests;
- core `SessionLock` and its path helper/tests;
- `CompletionLock` and its lock-held twin/tests;
- `DelegationLock` and its lock-held twin/tests;
- obsolete `DELEGATION_LOCK_TIMEOUT` error registry, factory, schemas, CLI
  mappings, rendering, and tests.

Replace useful lock-test assertions with transaction ownership, rollback,
claim-rotation, contention, and committed-before-observation coverage at the SQL
workflow layer. Do not retain test-only production APIs solely to keep old lock
fixtures compiling.

### 3. Retain legitimate filesystem locks and paths

The following are intentionally outside the deletion:

- `file-lock.ts` and its async/sync scoped-release primitives;
- the sql.js durable replacement lock;
- artifact-manifest async and sync locks;
- `PluginSessionLock`, which protects the separate plugin-local
  `.claude/session/state.json` authority;
- `isProcessAlive`, used by execution-lease stale-owner detection;
- `LOCKS_DIR` / `locksDir`, still required by manifests and sandbox policy;
- `.rundown/runs/<run-id>/outputs/**`, which remains filesystem-backed output
  storage.

The retained locks continue to use non-masking `await using` / `using` scoped
release.

### 4. Remove obsolete JSON authority contracts

PR 13 owns `runbook_started.statePath` removal and must update its complete
contract in one change:

- core event type, emitter examples, subscribers, and tests;
- CLI producer, JSON/text renderers, normalizers, snapshots, and tests;
- output schemas and `docs/spec/cli-output.md` / `docs/reference/cli.md`.

Audit the separate `RunbookMetadata.state` field before editing it. If it also
advertises a nonexistent JSON authority file, retain the established field but
make it truthful as `.rundown/rundown.db`; update every output fixture and spec
example in the same contract change.

Remove obsolete `.rundown/session.json` write-policy allowance and legacy
`sessionPath` / JSON `statePath` helpers when their exact callers reach zero.
Keep `RUNS_DIR`, `runsDir`, and their sandbox allowance for captured outputs.
Update stale comments that describe JSON as authoritative without renaming or
removing schemas still used to validate data assembled from SQLite rows.

Narrow the default write policy rather than retaining the legacy broad grants:

- remove the `.rundown/session.json` grant;
- deny `.rundown/runs/<run-id>.json` as authority;
- permit `.rundown/runs/<run-id>/outputs/**` for captured artifacts;
- retain explicit database, WAL, SHM, artifact-lock, and sql.js replacement-lock
  access.

Pin each boundary in policy tests. The older `.claude/rundown/session.json`
warning is a separate historical-install signal; retain or deliberately fold it
into `RD-305`, but do not silently confuse it with current `.rundown` legacy
authority.

## Precise inventories and residual gates

Generate production and test constructor inventories immediately after PR 12
merges. Verify that only `store-registry.ts` opens the driver or constructs the
store, while multiple manager/service wrappers still converge on that registry.

Use exact searches, not the historical broad substring gate:

```bash
rg -n '\b(?:RunStateLock|SessionLock|CompletionLock|DelegationLock)\b' packages
rg -n 'DELEGATION_LOCK_TIMEOUT' packages docs
rg -n 'sessionPath\(|statePath\(|SESSION_FILE' packages
rg -n 'session\.json|\.rundown/runs/[^/[:space:]]+\.json' packages
rg -n 'new RunbookStore|openRunbookDriver' packages --glob '!**/__tests__/**'
```

Expected results must be documented per search. A hit on `PluginSessionLock`,
artifact output storage, a legacy-refusal fixture, or historical documentation
is classified explicitly rather than hidden by a zero-hit assertion.

## Validation order

Use repository-current commands, which supersede the original plan's historical
Corepack and whole-file Stryker instructions.

1. Observe focused RED tests failing for missing legacy refusal and remaining
   obsolete contracts.
2. Run the focused core storage/registry/path/error tests.
3. Run affected CLI event, renderer, schema, and command tests after
   `pnpm run build` so CLI resolves current core `dist`.
4. Run cross-process concurrent initialization and refusal tests.
   Assert externally durable facts—both processes open one valid database,
   current schema is present, `PRAGMA integrity_check` succeeds, and no JSON
   authority appears—rather than adding instrumentation merely to count schema
   installation.
5. Run `git diff --check` and targeted Biome checks while iterating.
6. Run `pnpm run test:mutate:changed`; use package narrowing or
   `--related-tests` only where justified. Every changed-source campaign must
   instrument non-zero sources/mutants, and every survivor or `NoCoverage`
   result must be dispositioned.
7. Run the full mandatory `pnpm run verify` gate before any push.

## PR 13 branch gate

Create `issue-608/pr13-single-store-cutover` only after all of the following are
true:

- PR 12 includes transactional delegate, collect, and abort behavior;
- PR 12 has no CLI `DelegationLock` caller and no remaining collection lock
  dependency that PR 13 would have to replace behaviorally;
- PR 12 is rebased on the then-current `origin/main`, fully validated, merged,
  and fetched locally;
- this audit is refreshed against that merge SHA and converted into a final
  dated implementation addendum if any inventory changed.
