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
    /- name: Run mutation tests[\s\S]*?continue-on-error:\s*true/,
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
    /elif \[ "\$\{DOWNLOAD_OUTCOME\}" != "success" \]; then/,
    'assemble step must branch on a non-success download outcome',
  );
  // The advisory no-op message stays for the genuine zero-summary case.
  assert.match(yml, /No mutated changed files in this PR\./);
});

test('mutation.yml is the full-fidelity producer (no ignoreStatic, uploads to dashboard)', async () => {
  const yml = await read('.github/workflows/mutation.yml');
  assert.doesNotMatch(
    yml,
    /STRYKER_IGNORE_STATIC:/,
    'producer must score static mutants (no ignoreStatic env assignment)',
  );
  assert.match(
    yml,
    /STRYKER_DASHBOARD_API_KEY/,
    'producer must pass the dashboard API key for upload',
  );
  // The upload key must be gated on automated main-branch runs so an ad-hoc
  // workflow_dispatch (possibly off a feature branch) cannot overwrite the
  // canonical baseline. Match the exact boolean grouping — the ref AND the
  // parenthesized (schedule || push) event group — so the test also fails on a
  // mis-grouping (e.g. && between the events, which is always false) rather than
  // only on a dropped token.
  assert.match(
    yml,
    /STRYKER_DASHBOARD_API_KEY:\s*\$\{\{\s*\(github\.ref == 'refs\/heads\/main' && \(github\.event_name == 'schedule' \|\| github\.event_name == 'push'\)\) && secrets\.STRYKER_DASHBOARD_API_KEY/,
    'producer must gate the upload key on refs/heads/main AND (schedule || push)',
  );
  assert.match(
    yml,
    /push:\s*\n\s*branches:\s*\[main\]/,
    'producer must run on push to main to refresh the baseline',
  );
});

void repoRoot;
