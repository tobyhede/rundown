# 608 Controlled Rebuild — PR 1: SQLite driver substrate

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Parent plan:** [2026-07-23-608-controlled-rebuild.md](2026-07-23-608-controlled-rebuild.md) — PR 1 of 14.

**Goal:** Land the adapter-neutral SQL driver substrate (`node:sqlite` and sql.js) and its schema probe as an independently green PR. No run or session persistence changes.

**Depends on:** Task 1 of the parent plan (salvage tag `608-salvage-2026-07-23` pushed) — already complete. Branch from the freshly fetched merged `origin/main`.

**Tech Stack:** TypeScript, SQLite (`node:sqlite` and sql.js), Jest, Stryker, Biome, ESLint, pnpm 11 through Corepack, Playwright, GitHub pull requests.

## Shared Constraints

- The planning baseline is `origin/main` at `a52fb4ae0`; fetch `origin/main` and record the then-current SHA before creating the branch.
- Salvage tag `608-salvage-2026-07-23` (peeled to `5364e3965`) is immutable: never force-update or delete it, and never prune the salvage branches.
- The source commits below are evidence, not merge bases. Never base work on `608-sqlite-claim-concurrency`, `608-integration`, or a closed PR branch.
- Open only one dependent implementation PR at a time. This PR must merge before PR 2 branches from the newly fetched `origin/main`.
- Before editing, run the exact `git cherry-pick --no-commit` sequence below. Resolve conflicts in favor of current-main package scripts, CI, error helpers, docs guards, and test conventions; preserve this task's named behavior and tests.
- After conflict resolution, `git diff --name-only --diff-filter=U` must print nothing, `git diff --check` must exit 0, and every changed path must be listed in the ownership block below. An unexpected path is a stop-and-review event, not an implicit addition.
- Run the named tests, the exact scoped mutation command, and `corepack pnpm run verify`. Expected result is exit 0; Stryker must report at least one instrumented source and at least one mutant. Never use `--allowEmpty`.
- The only scoped mutation form is `corepack pnpm --filter @rundown-org/<pkg> exec stryker run --mutate <package-relative-comma-separated-paths> --testFiles <package-relative-comma-separated-paths>`. Pass each option once, use package-relative paths, and never insert a pnpm `--` separator. Use the comma form, never a brace glob: Stryker splits `--mutate` and `--testFiles` on commas *before* brace expansion, so `{a,b}.ts` degrades into patterns that match nothing and the run reports `Instrumented 0 source file(s) with 0 mutant(s)` — a gate that cannot fail. Confirm that line reports a non-zero count before trusting any score, and delete `reports/stryker-incremental.json` first so an `incremental: true` cache cannot replay a previous run's aggregate over it.
- `RESULT`, `HANDLER`, and `ACTION` remain distinct. Lifecycle dispatch is type-driven; no frontend branches on raw action strings and no action is silently mapped to another action.
- Persisted `RunbookState.schemaVersion` remains `1`. SQLite storage schema versions are independent. Never migrate, import, hydrate, shim, or dual-read incompatible persisted JSON state.
- Runtime services, callables, `cwd`, and store instances flow through actor invoke-input/constructor DI, never persisted XState context.
- `pnpm run verify` is mandatory before every push. Any red local or GitHub check is a hard stop.

## Commit Ownership

Owned in full: `5fdf7379c`.

## Task: Add the SQLite driver substrate

**Files:**
- Modify/Create: exactly the 12 paths reported by `git diff-tree --no-commit-id --name-only -r 5fdf7379c`: `eslint.config.js`, `packages/core/package.json`, `pnpm-lock.yaml`, `packages/core/src/runbook/storage/{sql-driver,native-sqlite-driver,sqljs-driver,driver-factory,schema}.ts`, `packages/core/__tests__/runbook/storage/{driver-contract,schema}.test.ts`, `site/src/pages/sqlite-substrate-probe.astro`, `site/tests/sqlite-substrate.spec.ts`.

