#!/usr/bin/env node
/**
 * Audit every pnpm override for whether it is still load-bearing.
 *
 * ## Why this script exists
 *
 * The removal test this repo documented for years was unsound:
 *
 *     delete the pin -> `pnpm install` -> run `osv-scanner` -> clean? drop it.
 *
 * pnpm never *downgrades* an already-satisfying locked version. So a Category B
 * pin — whose entire purpose is to stop resolution landing on a vulnerable
 * version — leaves the lockfile untouched when you delete it, scans clean, and
 * looks redundant whether or not it actually is. The test can only ever detect
 * Category A pins (an out-of-range force, which pnpm must undo).
 *
 * The consequence is not theoretical. `brace-expansion` was pinned when the only
 * fixed release genuinely was on the 5.x line, then upstream backported the fix
 * to 1.x and 2.x and OSV was edited in place. The pin became redundant — and
 * harmful, forcing two subtrees cross-major into a new `engines` floor — and
 * nothing detected it, because the documented test could not.
 *
 * The sound test deletes the lockfile so resolution runs from scratch, and
 * compares against a control run of the same shape (a fresh resolve differs from
 * the committed lockfile in many unrelated ways, so comparing against the
 * committed state reports noise as signal).
 *
 * ## What it reports
 *
 * For each entry in `override-policy.json`, one of:
 *
 * | Verdict        | Meaning                                                       |
 * | -------------- | ------------------------------------------------------------- |
 * | `LOAD-BEARING` | removing it lets resolution reach a vulnerable version         |
 * | `INERT`        | resolution reaches a safe version without it — candidate to drop |
 * | `PROTECTED`    | `scannerInvisible` in the policy: keep regardless of the scan  |
 * | `ERROR`        | resolution failed without it (itself a reason to keep it)      |
 *
 * `PROTECTED` exists because not every override guards something OSV can see.
 * The three Category A `js-yaml` pins hold `gray-matter`, `read-yaml-file`, and
 * `@istanbuljs/load-nyc-config` on 4.x so that `patches/gray-matter@4.0.3.patch`
 * and `patches/read-yaml-file@1.1.0.patch` keep meaning what they say: they
 * rewrite the removed `safeLoad`/`safeDump` to `load`/`dump`, which is the SAFE
 * schema only on 4.x. On 3.x `load` is the full/unsafe loader, so dropping those
 * pins would trade a DoS for arbitrary type construction — with a clean scan.
 * A tool that recommended removing them would be actively dangerous, so the
 * policy file marks them and this script refuses to test them for removal.
 *
 * An `INERT` verdict is a *candidate*, not an instruction. Read the entry's
 * `reason` before dropping it.
 *
 * ## Usage
 *
 *     node scripts/audit-overrides.mjs              # audit every override
 *     node scripts/audit-overrides.mjs --print      # show the plan, run nothing
 *     node scripts/audit-overrides.mjs qs hono      # audit only these keys
 *     node scripts/audit-overrides.mjs --concurrency 2
 *
 * Exits non-zero only on a tool failure. A clean audit that finds inert pins
 * still exits 0 — this is a reporting tool, not a gate. Pruning is a judgement
 * call a human makes with the `reason` field in front of them.
 */
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Default parallel resolves. Each is network-bound, not CPU-bound. */
export const DEFAULT_CONCURRENCY = 4;

/** Verdict ordering for the report — the actionable rows come first. */
export const VERDICT_ORDER = { 'LOAD-BEARING': 0, PROTECTED: 1, ERROR: 2, INERT: 3 };

/** Every flag this script accepts. Anything else spelled `--…` is a typo. */
const KNOWN_FLAGS = new Set(['--print', '--concurrency']);

/**
 * Parse the command line.
 *
 * Unrecognised `--…` tokens are rejected rather than dropped. A silently ignored
 * flag is the worst possible outcome for this command: `--dry-run` reads as a
 * request for a preview, and filtering it out leaves an EMPTY selection — which
 * means "audit every override", so the typo starts the full multi-minute network
 * run it was trying to avoid.
 *
 * @param argv - arguments after the script name
 * @returns the parsed options and the explicitly selected override keys, plus an
 *   `error` string when an option value is unusable, repeated, or a flag is unsupported
 */
