# Mutation Testing in CI

Mutation testing runs in two roles, split by issue #485 after per-PR blocking
gates proved structurally too slow regardless of tuning.

## Advisory per-PR check (`.github/workflows/mutation-pr.yml`)

- **Non-blocking.** It is intentionally NOT a required status check. It posts a
  single sticky PR comment (header `mutation-advisory`) with per-file mutation
  scores for the files changed in the PR.
- **Scoped + fast.** Runs Stryker with `--mutate` limited to the PR's changed
  source files, `--incremental` against the public `main` baseline downloaded
  from the Stryker Dashboard, and `STRYKER_IGNORE_STATIC=true` to skip static
  mutants. The Stryker run and the per-file score step are
  `continue-on-error: true`, so a low score annotates the comment but never
  fails the job.
- **No secret.** The baseline is a public dashboard read (`curl`). The PR run
  never uploads (an upload of a changed-file-scoped report would corrupt the
  baseline).

## Full-fidelity producer (`.github/workflows/mutation.yml`)

Since the `enableFindRelatedTests` fix (see Config below) a full `core` (~17k
mutants) or `cli` (~9k) campaign **does** complete — a full `policy/**` scope
(1921 mutants) finishes in ~25 min at zero OOM where it previously never
finished. The producer still splits its triggers by scope so that push-to-main
stays fast and only the weekly pays for full fidelity:

- **Weekly cron** — the full-fidelity producer.
  `stryker run --incremental --force` re-tests every mutant for every package
  and uploads the complete report, (re)seeding the dashboard baseline. This is
  the only trigger that runs a package in full, so it gets the long per-step
  budget (350 min within a 360-min job ceiling).
- **Push to `main`** — differential. A "Detect changed files (push)" step diffs
  `github.event.before...HEAD` under each package's `src` (mirroring the PR
  workflow's merge, including the config's `!` mutate exclusions) and passes the
  result to `--mutate ... --allowEmpty`. A package with no changed source is
  skipped entirely; the run is bounded to change size and gets a tight 50-min
  step budget. Full git history (`fetch-depth: 0`) is required for the diff.
- **`workflow_dispatch`** — runs the selected package in full (`--incremental`),
  ad-hoc, and never uploads. It shares the **50-min** non-schedule step budget,
  so it suits a quick package check; a cold full `core`/`cli` campaign needs the
  weekly's 350-min budget (or a temporary budget bump) to finish on-demand.
- `ignoreStatic` is OFF (env unset) so static mutants are scored.
- **Upload safety.** The dashboard upload (`STRYKER_DASHBOARD_API_KEY`) is
  enabled for the weekly run always, but for a push **only when a full baseline
  was downloaded** (`steps.baseline.outputs.present == 'true'`). A push is
  scoped to changed files, so it can only upload safely by merging into an
  existing complete baseline — uploading a changed-files-only report with no
  base would overwrite the dashboard with a thin report (the same corruption the
  PR check avoids by never uploading). With no baseline a push still runs
  scoped, but does not upload; the next weekly re-seeds.

## Config (`packages/*/stryker.config.mjs`)

- **Targeted `mutate` scope.** Mutation is focused on correctness-critical code.
  `core` excludes the JSON-output format contract (`src/output/**` — declarative
  Zod plus derived types), terminal rendering (`src/cli/**`), and logging
  (`src/logger.ts`); `cli` excludes doc codegen (`src/scripts/**`) and the
  output renderers (`src/services/renderers/**`). These layers produce many
  equivalent/noise mutants for little signal. The exclusions are pinned by
  `scripts/__tests__/stryker-config.test.mjs` so the scope cannot silently
  re-widen.
- **Campaign completion (`enableFindRelatedTests` + `maxTestRunnerReuse`).** The
  `@stryker-mutator/jest-runner` runs Jest in-band (`runInBand: true`) inside
  one long-lived child process. `core`/`cli` had overridden
  `jest.enableFindRelatedTests` to `false` (the schema default is `true`), which
  made **every mutant reload the entire test suite** — measured at ~1.3
  mutants/min, and the in-band child's heap crept until it OOM'd. Stryker then
  restarted and retried the same mutant, which re-leaked to the same wall: a
  death spiral that floored throughput to ~0, which is why a cold `core`/`cli`
  campaign never finished (`parser`/`plugin`, which left the default in place,
  always completed). Restoring `enableFindRelatedTests: true` scopes each mutant
  to only the test files that _transitively import_ the mutated source (~72
  mutants/min on `policy/**`, ~55×). `maxTestRunnerReuse` (default `25`,
  override with `STRYKER_MAX_TEST_RUNNER_REUSE`) then recycles the child every
  _n_ runs to cap the small residual per-run leak, so a full campaign holds at
  zero OOM. The tradeoff of `findRelatedTests`: a mutant whose only killing test
  reaches the code with **no static import path** (a subprocess that spawns the
  CLI, a dynamic `import()`, source read as a string) is no longer exercised and
  reports as a false survivor. The inverse graph is transitive, so ordinary
  integration tests still count; only runtime-only coverage is lost — acceptable
  because the alternative does not complete. Both pins live in
  `scripts/__tests__/stryker-config.test.mjs`.
- `ignoreStatic` is `false` by default; only `STRYKER_IGNORE_STATIC=true`
  enables it (the PR workflow sets it).
- The `dashboard` reporter is added to `reporters` only when
  `STRYKER_DASHBOARD_API_KEY` is present, so only the producer uploads.
- `dashboard.project` is `github.com/tobyhede/rundown`; `dashboard.module` is
  the package name (`parser`/`core`/`cli`/`plugin`); `reportType` is `full`.
- `thresholds.break: 70` still applies to every `stryker run`; on the advisory
  PR run it is neutralized by `continue-on-error` and superseded by the per-file
  score in `scripts/assert-mutation-score.mjs`.

## Options considered and declined

- **Per-PR blocking gate (status quo before #485).** Even scoped to changed
  files with `ignoreStatic` and concurrency 4, big-file PRs ran 40+ minutes.
  Blocking on it stalls merges; the empirical and Stryker-community guidance is
  to keep mutation testing advisory and track the score as a trend.
- **Merge queue (`merge_group:`).** A valid way to move an enforced check off
  the per-PR critical path, but it adds a gate-aggregation job and branch-
  protection wiring for a check we have decided should be advisory, not
  enforced. Revisit only if an enforced signal becomes a requirement.
- **`actions/cache` for the incremental baseline.** Workable but needs custom
  split restore/save (the combined action only saves on success) and suffers
  7-day/10 GB eviction cold-starts. The dashboard gives a durable, public,
  trend-tracking baseline with no cache plumbing, so it was preferred.
