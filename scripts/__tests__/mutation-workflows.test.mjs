import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const read = (p) => readFile(new URL(`../../${p}`, import.meta.url), 'utf-8');

test('mutation-pr.yml runs the advisory gate with ignoreStatic on', async () => {
  const yml = await read('.github/workflows/mutation-pr.yml');
  assert.match(yml, /STRYKER_IGNORE_STATIC:\s*'true'/, 'PR run must opt into ignoreStatic');
  assert.match(
    yml,
    /- name: Run source mutation shard[\s\S]*?continue-on-error:\s*true/,
    'Stryker advisory run must be non-fatal',
  );
  assert.match(
    yml,
    /- name: Score changed files \(advisory\)[\s\S]*?continue-on-error:\s*true/,
    'advisory scoring must be non-fatal',
  );
  // Verify the baseline is fetched from the Stryker dashboard by extracting the
  // URL and comparing its parsed host exactly. We deliberately avoid a
  // substring/regex check against a URL-shaped literal: CodeQL flags those as
  // incomplete URL sanitization (js/incomplete-url-substring-sanitization /
  // js/regex/missing-regexp-anchor), and exact host comparison after `new URL()`
  // is both the query's recommended pattern and a stronger assertion.
  // Scope the extraction to the baseline-download step so an unrelated `url=`
  // elsewhere in the workflow can't satisfy this assertion. The pattern carries
  // no URL/host literal, so it stays clear of CodeQL's URL queries.
  const baselineUrl = yml.match(
    /name: Download Stryker baseline from dashboard[\s\S]*?url="([^"]+)"/,
  )?.[1];
  assert.ok(baselineUrl, 'PR run must define a baseline download URL');
  assert.equal(
    new URL(baselineUrl).hostname,
    'dashboard.stryker-mutator.io',
    'PR run must download the baseline from the Stryker dashboard',
  );
  assert.ok(
    new URL(baselineUrl).pathname.startsWith('/api/reports/'),
    'baseline must use the dashboard report API path',
  );
  assert.doesNotMatch(
    yml,
    /STRYKER_DASHBOARD_API_KEY/,
    'PR workflow must not reference the upload secret',
  );
});

test('mutation-pr.yml implements the hybrid source and native test-only paths', async () => {
  const yml = await read('.github/workflows/mutation-pr.yml');
  assert.match(yml, /matrix\.kind == 'source'/);
  assert.match(yml, /matrix\.kind == 'test-only'/);
  assert.match(yml, /Run native incremental test-only shard/);
  assert.match(yml, /assert-mutation-regressions\.mjs/);
  assert.match(yml, /mutation:related/);
  assert.match(yml, /test_scope:/);
  assert.match(yml, /STRYKER_SCOPED:\s*'true'/);
  assert.doesNotMatch(yml, /--allowEmpty/);
});

// REGRESSION (P2): the plan job uploaded its scope notice as
// `mutation-summary-plan`, and the comment job downloads shard summaries with
// `pattern: mutation-summary-*` — which matched it. On any successful plan
// `ls summaries/*.md` therefore ALWAYS succeeded, making every branch below it
// dead code: the PLAN_EMPTY no-op, the download-failure warning, and the
// planned-but-no-summaries warning. The anti-masking guarantee the tests above
// assert the *text* of was never actually in force.
test('mutation-pr.yml keeps the plan notice out of the shard-summary download', async () => {
  const yml = await read('.github/workflows/mutation-pr.yml');

  // Anchored on the JOB, not a step title: what matters is that whatever the
  // plan job uploads cannot be swept up by the shard-summary glob.
  const planJob = /\n {2}plan:\n([\s\S]*?)\n {2}\w[\w-]*:\n/.exec(yml)?.[1];
  assert.ok(planJob, 'mutation-pr.yml must have a plan job');
  const planArtifact = /upload-artifact@[\s\S]*?\n\s*name:\s*(\S+)/.exec(planJob)?.[1];
  const downloadPattern = /\n\s*pattern:\s*(\S+)/.exec(yml)?.[1];
  assert.ok(planArtifact, 'plan job must upload its scope notice as an artifact');
  assert.ok(downloadPattern, 'comment job must download shard summaries by pattern');

  const matcher = new RegExp(`^${downloadPattern.replaceAll('*', '.*')}$`);
  assert.ok(
    !matcher.test(planArtifact),
    `the shard-summary pattern '${downloadPattern}' must not also match the plan ` +
      `notice '${planArtifact}', or the no-summaries branches can never run`,
  );
});

