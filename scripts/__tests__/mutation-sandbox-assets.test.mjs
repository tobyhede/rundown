// Guards the conventions that keep Stryker's dry run alive.
//
// Stryker copies only the package directory into `.stryker-tmp/sandbox-*`, which
// adds two path segments. A test that reaches an asset OUTSIDE its package via a
// relative traversal off `import.meta.url` therefore resolves to
// `packages/<pkg>/<path>` in the sandbox, where the asset does not exist. The
// failure is not a skipped assertion: it is a hard
// `There were failed tests in the initial test run.` abort that kills the whole
// campaign before a single mutant is tested — and because the shard step is
// `continue-on-error`, it reported as success.
//
// Two rules close the class, and this file is what keeps them true:
//   1. every mutation-tested package's sandbox config must ignore the naming
//      conventions, so the escape hatch actually exists everywhere;
//   2. no file a sandbox actually collects (or that such a file imports) may
//      build a path, off its own location, that leaves the package.
//
// Rule 2's scope is derived from each package's real
// `makeConfig({ sandboxed: true }).testPathIgnorePatterns` rather than a
// hand-listed set of suffixes. A file the sandbox never collects cannot abort the
// dry run, so flagging it would be a false positive; and deriving the set means
// dropping an ignore (e.g. the cli's `integration`) re-arms the guard over
// exactly the files that dropping it exposes.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { globSync } from 'glob';

import { PACKAGES } from '../lib/mutation-scope.mjs';

// Anchored to this file, not the cwd: resolving package paths relatively would
// make the scan below find zero files — and pass — when run from anywhere else.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const REPO_ASSET_IGNORE = '\\.repo-asset\\.test\\.ts$';
const SOURCE_TEXT_IGNORE = '\\.source-text\\.test\\.ts$';

/**
 * Strip comments so prose describing a path is not mistaken for code reaching
 * for one. The rule this file enforces is about what a test EXECUTES, and every
 * fix for a violation naturally leaves an explanatory comment quoting the old
 * path — which would otherwise re-trip the guard it just satisfied.
 *
 * @param {string} text - TypeScript source.
 * @returns {string} the source with block and line comments blanked.
 */
function withoutComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Relative path literals a test file embeds, resolved against that file.
 *
 * Only `./` and `../` specifiers are considered: an absolute literal such as
 * `'/project/../etc/passwd'` is path-traversal *test data*, not a filesystem
 * reach, and resolving it against the file would be meaningless.
 *
 * @param {string} text - comment-stripped TypeScript source.
 * @param {string} file - absolute test file path.
 * @param {string} pkgDir - absolute package directory the file belongs to.
 * @returns {Array<{specifier: string, escapes: string | null}>} each literal with
 *   its package-escaping target, or null when it stays inside the package.
 */
