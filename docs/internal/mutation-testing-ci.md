# Mutation Testing in CI

Mutation testing runs in two roles, split by issue #485 after per-PR blocking
gates proved structurally too slow regardless of tuning.

**Where the signal actually comes from.** The changed-code gates are the
day-to-day signal: `pnpm run test:mutate:changed` locally, and the advisory
per-PR check in CI. The full-fidelity producer is not a cadence — it is an
operator-triggered job whose only purpose is to seed the dashboard baseline the
PR check diffs against. Read the rest of this document with that split in mind;
the producer being idle for a month is the expected state, not a gap.

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

**Dispatch-only, and deliberately occasional.** `workflow_dispatch` is the only
trigger. Run it when the baseline is stale — after a large refactor, or when the
PR check's incremental diffs start looking untrustworthy — and expect to pay for
it: the full campaign is **~40,000 mutants and ~70 machine-hours**, and that
total is a property of the code and the runner, not of how the job is
configured.

### What was deleted, and why (issue #670)

Both automatic triggers were removed on 2026-08-10. Neither was producing
anything.

- **`push: branches: [main]`.** 98 runs since 2026-07-02, ~84 machine-hours. 49
  planned an empty matrix; 28 were cancelled at exactly 61 minutes. A push run
  planned _differentially_ (changed source only), so its merge was partial by
  construction and the upload gate never let it publish — it could not seed a
  baseline even in principle. What it did measure was the diff the per-PR gate
  had already scored on the same commits.
- **The weekly `schedule` cron.** Five weekly campaigns produced **zero** `core`
  and **zero** `parser` shard reports. `core`, `cli` and `parser` still 404 on
  the dashboard; `plugin` — small enough to finish inside one shard budget — is
  the only module that has ever been published. A cadence that has never once
  produced its artifact is not a cadence.

