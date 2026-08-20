import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

/**
 * Behavioural gate over the `RenderedUnitCommand` provenance ban.
 *
 * The brand is tier 1 — a module-private `declare const` unique symbol — so
 * there is no runtime check to fall back on: a type assertion IS the mint. The
 * ban (`local/no-rendered-unit-command-cast`,
 * ../../eslint-rules/no-rendered-unit-command-cast.mjs) is type-aware: it
 * resolves the TYPE an assertion names through the checker rather than matching
 * the SYNTAX that named it, which is what lets it catch an import rename or a
 * type alias without enumerating spellings.
 *
 * Asserted by running the real `eslint.config.js` over fixtures rather than by
 * reading the rule's source, because the rule itself is the thing under test: a
 * bug in its type resolution matches nothing and reads as passing.
 *
 * Note the layered defence this sits inside. Outside `packages/core`, the type's
 * NAME is not exported from `@rundown-org/core` at all, so none of these
 * spellings can even be written; that is pinned by
 * `packages/core/__tests__/events/entry-seam-barrel.test.ts` and its
 * `.typecheck.ts` twin. This rule is what holds INSIDE core, where a relative
 * import puts the name back in scope.
 *
 * ## Why committed files, and not `lintText`
 *
 * The obvious shape for this test is `lintText(snippet, { filePath })` aimed at
 * an existing core module, so that the snippet inherits that path's flat-config
 * block and TypeScript project membership. That shape is unsound, and it failed
 * in CI while passing on every developer machine.
 *
 * `lintText` hands ESLint one copy of the source (the snippet) while the
 * type-aware parser serves the AST out of a long-lived TypeScript watch program
 * keyed by path. Nothing reconciles the two: typescript-estree's
 * `getAstFromProgram` returns whatever `SourceFile` the program already holds
 * for that path, with no comparison against the text ESLint is reporting on.
 * Keeping them in step depends entirely on an invalidation path — a content
 * hash in `parsedFilesSeenHash`, a file-watcher callback registered under a
 * canonicalised path whose casing rules come from `ts.sys` — that is sensitive
 * to platform and to program state. When it does not fire, ESLint reports
 * positions against a 4-line snippet while the rules walk the 1151-line module
 * that lives at that path. In CI that surfaced as `jsdoc/check-param-names`
 * dereferencing a source line past the end of the snippet, and then as every
 * subsequent case resolving `RenderedUnitCommand` to an error type, so the rule
 * under test had nothing to resolve and silently never fired.
 *
 * Real files remove that failure mode by construction rather than by timing: the
 * bytes ESLint reads and the bytes TypeScript reads are the same bytes, so a
 * "stale" program entry and a fresh one are indistinguishable and no
 * invalidation is ever required.
 *
 * ## Why COMMITTED files, and not files this test writes and deletes
 *
 * Writing them per-run and sweeping them afterwards also fixes the staleness,
 * and it was the first fix applied here. It is not enough, because a transient
 * real file in a real package is visible to everything else that reads the
 * working tree while it exists:
 *
 * - Under `packages/core/src`, the files land inside the Stryker `mutate` glob.
 *   `scripts/mutation-shard-plan.mjs` globs the filesystem (not `git ls-files`,
 *   so `.gitignore` does not hide them) and then `readFileSync`s every hit, and
 *   `scripts/__tests__/mutation-sharding.test.mjs` drives that real planner at
 *   the repo root — in parallel, because `node --test` parallelises test FILES.
 *   Measured against a churn loop, 21 of 25 planner runs died `ENOENT` between
 *   the glob and the read. A one-shot write/sweep makes that window narrow, not
 *   absent.
 * - The same path is inside `packages/core/tsconfig.json`'s build `include`, so
 *   a concurrent `tsc` emits fixture output into `dist/`.
 * - They are deliberate lint violations for as long as they exist, so an
 *   editor's ESLint watcher or a hand-run `check:lint:typed` in that window
 *   reports errors that are about to stop existing.
 *
 * Committing the fixtures under `__tests__` removes all three by construction:
 * outside `src`, they are outside both the mutate glob and the build include;
 * and being permanent, there is no window at all. What committing costs is that
 * ten deliberate violations would fail the repository lint gate forever, so the
 * directory is listed in `eslint.ignores.js` and re-included here with
 * `ignore: false`. That option overrides file SELECTION only — the rule
 * configuration these paths resolve is the real config, unmodified, which is
 * what keeps the test meaningful. `pins the ignore entry` and
 * `resolves the ban for production core source` below assert both halves of
 * that arrangement, so neither can rot silently.
 *
 * The fixtures still resolve `../../../src/runbook/execution-unit-entry.js` to
 * the REAL producer, and `packages/core/__tests__` is inside
 * `tsconfig.eslint.json`'s `include`, so the checker sees the actual brand
 * declaration rather than a stand-in.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** Repo-relative, because that is the form `eslint.ignores.js` matches on. */
const FIXTURE_REL = 'packages/core/__tests__/fixtures/brand-cast';
const FIXTURE_DIR = path.join(repoRoot, FIXTURE_REL);

const RULE = 'local/no-rendered-unit-command-cast';
const PROVENANCE = /minted only by deriveExecutionUnitEntry/;

