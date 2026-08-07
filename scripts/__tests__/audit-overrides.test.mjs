import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CONCURRENCY,
  VERDICT_ORDER,
  classify,
  extractListBlock,
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