export function parseArgs(argv) {
  // EVERY occurrence, not just the first: locating the flag with indexOf inspected one
  // and let the rest through untouched, because `--concurrency` is a KNOWN flag and the
  // unknown-flag guard below has no complaint about it. A repeat's value then fell
  // outside the excluded value slot and into `keys`, and a TRAILING repeat left no value
  // to exclude at all — so `--concurrency 2 --concurrency` parsed clean with an EMPTY
  // selection, which means "audit every override" and starts the full multi-minute
  // network run that the unknown-flag guard exists to prevent.
  const concurrencyFlags = argv.flatMap((arg, i) => (arg === '--concurrency' ? [i] : []));
  const concurrencyValues = new Set(concurrencyFlags.map((i) => i + 1));
  const keys = argv.filter((arg, i) => !arg.startsWith('--') && !concurrencyValues.has(i));
  const parsed = { printOnly: argv.includes('--print'), concurrency: DEFAULT_CONCURRENCY, keys };

  // Refuse a repeat rather than picking a winner, and refuse it BEFORE validating any
  // value: two occurrences carry no fact about which limit was intended, so reporting one
  // of them as the bad value invites a fix that leaves the ambiguity in place. Rejecting
  // outright also makes the empty-selection hazard above unreachable by construction —
  // no repeated flag, and no value belonging to one, can reach the audit unvalidated.
  if (concurrencyFlags.length > 1) {
    return { ...parsed, error: '--concurrency specified more than once — pass a single limit' };
  }

  // Validate the concurrency value FIRST, so `--concurrency --print` is reported as
  // the missing value it is rather than as an unsupported flag. Validating at all is
  // what keeps an unusable limit (missing value, NaN, 0, negative, fractional,
  // Infinity) from starting no workers and leaving a sparse result array that only
  // crashes during report formatting — AFTER the expensive control resolve is paid
  // for — or from failing inside Array.from.
  //
  // Exactly zero or one occurrence survives the repeat check above, and index 0 is both a
  // legitimate position and a falsy number, so presence is tested against undefined.
  const [concurrencyFlag] = concurrencyFlags;
  if (concurrencyFlag !== undefined) {
    const raw = argv[concurrencyFlag + 1];
    const concurrency = Number(raw);
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      const got = raw === undefined ? 'no value' : `"${raw}"`;
      return { ...parsed, error: `--concurrency needs a positive integer, got ${got}` };
    }
    parsed.concurrency = concurrency;
  }

  // Every remaining `--…` token is a flag in its own right: a valid concurrency value
  // is a positive integer, and a `--`-prefixed one already returned above.
  const unknown = argv.find((arg) => arg.startsWith('--') && !KNOWN_FLAGS.has(arg));
  if (unknown !== undefined) {
    const supported = [...KNOWN_FLAGS].join(', ');
    return { ...parsed, error: `unknown flag "${unknown}" — supported flags: ${supported}` };
  }
  return parsed;
}

/**
 * Collapse an osv-scanner `--format=json` document to a comparable finding map.
 *
 * Keyed on package NAME rather than name@version: the question the audit asks is
 * "which package is vulnerable to what", and the removed pin's version differs
 * between the control and test runs by construction — keying on the version
 * would make ordinary resolution drift (8.4.31 -> 8.4.30, both vulnerable to the
 * same advisory) look like a regression, and every pin load-bearing.
 *
 * The versions are still carried, as the key's value, because collapsing to a
 * bare name loses MULTIPLICITY — and a lost instance is a false `INERT`, the one
 * direction of error that can talk a human into deleting a live security
 * control. A scoped pin whose removal introduces a second vulnerable copy of an
 * already-vulnerable package elsewhere in the tree produces an identical set of
 * names, so `classify` compares instance counts, not just presence.
 *
 * @param scanJson - parsed osv-scanner JSON output
 * @returns a Map of `name:VULN-ID` to the set of vulnerable versions carrying it
 */
export function parseFindings(scanJson) {
  const findings = new Map();
  for (const result of scanJson.results ?? []) {
    for (const pkg of result.packages ?? []) {
      for (const vuln of pkg.vulnerabilities ?? []) {
        const key = `${pkg.package.name}:${vuln.id}`;
        const versions = findings.get(key) ?? new Set();
        versions.add(pkg.package.version ?? 'unknown');
        findings.set(key, versions);
      }
    }
  }
  return findings;
}

/**
 * Total vulnerable instances across a finding map — advisories counted once per
 * distinct version, which is what a lockfile entry corresponds to.
 *
 * @param findings - a map from `parseFindings`
 * @returns the number of vulnerable package instances
 */
export function countInstances(findings) {
  let total = 0;
  for (const versions of findings.values()) total += versions.size;
  return total;
}