// One entry per way the brand can be asserted into existence. `as` was the only
// one the original selector matched; the rest are the gap. Each fixture imports
// the type it asserts to — an unresolvable name is not real TypeScript (`tsc`
// refuses it before this rule would ever run), and the type-aware rule correctly
// has nothing to resolve an unbound identifier to. Why each route defeats a
// syntax-matching selector is documented in the fixture itself.
const FORGERIES = [
  { file: 'direct-as.ts', label: 'a direct as-assertion' },
  { file: 'double-through-unknown.ts', label: 'a double assertion through unknown' },
  { file: 'angle-bracket.ts', label: 'an angle-bracket assertion' },
  { file: 'namespace-qualified.ts', label: 'an assertion through a namespace-qualified name' },
  {
    file: 'angle-bracket-qualified.ts',
    label: 'an angle-bracket assertion through a namespace-qualified name',
  },
  { file: 'local-type-alias.ts', label: 'an assertion through a local type alias' },
  { file: 'alias-two-hops.ts', label: 'a type alias two hops from the brand' },
  { file: 'interface-inheritance.ts', label: 'an interface that inherits the brand' },
  { file: 'import-renamed.ts', label: 'an import renamed at the specifier' },
  { file: 'union-member.ts', label: 'a union type naming the brand' },
];

// The negative control. Without it a rule broad enough to flag every `as` in the
// repository would satisfy every case above, and the rule would be unusable
// rather than correct. It is linted and read back through exactly the same path
// as the forgeries — a control linted differently from what it controls proves
// nothing about it.
const CONTROL = {
  file: 'control-unrelated-assertions.ts',
  label: 'leaves unrelated assertions alone',
};

const CASES = [...FORGERIES, CONTROL];

/** Provenance-ban messages per fixture basename. */
const provenanceMessages = new Map();

before(async () => {
  const files = CASES.map((testCase) => path.join(FIXTURE_DIR, testCase.file));

  // `ignore: false` re-includes the deliberately-ignored fixture directory. It
  // affects which files are linted, not how — see the header.
  const results = await new ESLint({ cwd: repoRoot, ignore: false }).lintFiles(files);

  assert.equal(
    results.length,
    files.length,
    'every fixture must be linted; a missing result means ESLint skipped one as unmatched',
  );

  for (const result of results) {
    const name = path.basename(result.filePath);

    const fatal = result.messages.filter((message) => message.fatal);
    assert.deepEqual(
      fatal.map((message) => message.message),
      [],
      `${name} failed to parse; the type-aware rule never ran`,
    );

    provenanceMessages.set(
      name,
      result.messages
        .filter((message) => message.ruleId === RULE)
        .map((message) => message.message),
    );
  }
});

for (const { file, label } of FORGERIES) {
  test(`bans ${label}`, () => {
    const messages = provenanceMessages.get(file);

    assert.ok(
      messages?.some((message) => PROVENANCE.test(message)),
      `expected the provenance ban to fire on ${label} (${file}); got: ${JSON.stringify(messages)}`,
    );
  });
}

test(CONTROL.label, () => {
  assert.deepEqual(provenanceMessages.get(CONTROL.file), []);
});

// A fixture nobody lints is dead weight that reads as coverage, and a case
// naming a file that no longer exists would fail only in `before`, where the
// message is about ESLint rather than about the drift. Pin the two lists to each
// other instead.
test('lints every fixture in the directory, and no fixture it does not have', () => {
  const onDisk = readdirSync(FIXTURE_DIR)
    .filter((entry) => entry.endsWith('.ts'))
    .sort();

  assert.deepEqual(
    onDisk,
    CASES.map((testCase) => testCase.file).sort(),
    'add the new fixture to FORGERIES (or delete it); every .ts file here must be a declared case',
  );
});

// The fixtures are violations on purpose, so an ordinary lint run has to skip
// them. Deleting the `eslint.ignores.js` entry would turn `check:lint:typed` red
// permanently while leaving every assertion above green, because `ignore: false`
// makes this suite indifferent to it. This is the assertion that notices.
test('pins the ignore entry that keeps the forgeries out of the ordinary lint run', async () => {
  const eslint = new ESLint({ cwd: repoRoot });

  for (const { file } of CASES) {
    assert.equal(
      await eslint.isPathIgnored(path.join(FIXTURE_DIR, file)),
      true,
      `${file} must be ignored by the default lint run; see eslint.ignores.js`,
    );
  }
});

// The fixtures live under `__tests__` for the reasons in the header, so this
// suite no longer demonstrates the ban firing on a file in `src`. Assert that
// directly rather than inferring it: the configured severity for a production
// core module, and the single exemption for the module that mints the brand.
test('resolves the ban for production core source, and lifts it only for the producer', async () => {
  const eslint = new ESLint({ cwd: repoRoot, ignore: false });

  // `calculateConfigForFile` resolves a path, not a file, and answers happily for
  // one that does not exist. Both source paths below are named because they are
  // real modules, so check that they still are — otherwise a rename turns these
  // into assertions about a path shape while the test name still claims
  // production source.
  const severity = async (relPath) => {
    assert.ok(existsSync(path.join(repoRoot, relPath)), `${relPath} no longer exists`);
    return (await eslint.calculateConfigForFile(path.join(repoRoot, relPath))).rules?.[RULE]?.[0];
  };

  assert.equal(
    await severity('packages/core/src/runbook/collection-service.ts'),
    2,
    'the ban must be an error on ordinary core source',
  );
  assert.equal(
    await severity('packages/core/src/runbook/execution-unit-entry.ts'),
    0,
    'the producer mints the brand, so it is the one file exempted',
  );
  assert.equal(
    await severity(path.join(FIXTURE_REL, CONTROL.file)),
    2,
    'the fixtures must resolve the same severity as production source, or they test nothing',
  );
});
