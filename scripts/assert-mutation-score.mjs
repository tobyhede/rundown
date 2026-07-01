#!/usr/bin/env node
/**
 * Per-PR changed-file mutation-score gate.
 *
 * Stryker has no native per-file `break` threshold — its `thresholds.break`
 * gates only the project-wide aggregate, so a single file can collapse from
 * ~99% to ~0% while the project total (and therefore CI) stays green. This
 * script closes that gap by post-processing the JSON report Stryker already
 * emits (`reports/mutation/mutation-report.json`): it computes the mutation
 * score of every file that changed in the PR and fails (non-zero exit) when any
 * changed, mutated file scores below a floor.
 *
 * The score formula mirrors mutation-testing-metrics exactly so the number this
 * gate reports equals the number Stryker prints:
 *   score = (Killed + Timeout) / (Killed + Timeout + Survived + NoCoverage)
 * Ignored / CompileError / RuntimeError / Pending mutants are excluded from the
 * denominator (they are not "valid" mutants). A file with no valid mutants has
 * no judgeable score and is skipped rather than failed.
 *
 * Usage (CLI):
 *   node scripts/assert-mutation-score.mjs \
 *     --report packages/core/reports/mutation/mutation-report.json \
 *     --package-dir packages/core \
 *     --base origin/main \
 *     [--floor 70]
 *
 * `--changed-file <path>` (repeatable) may be supplied instead of `--base` to
 * pass an explicit changed-file list (used by the tests and by callers that
 * already have the diff). Changed-file paths are repo-relative POSIX paths, the
 * same form `git diff --name-only` produces.
 *
 * @see issue #483
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Default per-file mutation-score floor (percent). A changed, mutated file must
 * score at or above this to pass. Kept equal to the package-level `break`
 * threshold so the per-file gate and the weekly aggregate gate agree.
 */
export const DEFAULT_FLOOR = 70;

/**
 * Compute the mutation score for a list of mutant status strings.
 *
 * Mirrors mutation-testing-metrics' `countFileMetrics`:
 * detected = Killed + Timeout; valid = detected + Survived + NoCoverage.
 *
 * @param {string[]} statuses - mutant status strings for a single file.
 * @returns {number | null} the score as a percentage (0–100), or `null` when
 *   the file has no valid mutants and therefore no judgeable score.
 */
export function fileMutationScore(statuses) {
  let killed = 0;
  let timeout = 0;
  let survived = 0;
  let noCoverage = 0;
  for (const status of statuses) {
    if (status === 'Killed') killed += 1;
    else if (status === 'Timeout') timeout += 1;
    else if (status === 'Survived') survived += 1;
    else if (status === 'NoCoverage') noCoverage += 1;
    // Ignored / CompileError / RuntimeError / Pending are not valid mutants.
  }
  const detected = killed + timeout;
  const valid = detected + survived + noCoverage;
  if (valid === 0) return null;
  return (detected / valid) * 100;
}

/**
 * Normalize a report's file keys to package-relative POSIX paths.
 *
 * Stryker normally emits keys relative to `projectRoot` (the package dir), but
 * some versions/configs emit absolute keys. This strips the `projectRoot`
 * prefix when present so keys compare cleanly against package-relative changed
 * paths.
 *
 * @param {{ files: Record<string, unknown>, projectRoot?: string }} report - a
 *   parsed Stryker JSON report.
 * @returns {Map<string, string>} map of normalized key -> original report key.
 */
export function normalizeReportFileKeys(report) {
  const out = new Map();
  const root = report.projectRoot ? toPosix(report.projectRoot).replace(/\/+$/, '') : '';
  for (const key of Object.keys(report.files)) {
    let normalized = toPosix(key);
    if (root && normalized.startsWith(`${root}/`)) {
      normalized = normalized.slice(root.length + 1);
    }
    out.set(normalized, key);
  }
  return out;
}

/**
 * Convert a path to POSIX separators for cross-platform key comparison.
 *
 * @param {string} p - a filesystem path.
 * @returns {string} the path with `\` replaced by `/`.
 */
function toPosix(p) {
  return p.replace(/\\/g, '/');
}

/**
 * Validate that an object is a structurally usable Stryker JSON report.
 *
 * Per the no-migration principle, we reject malformed input rather than
 * shimming it. The gate must fail loudly on a missing or shapeless report so a
 * broken mutation run cannot silently pass the PR.
 *
 * @param {unknown} report - the value to validate.
 * @returns {asserts report is { files: Record<string, { mutants: { status: string }[] }>, projectRoot?: string }}
 * @throws {Error} when the report is null/undefined or lacks a `files` object.
 */
function assertValidReport(report) {
  if (report == null || typeof report !== 'object') {
    throw new Error('mutation report is missing or not an object');
  }
  if (typeof report.files !== 'object' || report.files === null) {
    throw new Error('mutation report has no `files` object (malformed report)');
  }
}

