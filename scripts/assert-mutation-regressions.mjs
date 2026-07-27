#!/usr/bin/env node
/**
 * Compare a native incremental Stryker run with its baseline by stable mutant
 * identity. This is the test-only half of the hybrid PR mutation strategy:
 * source is unchanged, so a previously detected mutant becoming Survived or
 * NoCoverage is evidence that the changed tests weakened detection.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { htmlEscape } from './lib/pr-comment.mjs';

const detected = new Set(['Killed', 'Timeout']);
const undetected = new Set(['Survived', 'NoCoverage']);

function normalizeFile(report, file) {
  const posix = String(file).replace(/\\/g, '/');
  const root = String(report.projectRoot ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  return root && posix.startsWith(`${root}/`) ? posix.slice(root.length + 1) : posix;
}

/**
 * Reduce a mutant to the string that identifies it ACROSS reports.
 *
 * This mirrors `mutantToIdentifyingKey` in Stryker's own `IncrementalDiffer`
 * byte for byte, and it is deliberately not the mutant's `id`. Stryker states
 * plainly that "the ids of tests and mutants can differ across reports (they are
 * only unique within 1 report)": the instrumenter assigns the id as a run-global
 * counter in instrumentation order (`new Mutant(this._mutants.length.toString(),
 * …)`), so the producer's per-shard baseline and a whole-package PR run number
 * the same mutant differently — and mutants restored from an incremental
 * baseline carry the content key instead, so a single report mixes both forms.
 *
 * @param {object} mutant - a report mutant.
 * @param {string} file - the mutant's package-relative file.
 * @returns {string} the cross-report identity key.
 * @throws {Error} when the mutant lacks a usable `location`, `mutatorName` or
 *   `replacement` — any of which would make the key silently ambiguous.
 */
export function mutantIdentity(mutant, file) {
  const start = mutant?.location?.start;
  const end = mutant?.location?.end;
  if (typeof start?.line !== 'number' || typeof end?.line !== 'number') {
    throw new Error(
      `mutation report entry ${file} has a mutant without a usable \`location\`; ` +
        'it cannot be correlated across reports',
    );
  }
  // The schema marks `replacement` optional. An absent attribute would fold into
  // the key as the string "undefined", which either pairs two unrelated mutants
  // or splits one into a missing/extra pair — both silently. Refuse instead.
  for (const attribute of ['mutatorName', 'replacement']) {
    if (typeof mutant[attribute] !== 'string') {
      throw new Error(
        `mutation report entry ${file} has a mutant with no \`${attribute}\`; ` +
          'it cannot be correlated across reports',
      );
    }
  }
  return `${file}@${start.line}:${start.column}-${end.line}:${end.column}\n${mutant.mutatorName}: ${mutant.replacement}`;
}

function indexReport(report, label) {
  if (!report || typeof report !== 'object' || !report.files || typeof report.files !== 'object') {
    throw new Error(`${label} mutation report is malformed: missing files object`);
  }
  const index = new Map();
  for (const [rawFile, entry] of Object.entries(report.files)) {
    if (!entry || !Array.isArray(entry.mutants)) {
      throw new Error(`${label} mutation report entry ${rawFile} has no mutants array`);
    }
    const file = normalizeFile(report, rawFile);
    for (const mutant of entry.mutants) {
      const key = mutantIdentity(mutant, file);
      if (index.has(key)) {
        // Collapse EVERY newline, not just the key's own field separator:
        // `replacement` is verbatim mutated source and a multi-line block mutant is
        // ordinary, so a non-global replace would leave the rest raw and break the
        // single greppable line this collapse exists to produce.
        throw new Error(
          `${label} report has duplicate mutant identity ${key.replace(/\r?\n/g, ' ')}`,
        );
      }
      index.set(key, { ...mutant, file, identity: key });
    }
  }
  return index;
}

/**
 * Describe a mutant for a human, using only cross-report-stable attributes. The
 * report-local `id` is deliberately omitted: it names nothing the reader can
 * look up in the other report.
 *
 * @param {{file: string, location?: object, mutatorName?: string, replacement?: string}} mutant - an indexed mutant.
 * @returns {string} a stable, readable description.
 */
