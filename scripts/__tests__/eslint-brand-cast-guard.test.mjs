import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
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
 * `packages/core/__tests__/events/entry-seam-barrel.test.ts`. This rule is what
 * holds INSIDE core, where a relative import puts the name back in scope.
 *
 * ## Why real files on disk, and not `lintText`
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
 * Writing each case to a real `.ts` file removes the failure mode by
 * construction rather than by timing: the bytes ESLint reads and the bytes
 * TypeScript reads are the same bytes, so a "stale" program entry and a fresh
 * one are indistinguishable and no invalidation is ever required. Every fixture
 * is created before the first lint, so all of them enter the program on its
 * initial build.
 *
 * The fixtures live in `packages/core/src/runbook/` for the three reasons the
 * path mattered in the first place: it is inside `tsconfig.eslint.json`'s
 * `include`, it lands in the same flat-config block as production core source
 * (the ban is set on `**\/*.ts` and switched off only for the producing module),
 * and it makes `./execution-unit-entry.js` resolve to the REAL producer, so the
 * rule sees the actual brand declaration rather than a stand-in.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

// Inside core and not the producing module, so the base ban applies with no
// exemption.
const FIXTURE_DIR = path.join(repoRoot, 'packages', 'core', 'src', 'runbook');

// Fixtures are transient source files in a real package. The prefix is what
// lets a later run find and delete them, and `.gitignore` carries the matching
// pattern so a run that dies mid-flight cannot dirty `git status`.
const FIXTURE_PREFIX = 'brand-cast-fixture-';
const RUN_ID = randomBytes(6).toString('hex');

/**
 * Delete every fixture this test family has ever written, ours or a previous
 * run's.
 *
 * Sweeping the whole prefix rather than only this run's files is deliberate.
 * The fixtures deliberately violate a repository lint rule, so residue left by
 * a crashed run would fail `pnpm run check:lint:typed` until someone noticed;
 * a run of this file left concurrently in flight by a second process in the
 * same working tree is not a real scenario, and losing to the sweep would only
 * fail that run loudly.
 *
 * Synchronous so the same routine can serve the `after` hook and the `exit`
 * handler, which cannot await.
 */
function sweepFixtures() {
  let entries;
  try {
    entries = readdirSync(FIXTURE_DIR);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith(FIXTURE_PREFIX)) {
      rmSync(path.join(FIXTURE_DIR, entry), { force: true });
    }
  }
}

const PROVENANCE = /minted only by deriveExecutionUnitEntry/;

// One entry per way the brand can be asserted into existence. `as` was the only
// one the original selector matched; the rest are the gap. Each imports the
// type it asserts to — an unresolvable name is not real TypeScript (`tsc`
// refuses it before this rule would ever run), and the type-aware rule
// correctly has nothing to resolve an unbound identifier to.
const FORGERIES = [
  {
    label: 'a direct as-assertion',
    code: `import type { RenderedUnitCommand } from './execution-unit-entry.js';\ndeclare const value: unknown;\nexport const forged = value as RenderedUnitCommand;\n`,
  },
  {
    label: 'a double assertion through unknown',
    code: `import type { RenderedUnitCommand } from './execution-unit-entry.js';\ndeclare const value: string;\nexport const forged = value as unknown as RenderedUnitCommand;\n`,
  },
  {
    label: 'an angle-bracket assertion',
    code: `import type { RenderedUnitCommand } from './execution-unit-entry.js';\ndeclare const value: unknown;\nexport const forged = <RenderedUnitCommand>value;\n`,
  },
  {
    label: 'an assertion through a namespace-qualified name',
    code: `import * as core from './execution-unit-entry.js';\ndeclare const value: unknown;\nexport const forged = value as core.RenderedUnitCommand;\n`,
  },
  {
    label: 'an assertion through a local type alias',
    code: `import type { RenderedUnitCommand } from './execution-unit-entry.js';\ntype Laundered = RenderedUnitCommand;\ndeclare const value: unknown;\nexport const forged = value as Laundered;\n`,
  },
  {
    label: 'an angle-bracket assertion through a namespace-qualified name',
    code: `import * as core from './execution-unit-entry.js';\ndeclare const value: unknown;\nexport const forged = <core.RenderedUnitCommand>value;\n`,
  },
  {
    label: 'an interface that inherits the brand',
    code: `import type { RenderedUnitCommand } from './execution-unit-entry.js';\ninterface Laundered extends RenderedUnitCommand {}\ndeclare const value: unknown;\nexport const forged = value as Laundered;\n`,
  },
  {
    label: 'an import renamed at the specifier',
    // The gap a name-matching selector cannot close: the identifier at the
    // assertion site is `Renamed`, not `RenderedUnitCommand`, so no selector
    // enumerating spellings of the latter ever sees it. The checker resolves
    // `Renamed` back to the same declared symbol regardless.
    code: `import type { RenderedUnitCommand as Renamed } from './execution-unit-entry.js';\ndeclare const value: unknown;\nexport const forged = value as Renamed;\n`,
  },
  {
    label: 'a type alias two hops from the brand',
    code: `import type { RenderedUnitCommand } from './execution-unit-entry.js';\ntype First = RenderedUnitCommand;\ntype Second = First;\ndeclare const value: unknown;\nexport const forged = value as Second;\n`,
  },
  {
    label: 'a union type naming the brand',
    code: `import type { RenderedUnitCommand } from './execution-unit-entry.js';\ndeclare const value: unknown;\nexport const forged = value as RenderedUnitCommand | never;\n`,
  },
];