/**
 * Result of evaluating the per-file gate.
 *
 * @typedef {object} GateResult
 * @property {boolean} ok - true when no changed file scored below the floor.
 * @property {{ file: string, score: number }[]} failures - changed files below
 *   the floor.
 * @property {{ file: string, score: number }[]} checked - changed files that had
 *   a judgeable score and met the floor.
 * @property {{ file: string, reason: string }[]} skipped - changed files that
 *   could not be judged (not mutated, or no valid mutants).
 * @property {number} floor - the floor that was applied.
 */

/**
 * Evaluate the per-file mutation-score gate against a report and changed files.
 *
 * Only files that (a) live under `packageDir`, and (b) appear in the report with
 * at least one valid mutant are judged. Changed files outside the package, files
 * Stryker did not mutate, and files with no valid mutants never fail the gate.
 *
 * @param {object} args
 * @param {unknown} args.report - parsed Stryker JSON report (validated here).
 * @param {string[]} args.changedFiles - repo-relative POSIX paths changed in the
 *   PR.
 * @param {string} args.packageDir - repo-relative package directory the report
 *   belongs to (e.g. `packages/core`).
 * @param {number} [args.floor] - minimum acceptable score (inclusive).
 * @returns {GateResult} structured outcome of the evaluation.
 * @throws {Error} when the report is missing or structurally invalid, or when a
 *   per-file entry present in the report lacks a `mutants` array (malformed
 *   report).
 */
export function assertMutationScore({ report, changedFiles, packageDir, floor = DEFAULT_FLOOR }) {
  assertValidReport(report);
  const reportKeys = normalizeReportFileKeys(report);
  const pkgPrefix = `${toPosix(packageDir).replace(/\/+$/, '')}/`;

  const failures = [];
  const checked = [];
  const skipped = [];

  for (const raw of changedFiles) {
    const changed = toPosix(raw);
    if (!changed.startsWith(pkgPrefix)) continue; // outside this package.
    const relative = changed.slice(pkgPrefix.length);
    const reportKey = reportKeys.get(relative);
    if (reportKey === undefined) {
      skipped.push({ file: relative, reason: 'not mutated' });
      continue;
    }
    const entry = report.files[reportKey];
    if (!entry || !Array.isArray(entry.mutants)) {
      throw new Error(
        `mutation report entry for ${reportKey} has no \`mutants\` array (malformed report)`,
      );
    }
    const statuses = entry.mutants.map((m) => m.status);
    const score = fileMutationScore(statuses);
    if (score === null) {
      skipped.push({ file: relative, reason: 'no valid mutants' });
      continue;
    }
    if (score < floor) {
      failures.push({ file: relative, score });
    } else {
      checked.push({ file: relative, score });
    }
  }

  return { ok: failures.length === 0, failures, checked, skipped, floor };
}

/**
 * Render a GateResult as a GitHub-flavored markdown fragment for a PR comment.
 *
 * @param {GateResult} result - the gate outcome.
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
  // markdown/table parser to misinterpret. Newlines are collapsed to spaces so a
  // value can't break the table row.
  const htmlEscape = (value) =>
    String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/`/g, '&#96;')
      .replace(/\|/g, '&#124;')
      .replace(/\r?\n/g, ' ');
  const codeCell = (value) => `<code>${htmlEscape(value)}</code>`;
  const lines = [
    `#### ${status} ${codeCell(packageName)} — per-file mutation score (floor ${floor}%)`,
    '',
  ];
  if (checked.length === 0 && failures.length === 0 && skipped.length === 0) {
    lines.push('_No mutated changed files to score._');
    return lines.join('\n');
  }
  lines.push('| File | Score | Status |', '| --- | ---: | --- |');
  for (const f of failures)
    lines.push(`| ${codeCell(f.file)} | ${f.score.toFixed(2)}% | ❌ below floor |`);
  for (const c of checked) lines.push(`| ${codeCell(c.file)} | ${c.score.toFixed(2)}% | ✅ |`);
  for (const s of skipped) lines.push(`| ${codeCell(s.file)} | — | ⏭️ ${htmlEscape(s.reason)} |`);
  return lines.join('\n');
}

/**
 * Determine the files changed between a base ref and HEAD via git.
 *
 * Uses the merge-base (`base...HEAD`) so only commits unique to the PR branch
 * count — a stale base that moved on after branching does not inflate the
 * changed set.
 *
 * This fails closed: an unresolvable base or an unreachable merge-base (e.g. a
 * shallow clone that does not contain the common ancestor) throws rather than
 * falling back to a semantically different two-dot diff. A silent fallback could
 * compare HEAD against a truncated base tip and yield a wrong or oversized
 * changed-file set — masking the very regression this gate exists to catch. The
 * caller (and CI) must surface the error and refuse to gate on a bad diff.
 *
 * @param {string} base - a git ref to diff against (e.g. `origin/main`).
 * @returns {string[]} repo-relative POSIX paths of changed files.
 * @throws {Error} when the base ref is unresolvable, the merge-base is
 *   unreachable, or git invocation otherwise fails.
 */