function relativePathLiterals(text, file, pkgDir) {
  const found = [];
  for (const match of text.matchAll(/["'`](\.\.?\/[^"'`\n]*)["'`]/g)) {
    const specifier = match[1];
    const target = relative(pkgDir, resolve(dirname(file), specifier));
    found.push({ specifier, escapes: target.startsWith(`..${sep}`) ? target : null });
  }
  return found;
}

// A single literal is only the most visible shape of the escape. The same reach
// spelled one segment per argument — `join(__dirname, '..', '..', '..')` — holds
// no `../` literal at all, and the plugin suite chained it through an
// intermediate const (`const repoRoot = resolve(pluginDir, '..', '..')`). Both
// were invisible to the literal scan while aborting a real shard, so the calls
// below are evaluated rather than pattern-matched.
const CALL_SOURCE = String.raw`(?:^|[^\w.$])((?:path\.)?(?:join|resolve)|new\s+URL)\s*\(`;
const CALL_GLOBAL = new RegExp(CALL_SOURCE, 'g');
const CALL_FIRST = new RegExp(CALL_SOURCE);
const STRING_LITERAL = /^(['"])((?:[^'"\\\n]|\\.)*)\1$/;
const BINDING =
  /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:(?:new\s+)?[\w$.]+\s*\(\s*)*$/;

/**
 * @param {string} callee - matched path-building callee.
 * @returns {'join' | 'resolve' | 'url'} its path-composition semantics.
 */
function callKind(callee) {
  if (/URL$/.test(callee)) return 'url';
  return /join$/.test(callee) ? 'join' : 'resolve';
}

/**
 * Split a balanced, comma-separated argument list.
 *
 * @param {string} text - source text.
 * @param {number} open - index of the call's opening parenthesis.
 * @returns {{args: string[], end: number} | null} the top-level arguments and the
 *   index of the closing parenthesis, or null when the call is unterminated.
 */
function readArguments(text, open) {
  let depth = 0;
  const args = [];
  let current = '';
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
      if (depth === 1) continue;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const all = [...args, current].map((arg) => arg.trim());
        return { args: all.length === 1 && all[0] === '' ? [] : all, end: i };
      }
    } else if (depth === 1 && ch === ',') {
      args.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  return null;
}

/**
 * Statically evaluate one path-building call, but only when it is anchored to the
 * file's own location.
 *
 * An anchor of `__dirname`, `import.meta.url`, or a const previously bound to
 * such a call is what makes the result move when the file moves — which is the
 * whole failure mode. A call rooted anywhere else (`join('/repo', …)` as
 * traversal test data, `join(tempDir, …)`, `segments.join('/')`) is not a reach
 * off this file and is deliberately left unevaluated.
 *
 * @param {string} text - comment-stripped source.
 * @param {number} open - index of the call's opening parenthesis.
 * @param {'join' | 'resolve' | 'url'} kind - the call's path-composition semantics.
 * @param {string} fileDir - directory holding the file.
 * @param {Map<string, string>} bindings - consts already bound to a resolved path.
 * @returns {{value: string, end: number} | null} the resolved absolute path and the
 *   index of the closing parenthesis, or null when it is not statically known.
 */
function evaluateCall(text, open, kind, fileDir, bindings) {
  const parsed = readArguments(text, open);
  if (parsed === null || parsed.args.length === 0) return null;
  const { args, end } = parsed;

  if (kind === 'url') {
    const literal = STRING_LITERAL.exec(args[0]);
    if (literal === null || args[1] !== 'import.meta.url') return null;
    return { value: resolve(fileDir, literal[2]), end };
  }

  let value;
  const anchor = args[0];
  if (bindings.has(anchor)) {
    value = bindings.get(anchor);
  } else if (anchor === '__dirname') {
    value = fileDir;
  } else {
    const nested = CALL_FIRST.exec(anchor);
    if (nested === null) return null;
    const inner = evaluateCall(
      anchor,
      nested.index + nested[0].length - 1,
      callKind(nested[1]),
      fileDir,
      bindings,
    );
    if (inner === null) return null;
    value = inner.value;
  }

  for (const arg of args.slice(1)) {
    const literal = STRING_LITERAL.exec(arg);
    if (literal === null) return null;
    value = kind === 'join' ? join(value, literal[2]) : resolve(value, literal[2]);
  }
  return { value, end };
}

/**
 * Every file-anchored path expression in a source file, with where it lands.
 *
 * @param {string} text - comment-stripped TypeScript source.
 * @param {string} file - absolute test file path.
 * @returns {Array<{expression: string, resolved: string}>} one entry per
 *   statically evaluable expression, in source order.
 */
function fileAnchoredPaths(text, file) {
  const fileDir = dirname(file);
  const bindings = new Map();
  const found = [];
  CALL_GLOBAL.lastIndex = 0;
  for (let match = CALL_GLOBAL.exec(text); match !== null; match = CALL_GLOBAL.exec(text)) {
    const open = match.index + match[0].length - 1;
    const evaluated = evaluateCall(text, open, callKind(match[1]), fileDir, bindings);
    if (evaluated === null) continue;
    const binding = BINDING.exec(text.slice(Math.max(0, match.index - 200), open + 1));
    if (binding !== null) bindings.set(binding[1], evaluated.value);
    found.push({
      expression: text
        .slice(match.index, evaluated.end + 1)
        .replace(/\s+/g, ' ')
        .trim(),
      resolved: evaluated.value,
    });
  }
  return found;
}

test('path evaluation preserves wrapped URL bindings and call semantics', () => {
  const file = '/repo/packages/example/__tests__/fixture.test.ts';
  const paths = fileAnchoredPaths(
    `
      const repoRoot = fileURLToPath ( new URL('../..', import.meta.url) );
      join(repoRoot, '/asset');
      resolve(repoRoot, '/asset');
      resolve(join(repoRoot, '/asset'), 'child');
    `,
    file,
  );

  assert.deepEqual(
    paths.map(({ resolved }) => resolved),
    ['/repo/packages', '/repo/packages/asset', '/asset', '/repo/packages/asset/child'],
  );
});

/**
 * Jest `testPathIgnorePatterns` compiled against absolute paths.
 *
 * @param {string[]} patterns - the config's raw pattern strings.
 * @param {string} pkgDir - absolute package directory standing in for `<rootDir>`.
 * @returns {RegExp[]} one matcher per pattern.
 */
function ignoreMatchers(patterns, pkgDir) {
  return patterns.map((pattern) => new RegExp(pattern.replaceAll('<rootDir>', pkgDir)));
}

/**
 * Load a package's sandbox and normal Jest configs.
 *
 * @param {string} dir - repo-relative package directory.
 * @returns {Promise<{sandboxed: import('jest').Config, normal: import('jest').Config}>} both configs.
 */
async function loadConfigs(dir) {
  const module = await import(pathToFileURL(resolve(repoRoot, dir, 'jest.config.shared.js')).href);
  return {
    sandboxed: module.makeConfig({ sandboxed: true }),
    normal: module.makeConfig({ sandboxed: false }),
  };
}

for (const pkg of PACKAGES) {
  test(`${pkg.package}: the Stryker sandbox config ignores the meta-test conventions`, async () => {
    const { sandboxed, normal } = await loadConfigs(pkg.dir);

    for (const ignore of [REPO_ASSET_IGNORE, SOURCE_TEXT_IGNORE]) {
      assert.ok(
        sandboxed.testPathIgnorePatterns.includes(ignore),
        `${pkg.dir} must not collect ${ignore} inside the sandbox`,
      );
      assert.ok(
        !normal.testPathIgnorePatterns.includes(ignore),
        `${pkg.dir} must still run ${ignore} under the normal Jest config`,
      );
    }
  });
}

// REGRESSION (P1): `packages/core/__tests__/runbook/session-service.process.test.ts`
// resolved tsx through `../../../../node_modules`, which lands on
// `packages/core/node_modules/tsx` in the sandbox. tsx is a ROOT-only
// devDependency, so pnpm never links it there — in CI either. Every core
// mutation run aborted its dry run, tested zero mutants, and reported success.
//
// The same class survived in the plugin in shapes the literal scan could not
// see: `join(__dirname, '..', '..', '..', 'cli', 'dist', 'cli.js')` spelled one
// segment per argument in `__tests__/helpers/test-utils.ts`, and a `repoRoot`
// chained off an intermediate const in
// `__tests__/runbook-rdpath-outputs.integration.test.ts` and
// `__tests__/content/no-bare-rd-command.repo-asset.test.ts`. Five plugin suites failed a
// full sandbox jest run because of them.
//
// Those five were ARMED BUT NOT FIRING, and the distinction is worth keeping
// straight. The jest runner's `enableFindRelatedTests` (its default, and set
// explicitly in core) scopes the DRY RUN as well as each mutant run, so a suite
// that statically imports none of its package's `src/**` never runs under
// Stryker at all — and the plugin suites' only src import is an `import type`,
// which ts-jest erases. Turning one of those into a value import is the whole
// distance between latent and a dead campaign, which is why the guard flags the
// path rather than waiting for the abort.
test('no sandbox-collected file reaches outside its package', async () => {
  const offenders = [];
  let scanned = 0;
  for (const pkg of PACKAGES) {
    const pkgDir = resolve(repoRoot, pkg.dir);
    const { sandboxed } = await loadConfigs(pkg.dir);
    const ignored = ignoreMatchers(sandboxed.testPathIgnorePatterns, pkgDir);
    for (const file of globSync(`${pkgDir}/__tests__/**/*.ts`)) {
      if (ignored.some((matcher) => matcher.test(file))) continue;
      scanned += 1;
      const text = withoutComments(readFileSync(file, 'utf8'));
      const where = relative(repoRoot, file);
      for (const { specifier, escapes } of relativePathLiterals(text, file, pkgDir)) {
        if (escapes) offenders.push(`${where}: '${specifier}' resolves to ${escapes}`);
      }
      for (const { expression, resolved } of fileAnchoredPaths(text, file)) {
        const target = relative(pkgDir, resolved);
        if (target.startsWith(`..${sep}`)) {
          offenders.push(`${where}: \`${expression}\` resolves to ${target}`);
        }
      }
    }
  }
  // A guard that scans nothing passes for the wrong reason, which is the same
  // shape of silent success this whole file exists to prevent.
  assert.ok(scanned > 100, `expected to scan the packages' test suites, saw ${scanned} files`);
  assert.deepEqual(
    offenders,
    [],
    'Resolve the asset without a traversal (e.g. createRequire(...).resolve for a ' +
      'dependency, or an upward search for a marker file), or name the file ' +
      '*.repo-asset.test.ts so the sandbox skips it.\n' +
      offenders.join('\n'),
  );
});
