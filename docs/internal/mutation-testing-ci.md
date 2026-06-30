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

Even with the `enableFindRelatedTests` fix (see Config below), a full `core`
(~17k mutants) or `cli` (~9k) campaign does not fit a single **60-min** CI job,
so the producer fans out across shards. It runs as a three-job pipeline — **plan
→ mutate → merge** — so that every individual job stays under the 60-min hard
cap:

- **`plan`** (`scripts/mutation-shard-plan.mjs`) globs each package's
  mutate-eligible files (the config `mutate` array, `!` negations included) and
  greedily partitions them into shards balanced by source line count — a mutant
  proxy — sized by `MAX_SHARD_LINES` (6000) so each shard lands well under 60
  min at concurrency 4. It emits a GitHub Actions matrix. On **push** it instead
  shards only the source changed since `github.event.before` (differential); a
  package with no changed source contributes no shards. Shards mutate **disjoint
  file sets**, which is what lets the merge reassemble a complete report.
- **`mutate`** runs one job per shard from that matrix —
  `stryker run --mutate <shard files> --allowEmpty` at `STRYKER_CONCURRENCY=4`,
  hard-capped at 60 min. A shard **never holds the dashboard key**, so it cannot
  upload a partial, scoped report. Each shard uploads its `mutation-report.json`
  as an artifact. The run step is `continue-on-error` because a sub-floor score
  makes Stryker exit non-zero on `thresholds.break`, and that floor belongs on
  the merged aggregate, not a single shard.
- **`merge`** (`scripts/mutation-merge-reports.mjs`) downloads every shard
  artifact, unions the disjoint `files` maps into one complete per-module
  report, recomputes the aggregate score, and writes a job summary. It verifies
  that every shard the plan emitted produced a report — a crashed shard
  (swallowed by `continue-on-error`) leaves a gap that fails the merge. On the
  **weekly schedule on `main`** — the only run that shards the FULL scope — it
  PUTs each complete report to the Stryker dashboard (gating both the upload
  flag and the `STRYKER_DASHBOARD_API_KEY` on `refs/heads/main && schedule`) and
  enforces the aggregate `break` floor. A push (differential, partial) and a
  dispatch (may be a feature branch) never upload and are advisory only.
- `ignoreStatic` is OFF (env unset) so static mutants are scored.
- **Upload safety.** Only the weekly schedule produces a complete report, so it
  is the only run that may (re)seed the dashboard baseline. A push merge is
  partial by construction (changed files only) and a dispatch may run off a
  feature branch, so neither uploads — exactly the thin-report corruption the PR
  check also avoids.

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