/**
 * Decide a verdict by comparing a pin-removed run against the control run.
 *
 * A finding counts as this pin's regression when it is either ABSENT from the
 * control, or present in the control at FEWER instances. A fresh resolve
 * legitimately differs from the committed lockfile in many unrelated ways, so
 * comparing against zero would report unrelated drift as this pin's regression;
 * comparing only presence would miss a pin that adds a vulnerable copy of a
 * package the control was already flagging.
 *
 * Counts, not identities, are compared. A control instance that merely moves to
 * a different (still vulnerable) version is drift, and the count is unchanged.
 *
 * @param control - findings with every pin in place
 * @param test - findings with this pin removed
 * @returns the verdict and its supporting detail
 */
export function classify(control, test) {
  const regressions = [];
  for (const [finding, versions] of test) {
    const controlVersions = control.get(finding);
    const at = [...versions].sort().join(', ');
    if (!controlVersions) {
      regressions.push(`${finding} @ ${at}`);
    } else if (versions.size > controlVersions.size) {
      regressions.push(
        `${finding} @ ${at} (${controlVersions.size} -> ${versions.size} vulnerable instances)`,
      );
    }
  }
  return regressions.length
    ? { verdict: 'LOAD-BEARING', detail: regressions.sort().join(', ') }
    : { verdict: 'INERT', detail: 'resolution reaches a safe version without this pin' };
}

/**
 * Read a repository-relative file as UTF-8 text.
 *
 * @param relPath - repository-relative path
 * @returns the file contents
 */
async function readRepoFile(relPath) {
  return readFile(join(repoRoot, relPath), 'utf8');
}

/**
 * Run a command, capturing stdout. Never throws on a non-zero exit — the caller
 * decides what a failure means (for `pnpm install` it is a signal, not a bug).
 *
 * @param cmd - executable to run
 * @param args - argument vector
 * @param cwd - working directory
 * @returns the exit code plus captured stdout and stderr
 */
