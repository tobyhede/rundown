// Guards the E2E command recorder's view of the CLI (issue #949).
//
// The recorder is a wrapper named `rundown`/`rd` placed ahead of the real bins
// on `PATH`, so it only sees a CLI that was started through `PATH`.
// `packages/claude-code-plugin/src/workflow/hooks/rundown.ts` starts the CLI by
// absolute path instead, which the recorder cannot see. Nothing in production
// imports that helper today. This file goes red when that changes, so a command
// can never go missing from the record without a failing test.
//
// The rule: no non-test file under the plugin's `src` may refer to the helper
// module. A re-export counts, so a barrel cannot hide it: for the helper to be
// reachable under another name, some file has to name the helper module first,
// and that file is the violation. The one way around that is a chain that
// starts in an exempt test file, so test files that reach the helper are
// tracked as carriers, and importing a carrier is a violation too.
//
// Specifiers are resolved to a file path and compared with the helper's path.
// Matching the text `hooks/rundown` would miss `./rundown.js` written inside
// `workflow/hooks/` and would wrongly flag `hooks/rundown-other.js`.
//
// The source is parsed with the TypeScript compiler, a root dev dependency like
// the `eslint` and `glob` that sibling tests import, so comments and import
// forms are read as the compiler reads them.

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

// Anchored to this file, not the cwd, so the scan cannot find zero files and
// pass when run from another directory.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const pluginDir = path.join(repoRoot, 'packages', 'claude-code-plugin');

/** Helper module path, relative to the plugin's source directory. */
const HELPER_IN_SRC = path.join('workflow', 'hooks', 'rundown.ts');

/** File extensions a module specifier may carry or leave off. */
const MODULE_EXTENSION = /\.(?:d\.[cm]?ts|[cm]?[jt]sx?)$/;

/**
 * What the detector needs to know about the plugin package.
 *
 * @typedef {object} PluginPackage
 * @property {string} dir - absolute package directory.
 * @property {string} name - package name, for self-referencing imports.
 * @property {unknown} exports - the `exports` field of `package.json`.
 * @property {string} srcDir - absolute source directory (`rootDir`).
 * @property {string} outDir - absolute build output directory.
 * @property {string} helper - absolute path of the helper module.
 */

/**
 * One reference to the helper from a non-test file.
 *
 * @typedef {object} Violation
 * @property {string} file - path relative to the package directory.
 * @property {number} line - 1-based line of the reference.
 * @property {string} form - the kind of reference, such as `import`.
 * @property {string | null} specifier - the text written, or null when the
 *   argument is not a plain string.
 * @property {string | null} via - the test file the reference goes through, or
 *   null for a direct reference.
 */

/**
 * Find every reference to the helper module from non-test source files.
 *
 * @param {Map<string, string>} sources - absolute file path to file text, for
 *   every file under the source directory.
 * @param {PluginPackage} pkg - the package the files belong to.
 * @returns {Violation[]} the references found, in file then line order.
 */
