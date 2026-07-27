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
 * changed, mutated scope contains a Survived or NoCoverage mutant. The score is
 * retained as secondary context, not used to dilute an individual escape.
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
 * `--changed-range <path>:<startLine>-<endLine>` (repeatable) narrows scoring to
 * the given lines of a file, using Stryker's own mutation-range notation. This is
 * REQUIRED whenever the run was itself range-scoped: with `--incremental`, Stryker
 * retains baseline results for mutants outside `--mutate`, so scoring the whole
 * file would let a survivor introduced in the changed lines be diluted by
 * hundreds of untouched baseline kills and still clear the floor. A ranged path is
 * implicitly a changed file, so it need not also be passed as `--changed-file`.
 *
 * `--floor <percent>` does NOT decide the verdict. Every undetected in-scope
 * mutant fails this gate on its own, because over a handful of changed lines a
 * percentage is not a meaningful threshold — two survivors out of two is 0% and
 * two out of four hundred is 99.5%, and both are the same defect. The floor is
 * carried through to the rendered output purely as context for reading the
 * score, and only the full producer run applies a percentage as a break
 * threshold (`thresholds.break` in each package's stryker.config.mjs).
 *
 * @see issue #483
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { htmlEscape } from './lib/pr-comment.mjs';

/**
 * Reference mutation-score floor (percent), displayed as context alongside the
 * individual mutant verdict. The scoped gate fails on any undetected mutant;
 * only the full producer applies this value as an aggregate break threshold.
 */
export const DEFAULT_FLOOR = 70;

/**
 * Most individual mutants one summary will name before it starts counting the
 * remainder instead. Bounds the sticky PR comment, which concatenates every
 * shard's summary and is rejected by GitHub above 65536 characters.
 */
export const MAX_LISTED_MUTANTS = 25;

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
 * Parse a `<path>:<startLine>-<endLine>` scope, mirroring Stryker's own
 * mutation-range syntax so the gate is scoped with the same notation the run was.
 *
 * @param {string} raw - the `--changed-range` value.
 * @returns {{file: string, start: number, end: number}} the parsed range; `file`
 *   is POSIX-normalized, because {@link assertMutationScore} looks the ranges up
 *   under a normalized key and a `\`-separated path would silently miss it —
 *   degrading the file to whole-file scoring.
 * @throws {Error} when the value is not a well-formed, non-inverted line range.
 */
export function parseChangedRange(raw) {
  const match = /^(.+):(\d+)-(\d+)$/.exec(raw);
  if (!match) {
    throw new Error(`malformed --changed-range '${raw}'; expected <path>:<startLine>-<endLine>`);
  }
  const start = Number.parseInt(match[2], 10);
  const end = Number.parseInt(match[3], 10);
  if (start < 1 || end < start) {
    throw new Error(`malformed --changed-range '${raw}'; start must be >= 1 and <= end`);
  }
  // Normalize at the source: this one call fixes both the `ranges` Map key built
  // in `main` and the implicit `changedFiles` push in `parseArgs`.
  return { file: toPosix(match[1]), start, end };
}

/**
 * Whether a mutant lies inside any of a file's in-scope line ranges.
 *
 * CONTAINMENT, not overlap, because that is exactly the rule Stryker itself
 * applies when deciding whether a mutant is in the mutated scope and must be
 * rerun. From its incremental differ:
 *
 *     locationIncluded(haystack, needle) =
 *       gte(needle.start, haystack.start) && gte(haystack.end, needle.end)
 *
 * A multi-line mutant that merely straddles the range boundary is therefore NOT
 * rerun — Stryker keeps its result from the baseline report. Counting it would let
 * a stale kill, or a stale survivor, decide the changed-line score, which is the
 * opposite of what range scoping is for.
 *
 * Comparing line numbers alone is exact here rather than an approximation: for a
 * line-only range (`file:start-end`, the only form emitted) Stryker fills in
 * `startColumn = 0` and `endColumn = Number.MAX_SAFE_INTEGER`, so the column half
 * of its comparison is always satisfied.
 *
 * @param {{location?: {start?: {line?: number}, end?: {line?: number}}}} mutant - a report mutant.
 * @param {Array<{start: number, end: number}>} ranges - in-scope line ranges.
 * @param {string} reportKey - the report key, for diagnostics.
 * @returns {boolean} true when the mutant is contained in a range.
 * @throws {Error} when the mutant carries no usable location.
 */
export function mutantInRanges(mutant, ranges, reportKey) {
  const startLine = mutant?.location?.start?.line;
  const endLine = mutant?.location?.end?.line ?? startLine;
  if (typeof startLine !== 'number' || typeof endLine !== 'number') {
    // A mutant with no location cannot be assigned to a range. Dropping it would
    // understate the changed-line scope and could turn a survivor into a silent
    // pass, so fail loudly instead of shimming a default.
    throw new Error(
      `mutation report entry for ${reportKey} has a mutant without a usable \`location\`; cannot scope it to the changed ranges`,
    );
  }
  return ranges.some((r) => startLine >= r.start && endLine <= r.end);
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
 * @property {boolean} ok - true when every valid in-scope mutant was detected.
 * @property {{ file: string, score: number, undetected: object[] }[]} failures -
 *   changed files containing Survived or NoCoverage mutants.
 * @property {{ file: string, score: number }[]} checked - changed files whose
 *   valid in-scope mutants were all detected.
 * @property {{ file: string, reason: string }[]} skipped - changed files that
 *   could not be judged (not mutated, or no valid mutants).
 * @property {number} floor - the reference floor displayed as score context.
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
 * @param {number} [args.floor] - reference score shown in output.
 * @returns {GateResult} structured outcome of the evaluation.
 * @throws {Error} when the report is missing or structurally invalid, or when a
 *   per-file entry present in the report lacks a `mutants` array (malformed
 *   report).
 */
