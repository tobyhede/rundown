// Merge per-shard Stryker reports back into one full report per module, upload
// it once to the dashboard, and apply the aggregate break threshold.
//
// The producer fans a module's mutation campaign across shards that each mutate
// a disjoint set of SCOPES — whole files, or line ranges of one file too large
// to measure in a single shard (see mutation-shard-plan.mjs). Each shard uploads
// its partial `mutation-report.json` as a CI artifact but never writes to the
// dashboard — a partial, scoped report would overwrite the module's baseline
// with a thin one. This job runs after all shards: it unions their `files` into
// a single complete module report (a split file's key arrives from several
// shards, so entries are combined by mutant identity, not overwritten), recomputes
// the aggregate score, PUTs it to the dashboard once (when the run is an
// upload-eligible producer), and fails if a module's aggregate falls under the
// break floor.
//
// It also ACCOUNTS FOR EVERY PLANNED SHARD. A shard killed by a timeout writes
// no report at all, so absence used to be the only trace it left; each missing
// shard is now named, explained from its status artifact, and reported in the
// job summary (issue #670).
//
// Inputs (env):
//   DOWNLOAD_DIR   - dir holding `mutation-report-<module>-shard<N>/mutation-report.json`
//   STATUS_DIR     - dir holding `mutation-status-<module>-shard<N>/shard-status.json`,
//                    written by scripts/mutation-shard-status.mjs on every shard
//                    exit path. A shard killed by a timeout writes no report, so
//                    the status is the ONLY evidence of how far it got.
//   MATRIX         - the plan job's matrix JSON; used to verify every expected
//                    shard produced a report (a crashed shard runs under
//                    continue-on-error, so its absence must fail the merge here)
//   UPLOAD         - 'true' to PUT merged reports to the dashboard
//   DASHBOARD_API_KEY - Stryker dashboard key (required when UPLOAD=true)
//   APPLY_BREAK    - 'true' to exit non-zero when a module aggregate < BREAK
//   BREAK          - aggregate break floor (default 60). This is the ONLY place a
//                    complete module score exists, so it is the only place a
//                    score floor can mean anything: every individual `stryker
//                    run` in this repo is scoped to a fraction of a module. 60,
//                    not 70, because 70 sat above every score a module has ever
//                    achieved (plugin 66.17%, cli 64.51%).
//   PROJECT        - dashboard project slug (default github.com/tobyhede/rundown)
//   VERSION        - dashboard report version (default main)
//   OUT_DIR        - where merged reports are written (default ./merged-reports)

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { mutantIdentity } from './assert-mutation-regressions.mjs';
import { PACKAGES } from './lib/mutation-scope.mjs';

const downloadDir = process.env.DOWNLOAD_DIR ?? 'shard-reports';
const statusDir = process.env.STATUS_DIR ?? 'shard-status';
const upload = process.env.UPLOAD === 'true';
const apiKey = process.env.DASHBOARD_API_KEY ?? '';
const applyBreak = process.env.APPLY_BREAK === 'true';
const breakFloor = Number.parseInt(process.env.BREAK ?? '', 10) || 60;
const project = process.env.PROJECT ?? 'github.com/tobyhede/rundown';
const version = process.env.VERSION ?? 'main';
const outDir = process.env.OUT_DIR ?? 'merged-reports';
const dashboardBase =
  process.env.DASHBOARD_BASE ?? 'https://dashboard.stryker-mutator.io/api/reports';

const DETECTED = new Set(['Killed', 'Timeout']);
const UNDETECTED = new Set(['Survived', 'NoCoverage']);