test('mutation-pr.yml still surfaces the plan notice in the comment', async () => {
  const yml = await read('.github/workflows/mutation-pr.yml');
  assert.match(
    yml,
    /- name: Download scope plan notice/,
    'the plan notice needs its own download now that it is not a shard summary',
  );
  assert.match(
    yml,
    /cat plan\/[^\n]*\.md/,
    'the assembled comment must still include the plan notice',
  );
});

// `labeled`/`unlabeled` exist so `mutation:related` can be applied without a
// push. Left unguarded they also pay a full plan + shard matrix for every
// unrelated label added or removed on any PR.
test('mutation-pr.yml ignores label churn that cannot change the plan', async () => {
  const yml = await read('.github/workflows/mutation-pr.yml');
  assert.match(yml, /types:\s*\[[^\]]*\blabeled\b[^\]]*\]/, 'the label must be actionable');

  const guard =
    /github\.event\.action != 'labeled'\s*&&\s*github\.event\.action != 'unlabeled'\s*\|\|\s*github\.event\.label\.name == 'mutation:related'/;
  const job = (name) =>
    new RegExp(`\\n {2}${name}:\\n([\\s\\S]*?)(?=\\n {2}\\w[\\w-]*:\\n|$)`).exec(yml)?.[1];

  for (const name of ['plan', 'comment']) {
    const block = job(name);
    assert.ok(block, `mutation-pr.yml must have a ${name} job`);
    assert.match(block, guard, `${name} must not run for an unrelated label event`);
  }
});

// LABEL is a space-joined list of paths from the PR's own diff. The JS scorers
// HTML-escape everything they render; these shell-written diagnostics did not,
// so a path containing a backtick escaped its code span in the posted comment.
test('mutation-pr.yml never puts a raw PR path inside a markdown code span', async () => {
  const yml = await read('.github/workflows/mutation-pr.yml');
  assert.doesNotMatch(
    yml,
    /`\$\{LABEL\}`/,
    'LABEL must be sanitized before it is wrapped in backticks',
  );
  assert.match(yml, /LABEL_MD=/, 'the sanitized form is what the diagnostics must render');
});

test('mutation-pr.yml uploads per-package markdown summaries', async () => {
  const yml = await read('.github/workflows/mutation-pr.yml');
  assert.match(
    yml,
    /mutation-summary-/,
    'PR run must upload a per-package markdown summary artifact',
  );
});

test('mutation-pr.yml posts a single sticky advisory comment', async () => {
  const yml = await read('.github/workflows/mutation-pr.yml');
  assert.match(yml, /sticky-pull-request-comment/, 'must use a sticky comment action');
  assert.match(yml, /header:\s*mutation-advisory/, 'sticky comment must use a stable header');
  assert.match(yml, /pull-requests:\s*write/, 'comment job needs pull-requests: write');
});

