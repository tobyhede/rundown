#!/usr/bin/env node
/**
 * Compare a native incremental Stryker run with its baseline by stable mutant
 * identity. This is the test-only half of the hybrid PR mutation strategy:
 * source is unchanged, so a previously detected mutant becoming Survived or
 * NoCoverage is evidence that the changed tests weakened detection.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const detected = new Set(['Killed', 'Timeout']);
const undetected = new Set(['Survived', 'NoCoverage']);

function normalizeFile(report, file) {
  const posix = String(file).replace(/\\/g, '/');
  const root = String(report.projectRoot ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  return root && posix.startsWith(`${root}/`) ? posix.slice(root.length + 1) : posix;
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
      if (typeof mutant?.id !== 'string') {
        throw new Error(`${label} mutation report entry ${file} has a mutant without a string id`);
      }
      const key = `${file}\0${mutant.id}`;
      if (index.has(key))
        throw new Error(`${label} report has duplicate mutant id ${file}#${mutant.id}`);
      index.set(key, { ...mutant, file });
    }
  }
  return index;
}

/**
 * Compare native incremental reports by file plus Stryker mutant id.
 *
 * @param {{baseline: unknown, current: unknown}} reports - reports to compare.
 * @returns {{ok: boolean, regressions: object[], incompatible: string[]}} comparison result.
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
      incompatible.push(`current report is missing mutant ${oldMutant.file}#${oldMutant.id}`);
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
      incompatible.push(`current report has extra mutant ${mutant.file}#${mutant.id}`);
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
  const htmlEscape = (value) =>
    String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/`/g, '&#96;')
      .replace(/\r?\n/g, ' ');
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
    const line = regression.location?.start?.line;
    lines.push(
      `- ❌ ${code(`${regression.file}#${regression.id}`)}${typeof line === 'number' ? ` line ${line}` : ''}: ${htmlEscape(regression.from)} → ${htmlEscape(regression.to)}`,
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