The differential planning path went with the push trigger:
`scripts/mutation-shard-plan.mjs` no longer reads `PUSH_BASE` or diffs anything
in producer mode. The `pull_request` planner (one shard per changed file, scoped
to that file's changed line ranges) is untouched — it is the only changed-code
planner now, and it is the one that was always meant to carry that job.

### Pipeline

The producer fans out across shards as a three-job pipeline — **plan → mutate →
merge** — so that every individual job stays under its cap:

- **`plan`** (`scripts/mutation-shard-plan.mjs`) globs each package's
  mutate-eligible files (the config `mutate` array, `!` negations included) and
  partitions them into shards sized by `MAX_SHARD_LINES` (2400). It emits a
  GitHub Actions matrix. `INPUT_PACKAGE` selects one package or `all`.

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

  `MAX_SHARD_JOBS` (80) is the matrix ceiling — **not** the plan, which is 60
  jobs today. Over the ceiling the planner widens the line budget (and says so
  in the log) rather than dropping coverage.

- **`mutate`** runs one job per shard from that matrix —
  `stryker run --mutate <shard scopes>` at the matrix's `concurrency`. **The job
  cap (240 min) and the step cap (225 min) are deliberately unequal.** They used
  to both be 60, and because the job clock starts ~3 min before the Stryker
  step, the _job_ cap always fired first and **cancelled** the job; Stryker
  writes its report only on completion, so the shard vanished from the merged
  report with no evidence of why, and raising the job cap alone would have
  changed nothing (the step cap then fired at the same wall-clock). With the
  step strictly below the job, a slow shard **fails** — absorbed by
  `continue-on-error` — while the job is still alive, so the status and upload
  steps run normally.

  Shards run with `STRYKER_SCOPED=true`. A shard measures a fraction of a
  module, so `thresholds.break` on a shard would judge a partial score; nulling
  it means a non-zero Stryker exit is an execution failure, which is the only
  thing `continue-on-error` should have to absorb. A shard **never holds the
  dashboard key**, so it cannot upload a partial, scoped report. Each shard
  uploads its `mutation-report.json` and, via
  `scripts/mutation-shard-status.mjs` on an `always()` step, a
  `shard-status.json` recording its outcome, resolved scope, and last progress
  reading.

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
  result. **From `main`** it PUTs each complete report to the Stryker dashboard
  (gating both the upload flag and the `STRYKER_DASHBOARD_API_KEY` on
  `refs/heads/main && workflow_dispatch`) and enforces the aggregate `break`
  floor. A dispatch off a feature branch never uploads and is advisory only.

- `ignoreStatic` is OFF (env unset) so static mutants are scored.
- **Upload safety.** The producer always shards the FULL scope of the packages
  it runs, and the dashboard is keyed **per module**, so a `package: core`
  dispatch publishes a complete `core` report and touches nothing else. Only the
  `main` ref may publish; a feature-branch dispatch physically cannot, because
  the secret itself is gated, not just a flag.

### Sizing: why the budget is coarse

**The campaign's total work is flat in the shard budget.** Sharding trades
per-job setup overhead (checkout, install, build) for a shorter tail, and
nothing else. Projected over per-shard rates measured on real campaigns:

| `MAX_SHARD_LINES` | shards | machine-hours |   core p50 |    core max |
| ----------------: | -----: | ------------: | ---------: | ----------: |
|               800 |    161 |          70.1 |     28 min |      66 min |
|              1600 |     88 |          67.2 |     56 min |     104 min |
|          **2400** | **60** |      **66.3** | **80 min** | **179 min** |
|              4000 |     38 |          66.3 |    140 min |     259 min |

Setup overhead is 2.3 h at 161 shards versus 0.8 h at 60. Against that, GitHub
allows 360 min per job, and this is a **Free personal account with a 20
concurrent job limit** — so 161 jobs is 8+ waves that starve PR CI for hours,
while 60 jobs is 3 waves. Hence 2400 lines per shard and a 240-minute job cap.

**`MAX_SHARD_JOBS` (80) is a ceiling, not a target, and it deliberately sits
above the plan.** It is the point at which the planner starts widening the line
budget, and widening lengthens the shard tail toward the step cap — the exact
margin the coarse budget exists to create. Setting the ceiling at the current
60-job plan would bind on the very next core file added, and `core` grew 53% in
five weeks (see Calibration inputs below), so the widening would begin almost
immediately. 80 preserves the 2400-line budget through several months of that
growth, at the cost of a 4th wave of the account's 20 concurrent slots. That is
the right trade now the producer is dispatch-only: a 4th wave costs wall-clock
on a manual run nobody is waiting on, whereas a longer tail costs headroom on
the thing that has never once completed. GitHub's 256-job matrix limit is no
longer the binding constraint on either number.

When the plan reaches the ceiling, re-derive the budget from the table above
rather than raising the ceiling again — a test
(`scripts/__tests__/mutation-sharding.test.mjs`) fails when the default plan is
no longer strictly inside it.

### Calibration inputs

- **Mutant density: 0.46 mutants per source line** measured over the whole tree
  (0.39–0.60 per package). This is what makes line count a usable shard weight.
- **Throughput spans 5.55 to 78 mutants/min, and line count does not predict
  it.** Wall time is dominated by how many test files transitively import the
  mutated module (`enableFindRelatedTests` fan-out). The clearest demonstration:
  core shard 4/9 (5860 lines) ran at 27.20/min while shard 8/9 (5855 lines) ran
  at 5.55/min — essentially identical size, **4.9x apart**. No line budget can
  fix that; it only sets how long the tail is. Weighting shards by
  `lines × relatedTestCount` is the tracked follow-up.
- **Core is growing fast.** 16,885 mutants on 2026-06-29 and 22,702 on
  2026-08-03 — **53% in five weeks**. Any absolute mutant count in this document
  is a snapshot; re-derive from `0.46 × lines` rather than quoting one.
- **When a shard still busts its cap**, the status artifact reports its measured
  rate, so the next adjustment is arithmetic rather than guesswork.

## Config (`packages/*/stryker.config.mjs`)

- **Targeted `mutate` scope.** Mutation is focused on correctness-critical code.
  `core` excludes the JSON-output format contract (`src/output/**` — declarative
  Zod plus derived types), terminal rendering (`src/cli/**`), and logging
  (`src/logger.ts`); `cli` excludes doc codegen (`src/scripts/**`) and the
  output renderers (`src/services/renderers/**`). These layers produce many
  equivalent/noise mutants for little signal. The exclusions are pinned by
  `scripts/__tests__/stryker-config.test.mjs` so the scope cannot silently
  re-widen.
- **`jest.enableFindRelatedTests: true` is the jest-runner DEFAULT, not a tuning
  discovery.** `@stryker-mutator/jest-runner@9.6.1` declares `"default": true`
  for it in `dist/schema/jest-runner-options.json`. `core` and `cli` had
  **overridden it to `false`**, and commit `e0bef7949` removed that override —
  recovering from a self-inflicted non-default. The measured effect of that
  recovery is real and worth recording (the override made every mutant reload
  the entire suite at ~1.3 mutants/min, the in-band child's heap crept until it
  OOM'd, Stryker's retry re-leaked to the same wall, and a cold `core`/`cli`
  campaign never finished, while `parser`/`plugin` left the default in place and
  always completed) — but the causality is "we broke it and then stopped
  breaking it", not "we found a 55x lever". It is set explicitly so it cannot be
  re-broken silently.

  **The tradeoff is genuine and doc-backed.** A mutant whose only killing test
  reaches the code with **no static import path** (a subprocess that spawns the
  CLI, a dynamic `import()`, source read as a string) is no longer exercised and
  reports as a false survivor. The inverse graph is transitive, so ordinary
  integration tests still count; only runtime-only coverage is lost.

- **`maxTestRunnerReuse`** (default `25`, override with
  `STRYKER_MAX_TEST_RUNNER_REUSE`) recycles the in-band jest child every _n_
  runs to cap the small residual per-run heap leak, so a full campaign holds at
  zero OOM. Pinned in `scripts/__tests__/stryker-config.test.mjs`.
- **`coverageAnalysis: 'perTest'` is also the `@stryker-mutator/api@9.6.1`
  default** — `dist/schema/stryker-core.json` declares `"default": "perTest"`,
  and Stryker's `OptionsValidator` compiles that schema with ajv
  `useDefaults: true`. Setting it is a harmless no-op stated for explicitness,
  not a tuning decision. (The schema's own prose still reads `'off' (default)`;
  the machine-readable `default` is what Stryker applies.)
- `ignoreStatic` is `false` by default; only `STRYKER_IGNORE_STATIC=true`
  enables it (the PR workflow sets it).
- The `dashboard` reporter is added to `reporters` only when
  `STRYKER_DASHBOARD_API_KEY` is present, so only the producer uploads.
- `dashboard.project` is `github.com/tobyhede/rundown`; `dashboard.module` is
  the package name (`parser`/`core`/`cli`/`plugin`); `reportType` is `full`.
- **`thresholds.break` is 60, and null on any scoped run.** It was 70, which sat
  **above every score a module has ever achieved on a completed campaign**
  (plugin 66.17%, cli 64.51%) — so a flawless producer campaign exited 1 by
  construction. A gate that can only fire is not a gate. 60 is below every
  measurement that exists; `core` and `parser` have never completed a campaign
  at all, so it is provisional and should be re-derived from the first baseline
  the producer publishes.

  A scoped run (`STRYKER_SCOPED=true`) disables it entirely, because a scoped
  run measures a **fraction** of a module and a fraction's score is not the
  module's. Every `stryker run` in this repository is scoped: the PR gate to
  changed files, the producer's shards to line ranges, `test:mutate:changed` to
  hunks. The producer's real floor therefore lives on the **merged** report in
  `scripts/mutation-merge-reports.mjs` (`BREAK`, default 60), which is the only
  place a complete module score exists. It is applied **after** the upload, so a
  breach reports the number loudly without withholding the baseline that
  produced it.

## Options considered and declined

- **Per-PR blocking gate (status quo before #485).** Even scoped to changed
  files with `ignoreStatic` and concurrency 4, big-file PRs ran 40+ minutes.
  Blocking on it stalls merges; the empirical and Stryker-community guidance is
  to keep mutation testing advisory and track the score as a trend.
- **Keeping a weekly cron with a bigger budget.** The cron's problem was never
  only the budget: at 20 concurrent job slots a 60-job campaign occupies CI for
  hours, and it did so every Monday whether or not anything had changed enough
  to move a baseline. Dispatch makes the cost deliberate. If a cadence is wanted
  back later, monthly is the shape to consider, and only once a dispatch run has
  proved the campaign completes end to end.
- **Merge queue (`merge_group:`).** A valid way to move an enforced check off
  the per-PR critical path, but it adds a gate-aggregation job and branch-
  protection wiring for a check we have decided should be advisory, not
  enforced. Revisit only if an enforced signal becomes a requirement.
- **`actions/cache` for the incremental baseline.** Workable but needs custom
  split restore/save (the combined action only saves on success) and suffers
  7-day/10 GB eviction cold-starts. The dashboard gives a durable, public,
  trend-tracking baseline with no cache plumbing, so it was preferred.
