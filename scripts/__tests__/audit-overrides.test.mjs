import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CONCURRENCY,
  VERDICT_ORDER,
  classify,
  extractListBlock,
  formatVerdictReport,
  mapWithConcurrency,
  parseArgs,
  parseFindings,
  removeOverrideLine,
} from '../audit-overrides.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const WORKSPACE_FIXTURE = [
  'packages:',
  '  - "packages/*"',
  '  - "site"',
  '',
  '# Category A',
  'overrides:',
  '  "yaml-language-server>yaml": "^2.8.3"',
  '  qs: "^6.15.2"',
  '  "ip-address": "^10.3.1"',
  '  "@istanbuljs/load-nyc-config>js-yaml": "^4.1.0"',
  '',
  'patchedDependencies:',
  '  gray-matter@4.0.3: patches/gray-matter@4.0.3.patch',
  '',
].join('\n');

// YAML gives single and double quotes the same meaning, so pnpm-workspace.yaml may use
// either. Today it happens to use double throughout; the parsers here must not encode
// that accident. Both failure modes are loud but late — a single-quoted glob yields a
// literal `'packages` directory and crashes readdir, and a single-quoted override key
// makes removeOverrideLine throw "not found" on a pin that is plainly present.
const SINGLE_QUOTED_FIXTURE = [
  'packages:',
  "  - 'packages/*'",
  "  - 'site'",
  '',
  '# Category A',
  'overrides:',
  "  'yaml-language-server>yaml': '^2.8.3'",
  "  '@istanbuljs/load-nyc-config>js-yaml': '^4.1.0'",
  "  '@scope/pkg': '^1.0.0'",
  '  qs: ^6.15.2',
  '',
  'patchedDependencies:',
  "  'gray-matter@4.0.3': patches/gray-matter@4.0.3.patch",
  '',
].join('\n');

/**
 * Read the real override policy, so these tests follow edits to it rather than
 * hard-coding a key that a later policy change would silently invalidate.
 *
 * @returns the `overrides` map from override-policy.json
 */
async function readPolicyOverrides() {
  return JSON.parse(await readFile(join(repoRoot, 'override-policy.json'), 'utf8')).overrides;
}

/**
 * Run the audit CLI as a subprocess with an emptied PATH.
 *
 * Scrubbing PATH is a safety interlock, not a fixture detail: `osv-scanner` and
 * `pnpm` are both installed on a developer machine, so a regression that reached
 * the scanner check would run a real multi-minute network audit from inside the
 * unit suite. With no PATH neither binary can spawn, so the worst case is a fast
 * exit 1 — which is exactly what the short-circuit under test must avoid.
 *
 * @param args - argv tokens after the script name
 * @returns the exit code plus captured stdout and stderr
 */