// The negative control. Without it a rule broad enough to flag every `as` in
// the repository would satisfy every case above, and the rule would be
// unusable rather than correct. It is written, linted, and read back through
// exactly the same path as the forgeries — a control linted differently from
// what it controls proves nothing about it.
const CONTROL = {
  label: 'leaves unrelated assertions alone',
  code: [
    'declare const value: unknown;',
    'export const fine = value as string;',
    'export const alsoFine = <number>0;',
    'type Unrelated = { readonly code: string };',
    'export const stillFine = value as Unrelated;',
    '',
  ].join('\n'),
};

const CASES = [...FORGERIES, CONTROL];

/** Messages from the brand-provenance ban, per case, in `CASES` order. */
const provenanceMessages = [];

// Last-resort cleanup. The `after` hook covers a failed assertion, a throwing
// hook, and a `--test-name-pattern` run that selects no test; this covers the
// paths that never reach a hook at all, such as an uncaught exception tearing
// the process down.
process.on('exit', sweepFixtures);

before(async () => {
  sweepFixtures();

  const fixtures = CASES.map((testCase, index) => {
    const filePath = path.join(FIXTURE_DIR, `${FIXTURE_PREFIX}${RUN_ID}-${index}.ts`);
    writeFileSync(filePath, testCase.code, 'utf8');
    return filePath;
  });

  // One batch, so the whole set is on disk before the type-aware program is
  // built and every fixture enters it on that first build.
  const results = await new ESLint({ cwd: repoRoot }).lintFiles(fixtures);

  assert.equal(
    results.length,
    fixtures.length,
    'every fixture must be linted; a missing result means ESLint skipped one as ignored or unmatched',
  );

  const byPath = new Map(results.map((result) => [result.filePath, result]));
  for (const [index, filePath] of fixtures.entries()) {
    const result = byPath.get(filePath);
    assert.ok(result, `no lint result for ${filePath}`);

    const fatal = result.messages.filter((message) => message.fatal);
    assert.deepEqual(
      fatal.map((message) => message.message),
      [],
      `fixture ${index} failed to parse; the type-aware rule never ran`,
    );

    provenanceMessages[index] = result.messages
      .filter((message) => message.ruleId === 'local/no-rendered-unit-command-cast')
      .map((message) => message.message);
  }
});

after(sweepFixtures);

for (const [index, { label }] of FORGERIES.entries()) {
  test(`bans ${label}`, () => {
    const messages = provenanceMessages[index];

    assert.ok(
      messages?.some((message) => PROVENANCE.test(message)),
      `expected the provenance ban to fire on ${label}; got: ${JSON.stringify(messages)}`,
    );
  });
}

test(CONTROL.label, () => {
  assert.deepEqual(provenanceMessages[CASES.indexOf(CONTROL)], []);
});
