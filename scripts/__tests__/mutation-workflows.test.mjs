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
  const baselineUrl = yml.match(/url="([^"]+)"/)?.[1];
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
  // canonical baseline. The key assignment carries the event/ref condition.
  assert.match(
    yml,
    /STRYKER_DASHBOARD_API_KEY:[^\n]*github\.event_name == 'schedule'[^\n]*secrets\.STRYKER_DASHBOARD_API_KEY/,
    'producer must gate the upload key on schedule/push main runs',
  );
  assert.match(
    yml,
    /push:\s*\n\s*branches:\s*\[main\]/,
    'producer must run on push to main to refresh the baseline',
  );
});

void repoRoot;
