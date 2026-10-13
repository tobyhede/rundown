/**
 * Every agent-confusion mode ADR 0005 defends against has a test named for it
 * (#908), so none can silently disappear.
 *
 * A mode is pinned either by a runbook scenario named `confusion-<mode>`,
 * which `pnpm run test:scenarios` runs because it lives under `runbooks/`, or
 * by a plugin hook test whose title starts `confusion mode: <mode>`. This file
 * owns the list: removing a mode's test, renaming it, or adding a
 * `confusion-*` scenario no mode names fails here.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const DELEGATE_SINGLE = 'runbooks/delegation/delegate-single.runbook.md';
const DELEGATE_FOR_EACH = 'runbooks/delegation/delegate-for-each.runbook.md';
const HOOKS_INTEGRATION =
  'packages/claude-code-plugin/__tests__/workflow/hooks/delegation-hooks.integration.test.ts';

/**
 * The agent-confusion modes, each with the one test that pins it.
 *
 * @type {readonly { mode: string; scenario?: string; hook?: string }[]}
 */
const CONFUSION_MODES = [
  { mode: 'wrong run', scenario: DELEGATE_SINGLE },
  { mode: 'missing --step', scenario: DELEGATE_SINGLE },
  { mode: '--index misuse', scenario: DELEGATE_FOR_EACH },
  { mode: 'double claim', scenario: DELEGATE_SINGLE },
  { mode: 'stale claim after re-entry', scenario: DELEGATE_SINGLE },
  { mode: 'claim after cancellation', scenario: DELEGATE_SINGLE },
  { mode: 'lost ticket', scenario: DELEGATE_SINGLE },
  { mode: 'lost child token', scenario: DELEGATE_SINGLE },
  { mode: 'release', scenario: DELEGATE_SINGLE },
  { mode: 'claim outside a sub-agent', hook: HOOKS_INTEGRATION },
  { mode: 'SubagentStop gate', hook: HOOKS_INTEGRATION },
];

/**
 * The scenario name a mode is pinned by.
 *
 * @param {string} mode - The mode as listed.
 * @returns {string} `confusion-` followed by the mode's words, lower-cased and hyphenated.
 */
function scenarioName(mode) {
  return `confusion-${mode
    .toLowerCase()
    .replace(/[^a-z]+/g, '-')
    .replace(/^-|-$/g, '')}`;
}

/**
 * The frontmatter of a runbook, between its opening and closing `---`.
 *
 * @param {string} source - Runbook source.
 * @returns {string} The frontmatter text, or '' when there is none.
 */
function frontmatter(source) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(source);
  return match?.[1] ?? '';
}

/**
 * The scenario names declared under a runbook's `scenarios:` key, mapped to
 * the number of commands each lists.
 *
 * @param {string} source - Runbook source.
 * @returns {Map<string, number>} Scenario name to command count.
 */
function scenarios(source) {
  const result = new Map();
  let current;
  let inScenarios = false;
  for (const line of frontmatter(source).split('\n')) {
    if (/^\S/.test(line)) {
      inScenarios = line.startsWith('scenarios:');
      current = undefined;
      continue;
    }
    if (!inScenarios) continue;
    const key = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (key) {
      current = key[1];
      result.set(current, 0);
    } else if (current !== undefined && /^ {6}- /.test(line)) {
      result.set(current, (result.get(current) ?? 0) + 1);
    }
  }
  return result;
}

/**
 * Every runbook under the repository's `runbooks/` tree.
 *
 * @returns {string[]} Repo-relative paths.
 */
function runbookFiles() {
  return readdirSync(join(repoRoot, 'runbooks'), { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.runbook.md'))
    .map((entry) => relative(repoRoot, join(repoRoot, 'runbooks', entry)));
}

const read = (path) => readFileSync(join(repoRoot, path), 'utf8');

test('the confusion-mode list names each mode once', () => {
  const modes = CONFUSION_MODES.map(({ mode }) => mode);
  assert.equal(new Set(modes).size, modes.length);
  assert.equal(modes.length, 11);
});

for (const { mode, scenario, hook } of CONFUSION_MODES) {
  if (scenario !== undefined) {
    test(`confusion mode "${mode}" has its scenario ${scenarioName(mode)} in ${scenario}`, () => {
      const commands = scenarios(read(scenario)).get(scenarioName(mode));
      assert.ok(commands !== undefined, `${scenario} has no scenario ${scenarioName(mode)}`);
      assert.ok(commands > 0, `${scenarioName(mode)} lists no commands`);
    });
  } else {
    test(`confusion mode "${mode}" has its hook test in ${hook}`, () => {
      const title = `confusion mode: ${mode}`;
      const source = read(hook);
      const pattern = new RegExp(
        `\\b(?:it|test)\\((['"\`])${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
      );
      assert.ok(pattern.test(source), `${hook} has no test titled "${title} ..."`);
    });
  }
}

test('every confusion-* scenario under runbooks/ pins a listed mode', () => {
  const known = new Set(
    CONFUSION_MODES.filter(({ scenario }) => scenario !== undefined).map(
      ({ mode, scenario }) => `${scenario}#${scenarioName(mode)}`,
    ),
  );
  const strays = runbookFiles().flatMap((file) =>
    [...scenarios(read(file)).keys()]
      .filter((name) => name.startsWith('confusion-'))
      .map((name) => `${file}#${name}`)
      .filter((id) => !known.has(id)),
  );
  assert.deepEqual(strays, []);
});
