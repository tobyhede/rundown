# Mutation Gate Advisory + Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve issue #485 by making the per-PR mutation check advisory (non-blocking), restoring exhaustive-run fidelity, and adopting the Stryker Dashboard as the cross-run incremental baseline and score-trend surface.

**Architecture:** Three roles, cleanly separated. (1) The **per-PR workflow** (`mutation-pr.yml`) becomes advisory: it downloads the public `main` baseline from the Stryker Dashboard, runs Stryker scoped to changed files with `ignoreStatic` on, computes per-file scores, and posts a single sticky PR comment — it never fails the job. (2) The **producer workflow** (`mutation.yml`) runs on push-to-main and weekly cron with `ignoreStatic` OFF (full fidelity), and uploads the full report to the dashboard (the baseline + trend). (3) The **Stryker configs** gate `ignoreStatic` behind an env var (default OFF) and enable the dashboard reporter only when the upload API key is present.

**Tech Stack:** StrykerJS (jest-runner), GitHub Actions, Node.js 24, pnpm, `node:test`, Stryker Dashboard (dashboard.stryker-mutator.io), `marocchino/sticky-pull-request-comment`.

## Global Constraints

- **Dashboard project slug:** `github.com/tobyhede/rundown` (exact, verbatim in every config).
- **Dashboard modules:** one per package — `parser`, `core`, `cli`, `plugin` (the `plugin` module maps to `packages/claude-code-plugin`).
- **Secret:** `STRYKER_DASHBOARD_API_KEY` is a GitHub Actions secret (added by the maintainer out-of-band). It is consumed **only** by the producer workflow (`mutation.yml`) for uploads. The PR workflow must never reference it — baseline download is an unauthenticated public GET.
- **`ignoreStatic` policy:** ON for the advisory PR run only (via `STRYKER_IGNORE_STATIC=true`); OFF everywhere else (default). The exhaustive producer run must score static mutants.
- **GitHub Actions are SHA-pinned** with a `# vN` version comment. Never use a floating tag. Resolve new action SHAs with `gh api` (Task 0).
- **CLI output is JSON by default**; this plan touches CI/scripts only, not CLI command output.
- **No persisted-state migration** concerns apply here (no `.rundown/` state touched).
- Run `pnpm run verify` before any push (format, spell, lint, test).

---

## File Structure

| File | Role | Change |
| --- | --- | --- |
| `packages/{parser,core,cli,claude-code-plugin}/stryker.config.mjs` | Stryker config per package | Env-gate `ignoreStatic` (default false); add conditional `dashboard` reporter + `dashboard` config block (module per package) |
| `scripts/__tests__/stryker-config.test.mjs` | Config invariants (node:test) | Add `ignoreStatic` default/env tests and dashboard-reporter/config tests |
| `scripts/assert-mutation-score.mjs` | Per-file score gate | Add `renderMarkdown()` + `--markdown` / `--package-name` flags; preserve existing exit codes |
| `scripts/__tests__/assert-mutation-score.test.mjs` | Gate unit tests (node:test) | Add `renderMarkdown()` tests |
| `.github/workflows/mutation-pr.yml` | Per-PR advisory check | Rewrite: dashboard baseline download, scoped incremental run, `ignoreStatic=true`, non-fatal steps, write+upload per-package markdown; add aggregation job posting one sticky comment |
| `.github/workflows/mutation.yml` | Exhaustive producer | Add `push: [main]` trigger, dashboard upload (key present), `ignoreStatic` OFF, `--force` on cron; keep weekly + dispatch |
| `scripts/__tests__/mutation-workflows.test.mjs` | New workflow-content invariants (node:test) | Pin the fidelity split (PR sets `STRYKER_IGNORE_STATIC: 'true'`; producer never sets it) and advisory non-fatal markers |
| `docs/internal/mutation-testing-ci.md` | New descriptive doc | Document the current strategy + the declined options (merge-queue, actions/cache) with rationale |

---

## Task 0: Resolve and pin new action SHAs

**Files:**
- (none yet — this task records SHAs used by Tasks 4–5)

**Interfaces:**
- Produces: two pinned `uses:` lines (download-artifact, sticky-pull-request-comment) referenced verbatim in Tasks 4 and 5.

- [ ] **Step 1: Resolve `actions/download-artifact` v7 SHA**

Run:
```bash
gh api repos/actions/download-artifact/git/refs/tags/v7 --jq '.object.sha'
```
Expected: a 40-char commit SHA. If the ref is a tag object (not a commit), dereference it:
```bash
gh api repos/actions/download-artifact/git/tags/$(gh api repos/actions/download-artifact/git/refs/tags/v7 --jq '.object.sha') --jq '.object.sha'
```
Record the resulting commit SHA as `DL_ARTIFACT_SHA`.

- [ ] **Step 2: Resolve `marocchino/sticky-pull-request-comment` v3.0.4 SHA**

Run:
```bash
gh api repos/marocchino/sticky-pull-request-comment/git/refs/tags/v3.0.4 --jq '.object.sha'
```
Expected: a 40-char commit SHA (dereference as in Step 1 if it points at a tag object). The shipped workflow pins `0ea0beb66eb9baf113663a64ec522f60e49231c0  # v3.0.4`. Record as `STICKY_SHA` and note the exact tag (`v3.0.4`) for the version comment.

- [ ] **Step 3: Record the values**

Write both SHAs and their version comments into the scratchpad (or a sticky note) so Tasks 4–5 use the exact strings, e.g.:
```
DL_ARTIFACT: actions/download-artifact@<DL_ARTIFACT_SHA>  # v7
STICKY:      marocchino/sticky-pull-request-comment@0ea0beb66eb9baf113663a64ec522f60e49231c0  # v3.0.4
```
No commit for this task.

---

## Task 1: Env-gate `ignoreStatic` (default OFF) in all four Stryker configs

**Files:**
- Modify: `packages/core/stryker.config.mjs`, `packages/parser/stryker.config.mjs`, `packages/cli/stryker.config.mjs`, `packages/claude-code-plugin/stryker.config.mjs`
- Test: `scripts/__tests__/stryker-config.test.mjs`

