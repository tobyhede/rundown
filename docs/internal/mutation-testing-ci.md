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

- Runs on **push to `main`** (incremental refresh) and **weekly cron**
  (`--force` complete refresh), every package.
- `ignoreStatic` is OFF (env unset) so static mutants are scored.
- Uploads the full report per module to the Stryker Dashboard
  (`STRYKER_DASHBOARD_API_KEY`), which is both the trend/score surface and the
  baseline the PR check downloads.

## Config (`packages/*/stryker.config.mjs`)

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