function runAudit(args) {
  return new Promise((resolveRun) => {
    const child = spawn(
      process.execPath,
      [join(repoRoot, 'scripts/audit-overrides.mjs'), ...args],
      {
        cwd: repoRoot,
        env: { ...process.env, PATH: '' },
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
  });
}

test('parseArgs separates flags, concurrency, and selected override keys', () => {
  assert.deepEqual(parseArgs([]), {
    printOnly: false,
    concurrency: DEFAULT_CONCURRENCY,
    keys: [],
  });
  assert.deepEqual(parseArgs(['--print', 'qs', 'hono']), {
    printOnly: true,
    concurrency: DEFAULT_CONCURRENCY,
    keys: ['qs', 'hono'],
  });
});

test('parseArgs does not mistake the concurrency value for an override key', () => {
  // `--concurrency 2` puts a bare "2" in argv; treating it as a key would make the
  // audit fail with `unknown override "2"` instead of running.
  const parsed = parseArgs(['--concurrency', '2', 'qs']);
  assert.equal(parsed.concurrency, 2);
  assert.deepEqual(parsed.keys, ['qs']);
});

test('parseArgs rejects a --concurrency value that would audit nothing', () => {
  // mapWithConcurrency sizes its pool with Math.min(limit, items.length), so NaN,
  // zero, or a negative starts ZERO runners: every pin goes unaudited and the report
  // tail throws destructuring an unassigned slot — after the control resolve has
  // already been paid for. A fractional value silently truncates. All must be
  // rejected at parse time, before any resolution starts.
  for (const argv of [
    ['--concurrency'], // missing value
    ['--concurrency', '0'],
    ['--concurrency', '-1'],
    ['--concurrency', 'abc'], // non-numeric
    ['--concurrency', ''],
    ['--concurrency', '2.5'], // fractional
    ['--concurrency', '--print'], // the next flag is not a value
  ]) {
    assert.throws(
      () => parseArgs(argv),
      /--concurrency requires a positive integer/,
      `${JSON.stringify(argv)} must be rejected`,
    );
  }
});

test('parseArgs rejects an unknown flag instead of auditing everything anyway', () => {
  // A dropped flag is not a harmless no-op here: `--dry-run` looks like it asked for a
  // preview and instead starts the real multi-minute audit, because an unrecognised
  // token was filtered out and the empty selection means "every override".
  for (const argv of [
    ['--dry-run'],
    ['--dryRun', 'qs'], // the same typo without the separator
    ['--concurrency', '2', '--dry-run'],
    ['--print', '--verbose'],
    ['--'], // a bare separator is not a selection either
  ]) {
    assert.throws(
      () => parseArgs(argv),
      /unknown flag/,
      `${JSON.stringify(argv)} must be rejected, not silently ignored`,
    );
  }
});

test('parseArgs still accepts every supported flag', () => {
  // The guard above must not reject the flags the script actually documents.
  assert.doesNotThrow(() => parseArgs(['--print']));
  assert.doesNotThrow(() => parseArgs(['--concurrency', '2']));
  assert.doesNotThrow(() => parseArgs(['--print', '--concurrency', '2', 'qs']));
});

test('parseArgs reports a bad --concurrency value ahead of an unknown flag', () => {
  // Both are typos, but the concurrency message names the actual problem; the
  // unknown-flag guard must not shadow it by claiming "--print" is unsupported.
  assert.throws(() => parseArgs(['--concurrency', '--print']), /--concurrency requires/);
});

test('a repeated --concurrency is still refused rather than half-applied', async () => {
  // The second occurrence's value falls through into the key list, where main() rejects
  // it as an unknown override. That loudness predates the unknown-flag guard and must
  // survive it — silently honouring the first value would run the audit at a
  // concurrency the caller did not ask for.
  assert.deepEqual(parseArgs(['--concurrency', '2', '--concurrency', '4']).keys, ['4']);

  const { code, stderr, stdout } = await runAudit(['--concurrency', '2', '--concurrency', '4']);
  assert.equal(code, 1);
  assert.match(stderr, /unknown override "4"/);
  assert.doesNotMatch(stdout, /Resolving control/, 'nothing may resolve before the argv is sound');
});

test('an unknown flag fails before any resolution starts', async () => {
  const { code, stdout, stderr } = await runAudit(['--dry-run']);
  assert.equal(code, 1);
  assert.match(stderr, /unknown flag "--dry-run"/);
  assert.doesNotMatch(stdout, /Resolving control/, 'a typo must not cost a control run');
});

test('parseArgs accepts a valid --concurrency and defaults when the flag is absent', () => {
  assert.equal(parseArgs(['--concurrency', '1']).concurrency, 1);
  assert.equal(parseArgs(['--concurrency', '16', 'qs']).concurrency, 16);
  // Absent flag must keep the default rather than inheriting the validation path.
  assert.equal(parseArgs(['qs']).concurrency, DEFAULT_CONCURRENCY);
  assert.equal(parseArgs(['--print']).concurrency, DEFAULT_CONCURRENCY);
});

test('DEFAULT_CONCURRENCY is itself a valid concurrency', () => {
  // The default bypasses parseConcurrency, so nothing else would catch it drifting
  // to a value that starts zero runners.
  assert.ok(Number.isSafeInteger(DEFAULT_CONCURRENCY) && DEFAULT_CONCURRENCY >= 1);
});

test('parseFindings keys on package name, not name@version', () => {
  // The removed pin's version differs between the control and test runs by
  // construction. Including the version would make every pin look load-bearing.
  const findings = parseFindings({
    results: [
      {
        packages: [
          { package: { name: 'qs', version: '6.15.1' }, vulnerabilities: [{ id: 'GHSA-aaaa' }] },
          {
            package: { name: 'postcss', version: '8.5.21' },
            vulnerabilities: [{ id: 'GHSA-bbbb' }, { id: 'GHSA-cccc' }],
          },
        ],
      },
    ],
  });
  assert.deepEqual([...findings].sort(), [
    'postcss:GHSA-bbbb',
    'postcss:GHSA-cccc',
    'qs:GHSA-aaaa',
  ]);
});

test('parseFindings tolerates an empty or absent results document', () => {
  assert.equal(parseFindings({}).size, 0);
  assert.equal(parseFindings({ results: [] }).size, 0);
  assert.equal(parseFindings({ results: [{ packages: [] }] }).size, 0);
});

test('classify reports LOAD-BEARING only for findings absent from the control', () => {
  const control = new Set(['qs:GHSA-aaaa']);
  // The pre-existing control finding must not be attributed to the removed pin.
  assert.deepEqual(classify(control, new Set(['qs:GHSA-aaaa'])), {
    verdict: 'INERT',
    detail: 'resolution reaches a safe version without this pin',
  });
  assert.deepEqual(classify(control, new Set(['qs:GHSA-aaaa', 'hono:GHSA-dddd'])), {
    verdict: 'LOAD-BEARING',
    detail: 'hono:GHSA-dddd',
  });
});

test('classify treats a control finding that DISAPPEARS as inert, not load-bearing', () => {
  // Removing a pin can shift resolution enough to drop an unrelated finding. That
  // is not a regression, and must not be reported as one.
  assert.equal(classify(new Set(['qs:GHSA-aaaa']), new Set()).verdict, 'INERT');
});

test('removeOverrideLine drops exactly the named key and leaves comments intact', () => {
  const edited = removeOverrideLine(WORKSPACE_FIXTURE, 'qs');
  assert.ok(!edited.includes('qs: "^6.15.2"'), 'the targeted pin must be gone');
  assert.ok(edited.includes('"yaml-language-server>yaml": "^2.8.3"'), 'siblings must survive');
  assert.ok(edited.includes('"ip-address": "^10.3.1"'), 'siblings must survive');
  assert.ok(edited.includes('# Category A'), 'the explanatory comment block must survive');
  assert.ok(edited.includes('patchedDependencies:'), 'later blocks must survive');
});

test('removeOverrideLine handles quoted, scoped, and parent>child keys', () => {
  for (const key of [
    'yaml-language-server>yaml',
    'ip-address',
    '@istanbuljs/load-nyc-config>js-yaml',
  ]) {
    const edited = removeOverrideLine(WORKSPACE_FIXTURE, key);
    assert.ok(!edited.includes(`"${key}"`), `${key} should have been removed`);
  }
});

test('removeOverrideLine accepts single-quoted keys as readily as double-quoted ones', () => {
  // A single-quoted pin is the same pin. Failing to match one makes the audit throw
  // "not found" on an override that is right there in the file.
  for (const key of ['yaml-language-server>yaml', '@istanbuljs/load-nyc-config>js-yaml', 'qs']) {
    const edited = removeOverrideLine(SINGLE_QUOTED_FIXTURE, key);
    assert.ok(!edited.includes(`'${key}'`), `${key} should have been removed`);
    assert.ok(edited.includes("'@scope/pkg'"), 'siblings must survive');
    assert.ok(edited.includes('# Category A'), 'the explanatory comment block must survive');
  }
  const edited = removeOverrideLine(SINGLE_QUOTED_FIXTURE, '@scope/pkg');
  assert.ok(!edited.includes("'@scope/pkg'"), 'a scoped single-quoted key must be removable');
  assert.ok(edited.includes("'yaml-language-server>yaml'"), 'siblings must survive');
});

test('removeOverrideLine still stops at the end of the overrides block when keys are single-quoted', () => {
  // The quote-agnostic match must not start reaching into patchedDependencies.
  assert.throws(() => removeOverrideLine(SINGLE_QUOTED_FIXTURE, 'gray-matter@4.0.3'), /not found/);
  assert.throws(() => removeOverrideLine(SINGLE_QUOTED_FIXTURE, 'not-a-real-pin'), /not found/);
});

test('removeOverrideLine does not match a key whose quoting is mismatched', () => {
  // `"qs': …` is not valid YAML; matching it would mean the regex had stopped checking
  // that the closing quote pairs with the opening one.
  assert.throws(
    () => removeOverrideLine(['overrides:', '  "qs\': "^6.15.2"', ''].join('\n'), 'qs'),
    /not found/,
  );
});

test('removeOverrideLine throws rather than silently producing a no-op run', () => {
  // A typo'd key that quietly changed nothing would report the pin as INERT —
  // a false "safe to delete" verdict on an untested pin.
  assert.throws(() => removeOverrideLine(WORKSPACE_FIXTURE, 'not-a-real-pin'), /not found/);
  assert.throws(() => removeOverrideLine('packages:\n  - "site"\n', 'qs'), /no top-level/);
});

test('removeOverrideLine does not match a key in a different block', () => {
  // `gray-matter@4.0.3` lives under patchedDependencies; the scan must stop at the
  // end of the overrides block rather than reaching into the next one.
  assert.throws(() => removeOverrideLine(WORKSPACE_FIXTURE, 'gray-matter@4.0.3'), /not found/);
});

test('extractListBlock reads the workspace packages globs', () => {
  assert.deepEqual(extractListBlock(WORKSPACE_FIXTURE, 'packages'), ['packages/*', 'site']);
  assert.deepEqual(extractListBlock(WORKSPACE_FIXTURE, 'nonexistent'), []);
});

test('extractListBlock unquotes single-quoted globs', () => {
  // Leaving the quotes on is not cosmetic: `'packages/*'.split('*')[0]` is `'packages/`,
  // so the scratch workspace build crashes on a readdir of a directory that cannot exist.
  assert.deepEqual(extractListBlock(SINGLE_QUOTED_FIXTURE, 'packages'), ['packages/*', 'site']);
});

test('extractListBlock leaves an unquoted item and its inner quotes alone', () => {
  const yaml = ['packages:', '  - packages/*', '  - "site"', "  - it's-fine", ''].join('\n');
  assert.deepEqual(extractListBlock(yaml, 'packages'), ['packages/*', 'site', "it's-fine"]);
});

test('mapWithConcurrency preserves input order and bounds parallelism', async () => {
  let inFlight = 0;
  let peak = 0;
  const items = [10, 1, 8, 2, 6, 3];
  const results = await mapWithConcurrency(items, 2, async (item) => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, item));
    inFlight--;
    return item * 2;
  });
  assert.deepEqual(results, [20, 2, 16, 4, 12, 6], 'results must stay in input order');
  assert.ok(peak <= 2, `expected at most 2 concurrent tasks, saw ${peak}`);
});

