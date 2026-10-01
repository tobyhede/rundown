# Mutation testing (local)

How to mutation-test your own changes locally, and the foot-guns that make a
scoped Stryker run report the wrong thing. The CI producer and dashboard are
described in [mutation-testing-ci.md](mutation-testing-ci.md).

## `pnpm run test:mutate:changed`

the default way to mutation-test your own work, and what an agent should reach
for first. It derives the diff base (merge-base with `main`) and runs **one
Stryker invocation per changed source file**, each scoped to that file's changed
`file:start-end` ranges (whole-file only when the file is new) and to that
file's dedicated unit test, then reports every in-scope Survived or NoCoverage
mutant through `assert-mutation-score.mjs`; the percentage is secondary context.
For a test-only change it uses Stryker's native incremental analysis and
compares stable mutant IDs with an existing baseline, refusing an unbounded cold
run when no baseline exists. It encodes every foot-gun below by construction,
adds `--force` to every source-change scope (mandatory there, see below), and
fails loudly when Stryker instrumented 0 files — the silent no-op that a
hand-written `--mutate` reports as success.

```bash
pnpm run test:mutate:changed                    # every changed package
pnpm run test:mutate:changed --package core     # one package
pnpm run test:mutate:changed --print            # show the plan + commands, run nothing
pnpm run test:mutate:changed --related-tests    # drop --testFiles, use findRelatedTests
```

**Read a survivor correctly.** Scoping to one dedicated test disables the jest
runner's `--findRelatedTests`, so a mutant killed only by an integration test
reports as a **survivor**. That is the intended reading — "this module's own
unit tests do not kill this mutant independently", which is what Stryker
documents `testFiles` for — not "nothing in the suite covers this". Pass
`--related-tests` to check the broader question, at roughly 13x the cost per
mutant on a widely-imported module.

The advisory PR workflow uses the same hybrid: custom changed ranges for source
changes, native incremental analysis for test-only changes. Dedicated tests are
the default fast tier; add the `mutation:related` PR label (or choose `related`
in a manual dispatch) to retain Jest's related-test fallback.

**`--force` is not optional on a source-change scope.** Every package config
sets `incremental: true`, so without `--force` Stryker may serve cached results
from the `main` baseline for the very lines you changed, and the score you read
is main's. The Stryker docs call `--force` "especially beneficial when combined
with a custom `--mutate` pattern" for exactly this reason. It is scope-limited,
so the full-report benefit of incremental mode is preserved. The **test-only
tier is the deliberate exception**: it passes bare `--incremental` and no
`--force`, because that tier's entire method is diffing stable mutant IDs
against the retained baseline — a forced cold rerun would discard the very
results it compares against.

**Never tune `timeoutMS` down for speed.** Timeout is a _detected_ state (score
is `detected / valid`, detected = `killed + timeout`), so a spurious timeout
inflates the score by crediting a kill no test performed. Measured on
`src/paths.ts`: 60000ms gives 11 Killed / 15 Timeout / 2 Survived / 5 NoCoverage
= 78.79%; 8000ms gives 0 Killed / 31 Timeout / 0 Survived / 5 NoCoverage =
86.11% — both real survivors erased. Reduce mutant count (ranges) or tests per
mutant (`testFiles`) instead.

**Concurrency is bounded for you — mutation runs are memory-bound, not
CPU-bound.** Every package config reads `STRYKER_CONCURRENCY` (default **2**).
That number is not the process count: Stryker spawns a test-runner worker _and_
a TypeScript checker worker per unit, so `concurrency=2` is **four** Node
processes, each holding the whole instrumented module graph. Memory scales with
the size of the mutated file, not with the number of mutants, so a big module is
where this bites: measured on a ~3600-line revision of
`lifecycle-command-service.ts`, `concurrency=2` ran 4 workers at 3–4 GB each —
**~14 GB**, enough to make the machine unusable for everything else.

`test:mutate:changed` therefore sets `STRYKER_CONCURRENCY=1` itself on a
source-change scope whose mutated file exceeds `LARGE_SOURCE_FILE_LINES` (1000,
in `scripts/lib/mutation-scope.mjs`, re-exported from
`scripts/mutate-changed.mjs`). The CI producer's shard planner keys off the
**same** constant, dropping a shard that mutates a file over it to concurrency 2
— one threshold, two policies, so they cannot drift. **Do not set it by hand for
that path** — an explicit `STRYKER_CONCURRENCY` in the environment always wins,
so doing so only overrides a size-aware default with a flat one. Two paths the
automatic bound does **not** cover:

