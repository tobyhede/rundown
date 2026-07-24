# 608 Controlled Rebuild — PR 14: WebContainer support, schemas, descriptive docs, release evidence

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This task is TDD: RED, then implement, then GREEN, then mutation, then release evidence.

**Parent plan:** [2026-07-23-608-controlled-rebuild.md](2026-07-23-608-controlled-rebuild.md) — PR 14 of 14, the final PR closing #608.

**Goal:** Bundle sql.js JS/WASM for WebContainer, register the five result codes through every schema and rendering layer, rewrite descriptive docs from the merged implementation, and produce full release evidence.

**Depends on:** PR 13 (`feat: cut runbook state authority over to SQLite`) merged, including its saved documentation-input search. Branch from the freshly fetched merged `origin/main`.

**Tech Stack:** TypeScript, XState 5, SQLite (`node:sqlite` and sql.js), Jest, Stryker, Biome, ESLint, pnpm 11 through Corepack, Playwright, Astro, GitHub pull requests.

## Shared Constraints

- Fetch `origin/main` and record the then-current SHA before creating the branch. Never base work on `608-sqlite-claim-concurrency`, `608-integration`, or a closed PR branch.
- Salvage tag `608-salvage-2026-07-23` (peeled to `5364e3965`) is immutable: never force-update or delete it. Consider salvage branch cleanup only after the release containing this change is validated.
- Every changed path must be listed in the Files block below. An unexpected path is a stop-and-review event. `git diff --check` must exit 0.
- `4859a9c08` is applied here and only to its three site paths — this PR owns the runnable WebContainer probe correction that PR 5 excluded. Commit `21078e2b4` is not replayed: rewrite descriptive comments and docs from the final implementation instead.
- Descriptive docs (`docs/internal/`, `CLAUDE.md`, `docs/reference/`, `docs/spec/`) are edited in place to describe the code that now exists. Prospective plans stay under `docs/superpowers/`.
- Run the named tests, all four exact scoped mutation campaigns, and `corepack pnpm run verify`. Expected result is exit 0; Stryker must report at least one instrumented source and at least one mutant per campaign. Never use `--allowEmpty`.
- The only scoped mutation form is `corepack pnpm --filter @rundown-org/<pkg> exec stryker run --mutate <package-relative-comma-separated-paths> --testFiles <package-relative-comma-separated-paths>`. Pass each option once, use package-relative paths, and never insert a pnpm `--` separator. Use the comma form, never a brace glob: Stryker splits `--mutate` and `--testFiles` on commas *before* brace expansion, so `{a,b}.ts` degrades into patterns that match nothing and the run reports `Instrumented 0 source file(s) with 0 mutant(s)` — a gate that cannot fail. Confirm that line reports a non-zero count before trusting any score, and delete `reports/stryker-incremental.json` first so an `incremental: true` cache cannot replay a previous run's aggregate over it.
- `RESULT`, `HANDLER`, and `ACTION` remain distinct. Persisted `RunbookState.schemaVersion` remains `1` and is documented as distinct from the SQLite storage schema version. Never migrate, import, hydrate, shim, or dual-read incompatible persisted JSON state.
- CLI tests cover default JSON and `--text` separately.
- `pnpm run verify` is mandatory before every push. Any red local or GitHub check is a hard stop.

## Commit Ownership

Partially owned: `4859a9c08`, applied/adapted only to `site/playwright.config.ts`, `site/src/pages/dev/sqlite-substrate-probe.astro`, `site/tests/sqlite-substrate.spec.ts`. Everything else in this PR is fresh work.

## Task: Bundle WebContainer support, schemas, descriptive docs, and release evidence

**Files:**
- Apply/adapt: `4859a9c08` only to `site/playwright.config.ts`, `site/src/pages/dev/sqlite-substrate-probe.astro`, `site/tests/sqlite-substrate.spec.ts`
- Rename (both paths are expected changes): `site/src/pages/sqlite-substrate-probe.astro` → `site/src/pages/dev/sqlite-substrate-probe.astro`
- **Move, do not duplicate, the PR 1 probe.** PR 1 lands the probe at `site/src/pages/sqlite-substrate-probe.astro`; this PR's final location is `site/src/pages/dev/sqlite-substrate-probe.astro`. `git mv` the PR 1 page to the `dev/` path and repoint the `goto` in `site/tests/sqlite-substrate.spec.ts` — do not leave both pages in the tree. Keep the comment warning against an `_`-prefixed filename, which Astro excludes from routing.
- **Path-check staging.** `4859a9c08` is cherry-picked against PR 1's path, so validate in two stages: immediately after `git cherry-pick --no-commit`, the three adapted paths are `site/playwright.config.ts`, `site/src/pages/sqlite-substrate-probe.astro`, `site/tests/sqlite-substrate.spec.ts`; after the `git mv`, `git diff HEAD --name-only` reports four site paths, because a rename shows as both the deleted source and the added destination. Checking the post-rename tree against the pre-rename three-path set would flag the rename itself as an unexpected path.
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

## Mandatory Review Checkpoint (after this PR)

Require WebContainer parity, schema/docs parity, scenarios, scoped mutation, full mutation, and ordinary release gates.

## Self-Review Checklist

- [ ] `4859a9c08` touched exactly its three site paths.
- [ ] The snapshot bundles sql.js JS and WASM and runs offline with no runtime install.
- [ ] Exactly the five result codes are registered across core enums, core Zod schemas, CLI output schemas, and the schema service.
- [ ] Descriptive docs describe the merged implementation, including the absence of an exactly-once-effect guarantee and the two distinct schema versions.
- [ ] All four scoped campaigns instrumented every named target with non-zero mutants; survivors are killed or linked to an accepted-risk issue.
- [ ] Full release evidence recorded: SHA, counts, duration, package mutation scores, timeouts, survivors — no partial suite.
- [ ] #608 updated with all merged PRs and evidence.