test('mutation-pr.yml distinguishes a failed summary download from a genuine no-op', async () => {
  const yml = await read('.github/workflows/mutation-pr.yml');
  // The download step must be addressable (id) and stay non-fatal so the comment
  // job still runs when the artifact download fails.
  assert.match(
    yml,
    /- name: Download advisory summaries\n\s*id: download\b/,
    'download step must have an id so its outcome can be inspected',
  );
  assert.match(
    yml,
    /- name: Download advisory summaries[\s\S]*?continue-on-error:\s*true/,
    'download step must stay non-fatal (continue-on-error) so the comment still posts',
  );
  // The assemble step reads the download outcome via env (never interpolated
  // into the run: script) and branches on it so a download failure surfaces a
  // distinct message rather than the clean "no mutated changed files" no-op.
  assert.match(
    yml,
    /- name: Assemble comment body\n\s*env:\n\s*DOWNLOAD_OUTCOME:\s*\$\{\{\s*steps\.download\.outcome\s*\}\}/,
    'assemble step must read steps.download.outcome via env (no run: interpolation)',
  );
  assert.match(
    yml,
    /PLAN_OUTCOME:\s*\$\{\{\s*needs\.plan\.result\s*\}\}/,
    'assemble step must receive the plan job result through env',
  );
  assert.match(
    yml,
    /if \[ "\$\{PLAN_OUTCOME\}" != "success" \]; then[\s\S]*Mutation scope planning failed[\s\S]*elif \[ "\$\{PLAN_EMPTY\}" = "true" \]; then/,
    'plan failure must be reported before empty/download/no-summary fallbacks',
  );
  assert.match(
    yml,
    /elif \[ "\$\{DOWNLOAD_OUTCOME\}" != "success" \]; then/,
    'assemble step must branch on a non-success download outcome',
  );
  assert.match(
    yml,
    /Could not download advisory summaries \(download step: \$\{DOWNLOAD_OUTCOME\}\)/,
    'failure branch must emit the advisory download-warning message',
  );
  // The advisory no-op message stays for the genuine zero-summary case, and it
  // must be gated on the PLANNER having found nothing — not merely on there
  // being no summaries. Planned-but-no-summaries is a failure, and reporting it
  // as "nothing changed" is exactly the masking this test exists to prevent.
  assert.match(yml, /No mutated source changes in this PR\./);
  assert.match(
    yml,
    /elif \[ "\$\{PLAN_EMPTY\}" = "true" \]; then/,
    'the no-op message must be gated on the planner finding no scope',
  );
  assert.match(
    yml,
    /- name: Assemble comment body\n\s*env:\n(?:\s*\w+:.*\n)*?\s*PLAN_EMPTY:\s*\$\{\{\s*needs\.plan\.outputs\.empty\s*\}\}/,
    'assemble step must read the planner outcome via env (no run: interpolation)',
  );
});

test('mutation.yml is the full-fidelity producer (no ignoreStatic, shards score static)', async () => {
  const yml = await read('.github/workflows/mutation.yml');
  assert.doesNotMatch(
    yml,
    /STRYKER_IGNORE_STATIC:/,
    'producer must score static mutants (no ignoreStatic env assignment)',
  );
  assert.doesNotMatch(yml, /--allowEmpty/);
});

// The producer is DISPATCH-ONLY (issue #670). Both automatic triggers were
// deleted because they cost machine-hours and produced nothing:
//   - `push: branches: [main]` planned differentially, so its merge was partial
//     by construction and the upload gate could never publish it; it re-measured
//     the diff mutation-pr.yml had already scored. 98 runs, ~84 machine-hours,
//     28 cancelled at exactly 61 minutes.
//   - the weekly cron produced ZERO core and ZERO parser shard reports across
//     five campaigns; core/cli/parser still 404 on the dashboard.
// Anchored on the `on:` block alone, so the word "push"/"schedule" appearing in
// a comment or a step cannot satisfy or defeat it.
test('mutation.yml runs only on workflow_dispatch — no push, no cron', async () => {
  const yml = await read('.github/workflows/mutation.yml');
  const on = /\non:\n([\s\S]*?)\n\w/.exec(yml)?.[1];
  assert.ok(on, 'mutation.yml must declare an `on:` block');
  assert.match(on, /^\s{2}workflow_dispatch:/m, 'an operator must still be able to run it');
  assert.doesNotMatch(
    on,
    /^\s{2}push:/m,
    'a push producer run can never upload (its plan is partial) and duplicates the PR gate',
  );
  assert.doesNotMatch(
    on,
    /^\s{2}schedule:/m,
    'the weekly cron never once produced a core or parser report; the baseline is dispatch-seeded',
  );
});