export function assertMutationScore({
  report,
  changedFiles,
  packageDir,
  floor = DEFAULT_FLOOR,
  ranges,
}) {
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
    // Range scoping is what keeps an incremental run honest: Stryker retains
    // baseline results for mutants outside `--mutate`, so scoring the whole file
    // would let a survivor in the changed lines be diluted by hundreds of
    // untouched baseline kills and still clear the floor.
    const fileRanges = ranges?.get(changed);
    const inScope = fileRanges
      ? entry.mutants.filter((m) => mutantInRanges(m, fileRanges, reportKey))
      : entry.mutants;
    const statuses = inScope.map((m) => m.status);
    const score = fileMutationScore(statuses);
    if (score === null) {
      skipped.push({
        file: relative,
        reason: fileRanges ? 'no valid mutants in the changed ranges' : 'no valid mutants',
      });
      continue;
    }
    const undetected = inScope
      .filter((mutant) => mutant.status === 'Survived' || mutant.status === 'NoCoverage')
      .map((mutant) => ({
        id: mutant.id,
        status: mutant.status,
        mutatorName: mutant.mutatorName,
        replacement: mutant.replacement,
        location: mutant.location,
      }));
    if (undetected.length > 0) {
      failures.push({ file: relative, score, undetected });
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
  // Render interpolated values as HTML-escaped text wrapped in <code>. See
  // `scripts/lib/pr-comment.mjs` for why entity encoding — not backslash escaping
  // — is the only thing that survives GitHub's markdown renderer.
  const codeCell = (value) => `<code>${htmlEscape(value)}</code>`;
  const lines = [
    `#### ${status} ${codeCell(packageName)} — changed-scope mutants (floor ${floor}% shown as score context)`,
    '',
  ];
  if (checked.length === 0 && failures.length === 0 && skipped.length === 0) {
    lines.push('_No mutated changed files to score._');
    return lines.join('\n');
  }
  lines.push('| File | Score | Status |', '| --- | ---: | --- |');
  for (const f of failures) {
    const undetected = f.undetected ?? [];
    lines.push(
      `| ${codeCell(f.file)} | ${f.score.toFixed(2)}% | ❌ ${undetected.length || 'undetected'} mutant${undetected.length === 1 ? '' : 's'} |`,
    );
  }
  for (const c of checked) lines.push(`| ${codeCell(c.file)} | ${c.score.toFixed(2)}% | ✅ |`);
  for (const s of skipped) lines.push(`| ${codeCell(s.file)} | — | ⏭️ ${htmlEscape(s.reason)} |`);
  // Every shard's summary is concatenated into ONE sticky PR comment, and GitHub
  // rejects a comment over 65536 characters. A newly added file is mutated whole,
  // so a single shard can legitimately carry hundreds of escapes — uncapped, the
  // most interesting result is precisely the one that fails to post. The table
  // rows above still carry the true per-file counts, and the full list is in the
  // uploaded mutation report.
  let budget = MAX_LISTED_MUTANTS;
  let withheld = 0;
  for (const failure of failures) {
    for (const mutant of failure.undetected ?? []) {
      if (budget === 0) {
        withheld += 1;
        continue;
      }
      budget -= 1;
      const line = mutant.location?.start?.line;
      const where = typeof line === 'number' ? `line ${line}` : 'unknown location';
      const mutation = [mutant.mutatorName, mutant.replacement]
        .filter((value) => value !== undefined)
        .join(' → ');
      lines.push(
        `- ${codeCell(failure.file)} ${htmlEscape(where)}: ${codeCell(mutant.id ?? 'unknown-id')} ${htmlEscape(mutant.status)}${mutation ? ` — ${codeCell(mutation)}` : ''}`,
      );
    }
  }
  if (withheld > 0) {
    lines.push(
      `- _…and ${withheld} more undetected mutant${withheld === 1 ? '' : 's'} not listed here; see the uploaded mutation report artifact._`,
    );
  }
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
 * @returns {{ report: string, packageDir: string, base?: string, changedFiles: string[], changedRanges: Array<{file: string, start: number, end: number}>, floor: number, markdown?: string, packageName?: string }}
 *   parsed options; `floor` is reported as context and never decides the verdict.
 * @throws {Error} when a required option is missing or a flag lacks a value.
 */
export function parseArgs(argv) {
  const opts = { changedFiles: [], changedRanges: [], floor: DEFAULT_FLOOR };
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
    else if (arg === '--changed-range') {
      const range = parseChangedRange(next());
      opts.changedRanges.push(range);
      // A ranged file is implicitly a changed file, so a caller that scopes to
      // ranges need not also repeat --changed-file for the same path.
      if (!opts.changedFiles.includes(range.file)) opts.changedFiles.push(range.file);
    } else if (arg === '--floor') opts.floor = Number.parseInt(next(), 10);
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
 * @returns {number} process exit code (0 = pass, 1 = an in-scope mutant is
 *   undetected, 2 = usage/IO error).
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
    // Group the flat --changed-range list into per-file range arrays.
    const ranges = opts.changedRanges.length > 0 ? new Map() : undefined;
    for (const { file, start, end } of opts.changedRanges) {
      if (!ranges.has(file)) ranges.set(file, []);
      ranges.get(file).push({ start, end });
    }
    result = assertMutationScore({
      report,
      changedFiles,
      packageDir: opts.packageDir,
      floor: opts.floor,
      ranges,
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
    console.log(`ok    ${c.file} — ${fmt(c.score)} (all valid mutants detected)`);
  }
  for (const s of result.skipped) {
    console.log(`skip  ${s.file} — ${s.reason}`);
  }
  for (const f of result.failures) {
    console.error(`FAIL  ${f.file} — ${f.undetected.length} undetected mutant(s), ${fmt(f.score)}`);
    for (const mutant of f.undetected) {
      const line = mutant.location?.start?.line;
      console.error(
        `      ${mutant.id ?? 'unknown-id'} ${mutant.status}${typeof line === 'number' ? ` at line ${line}` : ''}`,
      );
    }
  }

  if (!result.ok) {
    console.error(
      `\nmutation gate: ${result.failures.length} changed file(s) contain undetected mutants. ` +
        'Add tests that kill or cover each listed mutant.',
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