/**
 * The only module names a shard artifact may claim.
 *
 * Single-sourced from {@link PACKAGES}, which is also what the shard planner
 * builds the matrix from, so the collectors below and the plan cannot disagree
 * about what a module is. Both collectors previously accepted any `[a-z]+`
 * directory name, which had two consequences:
 *
 * - **A junk dashboard module.** An artifact directory naming a module that does
 *   not exist would be merged and PUT to the dashboard under that name, silently
 *   creating a module on a public dashboard that nothing in this repo produces.
 * - **A file-data-to-network flow.** The artifact directory name is data read off
 *   the filesystem, and its module component reached the upload URL. The URL's
 *   HOST never did — `dashboardBase` and `project` are env-derived with constant
 *   defaults — so this was never host redirection, and the slug was already
 *   `encodeURIComponent`'d into a query parameter. Constraining it to a fixed set
 *   removes the flow at the source rather than relying on that encoding.
 *
 * The same constraint protects `${module}.json` under OUT_DIR, which is a path
 * built from the same string.
 */
const KNOWN_MODULES = new Set(PACKAGES.map((pkg) => pkg.module));

/**
 * Matches both shard artifact families. ONE regex, shared by both collectors, so
 * they cannot drift on what a valid artifact name is — a name that parses for
 * reports must parse identically for statuses, differing only in `kind`.
 */
const SHARD_ARTIFACT = /^mutation-(report|status)-([a-z]+)-shard(\d+)$/;

/**
 * Parse a shard artifact directory name into the module and shard it belongs to.
 *
 * @param {string} name - the artifact directory name.
 * @param {'report' | 'status'} kind - which artifact family to accept.
 * @returns {{module: string, shard: number} | null} the parsed identity, or null
 *   when the name is not a shard artifact of this kind, or names a module outside
 *   {@link KNOWN_MODULES}.
 */
function parseShardArtifact(name, kind) {
  const match = SHARD_ARTIFACT.exec(name);
  if (!match || match[1] !== kind) return null;
  const [, , module, shard] = match;
  if (!KNOWN_MODULES.has(module)) {
    // Not fatal — a stray directory must not take down a merge that has real
    // reports — but never silent either. Every other unmeasured-shard path in
    // this script is named and explained, and an artifact dropped on the floor
    // is exactly the kind of thing that should not vanish quietly. A shard the
    // PLAN expected is still reported as NOT MEASURED by the completeness check,
    // because the plan is built from the same PACKAGES list.
    process.stderr.write(
      `ignoring artifact '${name}': '${module}' is not a known module ` +
        `(${[...KNOWN_MODULES].join(', ')})\n`,
    );
    return null;
  }
  return { module, shard: Number(shard) };
}

/**
 * Recompute a report's mutation score from its merged mutants. Mirrors Stryker:
 * score = detected / valid, where valid = detected + undetected and
 * ignored/runtime/compile-error mutants are excluded.
 *
 * @param {object} report - a (merged) mutation-testing report.
 * @returns {{score: number, detected: number, valid: number, total: number}}
 */
function scoreOf(report) {
  let detected = 0;
  let undetected = 0;
  let total = 0;
  for (const file of Object.values(report.files ?? {})) {
    for (const m of file.mutants ?? []) {
      total += 1;
      if (DETECTED.has(m.status)) detected += 1;
      else if (UNDETECTED.has(m.status)) undetected += 1;
    }
  }
  const valid = detected + undetected;
  return { score: valid ? (detected / valid) * 100 : 100, detected, valid, total };
}

/**
 * Discover shard report files grouped by module, keeping each report's shard
 * NUMBER. Expects artifact directories named `mutation-report-<module>-shard<N>`
 * each containing one report JSON, where `<module>` is one of
 * {@link KNOWN_MODULES}.
 *
 * The shard number is what lets the completeness check below name the shards
 * that are missing instead of only counting them — the difference between
 * "1 of 74 shards crashed" and "core shard 37 (src/runbook/compiler.ts:1-400)
 * was not measured".
 *
 * @param {string} dir - the artifact download directory.
 * @returns {Map<string, Array<{shard: number, path: string}>>} module -> shard reports.
 */
