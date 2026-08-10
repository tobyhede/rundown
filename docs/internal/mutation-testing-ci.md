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
(~23k mutants) or `cli` (~9k) campaign does not fit a single CI job, so the
producer fans out across shards. It runs as a three-job pipeline — **plan →
mutate → merge** — so that every individual job stays under its hard cap:

- **`plan`** (`scripts/mutation-shard-plan.mjs`) globs each package's
  mutate-eligible files (the config `mutate` array, `!` negations included) and
  partitions them into shards sized by `MAX_SHARD_LINES` (800). Source line
  count is the shard weight because it is a good mutant proxy — measured at
  0.39–0.60 mutants per line across the four packages. It emits a GitHub Actions
  matrix. On **push** it instead shards only the source changed since
  `github.event.before` (differential); a package with no changed source
  contributes no shards.

  Two tiers, in `partitionProducerFiles` (`scripts/lib/mutation-scope.mjs`):
  - A file above `LARGE_SOURCE_FILE_LINES` (1000) is **isolated and split by
    line range** into chunks of half the budget, each its own shard at
    `STRYKER_CONCURRENCY=2`. Halving both the worker count and the mutant budget
    keeps projected wall time equal to an ordinary shard while halving peak
    memory — a worker holds the whole instrumented module graph, measured at 3–4
    GB for a ~3600-line file. Splitting is what makes a 4000-line module
    measurable at all; before it, whole-file scopes were indivisible and no
    budget could bring one under the job timeout (issue #670).
  - Everything else is **batched** largest-first onto the lightest shard, at
    `STRYKER_CONCURRENCY=4`.

  Chunks of a split file **overlap** by `CHUNK_OVERLAP_LINES` (40). Stryker
  places a mutant only when its location fits entirely inside a mutation range,
  so without the overlap a mutant straddling a chunk boundary would be dropped
  by both chunks and never measured. The merge dedupes the copies the overlap
  produces. A mutant spanning more than 40 lines at a boundary is still lost — a
  bounded, documented fidelity cost that applies only to files too large to
  measure in one shard.

  `MAX_SHARD_JOBS` (240) caps the matrix below GitHub's 256-job hard limit; over
  it the planner widens the line budget (and says so in the log) rather than
  dropping coverage.

- **`mutate`** runs one job per shard from that matrix —
  `stryker run --mutate <shard scopes>` at the matrix's `concurrency`. **The job
  cap (75 min) and the step cap (60 min) are deliberately unequal.** They used
  to both be 60, and because the job clock starts ~3 min before the Stryker
  step, the _job_ cap always fired first and **cancelled** the job; Stryker
  writes its report only on completion, so the shard vanished from the merged
  report with no evidence of why, and raising the job cap alone would have
  changed nothing (the step cap then fired at the same wall-clock). With the
  step strictly below the job, a slow shard **fails** — absorbed by
  `continue-on-error` — while the job is still alive, so the status and upload
  steps run normally. A shard **never holds the dashboard key**, so it cannot
  upload a partial, scoped report. Each shard uploads its `mutation-report.json`
  and, via `scripts/mutation-shard-status.mjs` on an `always()` step, a
  `shard-status.json` recording its outcome, resolved scope, and last progress
  reading. The run step is `continue-on-error` because a sub-floor score makes
  Stryker exit non-zero on `thresholds.break`, and that floor belongs on the
  merged aggregate, not a single shard.
- **`merge`** (`scripts/mutation-merge-reports.mjs`) downloads every shard
  report and status, unions the `files` maps into one complete per-module
  report, recomputes the aggregate score, and writes a job summary. Because a
  split file's ranges live on several shards, a repeated `files` key is normal:
  entries are combined by cross-report mutant identity (a real status beats an
  `Ignored` placeholder) rather than overwritten, and mutant ids are renumbered
  so the merged report has none of the duplicates Stryker's per-run counter
  produces. It verifies that every shard the plan emitted produced a report;
  each one that did not is reported **by name, with a reason** — cancelled vs
  step-failed, how far it got, and at what measured mutants/min — in both stderr
  and the job summary, and fails the merge. A shard that finished but measured
  zero mutants is called out separately, because 100% of nothing is not a clean
  result. On the **weekly schedule on `main`** — the only run that shards the
  FULL scope — it PUTs each complete report to the Stryker dashboard (gating
  both the upload flag and the `STRYKER_DASHBOARD_API_KEY` on
  `refs/heads/main && schedule`) and enforces the aggregate `break` floor. A
  push (differential, partial) and a dispatch (may be a feature branch) never
  upload and are advisory only.

- `ignoreStatic` is OFF (env unset) so static mutants are scored.
- **Upload safety.** Only the weekly schedule produces a complete report, so it
  is the only run that may (re)seed the dashboard baseline. A push merge is
  partial by construction (changed files only) and a dispatch may run off a
  feature branch, so neither uploads — exactly the thin-report corruption the PR
  check also avoids.

**Calibration.** `MAX_SHARD_LINES` comes from the 2026-08-03 campaign, in which
all 9 core shards at `MAX_SHARD_LINES=6000` were killed by the timeout having
tested 12–27% of their mutants. Measured throughput varied 12x across those
shards — 5.6 to 71 mutants/min — because wall time is dominated by how many test
files transitively import the mutated module, which line count cannot predict.
800 lines is ~310 core mutants: ~56 min at the worst observed rate and ~25 min
at the campaign median of 12.4/min. When a shard still busts its cap, the status
artifact reports its measured rate, so the next adjustment is arithmetic rather
than guesswork.

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