// A shard measures a fraction of a module, so `thresholds.break` on a shard
// judges a partial score. STRYKER_SCOPED is the existing seam that nulls it (the
// PR gate and scripts/mutate-changed.mjs both use it), which leaves a non-zero
// Stryker exit meaning an execution failure rather than a low partial score.
test('mutation.yml runs shards scoped, so no shard is failed by a partial score', async () => {
  const yml = await read('.github/workflows/mutation.yml');
  const mutateJob = yml.match(/\n {2}mutate:\n([\s\S]*?)\n {2}merge:/)?.[1];
  assert.ok(mutateJob, 'mutate job must precede merge job');
  assert.match(mutateJob, /STRYKER_SCOPED:\s*'true'/);
});

test('mutation.yml shards the campaign across a plan/mutate/merge pipeline', async () => {
  const yml = await read('.github/workflows/mutation.yml');
  // The shard matrix is computed by the plan job and consumed by the mutate job.
  assert.match(yml, /\bplan:\s*\n/, 'must define a plan job');
  assert.match(yml, /\bmutate:\s*\n/, 'must define a mutate job');
  assert.match(yml, /\bmerge:\s*\n/, 'must define a merge job');
  assert.match(
    yml,
    /matrix:\s*\$\{\{\s*fromJson\(needs\.plan\.outputs\.matrix\)\s*\}\}/,
    'mutate must run the plan job matrix',
  );
  assert.match(yml, /node scripts\/mutation-shard-plan\.mjs/, 'plan must run the shard planner');
  assert.match(
    yml,
    /node scripts\/mutation-merge-reports\.mjs/,
    'merge must run the report merger',
  );
  // Concurrency is decided per shard by the planner from the size of the file
  // being mutated (see partitionProducerFiles); a flat literal here would be the
  // hand-rolled second policy the shared threshold exists to prevent.
  assert.match(
    yml,
    /STRYKER_CONCURRENCY:\s*\$\{\{\s*matrix\.concurrency\s*\}\}/,
    'shard concurrency must come from the plan matrix, not a flat literal',
  );
});

// REGRESSION (#670): both timeouts were 60, and the job clock starts ~3 min
// before the Stryker step — so the JOB cap always fired first and CANCELLED the
// job. Stryker writes its report only on completion, so the shard then vanished
// from the merged report entirely. The step cap must be STRICTLY below the job
// cap, or the graceful path (step fails, status and upload steps still run) is
// unreachable and raising the job cap alone changes nothing.
test('mutation.yml caps the shard step strictly below the job, so a slow shard fails gracefully', async () => {
  const yml = await read('.github/workflows/mutation.yml');
  const mutateJob = yml.match(/\n {2}mutate:\n([\s\S]*?)\n {2}merge:/)?.[1];
  assert.ok(mutateJob, 'mutate job must precede merge job');
  const jobTimeout = Number(/^\s{4}timeout-minutes:\s*(\d+)/m.exec(mutateJob)?.[1]);
  const stepTimeout = Number(
    /- name: Run mutation shard[\s\S]*?timeout-minutes:\s*(\d+)/.exec(mutateJob)?.[1],
  );
  assert.ok(Number.isInteger(jobTimeout), 'mutate job must declare a timeout');
  assert.ok(Number.isInteger(stepTimeout), 'the shard step must declare a timeout');
  assert.ok(
    stepTimeout < jobTimeout,
    `shard step timeout ${stepTimeout} must be below the job timeout ${jobTimeout}, ` +
      'or the job is cancelled before the step can fail and record a status',
  );
  // GitHub's hard per-job maximum. A larger value is not rejected at parse time;
  // the job is simply killed at 360 anyway, which reintroduces the cancellation
  // this whole inequality exists to avoid.
  assert.ok(
    jobTimeout <= 360,
    `mutate job timeout ${jobTimeout} exceeds GitHub's 360-minute per-job maximum`,
  );
  // The 2400-line budget projects a ~179-min worst-case core shard against the
  // slowest rate ever measured (5.55 mutants/min). A step cap under that would
  // kill the tail the coarser budget was chosen to accommodate.
  assert.ok(
    stepTimeout >= 180,
    `shard step timeout ${stepTimeout} is below the ~179-min projected worst-case shard`,
  );
});