function collectShardReports(dir) {
  const byModule = new Map();
  if (!existsSync(dir)) return byModule;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const parsed = parseShardArtifact(entry.name, 'report');
    if (!parsed) continue;
    const reportPath = join(dir, entry.name, 'mutation-report.json');
    if (!existsSync(reportPath)) continue;
    if (!byModule.has(parsed.module)) byModule.set(parsed.module, []);
    byModule.get(parsed.module).push({ shard: parsed.shard, path: reportPath });
  }
  for (const reports of byModule.values()) reports.sort((a, b) => a.shard - b.shard);
  return byModule;
}

/**
 * Discover per-shard status documents, keyed `<module>#<shard>`.
 *
 * Statuses are best-effort context, never authority: a status is present for a
 * shard whose report is missing (that is the point), and absent for a job that
 * never reached its status step. Nothing here fails on a malformed one.
 *
 * @param {string} dir - the status artifact download directory.
 * @returns {Map<string, object>} `<module>#<shard>` -> status document.
 */
function collectShardStatuses(dir) {
  const statuses = new Map();
  if (!existsSync(dir)) return statuses;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const parsed = parseShardArtifact(entry.name, 'status');
    if (!parsed) continue;
    const statusPath = join(dir, entry.name, 'shard-status.json');
    if (!existsSync(statusPath)) continue;
    try {
      statuses.set(
        `${parsed.module}#${parsed.shard}`,
        JSON.parse(readFileSync(statusPath, 'utf8')),
      );
    } catch {
      // A truncated status must not take down a merge that has real reports.
    }
  }
  return statuses;
}

/**
 * Merge one file's mutants from two shard reports.
 *
 * Shards used to mutate disjoint FILES, so a plain key-overwrite union was
 * correct. Now that an oversized file is split into line-range scopes across
 * several shards (see partitionProducerFiles), the same `files` key legitimately
 * arrives more than once and an overwrite would silently discard every mutant a
 * sibling chunk measured. Mutants are therefore combined by cross-report identity
 * — the same key Stryker's own incremental differ uses — because that identity,
 * not the report-local `id`, is what makes two entries the same mutant.
 *
 * A duplicate is possible even between disjoint ranges: a chunk boundary can
 * land inside a multi-line expression. When it happens, a real result wins over
 * an `Ignored`/`Pending` placeholder, so a mutant measured by one chunk is never
 * demoted by another chunk that merely skipped it.
 *
 * @param {object} into - the accumulating merged file entry (mutated in place).
 * @param {object} from - the incoming shard's file entry.
 * @param {string} file - the report key, for diagnostics.
 */
function mergeFileEntry(into, from, file) {
  const placeholder = new Set(['Ignored', 'Pending']);
  // A mutant missing the identifying attributes cannot be correlated, so it
  // falls back to its own serialisation: byte-identical duplicates still
  // collapse, and anything else is kept. Merging must never DROP a measured
  // mutant, which a throw here would do to the whole module.
  const identify = (mutant) => {
    try {
      return mutantIdentity(mutant, file);
    } catch {
      return `raw:${JSON.stringify(mutant)}`;
    }
  };
  const seen = new Map();
  for (const [index, mutant] of (into.mutants ?? []).entries()) {
    seen.set(identify(mutant), index);
  }
  for (const mutant of from.mutants ?? []) {
    const key = identify(mutant);
    const existing = seen.get(key);
    if (existing === undefined) {
      seen.set(key, into.mutants.push(mutant) - 1);
      continue;
    }
    if (placeholder.has(into.mutants[existing].status) && !placeholder.has(mutant.status)) {
      into.mutants[existing] = mutant;
    }
  }
}