test('VERDICT_ORDER puts actionable verdicts above INERT', () => {
  assert.ok(VERDICT_ORDER['LOAD-BEARING'] < VERDICT_ORDER.INERT);
  assert.ok(VERDICT_ORDER.PROTECTED < VERDICT_ORDER.INERT);
  assert.ok(VERDICT_ORDER.ERROR < VERDICT_ORDER.INERT);
});

test('formatVerdictReport sorts by verdict, pads to the widest key, and warns about inert pins', () => {
  const report = formatVerdictReport([
    { key: 'qs', verdict: 'INERT', detail: 'resolution reaches a safe version without this pin' },
    { key: 'gray-matter>js-yaml', verdict: 'PROTECTED', detail: 'holds the patch target on 4.x' },
    { key: 'hono', verdict: 'LOAD-BEARING', detail: 'hono:GHSA-dddd' },
  ]);
  const rows = report.split('\n');
  assert.deepEqual(
    rows.slice(0, 3).map((line) => line.split(/\s{2,}/)[0]),
    ['hono', 'gray-matter>js-yaml', 'qs'],
    'actionable verdicts must come before INERT',
  );
  // The width comes from the widest key, so every detail column starts at one offset.
  assert.ok(
    rows[0].startsWith(`${'hono'.padEnd('gray-matter>js-yaml'.length)}  LOAD-BEARING`),
    `key column not padded to the widest key: ${JSON.stringify(rows[0])}`,
  );
  assert.match(
    report,
    /1 pin\(s\) look inert/,
    'an INERT verdict must carry the "read the reason" warning',
  );
});