- **The test-only tier.** It passes no `--mutate` scope, so it mutates the whole
  package glob — the largest instrumented graph there is, and the worst case for
  the blow-up this bound exists to prevent — at the default 2. There is no file
  size to key on, so bound it yourself if that tier starts swapping.
- **The manual `exec stryker run` form below**, which never goes through the
  script. Set the variable yourself, as its large-file example does.

Bound it by hand whenever anything else is running concurrently (another agent,
a `pnpm run verify`, a dev server) — a mutation run must never be the reason a
developer's machine starts swapping. The default 2 is for a small, isolated
scope. Raising it above 2 needs a specific reason and a machine with the RAM to
match.

Concurrency trades wall-clock for memory and nothing else — it does not change
which mutants are tested or whether they are killed — so lowering it is always
safe for correctness. That makes it the **first** knob to reach for when a run
is too heavy, ahead of narrowing scope, and far ahead of `timeoutMS`, which is
never a legitimate knob (see above).

If you kill a mutation run mid-flight, kill that run's whole tree — the workers
are children of the `stryker` process and outlive a bare `kill` on the pnpm
wrapper. Target the run by its PID, not by pattern: `pkill -f` on a Stryker
pattern also kills every other agent's mutation run on the machine.

```bash
pgrep -fl 'stryker run'      # find the run you mean; note its PID
STRYKER_PID=<pid>
pkill -P "$STRYKER_PID"      # its memory-holding workers (direct children)
kill "$STRYKER_PID"          # the parent
```

Reach for the manual form below only when you need a scope the diff does not
describe (a single function, a file you did not touch).

## Hand-scoped Stryker runs

For any package, use `exec` and pass **package-relative** paths:

```bash
pnpm --filter @rundown-org/cli exec stryker run \
  --mutate src/helpers/table-formatter.ts \
  --testFiles __tests__/helpers/table-formatter.test.ts
```

This is the canonical form. **Never run an unscoped Stryker run** — no
`pnpm run test:mutate:<pkg>` without `--mutate`, and never the package glob.

**Scope to changed lines, not to a file.** Whole-file `--mutate` is only
appropriate for a small file (roughly < 300 lines) or one that is entirely new.
Pointing it at a large existing module is a full run wearing a scoped flag:
`runbook-store.ts` is ~1450 lines, so mutating it whole to cover a ~280-line
change ran 17+ minutes without finishing. Use line ranges, which Stryker accepts
as `file:start-end` and comma-separates:

```bash
# ranges from: git diff -U0 [<merge-base>] -- <file> | grep -E '^@@'
# this form is unscripted, so bound concurrency yourself on a >1000-line file
STRYKER_CONCURRENCY=1 pnpm --filter @rundown-org/core exec stryker run \
  --mutate 'src/runbook/storage/runbook-store.ts:693-820,src/runbook/storage/runbook-store.ts:1219-1240' \
  --testFiles __tests__/runbook/storage/runbook-store.test.ts \
  --force
```

**Derive the ranges from the diff; never guess them.** A hand-picked range that
is wider than the change sweeps in pre-existing untested code and reports it as
your survivors. Measured on `lifecycle-command-service.ts`: a guessed
`1240-1420` produced 12 in-scope Survived/NoCoverage mutants, **all twelve on
lines the branch never touched**. The diff-derived scope over the same file
reported none of them. Use `git diff -U0 <merge-base> -- <file> | grep -E '^@@'`
and convert the `+start,count` hunks — and diff against the **working tree**,
not `main...HEAD`, whenever you have uncommitted changes, or every line number
is shifted relative to the file Stryker actually mutated.

Judge the result on survivors **in the lines you changed**, never on the
aggregate score: a scope this narrow makes the percentage meaningless. Run a
hand-rolled scope with `STRYKER_SCOPED=true` (as `test:mutate:changed` does) so
`thresholds.break` is nulled and a non-zero exit means the run actually failed;
without it the floor judges a partial score and fails a fine run.

**The report lists survivors from outside your scope.** With
`incremental: true`, the textual report and the per-file table merge cached
results for the whole project over the mutants this run actually tested, so a
clean scoped run can print hundreds of `[Survived]` entries for files and lines
you never mutated. This is the inverse of the two foot-guns below — those make a
broken run look green, this makes a green run look broken — and it is why the
only valid reading is to filter the survivor list by your own line ranges:

```bash
# after a scoped run, keep only survivors inside the ranges you mutated
grep -A2 '^\[Survived\]\|^\[NoCoverage\]' run.log | grep '<your-file>.ts:'
```