/**
 * Combine shard reports for one module into a single complete report.
 *
 * `testFiles` may repeat (the same test relates to sources in several shards)
 * and is merged by key. `files` keys may now also repeat, because one source
 * file's line ranges can be spread across shards; those entries are combined by
 * {@link mergeFileEntry} rather than overwritten.
 *
 * Mutant `id` is renumbered across the merged report. Stryker assigns it as a
 * run-global counter, so every shard starts again at 0 and a merged report would
 * otherwise carry duplicate ids — within one file, once a file is split. The
 * schema wants them unique, and no consumer correlates ids across reports
 * (`assert-mutation-regressions.mjs` documents exactly why it does not).
 *
 * @param {Array<{shard: number, path: string}>} shardReports - the module's shard reports.
 * @returns {object} the merged report.
 */
function mergeModule(shardReports) {
  const reports = shardReports.map(({ path }) => JSON.parse(readFileSync(path, 'utf8')));
  const merged = {
    schemaVersion: reports[0].schemaVersion,
    thresholds: reports[0].thresholds,
    projectRoot: reports[0].projectRoot,
    files: {},
  };
  if (reports[0].framework) merged.framework = reports[0].framework;
  if (reports[0].config) merged.config = reports[0].config;
  const testFiles = {};
  for (const r of reports) {
    for (const [file, entry] of Object.entries(r.files ?? {})) {
      const existing = merged.files[file];
      if (!existing) {
        merged.files[file] = { ...entry, mutants: [...(entry.mutants ?? [])] };
        continue;
      }
      mergeFileEntry(existing, entry, file);
    }
    Object.assign(testFiles, r.testFiles ?? {});
  }
  let nextId = 0;
  for (const entry of Object.values(merged.files)) {
    entry.mutants = (entry.mutants ?? []).map((mutant) => ({ ...mutant, id: String(nextId++) }));
  }
  if (Object.keys(testFiles).length > 0) merged.testFiles = testFiles;
  return merged;
}

/**
 * PUT a merged module report to the Stryker dashboard.
 *
 * @param {string} module - the dashboard module name.
 * @param {object} report - the full merged report.
 * @returns {Promise<void>}
 * @throws when the dashboard responds with a non-2xx status.
 */
