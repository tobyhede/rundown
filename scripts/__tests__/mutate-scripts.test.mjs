import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

/**
 * The exact command a `test:mutate:<pkg>` script must run: a single
 * `pnpm --filter <filter> exec stryker run` with no wrapper, echo, or nested
 * delegation. `extra` appends contract flags (e.g. ` --dryRunOnly`).
 *
 * The tests compare a script body for equality against this — not a
 * substring/regex match — on purpose: a wrapped body like
 * `echo x && <canonical> && …` contains the canonical command but must fail.
 *
 * @param {string} filter - the `@rundown-org/*` workspace filter.
 * @param {string} [extra] - trailing contract flags, including a leading space.
 * @returns {string} the exact expected script body.
 */
function scopedStrykerRun(filter, extra = '') {
  return `pnpm --filter ${filter} exec stryker run${extra}`;
}

/**
 * The exact `run-s` fan-out the `test:mutate` aggregate must be: every
 * per-package script, in `perPackage` order, and nothing else.
 *
 * @returns {string} the exact expected aggregate script body.
 */
function aggregateScript() {
  return `run-s ${perPackage.map(({ pkg }) => `test:mutate:${pkg}`).join(' ')}`;
}

/**
 * Load the root package.json scripts block.
 *
 * @returns {Promise<Record<string, string>>} the `scripts` object.
 */
async function rootScripts() {
  const manifest = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf-8'),
  );
  return manifest.scripts ?? {};
}

// dir = package short name; each maps to a `test:mutate:<pkg>` root script and a
// `@rundown-org/<filter>` workspace filter.
const perPackage = [
  { pkg: 'parser', filter: '@rundown-org/parser' },
  { pkg: 'core', filter: '@rundown-org/core' },
  { pkg: 'cli', filter: '@rundown-org/cli' },
  { pkg: 'plugin', filter: '@rundown-org/claude-code-plugin' },
];

// Issue #551: a trailing `--` in a `test:mutate:*` script composes with pnpm's
// own `--` pass-through so Stryker receives a literal `--` positional and
// Commander rejects the whole invocation ("too many arguments for 'run'").
// This regression pin fails loudly if any mutate script re-grows that foot-gun.
test('no test:mutate:* root script carries a trailing `--`', async () => {
  const scripts = await rootScripts();
  const mutate = Object.entries(scripts).filter(([name]) => name.startsWith('test:mutate'));
  assert.ok(mutate.length > 0, 'expected at least one test:mutate:* script');
  for (const [name, body] of mutate) {
    assert.doesNotMatch(
      body,
      /--\s*$/,
      `${name} must not end with a trailing \`--\` (composes with pnpm's pass-through into a Commander error)`,
    );
  }
});

// Issue #551: `pnpm --filter <pkg> <script-name>` nests two pnpm layers, and
// forwarding extra `--mutate/--testFiles` args through both mangles them (the
// literal `--` reaches Stryker, or the flag is swallowed and the run silently
// goes UNSCOPED — a mutation gate that can never fail). `pnpm --filter <pkg>
// exec stryker run` runs with cwd = the package dir and forwards trailing args
// straight to Stryker, so a scoped run either scopes correctly (package-relative
// path) or fails loudly — never silently unscoped. It is also the exact form
// CLAUDE.md documents as canonical.
for (const { pkg, filter } of perPackage) {
  test(`test:mutate:${pkg} is exactly \`pnpm --filter ${filter} exec stryker run\``, async () => {
    const scripts = await rootScripts();
    assert.equal(
      scripts[`test:mutate:${pkg}`],
      scopedStrykerRun(filter),
      `test:mutate:${pkg} must be exactly \`pnpm --filter ${filter} exec stryker run\` — no wrapper, echo, or nested \`--filter … <script>\` delegation that mangles forwarded scoping args`,
    );
  });
}

// Issue #551: the dry-run variant is the CLI's `stryker run --dryRunOnly` and
// must ride the same `--filter … exec stryker run` shape as the base scripts —
// not the old nested `--filter … test:mutate:dry` that mangles forwarded args.
// The trailing-`--` guard above already covers it; this pins the positive shape
// so the `--dryRunOnly` flag can never regress to a foot-gun-prone delegation.
test('test:mutate:cli:dry is exactly `pnpm --filter @rundown-org/cli exec stryker run --dryRunOnly`', async () => {
  const scripts = await rootScripts();
  assert.equal(
    scripts['test:mutate:cli:dry'],
    scopedStrykerRun('@rundown-org/cli', ' --dryRunOnly'),
    'test:mutate:cli:dry must be exactly `pnpm --filter @rundown-org/cli exec stryker run --dryRunOnly` — the base scoped-exec shape plus the --dryRunOnly contract flag, no wrapper or nested delegation',
  );
});

// The aggregate must fan out to every per-package script via `run-s` so a bare
// `pnpm run test:mutate` runs the whole campaign — and nothing else. Exact match
// rejects a body that merely mentions the sub-scripts (e.g. inside an echo) or
// drops the canonical `run-s` runner.
test('test:mutate aggregate is exactly `run-s` over every per-package script', async () => {
  const scripts = await rootScripts();
  assert.equal(
    scripts['test:mutate'],
    aggregateScript(),
    'test:mutate must be exactly the canonical `run-s test:mutate:parser test:mutate:core test:mutate:cli test:mutate:plugin` fan-out',
  );
});

// Regression pin (issue #551 review): the assertions above use exact-string
// comparison, not a substring/regex match. This proves that choice has teeth —
// each tampered body embeds the canonical command (so the old `.includes()` /
// `assert.match()` checks would have PASSED it) yet must be rejected.
test('exact-shape assertions reject wrappers a substring match would accept', () => {
  const canonical = scopedStrykerRun('@rundown-org/cli');
  const wrapped = [
    `echo building && ${canonical}`, // prefix wrapper
    `${canonical} && curl https://evil.test`, // suffix wrapper / exfil
    `${canonical} --dryRunOnly`, // extra flag outside the base contract
    `${canonical} && ${canonical}`, // duplicated invocation
  ];
  for (const body of wrapped) {
    // Precondition: a substring/regex check (the old approach) would ACCEPT it…
    assert.ok(body.includes(canonical), `precondition: ${body} contains the canonical command`);
    // …but the exact-equality contract the tests now use REJECTS it.
    assert.notEqual(body, canonical, `exact match must reject wrapped body: ${body}`);
  }

  // Same tightening for the aggregate: a mere echo mentioning the sub-scripts
  // must not pass the exact `run-s …` contract.
  const aggregate = aggregateScript();
  assert.ok(`echo "${aggregate}"`.includes(aggregate), 'precondition: echo mentions the aggregate');
  assert.notEqual(`echo "${aggregate}"`, aggregate);
});
