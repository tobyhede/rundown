import assert from 'node:assert/strict';
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
  '',
  'patchedDependencies:',
  '  gray-matter@4.0.3: patches/gray-matter@4.0.3.patch',
  '',
].join('\n');

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
  for (const key of ['yaml-language-server>yaml', 'ip-address']) {
    const edited = removeOverrideLine(WORKSPACE_FIXTURE, key);
    assert.ok(!edited.includes(`"${key}"`), `${key} should have been removed`);
  }
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