async function uploadToDashboard(module, report) {
  const url = `${dashboardBase}/${project}/${encodeURIComponent(version)}?module=${encodeURIComponent(module)}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: JSON.stringify(report),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`dashboard PUT ${module} failed: ${res.status} ${res.statusText} ${body}`);
  }
  const json = await res.json().catch(() => ({}));
  process.stderr.write(`uploaded ${module}: ${json.href ?? url}\n`);
}

/**
 * Every shard the plan matrix expected, per module, keyed by shard number and
 * carrying its Stryker scope. A shard that crashed produced no artifact;
 * comparing found-vs-expected turns that silent gap into a merge failure
 * (low-score exits are swallowed by continue-on-error, so absence is the only
 * crash signal left), and keeping the scope lets the failure NAME what went
 * unmeasured instead of only counting it.
 *
 * @returns {{known: true, planned: Map<string, Map<number, {mutate: string}>>} | {known: false, reason: string}}
 *   the planned shards, or a diagnostic explaining why expectations are unknown.
 */
function expectedShards() {
  /** @type {Map<string, Map<number, {mutate: string}>>} */
  const planned = new Map();
  const raw = process.env.MATRIX;
  if (!raw) return { known: false, reason: 'MATRIX is absent' };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { known: false, reason: 'MATRIX is not valid JSON' };
  }
  if (!Array.isArray(parsed?.include)) {
    return { known: false, reason: 'MATRIX has no include array' };
  }
  for (const entry of parsed.include) {
    if (!planned.has(entry.module)) planned.set(entry.module, new Map());
    const shards = planned.get(entry.module);
    // Fall back to positional numbering if a matrix entry ever lacks `shard`, so
    // an unnumbered plan still yields the right EXPECTED COUNT.
    const shard = Number.isInteger(entry.shard) ? entry.shard : shards.size + 1;
    shards.set(shard, { mutate: typeof entry.mutate === 'string' ? entry.mutate : '' });
  }
  return { known: true, planned };
}

/**
 * Explain, for a human, why a planned shard produced no report.
 *
 * The distinction this draws is the whole point of the status artifact: a shard
 * that was killed mid-run reports how far it got and how fast it was going,
 * which is exactly the measurement the shard budget has to be calibrated
 * against. Without it every unmeasured shard looks identical.
 *
 * @param {object | undefined} status - the shard's status document, when uploaded.
 * @param {string} plannedMutate - the shard's planned Stryker scope, from the matrix.
 * @returns {string} a one-line reason.
 */
function describeMissing(status, plannedMutate) {
  const scope = status?.mutate || plannedMutate;
  const withScope = (text) => (scope ? `${text}; scope: ${scope}` : text);
  if (!status) {
    return withScope(
      'no report and no status artifact — the shard job never reached its status step',
    );
  }
  const parts = [];
  const outcome = status.outcome ?? 'unknown';
  parts.push(
    outcome === 'cancelled'
      ? 'the shard was cancelled (job timeout or a cancelled run)'
      : `the Stryker step ended '${outcome}' without writing a report (step timeout or crash)`,
  );
  if (status.instrumented) {
    parts.push(
      `instrumented ${status.instrumented.files} file(s) / ${status.instrumented.mutants} mutant(s)`,
    );
  }
  const progress = status.progress;
  if (progress) {
    const rate =
      progress.elapsedMinutes > 0
        ? `, ~${(progress.tested / progress.elapsedMinutes).toFixed(1)} mutants/min`
        : '';
    parts.push(
      `reached ${progress.tested}/${progress.total} tested in ~${progress.elapsedMinutes ?? '?'} min${rate}`,
    );
  }
  return withScope(parts.join('; '));
}

/**
 * Append a block to the GitHub job summary, when running under Actions.
 *
 * @param {string} markdown - the markdown to append.
 */
function appendJobSummary(markdown) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  writeFileSync(path, markdown, { flag: 'a' });
}

const byModule = collectShardReports(downloadDir);
const statuses = collectShardStatuses(statusDir);
const expected = expectedShards();

// Unknown expectations fail closed regardless of how many reports arrived. Scoped
// to the zero-report case this guard missed the more damaging half: with reports
// PRESENT the completeness loop below iterates nothing, so `incomplete` stays
// empty and a partial merge is uploaded straight over the module's dashboard
// baseline — the corruption this script exists to prevent.
if (!expected.known) {
  process.stderr.write(
    `plan expectations are unknown: ${expected.reason}. ` +
      `Refusing to merge ${byModule.size} module report(s): without the plan matrix a ` +
      'crashed shard is indistinguishable from a complete run, and a partial merge ' +
      'would overwrite the dashboard baseline.\n',
  );
  appendJobSummary(
    `## Mutation (merged)\n\n### ⚠️ Not merged\n\nThe plan matrix was unusable (${expected.reason}), ` +
      'so a crashed shard could not be told apart from a complete run. Nothing was merged or ' +
      'uploaded.\n',
  );
  process.exit(1);
}

// Account for EVERY planned shard before anything else, so the outcome of the
// campaign is legible whether it merged cleanly, lost one shard, or lost all of
// them. Previously the all-shards-lost path exited from inside a bare `if` with
// a single stderr line and no job summary at all — the loudest failure reported
// most quietly.
/** @type {Array<{module: string, shard: number, reason: string}>} */
const notMeasured = [];
const incomplete = new Set();
let plannedShards = 0;
for (const [module, shards] of expected.planned) {
  const measured = new Set((byModule.get(module) ?? []).map((r) => r.shard));
  for (const [shard, plan] of shards) {
    plannedShards += 1;
    if (measured.has(shard)) continue;
    incomplete.add(module);
    notMeasured.push({
      module,
      shard,
      reason: describeMissing(statuses.get(`${module}#${shard}`), plan.mutate),
    });
  }
}