Confirm `Instrumented N source file(s) with M mutant(s)` matches the scope you
asked for before trusting any score: that count, not the survivor list, tells
you what this run tested, and `N > 0` is what proves the scope resolved at all.
Two ways a scoped run can lie about success:

- Do **not** insert the `--` separator:
  `pnpm --filter … exec stryker run -- --mutate <file>` (or
  `pnpm run test:mutate:<pkg> -- --mutate <file>`) dies on
  `error: too many arguments for 'run'` because pnpm forwards the literal `--`
  into Stryker's Commander as a positional. The `test:mutate:<pkg>` root scripts
  delegate to the `exec stryker run` form above, so the bare shortcut
  `pnpm run test:mutate:<pkg> --mutate <pkg-relative-path>` (no `--`) forwards
  cleanly and scopes correctly; adding the separator is the foot-gun.
- Repo-relative paths (`--mutate packages/cli/src/x.ts`) match nothing:
  `pnpm --filter … exec` runs with cwd = the package dir, so Stryker reports
  `Instrumented 0 source file(s) with 0 mutant(s)` and **exits 0** — a gate that
  cannot fail. Each `stryker.config.mjs`'s own `mutate` array is
  package-relative (`'src/**/*.ts'`) for the same reason, and so are the scopes
  `scripts/lib/mutation-scope.mjs` emits for both the local runner and CI.

Note `incremental: true`: a stale `reports/stryker-incremental.json` can print a
plausible aggregate over a zero-mutant run — pass `--force` (as
`test:mutate:changed` does) so a hand-run scope is actually executed rather than
replayed. **Core is included in the per-PR matrix**, as one shard per changed
file; that workflow is advisory (`continue-on-error` throughout, no required
check), so it reports but never blocks.

**A killed run leaves that report poisoned, and the next run hangs rather than
failing.** If you `pkill` a run mid-flight (or it dies with workers live), the
partially-written `stryker-incremental.json` makes every subsequent scoped run
stall — measured on `output-channels.ts`: a scope that had just completed in
seconds stopped dead at 4/20 mutants with the ETA climbing past 17m,
reproducibly, across two different scopes and at both concurrency 1 and 2.
`--force` does not rescue this; it forces re-execution but the report is still
read first. The fix is to delete the report and re-run:

```bash
rm -f packages/<pkg>/reports/stryker-incremental.json
```

It is gitignored and regenerated by the next run, so deleting it costs only the
incremental reuse of a baseline the kill had already corrupted. Reach for this
whenever a scoped run that should take seconds is still going after a minute —
the symptom is a stall, not an error, so nothing tells you.

## CI and the dashboard baseline

The changed-code gates are the whole day-to-day signal.
`pnpm run test:mutate:changed` locally and the advisory per-PR check
(`.github/workflows/mutation-pr.yml`) are what you act on. The full-fidelity
producer (`.github/workflows/mutation.yml`) is **`workflow_dispatch`-only and
deliberately occasional** — an operator runs it to seed the Stryker dashboard
baseline the PR check diffs against, and the baseline going stale for weeks is
the expected state, not a gap. Its `push`-to-main trigger and weekly cron were
deleted (issue #670): the push run planned differentially, so it could never
upload a baseline and only re-measured the diff the PR gate had already scored,
and five weekly campaigns produced zero `core` and zero `parser` reports. **Do
not add an automatic trigger back**, and do not treat a stale dashboard as a
reason to start a campaign locally — a full campaign is ~40,000 mutants and ~70
machine-hours.

Numbers worth carrying, all measured (details in
[docs/internal/mutation-testing-ci.md](mutation-testing-ci.md)):

- **0.46 mutants per source line** across the tree (0.39–0.60 per package). That
  is the only reliable way to estimate a scope's size; absolute mutant counts go
  stale fast (core grew 53% in five weeks).
- **Throughput spans 5.55–78 mutants/min and line count does not predict it.**
  Two core shards of essentially identical size (5860 and 5855 lines) ran 4.9x
  apart, because wall time follows `findRelatedTests` fan-out. Budget for the
  slow end.
- **Total campaign work is flat in the shard budget** — sharding trades setup
  overhead for a shorter tail. The producer is sized at 2400 lines/shard, which
  plans **60 jobs** today → ~66 machine-hours, a 240-minute job cap, 3 waves of
  this account's 20 concurrent job slots. Finer sharding buys nothing but waves
  that starve PR CI. `MAX_SHARD_JOBS` (80) is the **ceiling** at which the
  planner widens the budget, deliberately above the plan so core's growth does
  not immediately lengthen the tail.