**Interfaces:**
- Consumes: `process.env.STRYKER_IGNORE_STATIC` (string `'true'`/`'1'` ⇒ true; unset/anything else ⇒ false).
- Produces: each config exports `ignoreStatic: boolean`, defaulting to `false` when the env var is unset.

- [ ] **Step 1: Add the failing tests**

In `scripts/__tests__/stryker-config.test.mjs`, add a generalized env-aware loader after the existing `loadConfig` function (around line 33):

```js
/**
 * Load a Stryker config with an arbitrary set of env vars temporarily applied.
 * Restores prior env values (including "unset") in a finally block.
 *
 * @param {string} configPath - repo-relative path to a stryker.config.mjs.
 * @param {Record<string, string | undefined>} env - env vars to apply; a value
 *   of `undefined` deletes the var for the duration of the load.
 * @returns {Promise<object>} the config module's default export.
 */
async function loadConfigWithEnv(configPath, env) {
  const keys = Object.keys(env);
  const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    const configUrl = pathToFileURL(join(repoRoot, configPath));
    configUrl.searchParams.set('case', `${JSON.stringify(env)}-${Date.now()}-${Math.random()}`);
    return (await import(configUrl.href)).default;
  } finally {
    for (const k of keys) {
      if (previous[k] === undefined) delete process.env[k];
      else process.env[k] = previous[k];
    }
  }
}
```

Then, inside the existing `for (const configPath of configs)` loop (after the `break` threshold test, ~line 56), add:

```js
  test(`${configPath} defaults ignoreStatic to false for exhaustive fidelity (issue #485)`, async () => {
    const config = await loadConfigWithEnv(configPath, { STRYKER_IGNORE_STATIC: undefined });
    // The producer run (mutation.yml) sets no env, so static mutants MUST be
    // scored there. Only the advisory PR run opts into ignoreStatic.
    assert.equal(
      config.ignoreStatic,
      false,
      `${configPath}: ignoreStatic must default to false (exhaustive run must score static mutants)`,
    );
  });

  test(`${configPath} enables ignoreStatic only when STRYKER_IGNORE_STATIC is truthy (issue #485)`, async () => {
    assert.equal((await loadConfigWithEnv(configPath, { STRYKER_IGNORE_STATIC: 'true' })).ignoreStatic, true);
    assert.equal((await loadConfigWithEnv(configPath, { STRYKER_IGNORE_STATIC: '1' })).ignoreStatic, true);
    assert.equal((await loadConfigWithEnv(configPath, { STRYKER_IGNORE_STATIC: 'false' })).ignoreStatic, false);
    assert.equal((await loadConfigWithEnv(configPath, { STRYKER_IGNORE_STATIC: '' })).ignoreStatic, false);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/__tests__/stryker-config.test.mjs`
Expected: FAIL — the new `ignoreStatic` tests fail because every config currently hardcodes `ignoreStatic: true`, so the default-false assertion fails.

- [ ] **Step 3: Add the boolean env parser to each config**

In each of the four `stryker.config.mjs` files, immediately after the existing `const concurrency = parsePositiveInteger(process.env.STRYKER_CONCURRENCY, 2);` line, add:

```js
/**
 * Parse a boolean-ish env value. Only 'true'/'1' enable the flag; unset or any
 * other value is the fallback. Keeps local `stryker run` conservative.
 *
 * @param {string | undefined} value - the raw env value.
 * @param {boolean} fallback - value when unset/unrecognized.
 * @returns {boolean}
 */
const parseBoolean = (value, fallback) => {
  if (value === undefined) return fallback;
  return value === 'true' || value === '1';
};

// ignoreStatic is OFF by default so the exhaustive producer run (mutation.yml)
// scores static mutants at full fidelity. The advisory per-PR gate sets
// STRYKER_IGNORE_STATIC=true to reclaim the static-mutant time on a run whose
// false negatives are acceptable (it never blocks merge). See issue #485.
const ignoreStatic = parseBoolean(process.env.STRYKER_IGNORE_STATIC, false);
```

- [ ] **Step 4: Replace the hardcoded `ignoreStatic` block in each config**

In each of the four files, replace the existing `ignoreStatic` comment block and `ignoreStatic: true,` line with the single line:

```js
  ignoreStatic,
```

(The old comment — beginning `// Skip static mutants ...` and ending at `ignoreStatic: true,` — is now stale because it claims the trade-off "also affects the weekly exhaustive mutation.yml"; the explanatory comment now lives next to the `const ignoreStatic` declaration added in Step 3, so the inline block is removed.) Read each file first to capture its exact current block before replacing.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test scripts/__tests__/stryker-config.test.mjs`
Expected: PASS — all tests, including the new `ignoreStatic` default/env tests and the pre-existing concurrency/break/plugin tests.

- [ ] **Step 6: Commit**

```bash
git add packages/*/stryker.config.mjs packages/claude-code-plugin/stryker.config.mjs scripts/__tests__/stryker-config.test.mjs
git commit -m "fix(#485): env-gate ignoreStatic (default off) to restore exhaustive fidelity"
```

---

## Task 2: Add the conditional Stryker Dashboard reporter to all four configs

**Files:**
- Modify: `packages/core/stryker.config.mjs`, `packages/parser/stryker.config.mjs`, `packages/cli/stryker.config.mjs`, `packages/claude-code-plugin/stryker.config.mjs`
- Test: `scripts/__tests__/stryker-config.test.mjs`

**Interfaces:**
- Consumes: `process.env.STRYKER_DASHBOARD_API_KEY` (presence ⇒ enable upload), `process.env.STRYKER_DASHBOARD_VERSION` (optional explicit version; Stryker auto-detects from CI when unset).
- Produces: each config exports `reporters` including `'dashboard'` **iff** the API key env is set, and a `dashboard` object with `project` = `github.com/tobyhede/rundown`, `module` = the package's module name, `reportType: 'full'`.

**Module-name map (use the exact value per file):**
- `packages/parser/stryker.config.mjs` → `parser`
- `packages/core/stryker.config.mjs` → `core`
- `packages/cli/stryker.config.mjs` → `cli`
- `packages/claude-code-plugin/stryker.config.mjs` → `plugin`

- [ ] **Step 1: Add the failing tests**

In `scripts/__tests__/stryker-config.test.mjs`, add inside the `for (const configPath of configs)` loop:

```js
  test(`${configPath} omits the dashboard reporter when no API key is set`, async () => {
    const config = await loadConfigWithEnv(configPath, { STRYKER_DASHBOARD_API_KEY: undefined });
    assert.ok(
      Array.isArray(config.reporters) && !config.reporters.includes('dashboard'),
      `${configPath}: dashboard reporter must be off without STRYKER_DASHBOARD_API_KEY`,
    );
  });

  test(`${configPath} enables the dashboard reporter when the API key is set`, async () => {
    const config = await loadConfigWithEnv(configPath, { STRYKER_DASHBOARD_API_KEY: 'fake-key' });
    assert.ok(
      config.reporters.includes('dashboard'),
      `${configPath}: dashboard reporter must turn on when STRYKER_DASHBOARD_API_KEY is present`,
    );
  });

  test(`${configPath} pins the dashboard project and a full report type`, async () => {
    const config = await loadConfigWithEnv(configPath, { STRYKER_DASHBOARD_API_KEY: 'fake-key' });
    assert.equal(config.dashboard?.project, 'github.com/tobyhede/rundown');
    assert.equal(config.dashboard?.reportType, 'full');
    assert.ok(
      typeof config.dashboard?.module === 'string' && config.dashboard.module.length > 0,
      `${configPath}: dashboard.module must be a non-empty per-package module name`,
    );
  });
```

Add one module-specific assertion after the loop (so each module name is pinned):

```js
const expectedModules = {
  'packages/parser/stryker.config.mjs': 'parser',
  'packages/core/stryker.config.mjs': 'core',
  'packages/cli/stryker.config.mjs': 'cli',
  'packages/claude-code-plugin/stryker.config.mjs': 'plugin',
};
for (const [configPath, moduleName] of Object.entries(expectedModules)) {
  test(`${configPath} declares dashboard.module = ${moduleName}`, async () => {
    const config = await loadConfigWithEnv(configPath, { STRYKER_DASHBOARD_API_KEY: 'fake-key' });
    assert.equal(config.dashboard.module, moduleName);
  });
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/__tests__/stryker-config.test.mjs`
Expected: FAIL — configs have no `dashboard` block and `reporters` is a static array.

- [ ] **Step 3: Make the reporters list conditional in each config**

In each of the four files, replace the static reporters line:

```js
  reporters: ['progress', 'clear-text', 'html', 'json'],
```

with a computed list. Add this just above the `const config = {` declaration (after the `ignoreStatic` const from Task 1):

```js
// The dashboard reporter UPLOADS the report and requires an API key, so enable
// it only when one is present. The producer workflow (mutation.yml) sets the
// key; the advisory PR workflow does not (it only downloads the public
// baseline), so PR runs never upload partial, changed-file-scoped reports that
// would corrupt the dashboard baseline. See issue #485.
const reporters = ['progress', 'clear-text', 'html', 'json'];
if (process.env.STRYKER_DASHBOARD_API_KEY) reporters.push('dashboard');
```

and change the config property to reference it:

```js
  reporters,
```

- [ ] **Step 4: Add the `dashboard` config block in each config**

In each of the four files, add a `dashboard` property to the `config` object (place it next to `htmlReporter` / `jsonReporter`). Use the correct module name per the map above — example shown for `core`:

```js
  dashboard: {
    project: 'github.com/tobyhede/rundown',
    module: 'core',
    // version is auto-detected from the CI environment (branch/ref) when unset;
    // the producer workflow may pin it via STRYKER_DASHBOARD_VERSION.
    version: process.env.STRYKER_DASHBOARD_VERSION || undefined,
    reportType: 'full',
  },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test scripts/__tests__/stryker-config.test.mjs`
Expected: PASS — all config tests including the new dashboard tests and module-name assertions.

- [ ] **Step 6: Commit**

```bash
git add packages/*/stryker.config.mjs packages/claude-code-plugin/stryker.config.mjs scripts/__tests__/stryker-config.test.mjs
git commit -m "feat(#485): enable Stryker Dashboard reporter when API key present"
```

---

## Task 3: Add markdown summary output to the per-file gate script

**Files:**
- Modify: `scripts/assert-mutation-score.mjs`
- Test: `scripts/__tests__/assert-mutation-score.test.mjs`

**Interfaces:**
- Consumes: the existing `GateResult` shape `{ ok, failures, checked, skipped, floor }` produced by `assertMutationScore`.
- Produces: `export function renderMarkdown(result, packageName)` → markdown string; new CLI flags `--markdown <path>` and `--package-name <name>`. Exit codes are unchanged (0 pass, 1 below-floor, 2 usage/IO).

- [ ] **Step 1: Add the failing tests**

In `scripts/__tests__/assert-mutation-score.test.mjs`, add (adjust the import line to include `renderMarkdown` alongside the existing imports from `../assert-mutation-score.mjs`):

```js
test('renderMarkdown renders a table of checked, failed, and skipped files', () => {
  const md = renderMarkdown(
    {
      ok: false,
      failures: [{ file: 'src/a.ts', score: 42.5 }],
      checked: [{ file: 'src/b.ts', score: 91.0 }],
      skipped: [{ file: 'src/c.ts', reason: 'not mutated' }],
      floor: 70,
    },
    'core',
  );
  assert.match(md, /core/);
  assert.match(md, /floor 70%/);
  assert.match(md, /src\/a\.ts/);
  assert.match(md, /42\.50%/);
  assert.match(md, /src\/b\.ts/);
  assert.match(md, /91\.00%/);
  assert.match(md, /src\/c\.ts/);
  assert.match(md, /not mutated/);
});

test('renderMarkdown reports an empty state when nothing was scored', () => {
  const md = renderMarkdown(
    { ok: true, failures: [], checked: [], skipped: [], floor: 70 },
    'parser',
  );
  assert.match(md, /parser/);
  assert.match(md, /No mutated changed files/i);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/__tests__/assert-mutation-score.test.mjs`
Expected: FAIL — `renderMarkdown` is not exported / not defined.

- [ ] **Step 3: Implement `renderMarkdown` and wire the CLI flags**

In `scripts/assert-mutation-score.mjs`:

(a) Extend the fs import:
```js
import { readFileSync, writeFileSync } from 'node:fs';
```

(b) Add the exported function (place it after `assertMutationScore`):
```js
/**
 * Render a GateResult as a GitHub-flavored markdown fragment for a PR comment.
 *
 * @param {import('./assert-mutation-score.mjs').GateResult} result - the gate outcome.
 * @param {string} packageName - human label for the package/module (e.g. `core`).
 * @returns {string} a markdown fragment (no trailing newline).
 */
export function renderMarkdown(result, packageName) {
  const { checked, failures, skipped, floor, ok } = result;
  const status = ok ? '✅' : '⚠️';
  // Render interpolated values as HTML-escaped text wrapped in <code>. GitHub
  // renders the comment markdown to HTML, and backslash escapes do NOT work
  // inside a markdown code span, so a backtick in a file path would still break
  // a `...` span. Encoding `, |, <, >, & as HTML entities leaves nothing for the
  // markdown/table parser to misinterpret. Newlines are collapsed to spaces.
  const htmlEscape = (value) =>
    String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/`/g, '&#96;')
      .replace(/\|/g, '&#124;')
      .replace(/\r?\n/g, ' ');
  const codeCell = (value) => `<code>${htmlEscape(value)}</code>`;
  const lines = [`#### ${status} ${codeCell(packageName)} — per-file mutation score (floor ${floor}%)`, ''];
  if (checked.length === 0 && failures.length === 0 && skipped.length === 0) {
    lines.push('_No mutated changed files to score._');
    return lines.join('\n');
  }
  lines.push('| File | Score | Status |', '| --- | ---: | --- |');
  for (const f of failures) lines.push(`| ${codeCell(f.file)} | ${f.score.toFixed(2)}% | ❌ below floor |`);
  for (const c of checked) lines.push(`| ${codeCell(c.file)} | ${c.score.toFixed(2)}% | ✅ |`);
  for (const s of skipped) lines.push(`| ${codeCell(s.file)} | — | ⏭️ ${htmlEscape(s.reason)} |`);
  return lines.join('\n');
}
```

(c) In `parseArgs`, add the two flags (alongside the existing `--floor` handling):
```js
    else if (arg === '--markdown') opts.markdown = next();
    else if (arg === '--package-name') opts.packageName = next();
```

(d) In `main`, after `result` is computed and before the existing exit logic, write the markdown when requested:
```js
  if (opts.markdown) {
    try {
      writeFileSync(opts.markdown, renderMarkdown(result, opts.packageName ?? opts.packageDir));
    } catch (err) {
      console.error(`error: failed to write markdown summary ${opts.markdown}: ${err.message}`);
      return 2;
    }
  }
```

(The markdown is written for both pass and fail so the advisory comment always reflects the run.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/__tests__/assert-mutation-score.test.mjs`
Expected: PASS — all existing gate tests plus the two new `renderMarkdown` tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/assert-mutation-score.mjs scripts/__tests__/assert-mutation-score.test.mjs
git commit -m "feat(#485): add markdown summary output to per-file mutation gate"
```

---

## Task 4: Make `mutation-pr.yml` advisory with a dashboard baseline

**Files:**
- Modify: `.github/workflows/mutation-pr.yml`
- Test: `scripts/__tests__/mutation-workflows.test.mjs` (created here)

**Interfaces:**
- Consumes: `STRYKER_IGNORE_STATIC` (Task 1), `--markdown`/`--package-name` (Task 3), the public dashboard download endpoint.
- Produces: per-package markdown artifacts named `mutation-summary-<package>` (consumed by Task 5). The job never fails on a low score.

- [ ] **Step 1: Add the failing workflow-invariant tests**

Create `scripts/__tests__/mutation-workflows.test.mjs`:

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const read = (p) => readFile(new URL(`../../${p}`, import.meta.url), 'utf-8');

test('mutation-pr.yml runs the advisory gate with ignoreStatic on', async () => {
  const yml = await read('.github/workflows/mutation-pr.yml');
  assert.match(yml, /STRYKER_IGNORE_STATIC:\s*'true'/, 'PR run must opt into ignoreStatic');
  assert.match(yml, /continue-on-error:\s*true/, 'advisory steps must be non-fatal');
  // Substring check, not a regex: avoids CodeQL's url-anchor heuristic, which
  // can't be satisfied for a URL that sits mid-line in the YAML.
  assert.ok(yml.includes('https://dashboard.stryker-mutator.io/api/reports/'), 'PR run must download the dashboard baseline');
  assert.doesNotMatch(yml, /STRYKER_DASHBOARD_API_KEY/, 'PR workflow must not reference the upload secret');
});

test('mutation-pr.yml uploads per-package markdown summaries', async () => {
  const yml = await read('.github/workflows/mutation-pr.yml');
  assert.match(yml, /mutation-summary-/, 'PR run must upload a per-package markdown summary artifact');
});

void repoRoot;
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/__tests__/mutation-workflows.test.mjs`
Expected: FAIL — the current `mutation-pr.yml` has no `STRYKER_IGNORE_STATIC` env, no dashboard download, no `continue-on-error`, and uploads no summary.

- [ ] **Step 3: Rewrite `mutation-pr.yml`**

Replace the file contents with the advisory version below. (Differences from current: new header comment; job env adds `STRYKER_IGNORE_STATIC: 'true'`; the `actions/cache` step is replaced by a public dashboard baseline download; the Stryker run and the assert step are `continue-on-error: true` and the assert writes markdown; a new `mutation-summary-<pkg>` artifact is uploaded.)

```yaml
name: Mutation Gate (PR)

# Per-PR ADVISORY mutation report (issue #485).
#
# This check is advisory: it never blocks merge. It runs each affected package's
# mutation suite scoped to the PR's changed files (so runtime tracks change size),
# scores each changed file, and surfaces the result as a sticky PR comment (see
# the `comment` job). Static mutants are ignored here (STRYKER_IGNORE_STATIC) to
# keep the advisory run fast; the exhaustive producer run (mutation.yml) scores
# them at full fidelity. The incremental baseline is downloaded from the public
# Stryker Dashboard report for `main` — no API key is needed to read it, and this
# workflow deliberately never uploads (which would corrupt the baseline with a
# partial, changed-file-scoped report).

on:
  pull_request:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: mutation-pr-${{ github.ref }}
  cancel-in-progress: true

permissions: {}

jobs:
  mutation-gate:
    strategy:
      fail-fast: false
      matrix:
        # `module` always equals `package`, so it is derived from matrix.package
        # rather than duplicated (keeps this matrix in sync with mutation.yml).
        include:
          - package: parser
            dir: packages/parser
          - package: core
            dir: packages/core
          - package: cli
            dir: packages/cli
          - package: plugin
            dir: packages/claude-code-plugin
    runs-on: ubuntu-latest
    # Advisory: this is a guardrail against a runaway run wasting minutes, not a
    # merge gate. ignoreStatic + concurrency keep a scoped run well under it.
    timeout-minutes: 45
    env:
      STRYKER_CONCURRENCY: '4'
      # PR-only: reclaim static-mutant time on the advisory run. The producer
      # run leaves this unset so it scores static mutants. See issue #485.
      STRYKER_IGNORE_STATIC: 'true'
    permissions:
      contents: read

    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0  # v7.0.0
        with:
          persist-credentials: false
          # Full history so the merge-base with the PR base ref is reachable;
          # assert-mutation-score.mjs diffs `${base}...HEAD`.
          fetch-depth: 0

      # Resolve the PR base ref and compute whether this package has changed
      # source files. Skipping unaffected packages keeps the run cheap. Fails
      # CLOSED on git errors (see issue #483 for the rationale on the layout).
      - name: Detect changes for ${{ matrix.package }}
        id: changes
        env:
          BASE_REF: ${{ github.base_ref }}
          DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}
          EVENT_NAME: ${{ github.event_name }}
          PKG_DIR: ${{ matrix.dir }}
        run: |
          set -euo pipefail
          base="origin/${BASE_REF}"
          if [ "${EVENT_NAME}" = "workflow_dispatch" ]; then
            base="origin/${DEFAULT_BRANCH}"
          fi
          git rev-parse --verify --quiet "${base}^{commit}" >/dev/null \
            || { echo "::error::base ref '${base}' is unreachable; cannot score." >&2; exit 1; }
          git merge-base "${base}" HEAD >/dev/null \
            || { echo "::error::no merge-base between '${base}' and HEAD; cannot score." >&2; exit 1; }
          changed_files="$(git diff --name-only --diff-filter=d "${base}...HEAD" -- "${PKG_DIR}/src")"
          if [ -n "${changed_files}" ]; then
            echo "changed=true" >> "$GITHUB_OUTPUT"
            pkg_rel="$(printf '%s\n' "${changed_files}" | sed "s#^${PKG_DIR}/##")"
            excludes="$(cd "${PKG_DIR}" && node --input-type=module -e 'import("./stryker.config.mjs").then((m) => { const c = m.default ?? m.config ?? {}; process.stdout.write((c.mutate ?? []).filter((p) => p.startsWith("!")).join("\n")); });')" \
              || { echo "::error::failed to read mutate exclusions from ${PKG_DIR}/stryker.config.mjs" >&2; exit 1; }
            mutate="$(printf '%s\n%s\n' "${pkg_rel}" "${excludes}" | sed '/^[[:space:]]*$/d' | paste -sd, -)"
            echo "mutate=${mutate}" >> "$GITHUB_OUTPUT"
          else
            echo "changed=false" >> "$GITHUB_OUTPUT"
            echo "No source changes under ${PKG_DIR}/src; skipping advisory run."
          fi
          echo "base=${base}" >> "$GITHUB_OUTPUT"

      - uses: ./.github/actions/setup-node-deps
        if: ${{ steps.changes.outputs.changed == 'true' }}
        with:
          node-version: 24

      - name: Build
        if: ${{ steps.changes.outputs.changed == 'true' }}
        run: pnpm run build

      # Download the public `main` baseline so incremental mode can reuse
      # unchanged results. Best-effort: a 404/empty body degrades to a cold
      # incremental run (still bounded by --mutate scoping). No API key needed —
      # OSS dashboard reports are public reads.
      - name: Download Stryker baseline from dashboard
        if: ${{ steps.changes.outputs.changed == 'true' }}
        env:
          MODULE: ${{ matrix.package }}
          PKG_DIR: ${{ matrix.dir }}
        run: |
          set -uo pipefail
          mkdir -p "${PKG_DIR}/reports"
          baseline="${PKG_DIR}/reports/stryker-incremental.json"
          url="https://dashboard.stryker-mutator.io/api/reports/github.com/tobyhede/rundown/main?module=${MODULE}"
          # A 200 with an empty or truncated body must not be trusted as a
          # baseline: require a non-empty file AND valid JSON before keeping it,
          # otherwise fall through to a cold incremental run.
          if curl --fail --silent --show-error --max-time 60 \
               --output "${baseline}" "${url}" \
               && [ -s "${baseline}" ] \
               && node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "${baseline}"; then
            echo "Baseline downloaded for module ${MODULE}."
          else
            echo "::notice::no dashboard baseline for module ${MODULE}; running cold incremental."
            rm -f "${baseline}"
          fi

      # Advisory run: scoped to changed files, incremental, never fatal.
      - name: Run mutation tests (${{ matrix.package }})
        id: stryker
        if: ${{ steps.changes.outputs.changed == 'true' }}
        continue-on-error: true
        env:
          MUTATE: ${{ steps.changes.outputs.mutate }}
        run: pnpm exec stryker run --incremental --mutate "${MUTATE}" --allowEmpty
        working-directory: ${{ matrix.dir }}

      # Score changed files and render the advisory markdown. Non-fatal: a
      # below-floor file annotates the comment, it does not fail the check.
      - name: Score changed files (advisory)
        id: assert
        if: ${{ steps.changes.outputs.changed == 'true' }}
        continue-on-error: true
        env:
          PKG_DIR: ${{ matrix.dir }}
          BASE: ${{ steps.changes.outputs.base }}
          PKG: ${{ matrix.package }}
        run: |
          pnpm run assert:mutation-score -- \
            --report "${PKG_DIR}/reports/mutation/mutation-report.json" \
            --package-dir "${PKG_DIR}" \
            --base "${BASE}" \
            --floor 70 \
            --package-name "${PKG}" \
            --markdown "${RUNNER_TEMP}/mutation-summary-${PKG}.md"

      # If Stryker or scoring failed, no markdown summary was written and the
      # comment job would otherwise report a clean "no mutated changed files"
      # result — masking the failure. Write a diagnostic summary so the sticky
      # comment surfaces the failure. Advisory: never fails the job. Runs before
      # the upload step so the diagnostic gets included in the artifact.
      #
      # A below-floor file makes the scorer exit non-zero *after* writing a valid
      # score table, so `assert.outcome == 'failure'` does not mean "no summary".
      # Only write the generic diagnostic when no non-empty summary exists, so we
      # never clobber the below-floor annotation the gate exists to surface.
      - name: Diagnose advisory failure (${{ matrix.package }})
        if: ${{ steps.changes.outputs.changed == 'true' && (steps.stryker.outcome == 'failure' || steps.assert.outcome == 'failure') }}
        env:
          PKG: ${{ matrix.package }}
        run: |
          set -euo pipefail
          summary="${RUNNER_TEMP}/mutation-summary-${PKG}.md"
          if [ -s "${summary}" ]; then
            exit 0
          fi
          {
            echo "#### ⚠️ \`${PKG}\` — advisory mutation scoring did not complete"
            echo
            echo "_The mutation run or scoring step failed. This is advisory and does not block merge. See the workflow logs for details._"
          } > "${summary}"

      - name: Upload advisory summary
        if: ${{ always() && steps.changes.outputs.changed == 'true' }}
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a  # v7
        with:
          name: mutation-summary-${{ matrix.package }}
          path: ${{ runner.temp }}/mutation-summary-${{ matrix.package }}.md
          if-no-files-found: ignore
          retention-days: 7

      - name: Upload mutation report
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a  # v7
        if: ${{ always() && steps.changes.outputs.changed == 'true' }}
        with:
          name: mutation-report-${{ matrix.package }}
          path: ${{ matrix.dir }}/reports/mutation/
          retention-days: 30
```

(The `comment` job is added in Task 5.)

- [ ] **Step 4: Run the workflow-invariant tests to verify they pass**

Run: `node --test scripts/__tests__/mutation-workflows.test.mjs`
Expected: PASS.

- [ ] **Step 5: Lint the workflow**

Run: `actionlint .github/workflows/mutation-pr.yml`
Expected: no output (clean). If `actionlint` is not installed, install it (`brew install actionlint`) or fall back to a YAML syntax check:
`python3 -c "import yaml; yaml.safe_load(open('.github/workflows/mutation-pr.yml'))"` (expected: no error).

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/mutation-pr.yml scripts/__tests__/mutation-workflows.test.mjs
git commit -m "fix(#485): make the per-PR mutation check advisory with a dashboard baseline"
```

---

## Task 5: Post one sticky PR comment aggregating the package summaries

**Files:**
- Modify: `.github/workflows/mutation-pr.yml` (add a `comment` job)
- Test: `scripts/__tests__/mutation-workflows.test.mjs`

**Interfaces:**
- Consumes: the `mutation-summary-<package>` artifacts from Task 4; the SHAs from Task 0.
- Produces: a single sticky PR comment with header `mutation-advisory`.

- [ ] **Step 1: Add the failing test**

Append to `scripts/__tests__/mutation-workflows.test.mjs`:

```js
test('mutation-pr.yml posts a single sticky advisory comment', async () => {
  const yml = await read('.github/workflows/mutation-pr.yml');
  assert.match(yml, /sticky-pull-request-comment/, 'must use a sticky comment action');
  assert.match(yml, /header:\s*mutation-advisory/, 'sticky comment must use a stable header');
  assert.match(yml, /pull-requests:\s*write/, 'comment job needs pull-requests: write');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/__tests__/mutation-workflows.test.mjs`
Expected: FAIL — no `comment` job yet.

- [ ] **Step 3: Add the `comment` job**

Append this job to `.github/workflows/mutation-pr.yml` (use the exact SHAs/version comments resolved in Task 0 in place of `<DL_ARTIFACT_SHA> # v7` and `<STICKY_SHA> # v2.x.x`):

```yaml
  comment:
    needs: mutation-gate
    # Only on real PRs (sticky comments need a PR number). Always runs so the
    # comment updates even when every package was skipped. Fork PRs are skipped
    # cleanly: their read-only token cannot post a comment, so the job would only
    # fail noisily — the gate job still produced artifacts for them.
    if: ${{ always() && github.event_name == 'pull_request' && !github.event.pull_request.head.repo.fork }}
    runs-on: ubuntu-latest
    permissions:
      # Elevated solely so the "Post sticky comment" step can create/update the
      # advisory PR comment. The gate job itself runs with contents: read only.
      pull-requests: write
    steps:
      - name: Download advisory summaries
        uses: actions/download-artifact@<DL_ARTIFACT_SHA>  # v7
        with:
          pattern: mutation-summary-*
          path: summaries
          merge-multiple: true
        continue-on-error: true

      - name: Assemble comment body
        run: |
          set -euo pipefail
          {
            echo "### 🧬 Mutation score (advisory)"
            echo
            echo "_Per-file mutation scores for files changed in this PR. **This check is advisory and never blocks merge.** Trend & full reports: the Stryker Dashboard. See issue #485._"
            echo
            if ls summaries/*.md >/dev/null 2>&1; then
              for f in summaries/*.md; do
                cat "$f"
                echo
                echo
              done
            else
              echo "_No mutated changed files in this PR._"
            fi
          } > comment.md
          cat comment.md

      - name: Post sticky comment
        uses: marocchino/sticky-pull-request-comment@0ea0beb66eb9baf113663a64ec522f60e49231c0  # v3.0.4
        with:
          header: mutation-advisory
          path: comment.md
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/__tests__/mutation-workflows.test.mjs`
Expected: PASS.

- [ ] **Step 5: Lint the workflow**

Run: `actionlint .github/workflows/mutation-pr.yml`
Expected: no output. (Fall back to the `python3 -c "import yaml; ..."` check as in Task 4 Step 5 if `actionlint` is unavailable.)

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/mutation-pr.yml scripts/__tests__/mutation-workflows.test.mjs
git commit -m "feat(#485): post a sticky advisory mutation comment on PRs"
```

---

## Task 6: Make `mutation.yml` the dashboard baseline producer at full fidelity

**Files:**
- Modify: `.github/workflows/mutation.yml`
- Test: `scripts/__tests__/mutation-workflows.test.mjs`

**Interfaces:**
- Consumes: `STRYKER_DASHBOARD_API_KEY` secret, the dashboard reporter (Task 2). Leaves `STRYKER_IGNORE_STATIC` unset ⇒ `ignoreStatic` OFF (Task 1).
- Produces: a full dashboard report per module for version `main` (the baseline the PR workflow downloads) on every push to `main` and weekly.

- [ ] **Step 1: Add the failing tests**

Append to `scripts/__tests__/mutation-workflows.test.mjs`:

```js
test('mutation.yml is the full-fidelity producer (no ignoreStatic, uploads to dashboard)', async () => {
  const yml = await read('.github/workflows/mutation.yml');
  assert.doesNotMatch(yml, /STRYKER_IGNORE_STATIC:/, 'producer must score static mutants (no ignoreStatic env assignment)');
  assert.match(yml, /STRYKER_DASHBOARD_API_KEY/, 'producer must pass the dashboard API key for upload');
  // The upload key must be gated on automated main-branch runs so an ad-hoc
  // workflow_dispatch (possibly off a feature branch) cannot overwrite the
  // canonical baseline. The key assignment carries the event/ref condition.
  assert.match(yml, /STRYKER_DASHBOARD_API_KEY:[^\n]*github\.event_name == 'schedule'[^\n]*secrets\.STRYKER_DASHBOARD_API_KEY/, 'producer must gate the upload key on schedule/push main runs');
  assert.match(yml, /push:\s*\n\s*branches:\s*\[main\]/, 'producer must run on push to main to refresh the baseline');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/__tests__/mutation-workflows.test.mjs`
Expected: FAIL — `mutation.yml` has no `push` trigger, no dashboard key env.

- [ ] **Step 3: Update `mutation.yml`**

Apply these edits to `.github/workflows/mutation.yml`:

(a) Add a `push` trigger to the `on:` block (alongside the existing `workflow_dispatch` and `schedule`):

```yaml
on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      package:
        description: 'Package to test'
        required: true
        type: choice
        options:
          - all
          - parser
          - core
          - cli
          - plugin
  schedule:
    - cron: '0 6 * * 1' # Weekly Monday 06:00 UTC
```

(b) Update the `RUN_PACKAGE` filter so `push` runs every package (like `schedule`):

```yaml
    env:
      RUN_PACKAGE: >-
        ${{ github.event_name == 'schedule' ||
            github.event_name == 'push' ||
            github.event.inputs.package == 'all' ||
            github.event.inputs.package == matrix.package }}
      STRYKER_DASHBOARD_VERSION: main
```

(c) Replace the `actions/cache` "Restore Stryker incremental cache" step with a public baseline download (so each run refreshes incremental against the last published `main` baseline):

```yaml
      - name: Download previous baseline from dashboard
        if: ${{ env.RUN_PACKAGE == 'true' }}
        env:
          MODULE: ${{ matrix.package }}
          PKG_DIR: ${{ matrix.dir }}
        run: |
          set -uo pipefail
          mkdir -p "${PKG_DIR}/reports"
          baseline="${PKG_DIR}/reports/stryker-incremental.json"
          url="https://dashboard.stryker-mutator.io/api/reports/github.com/tobyhede/rundown/${STRYKER_DASHBOARD_VERSION}?module=${MODULE}"
          # Keep the baseline only if curl succeeds AND the body is non-empty
          # valid JSON, so a 200 with a truncated body can't corrupt the report.
          if curl --fail --silent --show-error --max-time 60 \
               --output "${baseline}" "${url}" \
               && [ -s "${baseline}" ] \
               && node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "${baseline}"; then
            echo "Previous baseline downloaded for module ${MODULE}."
          else
            echo "::notice::no previous baseline for module ${MODULE}; producing a cold one."
            rm -f "${baseline}"
          fi
```

(Note: `matrix.package` already equals the module name — `parser`/`core`/`cli`/`plugin` — so `MODULE` is derived from `matrix.package` and the redundant `module:` matrix field is dropped.)

(d) Replace the "Run mutation tests" step so the dashboard key is in scope and the weekly cron forces a complete refresh while push stays incremental:

```yaml
      - name: Run mutation tests
        if: ${{ env.RUN_PACKAGE == 'true' }}
        env:
          # Only automated main-branch runs (schedule/push) may upload to the
          # canonical dashboard baseline. workflow_dispatch is ad-hoc (and may run
          # off a feature branch or a single package), so it runs WITHOUT the key
          # and therefore cannot overwrite the main baseline — the dashboard
          # reporter is enabled only when STRYKER_DASHBOARD_API_KEY is present.
          STRYKER_DASHBOARD_API_KEY: ${{ (github.ref == 'refs/heads/main' && (github.event_name == 'schedule' || github.event_name == 'push')) && secrets.STRYKER_DASHBOARD_API_KEY || '' }}
        # Weekly cron forces a complete re-run (drift-proof full fidelity);
        # push-to-main refreshes incrementally against the downloaded baseline.
        # Both upload to the dashboard (key present) and score static mutants
        # (STRYKER_IGNORE_STATIC unset). See issue #485.
        run: |
          if [ "${{ github.event_name }}" = "schedule" ]; then
            pnpm exec stryker run --incremental --force
          else
            pnpm exec stryker run --incremental
          fi
        working-directory: ${{ matrix.dir }}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/__tests__/mutation-workflows.test.mjs`
Expected: PASS — all workflow invariants.

- [ ] **Step 5: Lint the workflow**

Run: `actionlint .github/workflows/mutation.yml`
Expected: no output. (Fall back to the `python3 -c "import yaml; ..."` check if `actionlint` is unavailable.)

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/mutation.yml scripts/__tests__/mutation-workflows.test.mjs
git commit -m "feat(#485): make mutation.yml the full-fidelity dashboard baseline producer"
```

---

## Task 7: Document the strategy and record the declined options

**Files:**
- Create: `docs/internal/mutation-testing-ci.md`

**Interfaces:**
- Consumes: nothing.
- Produces: a descriptive doc of the current (post-change) mutation-testing CI design. (This is descriptive — current design — so it belongs in `docs/internal/`, not `docs/superpowers/`.)

- [ ] **Step 1: Write the doc**

Create `docs/internal/mutation-testing-ci.md`:

```markdown
# Mutation Testing in CI

Mutation testing runs in two roles, split by issue #485 after per-PR blocking
gates proved structurally too slow regardless of tuning.

## Advisory per-PR check (`.github/workflows/mutation-pr.yml`)

- **Non-blocking.** It is intentionally NOT a required status check. It posts a
  single sticky PR comment (header `mutation-advisory`) with per-file mutation
  scores for the files changed in the PR.
- **Scoped + fast.** Runs Stryker with `--mutate` limited to the PR's changed
  source files, `--incremental` against the public `main` baseline downloaded
  from the Stryker Dashboard, and `STRYKER_IGNORE_STATIC=true` to skip
  static mutants. The Stryker run and the per-file score step are
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
```

- [ ] **Step 2: Verify the doc spell-checks**

Run: `pnpm run check:spell`
Expected: PASS (add any new legitimate terms to the project dictionary if flagged — e.g. `ignoreStatic` is camelCase in code fences; prefer wording that avoids dictionary churn).

- [ ] **Step 3: Commit**

```bash
git add docs/internal/mutation-testing-ci.md
git commit -m "docs(#485): document advisory + dashboard mutation-testing CI strategy"
```

---

## Task 8: Add the mutation-score badge to the README

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the dashboard project (populated by Task 6's producer run).
- Produces: a mutation-score badge in the centered badge row, matching the
  existing `<a><img/></a>` HTML style.

- [ ] **Step 1: Add the badge**

In `README.md`, inside the centered badge `<p align="center">` block (lines
9–19), add this as the last badge, immediately after the CodeRabbit `</a>`
(line 18) and before the closing `</p>`:

```html
  <a href="https://dashboard.stryker-mutator.io/reports/github.com/tobyhede/rundown/main">
    <img src="https://img.shields.io/endpoint?style=flat&amp;url=https%3A%2F%2Fbadge-api.stryker-mutator.io%2Fgithub.com%2Ftobyhede%2Frundown%2Fmain" alt="Mutation testing badge" />
  </a>
```

(The `&` in the shields endpoint query is written `&amp;` to match the
HTML-fragment context; GitHub renders it back to `&`. Style matches the
license/npm/CodeRabbit badges: an `<a>` wrapping an `<img>` with an `alt`.)

- [ ] **Step 2: Verify it renders**

Run: `grep -n "badge-api.stryker-mutator.io" README.md`
Expected: one match inside the `<p align="center">` block. Optionally preview
the README to confirm the badge sits in the row (it shows "unknown" until the
first producer run from Task 6's Manual Step 4 publishes a baseline).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(#485): add Stryker mutation-score badge to README"
```

---

## Final verification

- [ ] **Step 1: Run the full pre-PR verification**

Run: `pnpm run verify`
Expected: format, spell, lint, and tests all pass.

- [ ] **Step 2: Run the new/affected tests together**

Run:
```bash
node --test scripts/__tests__/stryker-config.test.mjs scripts/__tests__/assert-mutation-score.test.mjs scripts/__tests__/mutation-workflows.test.mjs
```
Expected: all PASS.

- [ ] **Step 3: Lint all touched workflows**

Run: `actionlint .github/workflows/mutation-pr.yml .github/workflows/mutation.yml`
Expected: no output.

---

## Manual steps (maintainer — outside this plan's code)

These are not code changes and are not committed:

1. **Add the secret.** `STRYKER_DASHBOARD_API_KEY` → repo Actions secrets (in progress per the maintainer).
2. **Enable the dashboard project.** Confirm `github.com/tobyhede/rundown` is enabled at dashboard.stryker-mutator.io so uploads are accepted.
3. **Remove the required check.** In branch protection for `main`, remove any required status check from the old blocking `Mutation Gate (PR)` jobs so the advisory check cannot block merges.
4. **Seed the baseline.** Trigger `mutation.yml` once on `main` (push or `workflow_dispatch`) so the first dashboard baseline exists for PRs to download.
5. **Close the loop on #485.** Comment on issue #485 summarizing the resolution (advisory + dashboard, fidelity restored, merge-queue/actions-cache declined with rationale) and close it.
```

