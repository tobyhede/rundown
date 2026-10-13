/**
 * Every agent-confusion mode ADR 0005 defends against has a test named for it
 * (#908), so none can silently disappear.
 *
 * A mode is pinned either by a runbook scenario named `confusion-<mode>`,
 * which `pnpm run test:scenarios` runs because it lives under `runbooks/`, or
 * by a plugin hook test whose title starts `confusion mode: <mode>`. This file
 * owns the list: removing a mode's test or renaming it fails here, and so does
 * a `confusion-*` scenario in any runbook in the repository, or a test anywhere
 * under `packages/` titled `confusion mode: …`, that no listed mode names.
 * Only dependencies, build output, Stryker sandboxes and dot-directories are
 * skipped.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(source);
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
  for (const line of frontmatter(source).split(/\r?\n/)) {
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

/** Directory names the scan never descends into. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.stryker-tmp']);

/**
 * Every file under `dir` whose base name passes `keep`, skipping
 * {@link SKIPPED_DIRECTORIES} and dot-directories. Dot-directories hold other
 * checkouts (`.worktrees/`, `.claude/worktrees/`) and scratch (`.work/`), never
 * this checkout's sources.
 *
 * @param {string} root - Directory the returned paths are relative to.
 * @param {string} dir - Root-relative directory to walk.
 * @param {(name: string) => boolean} keep - Filter on a file's base name.
 * @returns {string[]} Root-relative paths, or none when `dir` does not exist.
 */
function walk(root, dir, keep) {
  let entries;
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return entries.flatMap((entry) => {
    const path = dir === '' ? entry.name : join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) return [];
      return walk(root, path, keep);
    }
    return entry.isFile() && keep(entry.name) ? [path] : [];
  });
}

/**
 * Every runbook in the repository, wherever it lives.
 *
 * @param {string} root - Repository root.
 * @returns {string[]} Root-relative paths.
 */
const runbookFiles = (root) => walk(root, '', (name) => name.endsWith('.runbook.md'));

/**
 * Every test source under `packages/`.
 *
 * @param {string} root - Repository root.
 * @returns {string[]} Root-relative paths.
 */
const testFiles = (root) => walk(root, 'packages', (name) => /\.test\.[cm]?[jt]s$/.test(name));

/**
 * Read a root-relative file.
 *
 * @param {string} path - Root-relative path.
 * @param {string} [root] - Repository root.
 * @returns {string} The file's contents.
 */
const read = (path, root = repoRoot) => readFileSync(join(root, path), 'utf8');

/**
 * Escape `text` for use as a literal inside a regular expression.
 *
 * @param {string} text - Literal text.
 * @returns {string} The escaped pattern.
 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The titles of every test in `source` titled `confusion mode: …`.
 *
 * @param {string} source - Test source.
 * @returns {string[]} Each title with its `confusion mode: ` prefix removed.
 */
function confusionTitles(source) {
  const pattern = /\b(?:it|test)(?:\.\w+)*\(\s*(['"`])confusion mode: ((?:(?!\1)[^\n])*)\1/g;
  return [...source.matchAll(pattern)].map((match) => match[2]);
}

/**
 * Every confusion scenario or confusion-mode test under `root` that no listed
 * mode pins.
 *
 * @param {string} root - Repository root.
 * @returns {string[]} `<file>#confusion-<name>` and `<file>#confusion mode: <title>` ids.
 */
function strays(root) {
  const known = new Set(
    CONFUSION_MODES.filter(({ scenario }) => scenario !== undefined).map(
      ({ mode, scenario }) => `${scenario}#${scenarioName(mode)}`,
    ),
  );
  const scenarioStrays = runbookFiles(root).flatMap((file) =>
    [...scenarios(read(file, root)).keys()]
      .filter((name) => name.startsWith('confusion-'))
      .map((name) => `${file}#${name}`)
      .filter((id) => !known.has(id)),
  );
  const pins = (file, title) =>
    CONFUSION_MODES.some(
      ({ mode, hook }) =>
        hook === file && new RegExp(`^${escapeRegExp(mode)}(?:\\W|$)`).test(title),
    );
  const testStrays = testFiles(root).flatMap((file) =>
    confusionTitles(read(file, root))
      .filter((title) => !pins(file, title))
      .map((title) => `${file}#confusion mode: ${title}`),
  );
  return [...scenarioStrays, ...testStrays];
}

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
      const pattern = new RegExp(`\\b(?:it|test)\\((['"\`])${escapeRegExp(title)}`);
      assert.ok(pattern.test(source), `${hook} has no test titled "${title} ..."`);
    });
  }
}

test('every confusion scenario and confusion-mode test in the repository pins a listed mode', () => {
  assert.deepEqual(strays(repoRoot), []);
});

test('frontmatter reads a CRLF runbook', () => {
  assert.equal(frontmatter('---\r\nname: x\r\n---\r\n# X\r\n'), 'name: x');
  assert.deepEqual(
    [
      ...scenarios(
        '---\r\nscenarios:\r\n  confusion-x:\r\n    commands:\r\n      - rundown run x\r\n---\r\n',
      ),
    ],
    [['confusion-x', 1]],
  );
});

test('the stray scan reaches every tree a confusion test can live in, and no other', () => {
  const root = mkdtempSync(join(tmpdir(), 'confusion-modes-'));
  try {
    const stray = (name) =>
      `---\nscenarios:\n  ${name}:\n    commands:\n      - rundown run x\n---\n# X\n`;
    const files = {
      'runbooks/a.runbook.md': stray('confusion-in-runbooks'),
      'packages/claude-code-plugin/runbooks/b.runbook.md': stray('confusion-in-plugin'),
      'packages/claude-code-plugin/__tests__/workflow/hooks/c.test.ts':
        "it('confusion mode: made up — does a thing', () => {});\n",
      'node_modules/pkg/d.runbook.md': stray('confusion-in-node-modules'),
      'packages/cli/dist/e.runbook.md': stray('confusion-in-dist'),
      'packages/core/.stryker-tmp/sandbox-1/f.runbook.md': stray('confusion-in-stryker'),
      '.worktrees/other/runbooks/g.runbook.md': stray('confusion-in-worktree'),
    };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    assert.deepEqual(strays(root).sort(), [
      'packages/claude-code-plugin/__tests__/workflow/hooks/c.test.ts#confusion mode: made up — does a thing',
      'packages/claude-code-plugin/runbooks/b.runbook.md#confusion-in-plugin',
      'runbooks/a.runbook.md#confusion-in-runbooks',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
