#!/usr/bin/env node
/**
 * Measure the `src` footprint of the delegation rebuild against the two size
 * gates in ADR 0005 (`docs/adr/0005-one-writer-per-run.md` § Consequences):
 * at most 6,400 lines for delegation, authority and concurrency, and at most
 * about 8,600 for the general machinery those modules touch.
 *
 * Which files belong to which gate is data, not code: `scripts/size-allowlist.json`
 * lists repo-relative paths or `dir/**\/*.ext` globs under `authority` and
 * `machinery`, plus the two gate values. Lines are counted with `wc -l`
 * semantics (number of newline characters), so an unterminated final line is
 * not counted and an empty file is 0. A listed file that does not exist is
 * reported under `missing`, never thrown: modules are deleted during the
 * rebuild and the allowlist is edited to follow, so a stale entry is a
 * reporting fact, not a failure.
 *
 * Usage:
 *   node scripts/measure-size.mjs              JSON report, exit 0
 *   node scripts/measure-size.mjs --text       two-column table plus totals vs gates
 *   node scripts/measure-size.mjs --enforce    exit 1 when a total exceeds its gate
 *   --root <dir> / --allowlist <file>          override the repo root / allowlist (tests)
 *
 * `--enforce` is not yet part of `verify`; #908 wires it in.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE_KEYS = ['authority', 'machinery'];

/**
 * Parse CLI arguments.
 *
 * @param {string[]} argv - arguments after the script path
 * @returns {{ root: string, allowlist: string, text: boolean, enforce: boolean }} parsed options
 * @throws {Error} on an unknown flag or a value flag with no value
 */
export function parseArgs(argv) {
  const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const options = {
    root: defaultRoot,
    allowlist: undefined,
    text: false,
    enforce: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--text') {
      options.text = true;
    } else if (arg === '--enforce') {
      options.enforce = true;
    } else if (arg === '--root' || arg === '--allowlist') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      options[arg.slice(2)] = resolve(value);
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  options.allowlist ??= join(options.root, 'scripts', 'size-allowlist.json');
  return options;
}

/**
 * Count lines with `wc -l` semantics: the number of newline characters.
 *
 * @param {string} absPath - absolute path of the file to count
 * @returns {number} newline count
 */
export function countLines(absPath) {
  const content = readFileSync(absPath);
  let count = 0;
  for (const byte of content) {
    if (byte === 0x0a) count += 1;
  }
  return count;
}

/**
 * Recursively list files under a directory whose names end with `suffix`,
 * returned as repo-relative POSIX paths.
 *
 * @param {string} root - repo root the paths are relative to
 * @param {string} dir - absolute directory to walk
 * @param {string} suffix - required filename suffix, e.g. `.ts`
 * @returns {string[]} matching repo-relative paths, unsorted
 */
function walk(root, dir, suffix) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(root, abs, suffix));
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      out.push(relative(root, abs).split(sep).join('/'));
    }
  }
  return out;
}

/**
 * Expand one allowlist entry to the repo-relative files it names.
 *
 * Two forms are supported: an explicit path, and `dir/**\/*.ext` (any
 * directory prefix, then `**`, then a `*.ext` filename pattern). Anything else
 * is treated as an explicit path. An entry that matches nothing is returned
 * under `missing`.
 *
 * @param {string} root - absolute repo root
 * @param {string} entry - allowlist entry
 * @returns {{ files: string[], missing: string[] }} matched files and unmatched entries
 */