test('formatVerdictReport survives an empty verdict list', () => {
  // `Math.max(...[])` is -Infinity, which is how a padEnd-based table dies on an empty
  // selection. Nothing should be printed and nothing should throw.
  assert.equal(formatVerdictReport([]), '');
});

test('formatVerdictReport omits the inert warning when no pin is inert', () => {
  const report = formatVerdictReport([
    { key: 'qs', verdict: 'LOAD-BEARING', detail: 'qs:GHSA-aaaa' },
  ]);
  assert.doesNotMatch(report, /look inert/);
});

test('every scannerInvisible policy entry carries a substantive explanation', async () => {
  // A bare `scannerInvisible: true` would exempt a pin from the audit with no
  // record of why, which is the failure mode this whole tool exists to prevent.
  const policy = JSON.parse(
    await readFile(join(repoRoot, 'override-policy.json'), 'utf8'),
  ).overrides;
  for (const [key, entry] of Object.entries(policy)) {
    if (!('scannerInvisible' in entry)) continue;
    assert.equal(
      typeof entry.scannerInvisible,
      'string',
      `override "${key}": scannerInvisible must be a string explaining what OSV cannot see`,
    );
    assert.ok(
      entry.scannerInvisible.trim().length >= 40,
      `override "${key}": scannerInvisible needs a substantive explanation`,
    );
  }
});

