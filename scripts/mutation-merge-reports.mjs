// Merge per-shard Stryker reports back into one full report per module, upload
// it once to the dashboard, and apply the aggregate break threshold.
//
// The producer fans a module's mutation campaign across shards that each mutate
// a DISJOINT set of files (see mutation-shard-plan.mjs). Each shard uploads its
// partial `mutation-report.json` as a CI artifact but never writes to the
// dashboard — a partial, scoped report would overwrite the module's baseline
// with a thin one. This job runs after all shards: it unions their `files`
// (disjoint keys, so no collision) into a single complete module report,
// recomputes the aggregate score, PUTs it to the dashboard once (when the run
// is an upload-eligible producer), and fails if a module's aggregate falls
// under the break floor.
//
// Inputs (env):
//   DOWNLOAD_DIR   - dir holding `mutation-report-<module>-shard<N>/mutation-report.json`
//   MATRIX         - the plan job's matrix JSON; used to verify every expected
//                    shard produced a report (a crashed shard runs under
//                    continue-on-error, so its absence must fail the merge here)
//   UPLOAD         - 'true' to PUT merged reports to the dashboard
//   DASHBOARD_API_KEY - Stryker dashboard key (required when UPLOAD=true)
//   APPLY_BREAK    - 'true' to exit non-zero when a module aggregate < BREAK
//   BREAK          - aggregate break floor (default 70)
//   PROJECT        - dashboard project slug (default github.com/tobyhede/rundown)
//   VERSION        - dashboard report version (default main)
//   OUT_DIR        - where merged reports are written (default ./merged-reports)

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const downloadDir = process.env.DOWNLOAD_DIR ?? 'shard-reports';
const upload = process.env.UPLOAD === 'true';
const apiKey = process.env.DASHBOARD_API_KEY ?? '';
const applyBreak = process.env.APPLY_BREAK === 'true';
const breakFloor = Number.parseInt(process.env.BREAK ?? '', 10) || 70;
const project = process.env.PROJECT ?? 'github.com/tobyhede/rundown';
const version = process.env.VERSION ?? 'main';
const outDir = process.env.OUT_DIR ?? 'merged-reports';
const dashboardBase =
  process.env.DASHBOARD_BASE ?? 'https://dashboard.stryker-mutator.io/api/reports';

const DETECTED = new Set(['Killed', 'Timeout']);
const UNDETECTED = new Set(['Survived', 'NoCoverage']);

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
 * Discover shard report files grouped by module. Expects artifact directories
 * named `mutation-report-<module>-shard<N>` each containing one report JSON.
 *
 * @param {string} dir - the artifact download directory.
 * @returns {Map<string, string[]>} module name -> report file paths.
 */
function collectShardReports(dir) {
  const byModule = new Map();
  if (!existsSync(dir)) return byModule;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const match = /^mutation-report-([a-z]+)-shard\d+$/.exec(entry.name);
    if (!match) continue;
    const module = match[1];
    const reportPath = join(dir, entry.name, 'mutation-report.json');
    if (!existsSync(reportPath)) continue;
    if (!byModule.has(module)) byModule.set(module, []);
    byModule.get(module).push(reportPath);
  }
  return byModule;
}

/**
 * Combine shard reports for one module into a single complete report. `files`
 * keys are disjoint across shards; `testFiles` may repeat (same file relates to
 * sources in several shards) and is merged by key.
 *
 * @param {string[]} reportPaths - shard report file paths for the module.
 * @returns {object} the merged report.
 */
function mergeModule(reportPaths) {
  const reports = reportPaths.map((p) => JSON.parse(readFileSync(p, 'utf8')));
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
    Object.assign(merged.files, r.files ?? {});
    Object.assign(testFiles, r.testFiles ?? {});
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
 * Expected shard count per module, parsed from the plan matrix. A shard that
 * crashed produced no artifact; comparing found-vs-expected turns that silent
 * gap into a merge failure (low-score exits are swallowed by continue-on-error,
 * so absence is the only crash signal left).
 *
 * @returns {Map<string, number>} module -> expected shard count.
 */
function expectedShardCounts() {
  const counts = new Map();
  const raw = process.env.MATRIX;
  if (!raw) return counts;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return counts;
  }
  for (const entry of parsed.include ?? []) {
    counts.set(entry.module, (counts.get(entry.module) ?? 0) + 1);
  }
  return counts;
}

const byModule = collectShardReports(downloadDir);
const expected = expectedShardCounts();

// Zero reports is only a legitimate no-op when the plan expected no shards. If
// the plan DID expect shards and none produced a report, every shard crashed —
// the loudest possible failure, and previously the quietest: this returned 0, so
// a run whose entire mutation campaign died reported success. That inverted the
// partial-loss check below, which correctly fails when 1 of 2 shards is missing.
if (byModule.size === 0) {
  const wanted = [...expected.values()].reduce((sum, n) => sum + n, 0);
  if (wanted === 0) {
    process.stderr.write(`no shard reports found under ${downloadDir}; nothing to merge.\n`);
    process.exit(0);
  }
  process.stderr.write(
    `no shard reports found under ${downloadDir}, but the plan expected ${wanted} ` +
      `(${[...expected].map(([m, n]) => `${m}:${n}`).join(', ')}); every shard crashed.\n`,
  );
  process.exit(1);
}
if (upload && !apiKey) throw new Error('UPLOAD=true but DASHBOARD_API_KEY is empty');

mkdirSync(outDir, { recursive: true });
const failures = [];
const summary = [];

// Fail on any module that lost a shard (crash → no artifact), so a partial
// merge never masquerades as a complete baseline. An incomplete module must
// also be barred from the dashboard upload below: seeding the baseline with a
// partial report is exactly the corruption this check exists to prevent.
const incomplete = new Set();
for (const [module, want] of expected) {
  const got = byModule.get(module)?.length ?? 0;
  if (got < want) {
    incomplete.add(module);
    failures.push(`${module}: only ${got}/${want} shard reports present (a shard crashed)`);
  }
}

for (const [module, paths] of byModule) {
  const merged = mergeModule(paths);
  const { score, detected, valid, total } = scoreOf(merged);
  writeFileSync(join(outDir, `${module}.json`), JSON.stringify(merged));
  summary.push(
    `${module}: ${score.toFixed(2)}% (${detected}/${valid} detected, ${total} mutants, ${paths.length} shards)`,
  );

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

process.stderr.write(`\nmerged module scores:\n${summary.join('\n')}\n`);
if (process.env.GITHUB_STEP_SUMMARY) {
  writeFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `## Mutation (merged)\n\n${summary.map((s) => `- ${s}`).join('\n')}\n`,
    { flag: 'a' },
  );
}
if (failures.length > 0) {
  process.stderr.write(`\nFAILURES:\n${failures.join('\n')}\n`);
  process.exit(1);
}