// Issue #670 item 3. Stryker writes no report when it is killed, so absence is
// the only signal a shard leaves behind — and absence alone cannot distinguish
// "ran and found nothing" from "never finished". A status artifact, written on
// every exit path and merged separately, is what closes that gap.
test('mutation.yml records and ships a status for every shard, measured or not', async () => {
  const yml = await read('.github/workflows/mutation.yml');
  const mutateJob = yml.match(/\n {2}mutate:\n([\s\S]*?)\n {2}merge:/)?.[1];
  assert.ok(mutateJob);
  assert.match(
    mutateJob,
    /- name: Record shard status\n\s*if: \$\{\{ always\(\) \}\}/,
    'the status must be recorded on every exit path, including a cancelled job',
  );
  assert.match(mutateJob, /node scripts\/mutation-shard-status\.mjs/);
  assert.match(mutateJob, /tee "\$SHARD_LOG"/, 'the shard log is the only source of progress');
  assert.match(
    mutateJob,
    /- name: Upload shard status\n\s*if: \$\{\{ always\(\) \}\}/,
    'the status must upload even when the shard produced no report',
  );

  // The status artifact must not be swept up by the report glob, or the merge
  // would count a status as a measured shard.
  const statusArtifact = /name: mutation-status-\$\{\{[^\n]*\}\}/.exec(yml)?.[0];
  assert.ok(statusArtifact, 'status upload must name a mutation-status-* artifact');
  assert.doesNotMatch(statusArtifact, /mutation-report-/);
  assert.match(
    yml,
    /- name: Download shard statuses[\s\S]*?pattern: mutation-status-\*/,
    'the merge job must download the statuses it reports from',
  );
  assert.match(yml, /STATUS_DIR:\s*shard-status/, 'the merger needs the status directory');
});

test('mutation.yml shards never upload; only a merge on main seeds the baseline', async () => {
  const yml = await read('.github/workflows/mutation.yml');
  // The shard (mutate) job must not carry the dashboard key — a scoped shard
  // report would overwrite the baseline with a partial one.
  const mutateJob = yml.match(/\n {2}mutate:\n([\s\S]*?)\n {2}merge:/)?.[1];
  assert.ok(mutateJob, 'mutate job must precede merge job');
  assert.doesNotMatch(
    mutateJob,
    /STRYKER_DASHBOARD_API_KEY|DASHBOARD_API_KEY/,
    'shards must not reference the dashboard key (they must not upload)',
  );
  // The producer shards the FULL scope, so its merge is a complete per-module
  // report — but only from main. Gating the KEY (not just a flag) means a
  // feature-branch dispatch physically cannot push to the dashboard. The
  // event_name half is redundant while dispatch is the only trigger and is kept
  // so re-adding an automatic trigger cannot silently re-open the upload path.
  assert.match(
    yml,
    /DASHBOARD_API_KEY:\s*\$\{\{\s*\(github\.ref == 'refs\/heads\/main' && github\.event_name == 'workflow_dispatch'\) && secrets\.STRYKER_DASHBOARD_API_KEY/,
    'merge must gate the upload key on refs/heads/main AND the dispatch event',
  );
});

// REGRESSION (#670): `thresholds.break: 70` was above every score a module has
// ever achieved on a completed campaign (plugin 66.17%, cli 64.51%), so the
// producer exited 1 even when it did everything right. The merged aggregate is
// the only complete module score in the system, so it is the only place the
// floor belongs — and it must sit below the measurements that exist.
test('mutation.yml applies an aggregate floor below every measured module score', async () => {
  const yml = await read('.github/workflows/mutation.yml');
  const floor = Number(/^\s*BREAK:\s*'(\d+)'/m.exec(yml)?.[1]);
  assert.ok(Number.isInteger(floor), 'the merge must pin an explicit aggregate break floor');
  assert.ok(
    floor < 64.51,
    `aggregate floor ${floor} is at or above cli's measured 64.51%, so a flawless campaign fails`,
  );
  assert.ok(floor > 0, 'a floor of 0 is not a floor');
});

void repoRoot;