function run(cmd, args, cwd) {
  return new Promise((resolveRun) => {
    const child = spawn(cmd, args, { cwd, env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (err) => resolveRun({ code: -1, stdout, stderr: String(err) }));
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
  });
}

/**
 * Extract a top-level YAML sequence block (`key:` followed by `- item` lines).
 *
 * Matches the deliberately minimal parser in
 * `scripts/__tests__/pnpm-workspace-config.test.mjs` — the strict pnpm layout has
 * no YAML dependency available, and pinning a small security-sensitive set of
 * keys does not need one.
 *
 * Single and double quotes are accepted alike, because YAML treats them alike. A
 * quoting style this parser did not unquote would leave the quotes on the glob, and
 * `"'packages/*'".split('*')[0]` is `'packages/` — a directory that cannot exist, so
 * the scratch workspace build dies in `readdir` far from the cause.
 *
 * @param yaml - the full pnpm-workspace.yaml text
 * @param blockName - the top-level key whose sequence to extract
 * @returns the sequence items, unquoted
 */
export function extractListBlock(yaml, blockName) {
  const lines = yaml.split('\n');
  const start = lines.indexOf(`${blockName}:`);
  if (start === -1) return [];

  const items = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) break;
    // The backreference pairs the closing quote with the opening one, so an unquoted
    // item keeps any quotes of its own rather than being half-stripped.
    const match = line.match(/^\s+-\s*(["']?)(.+?)\1\s*$/);
    if (match) items.push(match[2].trim());
  }
  return items;
}

/**
 * Every workspace manifest path, derived from pnpm-workspace.yaml's `packages:`
 * globs so a package added later is picked up without editing this script.
 *
 * @returns repository-relative package.json paths, including the root
 */
async function workspaceManifestPaths() {
  const yaml = await readRepoFile('pnpm-workspace.yaml');
  const paths = ['package.json'];

  for (const pattern of extractListBlock(yaml, 'packages')) {
    if (!pattern.includes('*')) {
      paths.push(join(pattern, 'package.json'));
      continue;
    }
    const dir = pattern.split('*')[0].replace(/\/$/, '');
    for (const entry of await readdir(join(repoRoot, dir), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = join(dir, entry.name, 'package.json');
      if (existsSync(join(repoRoot, manifest))) paths.push(manifest);
    }
  }
  return paths;
}

/**
 * Remove one override key from a pnpm-workspace.yaml document.
 *
 * Operates on raw text rather than a parsed document so the file's extensive
 * explanatory comment block survives untouched — the audit only ever writes into
 * a throwaway directory, but a mangled workspace file would change resolution and
 * silently invalidate the result.
 *
 * Matches single-quoted, double-quoted, and bare keys alike, because YAML treats
 * them alike — a quoting style this parser did not accept would fail the audit with
 * "not found" on a pin that is plainly present in the file.
 *
 * @param yaml - the full pnpm-workspace.yaml text
 * @param key - the override key to drop
 * @returns the text with that key's line removed
 * @throws {Error} when the key is not present, which would make the run a no-op
 */
export function removeOverrideLine(yaml, key) {
  const lines = yaml.split('\n');
  const start = lines.indexOf('overrides:');
  if (start === -1) throw new Error('pnpm-workspace.yaml has no top-level "overrides:" block');

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() !== '' && !/^\s/.test(line)) break;
    // Quote-agnostic (YAML treats both alike), but still paired via the backreference:
    // a mismatched `"key'` is malformed and must not be treated as a hit.
    const match = line.match(/^\s+(["']?)([^"':]+)\1\s*:/);
    if (match && match[2].trim() === key) {
      return [...lines.slice(0, i), ...lines.slice(i + 1)].join('\n');
    }
  }
  throw new Error(`override "${key}" not found in pnpm-workspace.yaml`);
}

/**
 * Build a throwaway workspace containing only what pnpm needs to resolve:
 * every manifest, the workspace config, the patch files, and `.npmrc`.
 *
 * Deliberately does NOT copy `node_modules` or `pnpm-lock.yaml`. Omitting the
 * lockfile is the entire point of the sound test — resolution must run from
 * scratch, or the result is just the lockfile's existing opinion echoed back.
 *
 * @param workspaceYaml - the pnpm-workspace.yaml text to write (possibly edited)
 * @param manifests - repository-relative package.json paths to copy
 * @returns the temp directory path
 */
async function buildScratchWorkspace(workspaceYaml, manifests) {
  const dir = await mkdtemp(join(tmpdir(), 'rd-override-audit-'));

  for (const manifest of manifests) {
    await mkdir(join(dir, dirname(manifest)), { recursive: true });
    await cp(join(repoRoot, manifest), join(dir, manifest));
  }
  await writeFile(join(dir, 'pnpm-workspace.yaml'), workspaceYaml);

  // patchedDependencies records a hash of each patch file, so resolution needs them.
  if (existsSync(join(repoRoot, 'patches'))) {
    await cp(join(repoRoot, 'patches'), join(dir, 'patches'), { recursive: true });
  }
  if (existsSync(join(repoRoot, '.npmrc'))) {
    await cp(join(repoRoot, '.npmrc'), join(dir, '.npmrc'));
  }
  return dir;
}

/**
 * Resolve a scratch workspace from scratch and scan the resulting lockfile.
 *
 * Scans WITHOUT `--config`, so `.osv-scanner.toml` ignores are not applied. An
 * accepted vulnerability is still a vulnerability for the purpose of asking
 * "does this pin change what resolution reaches"; applying ignores here would
 * hide exactly the regression the audit is looking for.
 *
 * @param workspaceYaml - the pnpm-workspace.yaml text to resolve against
 * @param manifests - repository-relative package.json paths to copy
 * @returns findings as a Set of `name:VULN-ID`, or an error string
 */
async function resolveAndScan(workspaceYaml, manifests) {
  const dir = await buildScratchWorkspace(workspaceYaml, manifests);
  try {
    const install = await run('pnpm', ['install', '--lockfile-only'], dir);
    if (install.code !== 0) {
      return { error: `pnpm install failed:\n${install.stderr.trim().slice(-600)}` };
    }

    const scan = await run(
      'osv-scanner',
      ['scan', 'source', '--lockfile=pnpm-lock.yaml', '--format=json'],
      dir,
    );
    // osv-scanner exits 1 when it finds vulnerabilities; that is a result, not a failure.
    if (scan.code !== 0 && scan.code !== 1) {
      return {
        error: `osv-scanner failed (exit ${scan.code}):\n${scan.stderr.trim().slice(-600)}`,
      };
    }

    return { findings: parseFindings(JSON.parse(scan.stdout)) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Run tasks with a bounded number in flight.
 *
 * @param items - work items
 * @param limit - maximum concurrent tasks
 * @param worker - async function applied to each item
 * @returns the results, in input order
 * @throws {RangeError} when the limit is not a positive integer — a limit of 0
 *   or NaN starts no runners and returns a silently sparse result array
 */
export async function mapWithConcurrency(items, limit, worker) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`mapWithConcurrency needs a positive integer limit, got ${limit}`);
  }
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Render the verdict table plus the advisory footer.
 *
 * Split out of `main` so the all-protected short-circuit — which never resolves
 * anything — prints the identical report rather than growing a second copy of the
 * sort/pad block that would drift away from this one.
 *
 * @param verdicts - one row per audited or protected override
 * @returns the report text, empty when there is nothing to report
 */
export function formatVerdictReport(verdicts) {
  // `Math.max(...[])` is -Infinity, which silently collapses the key column. An empty
  // selection has nothing to say, so say nothing.
  if (!verdicts.length) return '';

  const width = Math.max(...verdicts.map((v) => v.key.length));
  const rows = [...verdicts]
    .sort(
      (a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] || a.key.localeCompare(b.key),
    )
    .map(({ key, verdict, detail }) => `${key.padEnd(width)}  ${verdict.padEnd(13)}  ${detail}\n`)
    .join('');

  const inert = verdicts.filter((v) => v.verdict === 'INERT').length;
  if (!inert) return rows;
  return (
    `${rows}\n${inert} pin(s) look inert. Read each entry's "reason" in override-policy.json ` +
    `before dropping it — an INERT verdict means the scanner sees nothing, not that the ` +
    `justification is void.\n`
  );
}

/**
 * Entry point: audit each override and print a verdict table.
 *
 * @returns process exit code
 */
async function main() {
  const {
    printOnly,
    concurrency,
    keys: selected,
    error: usageError,
  } = parseArgs(process.argv.slice(2));
  if (usageError) {
    process.stderr.write(`${usageError}\n`);
    return 1;
  }

  const policy = JSON.parse(await readRepoFile('override-policy.json')).overrides;
  const workspaceYaml = await readRepoFile('pnpm-workspace.yaml');
  const manifests = await workspaceManifestPaths();

  const keys = selected.length ? selected : Object.keys(policy);
  for (const key of keys) {
    if (!policy[key]) {
      process.stderr.write(`unknown override "${key}" — not in override-policy.json\n`);
      return 1;
    }
  }

  const protectedKeys = keys.filter((k) => policy[k].scannerInvisible);
  const testable = keys.filter((k) => !policy[k].scannerInvisible);

  if (printOnly) {
    process.stdout.write(
      // The plan has to describe the run that will actually happen. With nothing
      // testable the short-circuit below resolves nothing, so promising "1 control"
      // would send a reader looking for network work that never starts.
      (testable.length
        ? `Would run ${testable.length + 1} fresh resolutions (1 control + ${testable.length} pins), ` +
          `${concurrency} at a time.\n\n` +
          `Control : all overrides present, no lockfile\n` +
          testable.map((k) => `Test    : without "${k}"`).join('\n')
        : 'Would run 0 fresh resolutions — every selected override is scannerInvisible.') +
        (protectedKeys.length
          ? `\n\nSkipped (scannerInvisible — keep regardless of scan result):\n` +
            protectedKeys.map((k) => `  ${k}`).join('\n')
          : '') +
        '\n',
    );
    return 0;
  }

  const verdicts = [];

  // A selection of nothing but protected pins has no question for the scanner to
  // answer: `testable` is empty, so the control run would be compared against nobody.
  // Skipping it turns minutes of network work into an instant report, and stops the
  // command demanding a tool whose output could not change the outcome.
  if (testable.length) {
    if ((await run('osv-scanner', ['--version'], repoRoot)).code !== 0) {
      process.stderr.write('osv-scanner not found on PATH — install it to run this audit\n');
      return 1;
    }

    process.stdout.write('Resolving control (all overrides, no lockfile)...\n');
    const control = await resolveAndScan(workspaceYaml, manifests);
    if (control.error) {
      process.stderr.write(`control run failed:\n${control.error}\n`);
      return 1;
    }
    process.stdout.write(
      `Control: ${control.findings.size} finding(s) across ` +
        `${countInstances(control.findings)} vulnerable instance(s) with every pin in place.\n` +
        `Auditing ${testable.length} pin(s), ${concurrency} at a time...\n\n`,
    );

    verdicts.push(
      ...(await mapWithConcurrency(testable, concurrency, async (key) => {
        const result = await resolveAndScan(removeOverrideLine(workspaceYaml, key), manifests);
        if (result.error) return { key, verdict: 'ERROR', detail: result.error };
        return { key, ...classify(control.findings, result.findings) };
      })),
    );
  }

  for (const key of protectedKeys) {
    verdicts.push({ key, verdict: 'PROTECTED', detail: policy[key].scannerInvisible });
  }

  process.stdout.write(formatVerdictReport(verdicts));
  return 0;
}

// Only run when invoked directly — the test imports the pure helpers above.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