function describeMutant(mutant) {
  const line = mutant.location?.start?.line;
  const where = typeof line === 'number' ? `${mutant.file} line ${line}` : mutant.file;
  return `${where} (${mutant.mutatorName} → ${mutant.replacement})`;
}

/**
 * Compare native incremental reports by cross-report mutant identity.
 *
 * @param {{baseline: unknown, current: unknown}} reports - reports to compare.
 * @returns {{ok: boolean, regressions: object[], incompatible: string[]}} comparison result.
 * @throws {Error} when either report lacks `testFiles`, is structurally
 *   malformed, contains a mutant that cannot be located, or repeats one identity.
 */
export function compareMutationRegressions({ baseline, current }) {
  for (const [label, report] of [
    ['baseline', baseline],
    ['current', current],
  ]) {
    if (
      !report ||
      typeof report !== 'object' ||
      !report.testFiles ||
      typeof report.testFiles !== 'object' ||
      Object.keys(report.testFiles).length === 0
    ) {
      throw new Error(
        `${label} mutation report has no \`testFiles\` metadata; native changed-test analysis is not trustworthy`,
      );
    }
  }
  const before = indexReport(baseline, 'baseline');
  const after = indexReport(current, 'current');
  const regressions = [];
  const incompatible = [];

  for (const [key, oldMutant] of before) {
    const newMutant = after.get(key);
    if (!newMutant) {
      incompatible.push(`current report is missing mutant ${describeMutant(oldMutant)}`);
      continue;
    }
    if (detected.has(oldMutant.status) && undetected.has(newMutant.status)) {
      regressions.push({
        file: newMutant.file,
        id: newMutant.id,
        from: oldMutant.status,
        to: newMutant.status,
        mutatorName: newMutant.mutatorName,
        replacement: newMutant.replacement,
        location: newMutant.location,
      });
    }
  }
  for (const [key, mutant] of after) {
    if (!before.has(key))
      incompatible.push(`current report has extra mutant ${describeMutant(mutant)}`);
  }

  return {
    ok: regressions.length === 0 && incompatible.length === 0,
    regressions,
    incompatible,
  };
}

/**
 * Render a test-only comparison as a PR-comment markdown fragment.
 *
 * @param {{ok: boolean, regressions: object[], incompatible: string[]}} result - comparison.
 * @param {string} packageName - package label.
 * @returns {string} markdown fragment.
 */
export function renderMarkdown(result, packageName) {
  const code = (value) => `<code>${htmlEscape(value)}</code>`;
  const lines = [
    `#### ${result.ok ? '✅' : '⚠️'} ${code(packageName)} — test-only incremental comparison`,
    '',
  ];
  if (result.regressions.length === 0 && result.incompatible.length === 0) {
    lines.push('_No baseline-detected mutant became undetected._');
    return lines.join('\n');
  }
  for (const regression of result.regressions) {
    lines.push(
      `- ❌ ${code(describeMutant(regression))}: ${htmlEscape(regression.from)} → ${htmlEscape(regression.to)}`,
    );
  }
  for (const reason of result.incompatible) lines.push(`- ⚠️ ${htmlEscape(reason)}`);
  return lines.join('\n');
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!['--baseline', '--current', '--markdown', '--package-name'].includes(arg)) {
      throw new Error(`unknown argument: ${arg}`);
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`${arg} requires a value`);
    opts[arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = value;
  }
  for (const required of ['baseline', 'current']) {
    if (!opts[required]) throw new Error(`--${required} is required`);
  }
  return opts;
}

/** @returns {number} process exit code. */
export function main(argv = process.argv.slice(2)) {
  try {
    const opts = parseArgs(argv);
    const result = compareMutationRegressions({
      baseline: JSON.parse(readFileSync(opts.baseline, 'utf8')),
      current: JSON.parse(readFileSync(opts.current, 'utf8')),
    });
    const markdown = renderMarkdown(result, opts.packageName ?? 'package');
    if (opts.markdown) writeFileSync(opts.markdown, `${markdown}\n`);
    else process.stdout.write(`${markdown}\n`);
    return result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`mutation regression comparison failed: ${error.message}\n`);
    return 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main();
