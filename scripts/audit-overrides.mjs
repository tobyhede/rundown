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

/**
 * Parse the command line.
 *
 * @param argv - arguments after the script name
 * @returns the parsed options and the explicitly selected override keys
 */
export function parseArgs(argv) {
  const concurrencyFlag = argv.indexOf('--concurrency');
  const concurrency =
    concurrencyFlag === -1 ? DEFAULT_CONCURRENCY : Number(argv[concurrencyFlag + 1]);
  const keys = argv.filter(
    (arg, i) => !arg.startsWith('--') && !(concurrencyFlag !== -1 && i === concurrencyFlag + 1),
  );
  return { printOnly: argv.includes('--print'), concurrency, keys };
}

/**
 * Collapse an osv-scanner `--format=json` document to a comparable finding set.
 *
 * Keyed on package NAME rather than name@version: the question the audit asks is
 * "which package is vulnerable to what", and the removed pin's version differs
 * between the control and test runs by construction — including the version
 * would make every pin look load-bearing.
 *
 * @param scanJson - parsed osv-scanner JSON output
 * @returns a Set of `name:VULN-ID`
 */
export function parseFindings(scanJson) {
  const findings = new Set();
  for (const result of scanJson.results ?? []) {
    for (const pkg of result.packages ?? []) {
      for (const vuln of pkg.vulnerabilities ?? []) {
        findings.add(`${pkg.package.name}:${vuln.id}`);
      }
    }
  }
  return findings;
}

/**
 * Decide a verdict by comparing a pin-removed run against the control run.
 *
 * Only findings ABSENT from the control count. A fresh resolve legitimately
 * differs from the committed lockfile in many unrelated ways, so comparing
 * against zero would report unrelated drift as this pin's regression.
 *
 * @param control - findings with every pin in place
 * @param test - findings with this pin removed
 * @returns the verdict and its supporting detail
 */
export function classify(control, test) {
  const regressions = [...test].filter((finding) => !control.has(finding)).sort();
  return regressions.length
    ? { verdict: 'LOAD-BEARING', detail: regressions.join(', ') }
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
    const match = line.match(/^\s+-\s*("?)(.+?)\1\s*$/);
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
    const match = line.match(/^\s+("?)([^":]+)\1\s*:/);
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
 */
export async function mapWithConcurrency(items, limit, worker) {
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
 * Entry point: audit each override and print a verdict table.
 *
 * @returns process exit code
 */
async function main() {
  const { printOnly, concurrency, keys: selected } = parseArgs(process.argv.slice(2));

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
      `Would run ${testable.length + 1} fresh resolutions (1 control + ${testable.length} pins), ` +
        `${concurrency} at a time.\n\n` +
        `Control : all overrides present, no lockfile\n` +
        testable.map((k) => `Test    : without "${k}"`).join('\n') +
        (protectedKeys.length
          ? `\n\nSkipped (scannerInvisible — keep regardless of scan result):\n` +
            protectedKeys.map((k) => `  ${k}`).join('\n')
          : '') +
        '\n',
    );
    return 0;
  }

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
    `Control: ${control.findings.size} finding(s) with every pin in place.\n` +
      `Auditing ${testable.length} pin(s), ${concurrency} at a time...\n\n`,
  );

  const verdicts = await mapWithConcurrency(testable, concurrency, async (key) => {
    const result = await resolveAndScan(removeOverrideLine(workspaceYaml, key), manifests);
    if (result.error) return { key, verdict: 'ERROR', detail: result.error };
    return { key, ...classify(control.findings, result.findings) };
  });

  for (const key of protectedKeys) {
    verdicts.push({ key, verdict: 'PROTECTED', detail: policy[key].scannerInvisible });
  }

  const width = Math.max(...verdicts.map((v) => v.key.length));
  for (const { key, verdict, detail } of verdicts.sort(
    (a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] || a.key.localeCompare(b.key),
  )) {
    process.stdout.write(`${key.padEnd(width)}  ${verdict.padEnd(13)}  ${detail}\n`);
  }

  const inert = verdicts.filter((v) => v.verdict === 'INERT');
  if (inert.length) {
    process.stdout.write(
      `\n${inert.length} pin(s) look inert. Read each entry's "reason" in override-policy.json ` +
        `before dropping it — an INERT verdict means the scanner sees nothing, not that the ` +
        `justification is void.\n`,
    );
  }
  return 0;
}

// Only run when invoked directly — the test imports the pure helpers above.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