export function expandEntry(root, entry) {
  const glob = /^(.*?)\/?\*\*\/\*(\.[^/*]+)$/.exec(entry);
  if (glob) {
    const [, prefix, suffix] = glob;
    const dir = join(root, prefix);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      return { files: [], missing: [entry] };
    }
    const files = walk(root, dir, suffix);
    return files.length === 0 ? { files: [], missing: [entry] } : { files, missing: [] };
  }
  const abs = join(root, entry);
  if (existsSync(abs) && statSync(abs).isFile()) {
    return { files: [entry], missing: [] };
  }
  return { files: [], missing: [entry] };
}

/**
 * Measure one gate's list of entries.
 *
 * @param {string} root - absolute repo root
 * @param {string[]} entries - allowlist entries for this gate
 * @param {number} gate - the gate's line limit
 * @returns {{ files: { path: string, lines: number }[], total: number, gate: number, missing: string[] }} gate report
 */
export function measureList(root, entries, gate) {
  const paths = new Set();
  const missing = [];
  for (const entry of entries) {
    const expanded = expandEntry(root, entry);
    for (const file of expanded.files) paths.add(file);
    missing.push(...expanded.missing);
  }
  const files = [...paths].sort().map((path) => ({ path, lines: countLines(join(root, path)) }));
  const total = files.reduce((sum, file) => sum + file.lines, 0);
  return { files, total, gate, missing };
}

/**
 * Read and validate the allowlist file.
 *
 * @param {string} allowlistPath - absolute path of the allowlist JSON
 * @returns {{ authority: string[], machinery: string[], gates: { authority: number, machinery: number } }} parsed allowlist
 * @throws {Error} when a list or gate is missing or has the wrong type
 */
export function readAllowlist(allowlistPath) {
  const parsed = JSON.parse(readFileSync(allowlistPath, 'utf8'));
  for (const key of GATE_KEYS) {
    if (!Array.isArray(parsed[key]) || !parsed[key].every((e) => typeof e === 'string')) {
      throw new Error(`allowlist "${key}" must be an array of strings`);
    }
    if (typeof parsed.gates?.[key] !== 'number') {
      throw new Error(`allowlist "gates.${key}" must be a number`);
    }
  }
  return parsed;
}

/**
 * Build the full report for both gates.
 *
 * @param {string} root - absolute repo root
 * @param {{ authority: string[], machinery: string[], gates: { authority: number, machinery: number } }} allowlist - parsed allowlist
 * @returns {{ authority: object, machinery: object, generatedAt: string }} report
 */
export function buildReport(root, allowlist) {
  const report = {};
  for (const key of GATE_KEYS) {
    report[key] = measureList(root, allowlist[key], allowlist.gates[key]);
  }
  report.generatedAt = new Date().toISOString();
  return report;
}

/**
 * Render the report as a two-column table followed by totals against gates.
 *
 * @param {ReturnType<typeof buildReport>} report - the report to render
 * @returns {string} human-readable text
 */
export function renderText(report) {
  const lines = [];
  for (const key of GATE_KEYS) {
    const section = report[key];
    lines.push(`${key.toUpperCase()}`);
    const width = Math.max(4, ...section.files.map((f) => f.path.length));
    lines.push(`${'FILE'.padEnd(width)}  LINES`);
    for (const file of section.files) {
      lines.push(`${file.path.padEnd(width)}  ${String(file.lines).padStart(5)}`);
    }
    for (const entry of section.missing) {
      lines.push(`missing: ${entry}`);
    }
    lines.push('');
  }
  lines.push('TOTALS');
  for (const key of GATE_KEYS) {
    const { total, gate } = report[key];
    const status = total > gate ? 'OVER' : 'ok';
    lines.push(`${key.padEnd(9)}  ${String(total).padStart(5)} / ${gate}  ${status}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Whether any gate's total exceeds its limit.
 *
 * @param {ReturnType<typeof buildReport>} report - the report to check
 * @returns {boolean} true when at least one total is over its gate
 */
export function exceedsGate(report) {
  return GATE_KEYS.some((key) => report[key].total > report[key].gate);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const report = buildReport(options.root, readAllowlist(options.allowlist));
  process.stdout.write(options.text ? renderText(report) : `${JSON.stringify(report, null, 2)}\n`);
  if (options.enforce && exceedsGate(report)) {
    process.exitCode = 1;
  }
}
