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
  countInstances,
  extractListBlock,
  formatVerdictReport,
  mapWithConcurrency,
  parseArgs,
  parseFindings,
  removeOverrideLine,
} from '../audit-overrides.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Build a finding map in the shape `parseFindings` returns.
 *
 * @param entries - `name:VULN-ID` to the versions carrying it
 * @returns the finding map
 */
const findings = (entries) =>
  new Map(Object.entries(entries).map(([key, versions]) => [key, new Set(versions)]));

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
  '  "@istanbuljs/load-nyc-config>js-yaml": "^4.3.1"',
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
  "  '@istanbuljs/load-nyc-config>js-yaml': '^4.3.1'",
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
  assert.ok(!('error' in parsed), 'a valid limit must not report a usage error');
});

test('parseArgs rejects an unusable --concurrency value up front', () => {
  // A limit of 0/NaN starts no runners at all, so the failure would otherwise
  // surface as a crash formatting a sparse result array — AFTER the expensive
  // control resolution has been paid for.
  for (const argv of [
    ['--concurrency'],
    ['--concurrency', 'abc'],
    ['--concurrency', ''],
    ['--concurrency', '0'],
    ['--concurrency', '-1'],
    ['--concurrency', '2.5'],
    ['--concurrency', 'Infinity'],
    ['--concurrency', '--print'],
  ]) {
    const parsed = parseArgs(argv);
    assert.match(
      parsed.error ?? '',
      /--concurrency needs a positive integer/,
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
    assert.match(
      parseArgs(argv).error ?? '',
      /unknown flag/,
      `${JSON.stringify(argv)} must be rejected, not silently ignored`,
    );
  }
});

test('parseArgs still accepts every supported flag', () => {
  // The guard above must not reject the flags the script actually documents.
  for (const argv of [
    ['--print'],
    ['--concurrency', '2'],
    ['--print', '--concurrency', '2', 'qs'],
  ]) {
    assert.ok(
      !('error' in parseArgs(argv)),
      `${JSON.stringify(argv)} is supported and must not report a usage error`,
    );
  }
});

test('parseArgs reports a bad --concurrency value ahead of an unknown flag', () => {
  // Both are typos, but the concurrency message names the actual problem; the
  // unknown-flag guard must not shadow it by claiming "--print" is unsupported.
  assert.match(parseArgs(['--concurrency', '--print']).error ?? '', /--concurrency needs/);
});

test('parseArgs accepts a valid --concurrency and defaults when the flag is absent', () => {
  assert.equal(parseArgs(['--concurrency', '1']).concurrency, 1);
  assert.equal(parseArgs(['--concurrency', '16', 'qs']).concurrency, 16);
  // Absent flag must keep the default rather than inheriting the validation path.
  assert.equal(parseArgs(['qs']).concurrency, DEFAULT_CONCURRENCY);
  assert.equal(parseArgs(['--print']).concurrency, DEFAULT_CONCURRENCY);
});

test('DEFAULT_CONCURRENCY is itself a valid concurrency', () => {
  // The default bypasses the validation branch, so nothing else would catch it
  // drifting to a value that starts zero runners.
  assert.ok(Number.isInteger(DEFAULT_CONCURRENCY) && DEFAULT_CONCURRENCY >= 1);
});

test('a repeated --concurrency is still refused rather than half-applied', async () => {
  // The second occurrence's value is not at firstFlag+1, so it falls through into the
  // key list, where main() rejects it as an unknown override. That loudness predates
  // the unknown-flag guard and must survive it — silently honouring the first value
  // would run the audit at a concurrency the caller did not ask for.
  const parsed = parseArgs(['--concurrency', '2', '--concurrency', '4']);
  assert.deepEqual(parsed.keys, ['4']);
  assert.ok(!('error' in parsed), 'the repeat is caught by main(), not by parseArgs');

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

test('parseFindings keys on package name, not name@version', () => {
  // The removed pin's version differs between the control and test runs by
  // construction. Keying on the version would make every pin look load-bearing.
  const parsed = parseFindings({
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
  assert.deepEqual([...parsed.keys()].sort(), [
    'postcss:GHSA-bbbb',
    'postcss:GHSA-cccc',
    'qs:GHSA-aaaa',
  ]);
  assert.deepEqual(
    [...parsed.get('qs:GHSA-aaaa')],
    ['6.15.1'],
    'the version is carried, not keyed',
  );
});

test('parseFindings counts two vulnerable versions of one package as two instances', () => {
  // A scoped pin can introduce a SECOND vulnerable copy of a package the control
  // already flags. Collapsing to a bare name loses that, and the pin reads INERT.
  const parsed = parseFindings({
    results: [
      {
        packages: [
          { package: { name: 'qs', version: '6.9.0' }, vulnerabilities: [{ id: 'GHSA-aaaa' }] },
          { package: { name: 'qs', version: '6.2.0' }, vulnerabilities: [{ id: 'GHSA-aaaa' }] },
        ],
      },
    ],
  });
  assert.equal(parsed.size, 1, 'still one advisory');
  assert.deepEqual([...parsed.get('qs:GHSA-aaaa')].sort(), ['6.2.0', '6.9.0']);
  assert.equal(countInstances(parsed), 2);
});

test('parseFindings tolerates an empty or absent results document', () => {
  assert.equal(parseFindings({}).size, 0);
  assert.equal(parseFindings({ results: [] }).size, 0);
  assert.equal(parseFindings({ results: [{ packages: [] }] }).size, 0);
  assert.equal(countInstances(parseFindings({})), 0);
});

test('classify reports LOAD-BEARING only for findings absent from the control', () => {
  const control = findings({ 'qs:GHSA-aaaa': ['6.9.0'] });
  // The pre-existing control finding must not be attributed to the removed pin.
  assert.deepEqual(classify(control, findings({ 'qs:GHSA-aaaa': ['6.9.0'] })), {
    verdict: 'INERT',
    detail: 'resolution reaches a safe version without this pin',
  });
  assert.deepEqual(
    classify(control, findings({ 'qs:GHSA-aaaa': ['6.9.0'], 'hono:GHSA-dddd': ['4.0.0'] })),
    { verdict: 'LOAD-BEARING', detail: 'hono:GHSA-dddd @ 4.0.0' },
  );
});

test('classify reports a pin that ADDS an instance of an already-flagged advisory', () => {
  // The duplicate-instance case: the set of `name:VULN-ID` keys is identical
  // between control and test, so presence alone reads INERT and would recommend
  // deleting a pin that is holding back a second vulnerable copy.
  const control = findings({ 'qs:GHSA-aaaa': ['6.9.0'] });
  const test = findings({ 'qs:GHSA-aaaa': ['6.9.0', '6.2.0'] });
  assert.deepEqual(classify(control, test), {
    verdict: 'LOAD-BEARING',
    detail: 'qs:GHSA-aaaa @ 6.2.0, 6.9.0 (1 -> 2 vulnerable instances)',
  });
});

test('classify treats a same-count version shift as drift, not a regression', () => {
  // Removing an unrelated pin can move a still-vulnerable package to a different
  // still-vulnerable version. The instance count is unchanged, so it is not this
  // pin's regression — this is why counts are compared and identities are not.
  const control = findings({ 'postcss:GHSA-bbbb': ['8.4.31'] });
  const test = findings({ 'postcss:GHSA-bbbb': ['8.4.30'] });
  assert.equal(classify(control, test).verdict, 'INERT');
});

test('classify treats a control finding that DISAPPEARS as inert, not load-bearing', () => {
  // Removing a pin can shift resolution enough to drop an unrelated finding. That
  // is not a regression, and must not be reported as one.
  assert.equal(classify(findings({ 'qs:GHSA-aaaa': ['6.9.0'] }), new Map()).verdict, 'INERT');
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
  // The widened character class must not start reaching into patchedDependencies:
  // `'gray-matter@4.0.3'` is a patch target, and "removing" it would silently produce
  // an unpatched resolve reported as this pin's verdict.
  assert.throws(() => removeOverrideLine(SINGLE_QUOTED_FIXTURE, 'gray-matter@4.0.3'), /not found/);
  assert.throws(() => removeOverrideLine(SINGLE_QUOTED_FIXTURE, 'not-a-real-pin'), /not found/);
});

test('removeOverrideLine does not match a key whose quoting is mismatched', () => {
  // `"qs': …` is not valid YAML; matching it would mean the widened class had dropped
  // the backreference that pairs the closing quote with the opening one.
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
  // The backreference is what keeps this honest: widening the class to accept `'` must
  // not half-strip an item that merely contains one.
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

test('mapWithConcurrency rejects a non-positive limit instead of returning holes', async () => {
  // Zero or NaN starts no runners, so every result stays `undefined` and the
  // failure only surfaces later, while formatting the report.
  for (const limit of [0, -1, Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      () => mapWithConcurrency([1, 2], limit, async (n) => n),
      /positive integer limit/,
      `limit ${limit} must be rejected`,
    );
  }
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
  // A blank line separates the table from the advisory footer.
  assert.equal(rows[3], '', 'the inert footer must be preceded by a blank line');
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

test('formatVerdictReport does not reorder its input array', () => {
  // main() pushes PROTECTED rows onto the same array it later reports; sorting in place
  // would make the report's own ordering leak back into the caller.
  const verdicts = [
    { key: 'qs', verdict: 'INERT', detail: 'inert' },
    { key: 'hono', verdict: 'LOAD-BEARING', detail: 'hono:GHSA-dddd' },
  ];
  formatVerdictReport(verdicts);
  assert.deepEqual(
    verdicts.map((v) => v.key),
    ['qs', 'hono'],
  );
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

test('the manifest header says a scannerInvisible pin is required despite a clean scan', async () => {
  // The header is what a reader consults before pruning. If it only says the audit
  // "refuses to recommend" removing a PROTECTED pin, a reader can still take a clean
  // scan as licence to remove one by hand. It has to say the pin is REQUIRED, and that
  // a LOAD-BEARING verdict is a claim about scanner visibility, not about necessity.
  const header = JSON.parse(await readFile(join(repoRoot, 'override-policy.json'), 'utf8'))['//'];
  assert.match(header, /REQUIRED/, 'a scannerInvisible pin must be described as required');
  assert.match(header, /scanning clean|scans clean/i, 'required DESPITE a clean scan');
  assert.match(
    header,
    /scanner-VISIBLE/,
    'a LOAD-BEARING verdict must be scoped to the scanner-visible pins',
  );
  assert.match(header, /never the only required pin/i);
});

test('a LOAD-BEARING claim in the policy is scoped to the pins the audit tests', async () => {
  // "the only override still load-bearing" ranges only over the pins the audit TESTS.
  // The scannerInvisible pins are never tested and are equally required, so an unscoped
  // superlative licenses exactly the pin removal this manifest exists to prevent — and
  // it is the more misleading now that qs is the only testable pin left.
  const policy = await readPolicyOverrides();
  for (const [key, entry] of Object.entries(policy)) {
    if (!/load-bearing/i.test(entry.reason)) continue;
    assert.match(
      entry.reason,
      /scannerInvisible/,
      `override "${key}": a load-bearing claim must name the untested pins it does not range over`,
    );
    assert.doesNotMatch(
      entry.reason,
      /only override/i,
      `override "${key}": "the only override…" claims too much — the untested pins are required too`,
    );
  }
});

test('the qs entry keeps every piece of evidence behind its pin', async () => {
  // Scoping the claim must not cost the evidence: the version resolution reaches without
  // the pin, when that was last re-proven, and the reachability analysis that explains
  // why a free pin is kept for a path nothing imports today.
  const { reason } = (await readPolicyOverrides()).qs;
  // cspell:ignore streamable -- an upstream @modelcontextprotocol/sdk subpath
  for (const fact of [
    '6.15.1',
    '2026-08-07',
    'Dependency-reachable via packages/mcp',
    'NOT code-reachable',
    'StdioServerTransport',
    'server/streamableHttp.js',
    'server/auth/**',
    'Pinned anyway',
  ]) {
    assert.ok(reason.includes(fact), `the qs rationale must keep "${fact}"`);
  }
});

test('the qs entry does not restate js-yaml details that hold for only two of three pins', async () => {
  // Only TWO patches exist (patches/gray-matter@4.0.3.patch, read-yaml-file@1.1.0.patch).
  // @istanbuljs/load-nyc-config is NOT patched — it calls load() in its own source
  // (index.js:80) and its entry says "on 3.x", never 3.15.1. Generalising the patched
  // load() / 3.15.1 story across all three is false for one of them, so this entry must
  // refer the reader to each entry rather than paraphrase all three at once.
  const { reason } = (await readPolicyOverrides()).qs;
  assert.doesNotMatch(
    reason,
    /3\.15\.1|load\(\)|patch/i,
    'the qs entry must point at each js-yaml entry, not paraphrase details it cannot generalise',
  );
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