function findHelperImports(sources, pkg) {
  const files = [...sources].map(([file, text]) => ({
    file,
    key: moduleKey(file, pkg),
    isTest: isTestFile(file, pkg),
    references: collectReferences(file, text).map((reference) => ({
      ...reference,
      key: reference.specifier === null ? null : specifierKey(file, reference.specifier, pkg),
    })),
  }));

  // Module key to the test file that carries the helper, or null for the
  // helper itself.
  const reaches = new Map([[moduleKey(pkg.helper, pkg), null]]);
  const lookup = (reference) => {
    if (reference.key === null) return undefined;
    for (const key of [reference.key, `${reference.key}${path.sep}index`]) {
      if (reaches.has(key)) return { via: reaches.get(key) };
    }
    return undefined;
  };
  // A reference that cannot be resolved could be to anything, so it counts.
  const hit = (reference) => (reference.form === UNRESOLVABLE ? { via: null } : lookup(reference));

  // Test files are exempt, but one that reaches the helper would let a
  // non-test file reach it too. Repeat until no new carrier turns up, so a
  // chain of test files is followed to its end.
  for (let grew = true; grew; ) {
    grew = false;
    for (const entry of files) {
      if (!entry.isTest || reaches.has(entry.key)) continue;
      const found = entry.references.map(hit).find(Boolean);
      if (!found) continue;
      reaches.set(entry.key, found.via ?? relativeToPackage(entry.file, pkg));
      grew = true;
    }
  }

  const violations = [];
  for (const entry of files) {
    if (entry.isTest) continue;
    for (const reference of entry.references) {
      const found = hit(reference);
      if (!found) continue;
      violations.push({
        file: relativeToPackage(entry.file, pkg),
        line: reference.line,
        form: reference.form,
        specifier: reference.specifier,
        via: found.via,
      });
    }
  }
  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** Form given to a module load whose argument is not a plain string. */
const UNRESOLVABLE = 'unresolvable';

/**
 * Say whether a file under the source directory is a test file.
 *
 * This follows how the plugin lays out tests. Jest collects `**\/*.test.ts`
 * under the package's `__tests__` directory, and the build `tsconfig.json`
 * excludes `**\/*.test.ts`. So a test file is one named `*.test.ts` or one
 * inside a directory named `__tests__`. Nothing else is exempt: a name such as
 * `test-utils.ts` is built and shipped like any other source file.
 *
 * @param {string} file - absolute file path.
 * @param {PluginPackage} pkg - the package the file belongs to.
 * @returns {boolean} true when the file is a test file.
 */
function isTestFile(file, pkg) {
  const segments = path.relative(pkg.srcDir, file).split(path.sep);
  return segments.includes('__tests__') || segments.at(-1).endsWith('.test.ts');
}

/**
 * Give a file path as the plugin's docs and errors write it.
 *
 * @param {string} file - absolute file path.
 * @param {PluginPackage} pkg - the package the file belongs to.
 * @returns {string} the path relative to the package, with forward slashes.
 */
function relativeToPackage(file, pkg) {
  return path.relative(pkg.dir, file).split(path.sep).join('/');
}

/**
 * Reduce a file path to a key that is the same for every spelling of one
 * module: `rundown`, `rundown.js`, `rundown.ts`, the built `dist` copy, and any
 * letter case all give the same key.
 *
 * Letter case is ignored because macOS resolves `Rundown.js` to `rundown.ts`.
 *
 * @param {string} file - absolute path, with or without an extension.
 * @param {PluginPackage} pkg - the package the path is compared within.
 * @returns {string} the module key.
 */
function moduleKey(file, pkg) {
  let resolved = path.normalize(file);
  const inOutDir = path.relative(pkg.outDir, resolved);
  if (inOutDir !== '' && !inOutDir.startsWith('..') && !path.isAbsolute(inOutDir)) {
    resolved = path.join(pkg.srcDir, inOutDir);
  }
  return resolved.replace(MODULE_EXTENSION, '').toLowerCase();
}

/**
 * Resolve a module specifier written in a file to a module key.
 *
 * Handles relative and absolute paths, `file:` URLs, and the package importing
 * itself by name (through its `exports` map, and by plain subpath as well in
 * case the map is ever widened). The plugin has no other alias: the real-tree
 * test below fails if `paths`, `baseUrl`, `rootDirs` or `imports` appear.
 *
 * @param {string} file - absolute path of the file holding the specifier.
 * @param {string} specifier - the specifier text.
 * @param {PluginPackage} pkg - the package the file belongs to.
 * @returns {string | null} the module key, or null for a specifier that cannot
 *   name a file in this package (another package, a Node built-in).
 */
function specifierKey(file, specifier, pkg) {
  if (/^\.\.?(?:\/|$)/.test(specifier)) {
    return moduleKey(path.resolve(path.dirname(file), specifier), pkg);
  }
  if (specifier.startsWith('file:')) {
    try {
      return moduleKey(fileURLToPath(specifier), pkg);
    } catch {
      return null;
    }
  }
  if (path.isAbsolute(specifier)) return moduleKey(specifier, pkg);
  if (specifier === pkg.name || specifier.startsWith(`${pkg.name}/`)) {
    const subpath = `.${specifier.slice(pkg.name.length)}`;
    return moduleKey(path.resolve(pkg.dir, exportTarget(pkg.exports, subpath) ?? subpath), pkg);
  }
  return null;
}

/**
 * Look a subpath up in a `package.json` `exports` map.
 *
 * @param {unknown} exportsField - the `exports` value.
 * @param {string} subpath - `.` or a `./`-prefixed subpath.
 * @returns {string | null} the file the subpath maps to, relative to the
 *   package, or null when the map has no entry for it.
 */
function exportTarget(exportsField, subpath) {
  const pick = (entry) => {
    if (typeof entry === 'string') return entry;
    if (entry === null || typeof entry !== 'object') return null;
    for (const condition of ['import', 'default', 'require', 'node']) {
      const target = pick(entry[condition]);
      if (target !== null) return target;
    }
    return null;
  };
  if (typeof exportsField === 'string') return subpath === '.' ? exportsField : null;
  if (exportsField === null || typeof exportsField !== 'object') return null;
  if (!Object.keys(exportsField).some((key) => key.startsWith('.'))) {
    return subpath === '.' ? pick(exportsField) : null;
  }
  if (Object.hasOwn(exportsField, subpath)) return pick(exportsField[subpath]);
  for (const [pattern, entry] of Object.entries(exportsField)) {
    const star = pattern.indexOf('*');
    if (star === -1) continue;
    const [head, tail] = [pattern.slice(0, star), pattern.slice(star + 1)];
    if (subpath.length < pattern.length - 1) continue;
    if (!subpath.startsWith(head) || !subpath.endsWith(tail)) continue;
    const target = pick(entry);
    if (target === null) return null;
    return target.replaceAll('*', subpath.slice(head.length, subpath.length - tail.length));
  }
  return null;
}

/**
 * List everything in a source file that could name a module.
 *
 * Every string literal is returned, not only the ones in import positions, so
 * a path handed to a renamed `require`, to `new URL(...)`, or to a mocking
 * call is still compared with the helper's path. A module load whose argument
 * is not a plain string is returned with a null specifier.
 *
 * @param {string} file - file path, used to pick the parser mode.
 * @param {string} text - the file's source text.
 * @returns {Array<{line: number, form: string, specifier: string | null}>} the
 *   candidates in source order.
 */
function collectReferences(file, text) {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const lineOf = (position) => sourceFile.getLineAndCharacterOfPosition(position).line + 1;
  const references = sourceFile.referencedFiles.map((reference) => ({
    line: lineOf(reference.pos),
    form: 'reference path',
    specifier: reference.fileName,
  }));

  const visit = (node) => {
    if (ts.isStringLiteralLike(node)) {
      references.push({
        line: lineOf(node.getStart(sourceFile)),
        form: referenceForm(node),
        specifier: node.text,
      });
    } else if (ts.isCallExpression(node) && loaderName(node.expression) !== null) {
      const [argument] = node.arguments;
      if (argument !== undefined && !ts.isStringLiteralLike(argument)) {
        references.push({
          line: lineOf(node.getStart(sourceFile)),
          form: UNRESOLVABLE,
          specifier: null,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return references;
}

/**
 * Name the module loader an expression calls.
 *
 * @param {import('typescript').Expression} callee - the called expression.
 * @returns {string | null} `dynamic import`, `require` or `require.resolve`, or
 *   null when the call is not a module load.
 */
function loaderName(callee) {
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return 'dynamic import';
  if (ts.isIdentifier(callee) && callee.text === 'require') return 'require';
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'require' &&
    callee.name.text === 'resolve'
  ) {
    return 'require.resolve';
  }
  return null;
}

/**
 * Describe where a string literal sits, for the failure message.
 *
 * @param {import('typescript').StringLiteralLike} node - the literal.
 * @returns {string} the form, such as `import` or `export from`.
 */
function referenceForm(node) {
  const parent = node.parent;
  if (ts.isImportDeclaration(parent)) {
    return parent.importClause?.isTypeOnly ? 'import type' : 'import';
  }
  if (ts.isExportDeclaration(parent)) return 'export from';
  if (ts.isExternalModuleReference(parent)) return 'import = require';
  if (ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent)) return 'import() type';
  if (ts.isCallExpression(parent) && parent.arguments[0] === node) {
    return loaderName(parent.expression) ?? 'string literal';
  }
  return 'string literal';
}

/** A stand-in package with the same layout as the real plugin. */
const fixturePkg = {
  dir: '/repo/plugin',
  name: '@rundown-org/claude-code-plugin',
  exports: {
    '.': { import: './dist/index.js', types: './dist/index.d.ts' },
    './cli': { import: './dist/cli.js' },
  },
  srcDir: '/repo/plugin/src',
  outDir: '/repo/plugin/dist',
  helper: '/repo/plugin/src/workflow/hooks/rundown.ts',
};

/**
 * Run the detector over fixture files.
 *
 * @param {Record<string, string>} files - text keyed by path relative to the
 *   fixture source directory.
 * @returns {string[]} one `file:line form` string per violation.
 */
function detect(files) {
  const sources = new Map([[fixturePkg.helper, 'export function rundown() {}\n']]);
  for (const [name, text] of Object.entries(files)) {
    sources.set(path.join(fixturePkg.srcDir, name), text);
  }
  return findHelperImports(sources, fixturePkg).map(
    (violation) => `${violation.file}:${violation.line} ${violation.form}`,
  );
}

describe('detector flags every way of reaching the helper', () => {
  const cases = [
    ['a static import', "import { rundown } from './workflow/hooks/rundown.js';", 'import'],
    ['a side-effect import', "import './workflow/hooks/rundown.js';", 'import'],
    [
      'a type-only import',
      "import type { RundownExecOptions } from './workflow/hooks/rundown.js';",
      'import type',
    ],
    ['a star re-export', "export * from './workflow/hooks/rundown.js';", 'export from'],
    ['a named re-export', "export { rundown } from './workflow/hooks/rundown.js';", 'export from'],
    [
      'a type-only re-export',
      "export type { RundownExecOptions } from './workflow/hooks/rundown.js';",
      'export from',
    ],
    [
      'a dynamic import',
      "const m = await import('./workflow/hooks/rundown.js');",
      'dynamic import',
    ],
    [
      'a dynamic import of a template string',
      'const m = await import(`./workflow/hooks/rundown.js`);',
      'dynamic import',
    ],
    ['a require call', "const m = require('./workflow/hooks/rundown.js');", 'require'],
    [
      'require.resolve',
      "const p = require.resolve('./workflow/hooks/rundown.js');",
      'require.resolve',
    ],
    [
      'an import-equals require',
      "import m = require('./workflow/hooks/rundown.js');",
      'import = require',
    ],
    [
      'an import type expression',
      "type M = typeof import('./workflow/hooks/rundown.js');",
      'import() type',
    ],
    [
      'a reference directive',
      '/// <reference path="./workflow/hooks/rundown.ts" />',
      'reference path',
    ],
    ['no extension', "import { rundown } from './workflow/hooks/rundown';", 'import'],
    ['a .ts extension', "import { rundown } from './workflow/hooks/rundown.ts';", 'import'],
    [
      'a roundabout relative path',
      "import { rundown } from './gates/../workflow/./hooks/rundown.js';",
      'import',
    ],
    ['different letter case', "import { rundown } from './workflow/hooks/Rundown.js';", 'import'],
    ['the build output', "import { rundown } from '../dist/workflow/hooks/rundown.js';", 'import'],
    [
      'the package referring to itself',
      "import { rundown } from '@rundown-org/claude-code-plugin/dist/workflow/hooks/rundown.js';",
      'import',
    ],
    [
      'a renamed require function',
      "const load = createRequire(import.meta.url);\nconst m = load('./workflow/hooks/rundown.js');",
      'string literal',
    ],
    [
      'a file URL built from the path',
      "const url = new URL('./workflow/hooks/rundown.js', import.meta.url);",
      'string literal',
    ],
    ['a dynamic import of a computed path', 'const m = await import(name);', 'unresolvable'],
    [
      'a require of a joined path',
      "const m = require('./workflow/hooks/' + 'rundown.js');",
      'unresolvable',
    ],
    [
      'a dynamic import of a template string with a substitution',
      'const m = await import(`./workflow/hooks/$' + '{name}.js`);',
      'unresolvable',
    ],
    ['a require of a variable', 'const m = require(target);', 'unresolvable'],
    ['require.resolve of a variable', 'const p = require.resolve(target);', 'unresolvable'],
  ];

  for (const [name, source, form] of cases) {
    test(name, () => {
      const line = source.split('\n').length;
      assert.deepEqual(detect({ 'consumer.ts': source }), [`src/consumer.ts:${line} ${form}`]);
    });
  }

  test('a sibling import from inside workflow/hooks', () => {
    assert.deepEqual(
      detect({ 'workflow/hooks/index.ts': "export { rundown } from './rundown.js';" }),
      ['src/workflow/hooks/index.ts:1 export from'],
    );
  });

  test('a parent-relative import from another directory', () => {
    assert.deepEqual(
      detect({
        'gates/deep/gate.ts': "import { rundown } from '../../workflow/hooks/rundown.js';",
      }),
      ['src/gates/deep/gate.ts:1 import'],
    );
  });

  test('a barrel that re-exports the helper is the violation, so its consumers are covered', () => {
    assert.deepEqual(
      detect({
        'workflow/hooks/index.ts': "export * from './rundown.js';",
        'consumer.ts': "import { rundown } from './workflow/hooks/index.js';",
      }),
      ['src/workflow/hooks/index.ts:1 export from'],
    );
  });

  test('a non-test file that reaches the helper through a test file', () => {
    assert.deepEqual(
      detect({
        'workflow/hooks/carrier.test.ts': "export * from './rundown.js';",
        '__tests__/relay.ts': "export * from '../workflow/hooks/carrier.test.js';",
        'consumer.ts': "import { rundown } from './__tests__/relay.js';",
      }),
      ['src/consumer.ts:1 import'],
    );
  });

  test('every reference in a file is reported, with its line', () => {
    assert.deepEqual(
      detect({
        'consumer.ts': [
          "import type { RundownExecOptions } from './workflow/hooks/rundown.js';",
          '',
          "export const load = () => import('./workflow/hooks/rundown.js');",
        ].join('\n'),
      }),
      ['src/consumer.ts:1 import type', 'src/consumer.ts:3 dynamic import'],
    );
  });
});

describe('detector leaves near misses alone', () => {
  const cases = [
    [
      'a module whose name starts the same',
      "import { x } from './workflow/hooks/rundown-something.js';",
    ],
    [
      'a module in a directory named like the helper',
      "import { x } from './workflow/hooks/rundown/index.js';",
    ],
    ['a same-named module in another directory', "import { x } from './rundown.js';"],
    ['a same-named file that is not a module', "import data from './workflow/hooks/rundown.json';"],
    [
      'another module in the same directory',
      "import { x } from './workflow/hooks/subagent-stop.js';",
    ],
    [
      'a barrel that does not re-export the helper',
      "import { x } from './workflow/hooks/index.js';",
    ],
    ['the CLI package', "import { x } from '@rundown-org/cli';"],
    ['the package entry point', "import { x } from '@rundown-org/claude-code-plugin';"],
    [
      'a bare specifier that only looks like the path',
      "import { x } from 'workflow/hooks/rundown';",
    ],
    ['a comment that names the helper', "// see import('./workflow/hooks/rundown.js')\nexport {};"],
    [
      'a block comment with an import line',
      "/* import './workflow/hooks/rundown.js'; */\nexport {};",
    ],
    ['a dynamic import of another module', "const m = await import('./plan-schema.js');"],
    [
      'a plain string that is not a path to the helper',
      "const name = 'workflow/hooks/rundown.ts';",
    ],
  ];

  for (const [name, source] of cases) {
    test(name, () => {
      assert.deepEqual(
        detect({ 'consumer.ts': source, 'workflow/hooks/index.ts': 'export {};' }),
        [],
      );
    });
  }

  test('a test file named *.test.ts', () => {
    assert.deepEqual(
      detect({ 'workflow/hooks/rundown.test.ts': "import { rundown } from './rundown.js';" }),
      [],
    );
  });

  test('a file under a __tests__ directory', () => {
    assert.deepEqual(
      detect({
        '__tests__/helpers/cli.ts': "import { rundown } from '../../workflow/hooks/rundown.js';",
      }),
      [],
    );
  });

  test('a file whose name only contains the word test is not exempt', () => {
    assert.deepEqual(
      detect({ 'test-utils.ts': "import { rundown } from './workflow/hooks/rundown.js';" }),
      ['src/test-utils.ts:1 import'],
    );
  });

  test('the helper itself, which resolves the CLI path with require.resolve', () => {
    const helperText = "const p = require.resolve('@rundown-org/cli');\n";
    const sources = new Map([[fixturePkg.helper, helperText]]);
    assert.deepEqual(findHelperImports(sources, fixturePkg), []);
  });
});

/**
 * Read the real plugin package's layout from its own config files.
 *
 * @returns {{pkg: PluginPackage, aliases: Record<string, unknown>, rootDir: string | undefined, buildExclude: string[]}}
 *   the package description, any alias settings found (all expected to be
 *   undefined), the build's `rootDir`, and the build's exclude patterns.
 */
function loadPluginPackage() {
  const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
  const configPath = path.join(pluginDir, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined, 'the plugin tsconfig.json must parse');
  // Parsed through the compiler so that settings inherited through `extends`
  // are seen too.
  const { options, raw } = ts.parseJsonConfigFileContent(config.config, ts.sys, pluginDir);
  const srcDir = path.join(pluginDir, 'src');
  return {
    pkg: {
      dir: pluginDir,
      name: manifest.name,
      exports: manifest.exports,
      srcDir,
      outDir: options.outDir,
      helper: path.join(srcDir, HELPER_IN_SRC),
    },
    aliases: {
      'tsconfig paths': options.paths,
      'tsconfig baseUrl': options.baseUrl,
      'tsconfig rootDirs': options.rootDirs,
      'package.json imports': manifest.imports,
    },
    rootDir: options.rootDir,
    buildExclude: raw.exclude ?? [],
  };
}

describe('the plugin source tree', () => {
  const { pkg, aliases, rootDir, buildExclude } = loadPluginPackage();

  test('the layout the detector assumes still holds', () => {
    assert.equal(
      path.normalize(rootDir ?? ''),
      pkg.srcDir,
      'the plugin tsconfig rootDir is no longer src: update srcDir in this guard',
    );
    assert.equal(
      typeof pkg.outDir,
      'string',
      'the plugin tsconfig has no outDir: update how this guard maps build output to source',
    );
    assert.ok(
      buildExclude.includes('**/*.test.ts'),
      'the plugin build no longer excludes **/*.test.ts: update isTestFile in this guard',
    );
    // The resolver knows relative paths and the package's own name. A new
    // alias is a new way to spell the helper's path that it would not see.
    for (const [setting, value] of Object.entries(aliases)) {
      assert.equal(
        value,
        undefined,
        `${setting} is now set on the plugin package: teach specifierKey in this guard to resolve it`,
      );
    }
  });

  test('no non-test file refers to workflow/hooks/rundown', () => {
    assertNoHelperImports(pkg.srcDir, pkg);
  });
});

describe('the scan refuses to pass without checking anything', () => {
  const { pkg } = loadPluginPackage();

  /**
   * Run the scan over a temporary source directory.
   *
   * @param {Record<string, string>} files - text keyed by path relative to the
   *   temporary directory.
   * @returns {() => void} a function that runs the scan, for `assert.throws`.
   */
  const scanOf = (files) => () => {
    const root = mkdtempSync(path.join(tmpdir(), 'helper-import-guard-'));
    const srcDir = path.join(root, 'src');
    try {
      mkdirSync(srcDir);
      for (const [name, text] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(srcDir, name)), { recursive: true });
        writeFileSync(path.join(srcDir, name), text);
      }
      assertNoHelperImports(srcDir, pkg);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  const helperName = HELPER_IN_SRC.split(path.sep).join('/');

  test('an empty source directory', () => {
    assert.throws(scanOf({}), /no source files were found under /);
  });

  test('a source directory holding only test files and non-source files', () => {
    assert.throws(
      scanOf({ 'a.test.ts': 'export {};', '__tests__/b.ts': 'export {};', 'notes.md': 'x' }),
      /no source files were found under /,
    );
  });

  test('a source directory without the helper', () => {
    assert.throws(
      scanOf({ 'index.ts': 'export {};' }),
      /does not exist, so this guard is checking nothing/,
    );
  });

  test('a source directory holding only the helper', () => {
    assert.throws(
      scanOf({ [helperName]: 'export {};' }),
      /the helper is the only non-test source file found/,
    );
  });

  test('a source directory that imports the helper', () => {
    assert.throws(
      scanOf({
        [helperName]: 'export {};',
        'index.ts': "export * from './workflow/hooks/rundown.js';",
      }),
      /Plugin source refers to workflow\/hooks\/rundown[\s\S]*src\/index\.ts:1 export from/,
    );
  });

  test('a clean source directory passes', () => {
    assert.doesNotThrow(scanOf({ [helperName]: 'export {};', 'index.ts': 'export {};' }));
  });
});

/**
 * Scan a source directory and fail if a non-test file refers to the helper.
 *
 * Fails as well when there was nothing to check, so the guard cannot pass
 * because the directory moved, the walk found no files, or the helper is gone.
 *
 * @param {string} srcDir - absolute source directory to scan. The helper is
 *   looked for at its usual place under this directory.
 * @param {PluginPackage} plugin - the plugin package, for its name, `exports`
 *   and build output directory.
 * @throws {assert.AssertionError} when nothing was scanned, the helper is
 *   missing, or a non-test file refers to the helper.
 */
function assertNoHelperImports(srcDir, plugin) {
  const pkg = {
    ...plugin,
    dir: path.dirname(srcDir),
    srcDir,
    helper: path.join(srcDir, HELPER_IN_SRC),
  };

  const sources = new Map(
    readdirSync(srcDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && MODULE_EXTENSION.test(entry.name))
      .map((entry) => path.join(entry.parentPath, entry.name))
      .map((file) => [file, readFileSync(file, 'utf8')]),
  );
  const scanned = [...sources.keys()].filter((file) => !isTestFile(file, pkg));
  assert.ok(scanned.length > 0, `no source files were found under ${srcDir}`);

  // Without the helper there is nothing to guard, and every comparison below
  // would pass for the wrong reason. If it moved, point this guard at the new
  // path. If it was deleted, delete this guard with it.
  assert.ok(
    existsSync(pkg.helper),
    `${relativeToPackage(pkg.helper, pkg)} does not exist, so this guard is checking nothing`,
  );
  assert.ok(
    sources.has(pkg.helper),
    'the scan did not reach the helper, so it is not walking the tree',
  );
  assert.ok(
    scanned.some((file) => file !== pkg.helper),
    'the helper is the only non-test source file found',
  );

  const violations = findHelperImports(sources, pkg);
  assert.deepEqual(
    violations,
    [],
    [
      'Plugin source refers to workflow/hooks/rundown, which starts the CLI by absolute path.',
      'The E2E command recorder wraps `rundown` on PATH and cannot see a CLI started that way,',
      'so its record would be missing commands (issue #949). Start the CLI through PATH instead.',
      ...violations.map(
        ({ file, line, form, specifier, via }) =>
          `  ${file}:${line} ${form}${specifier === null ? '' : ` '${specifier}'`}${via === null ? '' : ` (through ${via})`}`,
      ),
    ].join('\n'),
  );
}
