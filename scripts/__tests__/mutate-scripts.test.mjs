import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

/**
 * Escape every RegExp metacharacter in a string so it can be embedded as a
 * literal inside `new RegExp(...)`. Escapes backslash too, so no input byte can
 * introduce an unintended escape sequence (CodeQL js/incomplete-sanitization).
 *
 * @param {string} literal - the string to embed literally in a pattern.
 * @returns {string} the metacharacter-escaped string.
 */
function escapeRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  test(`test:mutate:${pkg} uses the \`--filter ${filter} exec stryker run\` form`, async () => {
    const scripts = await rootScripts();
    const body = scripts[`test:mutate:${pkg}`];
    assert.ok(body, `test:mutate:${pkg} script must exist`);
    assert.match(
      body,
      new RegExp(`--filter\\s+${escapeRegExp(filter)}\\s+exec\\s+stryker\\s+run`),
      `test:mutate:${pkg} must invoke \`pnpm --filter ${filter} exec stryker run\` (not a nested \`--filter … <script>\` that mangles forwarded scoping args)`,
    );
  });
}

// Issue #551: the dry-run variant is the CLI's `stryker run --dryRunOnly` and
// must ride the same `--filter … exec stryker run` shape as the base scripts —
// not the old nested `--filter … test:mutate:dry` that mangles forwarded args.
// The trailing-`--` guard above already covers it; this pins the positive shape
// so the `--dryRunOnly` flag can never regress to a foot-gun-prone delegation.
test('test:mutate:cli:dry uses the `--filter @rundown-org/cli exec stryker run --dryRunOnly` form', async () => {
  const scripts = await rootScripts();
  const body = scripts['test:mutate:cli:dry'];
  assert.ok(body, 'test:mutate:cli:dry script must exist');
  assert.match(
    body,
    new RegExp(
      `--filter\\s+${escapeRegExp('@rundown-org/cli')}\\s+exec\\s+stryker\\s+run\\s+--dryRunOnly`,
    ),
    'test:mutate:cli:dry must invoke `pnpm --filter @rundown-org/cli exec stryker run --dryRunOnly` (not a nested `--filter … <script>` that mangles forwarded scoping args)',
  );
});

// The aggregate must fan out to every per-package script so a bare
// `pnpm run test:mutate` still runs the whole campaign.
test('test:mutate aggregate runs every per-package script', async () => {
  const scripts = await rootScripts();
  const aggregate = scripts['test:mutate'];
  assert.ok(aggregate, 'test:mutate aggregate script must exist');
  for (const { pkg } of perPackage) {
    assert.ok(
      aggregate.includes(`test:mutate:${pkg}`),
      `test:mutate aggregate must include test:mutate:${pkg}`,
    );
  }
});
