import assert from 'node:assert/strict';
import { test } from 'node:test';
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
 * Asserted by running the real `eslint.config.js` over snippets rather than by
 * reading the rule's source, because the rule itself is the thing under test: a
 * bug in its type resolution matches nothing and reads as passing.
 *
 * Note the layered defence this sits inside. Outside `packages/core`, the type's
 * NAME is not exported from `@rundown-org/core` at all, so none of these
 * spellings can even be written; that is pinned by
 * `packages/core/__tests__/events/entry-seam-barrel.test.ts`. This rule is what
 * holds INSIDE core, where a relative import puts the name back in scope.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

// Inside core and not the producing module, so the base ban applies with no
// exemption. A real path is required: ESLint resolves config blocks by file path,
// and the type-aware rule additionally needs a real TS program membership —
// this file's directory also makes `./execution-unit-entry.js` in the snippets
// below resolve to the REAL producer module, so the rule sees the actual brand
// declaration rather than a stand-in.
const LINTED_FILE = 'packages/core/src/runbook/collection-service.ts';

let sharedEslint;

/**
 * Lint one snippet through the repository's real flat config.
 *
 * @param {string} code - TypeScript source to lint.
 * @returns {Promise<string[]>} Messages from the brand-provenance ban, in report order.
 */
async function provenanceMessages(code) {
  sharedEslint ??= new ESLint({ cwd: repoRoot });
  const [result] = await sharedEslint.lintText(code, { filePath: LINTED_FILE });
  return result.messages
    .filter((message) => message.ruleId === 'local/no-rendered-unit-command-cast')
    .map((message) => message.message);
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

for (const { label, code } of FORGERIES) {
  test(`bans ${label}`, async () => {
    const messages = await provenanceMessages(code);

    assert.ok(
      messages.some((message) => PROVENANCE.test(message)),
      `expected the provenance ban to fire on ${label}; got: ${JSON.stringify(messages)}`,
    );
  });
}

// The negative control. Without it a rule broad enough to flag every `as` in
// the repository would satisfy every case above, and the rule would be
// unusable rather than correct.
test('leaves unrelated assertions alone', async () => {
  const code = [
    'declare const value: unknown;',
    'export const fine = value as string;',
    'export const alsoFine = <number>0;',
    'type Unrelated = { readonly code: string };',
    'export const stillFine = value as Unrelated;',
  ].join('\n');

  assert.deepEqual(await provenanceMessages(code), []);
});