test('an all-protected selection reports without paying for a control resolve', async () => {
  // Every scannerInvisible key is PROTECTED by definition, so `testable` is empty and
  // the control findings have nothing to be compared against. Resolving one anyway was
  // minutes of network work for an outcome already known — and it made the command fail
  // outright on a machine without osv-scanner, for an answer the scanner never informs.
  const policy = await readPolicyOverrides();
  const protectedKeys = Object.keys(policy).filter((key) => policy[key].scannerInvisible);
  assert.ok(
    protectedKeys.length,
    'precondition: the policy must mark at least one pin scannerInvisible',
  );

  const { code, stdout, stderr } = await runAudit(protectedKeys);

  assert.equal(code, 0, `expected a clean exit, got ${code}\n${stderr}`);
  assert.doesNotMatch(stdout, /Resolving control/, 'no control resolve may be started');
  assert.doesNotMatch(stderr, /osv-scanner/, 'the scanner must not even be required');
  for (const key of protectedKeys) {
    const row = stdout.split('\n').find((line) => line.startsWith(key));
    assert.ok(row, `${key} must appear in the report`);
    assert.match(row, /\bPROTECTED\b/, `${key} must be reported PROTECTED`);
    assert.ok(
      row.slice(key.length).replace('PROTECTED', '').trim().length > 0,
      `${key} must carry its scannerInvisible explanation as the detail column`,
    );
  }
});

test('--print does not promise a control resolve it will not run', async () => {
  // The plan must describe what the tool will actually do. With every selected key
  // protected there is now nothing to resolve, so promising "1 control" would send a
  // reader looking for network work that never happens.
  const policy = await readPolicyOverrides();
  const protectedKeys = Object.keys(policy).filter((key) => policy[key].scannerInvisible);

  const { code, stdout } = await runAudit(['--print', ...protectedKeys]);

  assert.equal(code, 0);
  assert.doesNotMatch(
    stdout,
    /Would run [1-9]/,
    'the plan must not promise resolutions that cannot happen',
  );
  assert.doesNotMatch(stdout, /^Control : /m, 'there is no control run to describe');
  assert.match(stdout, /Skipped \(scannerInvisible/, 'the protected keys must still be listed');
});

test('--print still describes the control run when there is something to test', async () => {
  // The short-circuit must not swallow the ordinary plan: --print stays a pure preview
  // that runs nothing, ahead of every other check in the flow.
  const policy = await readPolicyOverrides();
  const testable = Object.keys(policy).find((key) => !policy[key].scannerInvisible);
  assert.ok(testable, 'precondition: the policy must contain at least one testable pin');

  const { code, stdout } = await runAudit(['--print', testable]);

  assert.equal(code, 0);
  assert.match(stdout, /Would run 2 fresh resolutions \(1 control \+ 1 pins\)/);
  assert.match(stdout, /^Control : all overrides present, no lockfile$/m);
  assert.match(stdout, new RegExp(`^Test {4}: without "${testable}"$`, 'm'));
});

test('the three js-yaml patch-compat pins are marked scannerInvisible', async () => {
  // These hold gray-matter / read-yaml-file / @istanbuljs/load-nyc-config on
  // js-yaml 4.x. Dropping any of them resolves 3.15.1, which OSV reports as clean
  // while turning the patched load() call into the full/unsafe loader. If a future
  // edit removes the marker, the audit would start recommending their removal.
  const policy = JSON.parse(
    await readFile(join(repoRoot, 'override-policy.json'), 'utf8'),
  ).overrides;
  for (const key of [
    'gray-matter>js-yaml',
    'read-yaml-file>js-yaml',
    '@istanbuljs/load-nyc-config>js-yaml',
  ]) {
    assert.ok(
      policy[key]?.scannerInvisible,
      `override "${key}" must stay marked scannerInvisible — a clean scan is not grounds to drop it`,
    );
  }
});