**Deviation from `5fdf7379c` (recorded 2026-07-23, approved before proceeding):** the salvaged probe page was committed as `site/src/pages/__sqlite-substrate-probe.astro` and could never have executed. Two defects, both verified empirically:

1. Astro excludes `_`-prefixed files in `src/pages/` from routing, so `/__sqlite-substrate-probe` returned 404 and the Playwright guard asserted against Astro's 404 page until it timed out. Confirmed by serving identical pages at `zz-route-probe.astro` (200) and `_zz-route-probe.astro` (404).
2. Line 138 read `/(^|\\/)jsh$/`; the doubled backslash closes the regex literal early, so the Astro compiler rejected the whole page (`CompilerError` at 138:35) and the route served 500 even at a routable path.

The plan therefore owns the renamed path `site/src/pages/sqlite-substrate-probe.astro` (11 paths carried verbatim from `5fdf7379c` plus this rename), the `\\/` → `\/` fix, the matching `goto` in `site/tests/sqlite-substrate.spec.ts`, and a comment on the page warning against reintroducing the underscore prefix. With those applied the probe passes for real: `{"persistedTotal":"11","nativeWorks":"false","shell":"/bin/jsh","sqljsPersists":true,"nativeStubbed":true,"markerHolds":true}`.

**Interfaces:**
- Produces: adapter-neutral SQL driver/factory and schema probe; neither run nor session persistence changes.

- [ ] Branch `608-rebuild-sqlite-substrate` from merged `origin/main`; run `git cherry-pick --no-commit 5fdf7379c`. Resolve only current-main dependency/lint drift; verify no unmerged or unexpected paths.
- [ ] Run `corepack pnpm --filter @rundown-org/core exec jest __tests__/runbook/storage/driver-contract.test.ts __tests__/runbook/storage/schema.test.ts`. Expected: both suites pass for native SQLite and sql.js.
- [ ] Build the WebContainer snapshot first — `corepack pnpm --filter site run build:snapshot` — otherwise `astro dev` refuses to serve and Playwright reports `Process from config.webServer exited early`. `site/public/rundown-snapshot.bin` is gitignored, so this is a local prerequisite, not a committed path.
- [ ] Run `corepack pnpm --filter site exec playwright test tests/sqlite-substrate.spec.ts`. Expected: probe passes or, if the current-main site command differs, stop and update this plan before proceeding.
- [ ] Run `corepack pnpm --filter @rundown-org/core exec stryker run --mutate src/runbook/storage/native-sqlite-driver.ts,src/runbook/storage/sqljs-driver.ts,src/runbook/storage/driver-factory.ts --testFiles __tests__/runbook/storage/driver-contract.test.ts,__tests__/runbook/storage/schema.test.ts`. Expected: non-zero instrumentation and no driver-contract survivors accepted without an issue.

  **Use the comma form, not the brace form.** Stryker splits `--mutate` and `--testFiles` on commas *before* brace expansion, so `'src/runbook/storage/{native-sqlite-driver,sqljs-driver,driver-factory}.ts'` degrades into three patterns that match nothing: `Instrumented 0 source file(s) with 0 mutant(s)`. Because the broken `--testFiles` pattern also matched nothing, the dry run fell back to the whole core suite and aborted in `__tests__/output/docs-error-code-drift.test.ts`, which reads repo-root `docs/spec/cli-output.md` — absent from Stryker's package-scoped sandbox. Both symptoms disappear with the comma form.
- [ ] Run `corepack pnpm run verify`; commit `feat(core): add SQLite driver substrate`; open and merge PR 1.

## Self-Review Checklist

- [ ] Only the 12 owned paths changed (11 verbatim from `5fdf7379c` plus the `site/src/pages/sqlite-substrate-probe.astro` rename recorded above).
- [ ] Both adapters pass the driver contract.
- [ ] Scoped Stryker reported non-zero instrumented sources and mutants.
- [ ] No run or session persistence route changed in this PR.
- [ ] `corepack pnpm run verify` exited 0 before push; all GitHub checks green before merge.