const failures = notMeasured.map(
  ({ module, shard, reason }) => `${module} shard ${shard}: NOT MEASURED — ${reason}`,
);
const summary = [];

/**
 * Emit the campaign report to stderr and the job summary, then exit.
 *
 * Every exit path goes through here, so a reader always gets the same document:
 * merged module scores, then an explicit "not measured" list. A shard that
 * produced no report is the one thing this job exists to make visible, and it
 * must never be able to leave silently.
 *
 * @param {number} code - the process exit code.
 * @returns {never}
 */
function report(code) {
  const scored = summary.length > 0 ? summary : ['(no module produced a mergeable report)'];
  process.stderr.write(`\nmerged module scores:\n${scored.join('\n')}\n`);
  const lines = ['## Mutation (merged)', '', ...scored.map((s) => `- ${s}`)];
  if (notMeasured.length > 0) {
    lines.push(
      '',
      `### ⚠️ ${notMeasured.length} of ${plannedShards} planned shard(s) NOT MEASURED`,
      '',
      'These shards produced no mutation report. Their files are absent from the merged',
      'score above — read that score as incomplete, not as a clean result.',
      '',
      ...notMeasured.map(
        ({ module, shard, reason }) => `- \`${module}\` shard ${shard}: ${reason}`,
      ),
    );
  }
  appendJobSummary(`${lines.join('\n')}\n`);
  if (failures.length > 0) process.stderr.write(`\nFAILURES:\n${failures.join('\n')}\n`);
  process.exit(code);
}

// Zero reports is only a legitimate no-op when the plan expected no shards. If
// the plan DID expect shards and none produced a report, every shard crashed —
// the loudest possible failure, and previously the quietest: this returned 0, so
// a run whose entire mutation campaign died reported success. That inverted the
// partial-loss check below, which correctly fails when 1 of 2 shards is missing.
if (byModule.size === 0) {
  if (plannedShards === 0) {
    process.stderr.write(`no shard reports found under ${downloadDir}; nothing to merge.\n`);
    report(0);
  }
  process.stderr.write(
    `no shard reports found under ${downloadDir}, but the plan expected ${plannedShards} ` +
      `(${[...expected.planned].map(([m, s]) => `${m}:${s.size}`).join(', ')}); ` +
      'every shard crashed.\n',
  );
  report(1);
}
if (upload && !apiKey) throw new Error('UPLOAD=true but DASHBOARD_API_KEY is empty');

mkdirSync(outDir, { recursive: true });

for (const [module, shardReports] of byModule) {
  const merged = mergeModule(shardReports);
  const { score, detected, valid, total } = scoreOf(merged);
  writeFileSync(join(outDir, `${module}.json`), JSON.stringify(merged));
  const planned = expected.planned.get(module)?.size ?? shardReports.length;
  summary.push(
    `${module}: ${score.toFixed(2)}% (${detected}/${valid} detected, ${total} mutants, ` +
      `${shardReports.length}/${planned} shards measured)`,
  );
  // A shard CAN finish and legitimately measure nothing (an empty scope), and
  // that is not the same as a shard that never reported. Say so rather than
  // letting a 100%-of-nothing module read as a clean pass.
  if (total === 0) {
    failures.push(`${module}: every measured shard reported 0 mutants (scope resolved to nothing)`);
  }

  // Only upload a module with full shard coverage; an incomplete merge would
  // overwrite the dashboard baseline with a partial report.
  if (upload && !incomplete.has(module)) {
    try {
      await uploadToDashboard(module, merged);
    } catch (err) {
      failures.push(`upload ${module}: ${err.message}`);
    }
  }
  if (applyBreak && score < breakFloor) {
    failures.push(`${module} score ${score.toFixed(2)}% under break ${breakFloor}`);
  }
}

report(failures.length > 0 ? 1 : 0);