export function changedFilesFromGit(base) {
  try {
    return execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { encoding: 'utf8' })
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch (err) {
    throw new Error(
      `failed to diff ${base}...HEAD: ${err.message.trim()}. ` +
        'Ensure the base ref and its merge-base with HEAD are fetched ' +
        '(checkout with full history, e.g. fetch-depth: 0, and do not re-shallow).',
    );
  }
}

/**
 * Parse argv into options for the CLI entrypoint.
 *
 * @param {string[]} argv - process arguments (excluding node + script).
 * @returns {{ report: string, packageDir: string, base?: string, changedFiles: string[], floor: number }}
 * @throws {Error} when a required option is missing or a flag lacks a value.
 */
export function parseArgs(argv) {
  const opts = { changedFiles: [], floor: DEFAULT_FLOOR };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      const v = argv[i];
      if (v === undefined) throw new Error(`missing value for ${arg}`);
      return v;
    };
    if (arg === '--') continue; // pnpm forwards a bare `--`; ignore it.
    if (arg === '--report') opts.report = next();
    else if (arg === '--package-dir') opts.packageDir = next();
    else if (arg === '--base') opts.base = next();
    else if (arg === '--changed-file') opts.changedFiles.push(next());
    else if (arg === '--floor') opts.floor = Number.parseInt(next(), 10);
    else if (arg === '--markdown') opts.markdown = next();
    else if (arg === '--package-name') opts.packageName = next();
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!opts.report) throw new Error('--report <path> is required');
  if (!opts.packageDir) throw new Error('--package-dir <dir> is required');
  if (!opts.base && opts.changedFiles.length === 0) {
    throw new Error('one of --base <ref> or --changed-file <path> is required');
  }
  if (!Number.isInteger(opts.floor) || opts.floor < 0 || opts.floor > 100) {
    throw new Error('--floor must be an integer between 0 and 100');
  }
  return opts;
}

/**
 * CLI entrypoint: load the report, resolve changed files, evaluate the gate, and
 * print a human-readable summary.
 *
 * @param {string[]} argv - process arguments (excluding node + script).
 * @returns {number} process exit code (0 = pass, 1 = a changed file is below
 *   the floor, 2 = usage/IO error).
 */
export function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`error: ${err.message}`);
    return 2;
  }

  let report;
  try {
    report = JSON.parse(readFileSync(opts.report, 'utf8'));
  } catch (err) {
    console.error(`error: failed to read mutation report ${opts.report}: ${err.message}`);
    return 2;
  }

  let changedFiles;
  try {
    changedFiles =
      opts.changedFiles.length > 0 ? opts.changedFiles : changedFilesFromGit(opts.base);
  } catch (err) {
    // Fail closed: a bad diff must not be treated as "no changed files".
    console.error(`error: ${err.message}`);
    return 2;
  }

  let result;
  try {
    result = assertMutationScore({
      report,
      changedFiles,
      packageDir: opts.packageDir,
      floor: opts.floor,
    });
  } catch (err) {
    console.error(`error: ${err.message}`);
    return 2;
  }

  if (opts.markdown) {
    try {
      writeFileSync(opts.markdown, renderMarkdown(result, opts.packageName ?? opts.packageDir));
    } catch (err) {
      console.error(`error: failed to write markdown summary ${opts.markdown}: ${err.message}`);
      return 2;
    }
  }

  const fmt = (score) => `${score.toFixed(2)}%`;
  for (const c of result.checked) {
    console.log(`ok    ${c.file} — ${fmt(c.score)} (floor ${result.floor}%)`);
  }
  for (const s of result.skipped) {
    console.log(`skip  ${s.file} — ${s.reason}`);
  }
  for (const f of result.failures) {
    console.error(`FAIL  ${f.file} — ${fmt(f.score)} is below floor ${result.floor}%`);
  }

  if (!result.ok) {
    console.error(
      `\nmutation gate: ${result.failures.length} changed file(s) below the ${result.floor}% floor. ` +
        'Add tests that kill the surviving mutants, or justify a floor change in review.',
    );
    return 1;
  }

  if (result.checked.length === 0) {
    console.log(`mutation gate: no mutated changed files in ${opts.packageDir} to check.`);
  } else {
    console.log(`\nmutation gate: ${result.checked.length} changed file(s) passed.`);
  }
  return 0;
}

// Only run main() when invoked directly, not when imported by tests.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
