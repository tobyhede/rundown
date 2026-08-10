// Record what one CI mutation shard actually achieved, whatever happened to it.
//
// Stryker writes its JSON report only when a run COMPLETES, so a shard killed by
// a timeout leaves nothing behind: its artifact upload finds no file, and the
// merge job can then see only that a report is absent — never why, or how far
// the shard got. That is the silent gap issue #670 calls out. This script closes
// it by writing a small status document on EVERY exit path (the workflow calls
// it from an `if: always()` step), so "the shard ran and found nothing" and "the
// shard never finished" are distinguishable downstream.
//
// It parses two things out of the captured Stryker log:
//   * `Instrumented N source file(s) with M mutant(s)` - the scope that actually
//     resolved, which is also how a mis-scoped run (0 files) is caught.
//   * the last `Mutation testing ... N/M tested (...)` progress line - how far
//     the run got and how long it took, which together give the measured
//     mutants/min the shard budget has to be calibrated against.
//
// Inputs (env):
//   MODULE, SHARD, SHARD_COUNT, PACKAGE, MUTATE, CONCURRENCY - matrix values
//   OUTCOME      - the shard step's `steps.<id>.outcome`
//   SHARD_LOG    - captured combined output of the Stryker run
//   REPORT       - path Stryker was configured to write its JSON report to
//   STATUS_FILE  - where to write the status JSON

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Matching the ESC control character is precisely the point of an ANSI stripper;
// building the pattern from a string keeps a literal control byte out of this file.
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');

/**
 * Strip ANSI escape sequences from captured output.
 *
 * Stryker writes color codes around its console reporters, and the progress bar
 * in particular interleaves them with the very numbers parsed below, so every pattern
 * here runs against the stripped text rather than the raw log.
 *
 * @param {string} log - raw captured output.
 * @returns {string} the same text without SGR/cursor escape sequences.
 */
export function stripAnsi(log) {
  return log.replace(ANSI_PATTERN, '');
}

/**
 * Read the scope Stryker resolved from its instrumentation line.
 *
 * @param {string} log - captured Stryker output.
 * @returns {{files: number, mutants: number} | null} the instrumented counts, or
 *   null when the run never got as far as instrumenting.
 */
export function parseInstrumented(log) {
  const match = /Instrumented (\d+) source file\(s\) with (\d+) mutant\(s\)/.exec(stripAnsi(log));
  if (!match) return null;
  return { files: Number(match[1]), mutants: Number(match[2]) };
}

/**
 * Read the furthest progress the run reached.
 *
 * Stryker rewrites the progress bar in place, so a captured log holds every
 * intermediate line; the LAST match is the one that describes where the run
 * stopped. `elapsed` is reported as a human duration (`~1h 4m`, `~57m`), which
 * is normalised to minutes so a rate can be computed from it.
 *
 * @param {string} log - captured Stryker output.
 * @returns {{tested: number, total: number, elapsedMinutes: number | null} | null}
 *   the final progress reading, or null when no progress line was emitted.
 */
export function parseProgress(log) {
  const pattern = /elapsed:\s*~?([^),\r\n]*?)\s*,\s*remaining:[^)\r\n]*\)\s*(\d+)\/(\d+) tested/g;
  let last = null;
  for (const match of stripAnsi(log).matchAll(pattern)) last = match;
  if (!last) return null;
  const hours = /(\d+)\s*h/.exec(last[1]);
  // `(?!s)` so a millisecond reading is never read as minutes.
  const minutes = /(\d+)\s*m(?!s)/.exec(last[1]);
  const elapsedMinutes =
    hours || minutes ? Number(hours?.[1] ?? 0) * 60 + Number(minutes?.[1] ?? 0) : null;
  return { tested: Number(last[2]), total: Number(last[3]), elapsedMinutes };
}

/**
 * Build the status document for one shard.
 *
 * @param {object} params - shard facts.
 * @param {Record<string, string | undefined>} params.env - environment holding the matrix values.
 * @param {string} params.log - captured Stryker output ('' when nothing was captured).
 * @param {boolean} params.reportWritten - whether Stryker's JSON report exists.
 * @returns {object} the status document.
 */
export function buildStatus({ env, log, reportWritten }) {
  const asInt = (value) => {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isInteger(parsed) ? parsed : null;
  };
  return {
    module: env.MODULE ?? '',
    package: env.PACKAGE ?? '',
    shard: asInt(env.SHARD),
    shardCount: asInt(env.SHARD_COUNT),
    concurrency: asInt(env.CONCURRENCY),
    // The Stryker scope verbatim, so a shard can be re-run by hand from the
    // status alone.
    mutate: env.MUTATE ?? '',
    outcome: env.OUTCOME || 'unknown',
    reportWritten,
    instrumented: parseInstrumented(log),
    progress: parseProgress(log),
  };
}

/**
 * Entry point: write the status document described by the environment.
 *
 * @returns {number} process exit code. Always 0 - a status writer must never be
 *   the reason a shard job fails, or it would replace the gap it exists to
 *   report with a different one.
 */
export function main() {
  const statusFile = process.env.STATUS_FILE;
  if (!statusFile) {
    process.stderr.write('STATUS_FILE is required\n');
    return 0;
  }
  const logPath = process.env.SHARD_LOG ?? '';
  let log = '';
  if (logPath && existsSync(logPath)) {
    try {
      log = readFileSync(logPath, 'utf8');
    } catch (error) {
      process.stderr.write(`could not read ${logPath}: ${error.message}\n`);
    }
  }
  const report = process.env.REPORT ?? '';
  const status = buildStatus({
    env: process.env,
    log,
    reportWritten: report !== '' && existsSync(report),
  });
  writeFileSync(statusFile, `${JSON.stringify(status, null, 2)}\n`);
  process.stderr.write(`${JSON.stringify(status)}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main();
