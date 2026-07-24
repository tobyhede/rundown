import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

import { pruneNonRuntimeFiles } from '../../site/scripts/prune-non-runtime.mjs';

// The WebContainer snapshot packs an entire node_modules tree into ONE static
// asset against Cloudflare Pages' 25 MiB per-file cap. Nothing inside it is ever
// compiled, type-checked or debugged: there is no tsc, no bundler and no
// devtools consuming source maps. Declarations, published TypeScript sources and
// package docs are therefore pure asset weight. See issue #639.

let root;
const created = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'prune-non-runtime-'));
  created.push(root);
});

after(() => {
  for (const dir of created) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Write a fake installed package.
 *
 * @param {string} nodeModulesDir - Directory to install into.
 * @param {string} name - Package name.
 * @param {object} options - Fixture options.
 * @param {object} [options.packageJson] - package.json contents (name is filled in).
 * @param {Record<string, string>} [options.files] - Package-relative path → contents.
 * @returns {string} The package directory.
 */
function installFakePackage(nodeModulesDir, name, { packageJson, files } = {}) {
  const pkgDir = join(nodeModulesDir, name);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name, main: './dist/index.js', ...packageJson }),
  );
  for (const [relative, contents] of Object.entries(files ?? {})) {
    const target = join(pkgDir, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return pkgDir;
}

test('removes source maps, which reference sources the tarball never ships', () => {
  const pkgDir = installFakePackage(root, 'left-pad', {
    files: {
      'dist/index.js': 'module.exports = 1;',
      'dist/index.js.map': '{"version":3,"sources":["../src/index.ts"]}',
      'dist/index.d.ts.map': '{"version":3,"sources":["../src/index.ts"]}',
    },
  });

  pruneNonRuntimeFiles(root);

  assert.ok(existsSync(join(pkgDir, 'dist/index.js')), 'runtime entry survives');
  assert.ok(!existsSync(join(pkgDir, 'dist/index.js.map')));
  assert.ok(!existsSync(join(pkgDir, 'dist/index.d.ts.map')));
});

test('removes type declarations even when package.json declares a types entry', () => {
  // `types` is a compiler-facing field. Nothing in the snapshot type-checks, so
  // declaring one must not protect the declarations from the prune.
  const pkgDir = installFakePackage(root, 'typed', {
    packageJson: { types: './dist/index.d.ts' },
    files: {
      'dist/index.js': 'module.exports = 1;',
      'dist/index.d.ts': 'export declare const a: 1;',
    },
  });

  pruneNonRuntimeFiles(root);

  assert.ok(existsSync(join(pkgDir, 'dist/index.js')));
  assert.ok(!existsSync(join(pkgDir, 'dist/index.d.ts')));
});

test('removes published TypeScript sources', () => {
  const pkgDir = installFakePackage(root, 'zod', {
    files: { 'dist/index.js': 'module.exports = 1;', 'src/types.ts': 'export const a = 1;' },
  });

  pruneNonRuntimeFiles(root);

  assert.ok(!existsSync(join(pkgDir, 'src/types.ts')));
});

test('removes published .tsx sources', () => {
  // A component library ships .tsx source alongside its build. Node cannot load
  // .tsx any more than .ts, so it is weight of the same kind — the extension
  // pattern must reach it.
  const pkgDir = installFakePackage(root, 'ui-kit', {
    files: { 'dist/index.js': 'module.exports = 1;', 'src/Button.tsx': 'export const Button = 1;' },
  });

  pruneNonRuntimeFiles(root);

  assert.ok(existsSync(join(pkgDir, 'dist/index.js')), 'the runtime build survives');
  assert.ok(!existsSync(join(pkgDir, 'src/Button.tsx')));
});

test('prunes TypeScript even when a bundler-only module field points at it', () => {
  // `module` is bundler metadata Node never resolves — the same category as the
  // @zod/source condition. A package with a real `main` and a `module` pointing
  // at its .ts entry must still have those sources pruned: honouring `module`
  // would keep them for a resolver that does not exist in the snapshot.
  const pkgDir = installFakePackage(root, 'dual-entry', {
    packageJson: { main: './dist/index.js', module: './src/index.ts' },
    files: { 'dist/index.js': 'module.exports = 1;', 'src/index.ts': 'export default 1;' },
  });

  pruneNonRuntimeFiles(root);

  assert.ok(existsSync(join(pkgDir, 'dist/index.js')), 'the Node entry survives');
  assert.ok(!existsSync(join(pkgDir, 'src/index.ts')), 'the bundler-only source does not');
});

test('keeps TypeScript sources a package declares as its own entry point', () => {
  // Source-first packages resolve to `.ts` at runtime under Node's type
  // stripping. Deriving the keep-set from the package's own manifest — as the
  // sql.js prune does — means such a package survives instead of being gutted.
  const pkgDir = installFakePackage(root, 'source-first', {
    packageJson: { main: './src/index.ts', exports: { '.': './src/index.ts' } },
    files: { 'src/index.ts': 'export const a = 1;', 'src/helper.ts': 'export const b = 2;' },
  });

  pruneNonRuntimeFiles(root);

  assert.ok(existsSync(join(pkgDir, 'src/index.ts')), 'declared entry point survives');
  assert.ok(existsSync(join(pkgDir, 'src/helper.ts')), 'so does the rest of its package');
});

test('ignores entry points reachable only under a bundler-specific export condition', () => {
  // zod publishes `"@zod/source": "./src/index.ts"` alongside its real
  // import/require targets. Node never resolves that condition — only a bundler
  // configured for it does, and nothing inside the snapshot bundles. Honouring
  // it kept zod's whole 4 MiB of TypeScript for an entry point the demo cannot
  // reach.
  const pkgDir = installFakePackage(root, 'condition-source', {
    packageJson: {
      main: './dist/index.cjs',
      exports: {
        '.': {
          '@vendor/source': './src/index.ts',
          import: './dist/index.js',
          require: './dist/index.cjs',
        },
      },
    },
    files: {
      'dist/index.js': 'export default 1;',
      'dist/index.cjs': 'module.exports = 1;',
      'src/index.ts': 'export default 1;',
    },
  });

  pruneNonRuntimeFiles(root);

  assert.ok(existsSync(join(pkgDir, 'dist/index.js')), 'the import target survives');
  assert.ok(existsSync(join(pkgDir, 'dist/index.cjs')), 'so does the require target');
  assert.ok(!existsSync(join(pkgDir, 'src/index.ts')), 'the bundler-only source does not');
});

test('removes package README and CHANGELOG files', () => {
  const pkgDir = installFakePackage(root, 'documented', {
    files: {
      'dist/index.js': 'module.exports = 1;',
      'README.md': '# documented',
      'CHANGELOG.md': '## 1.0.0',
      'readme.markdown': '# lowercase',
    },
  });

  pruneNonRuntimeFiles(root);

  assert.ok(!existsSync(join(pkgDir, 'README.md')));
  assert.ok(!existsSync(join(pkgDir, 'CHANGELOG.md')));
  assert.ok(!existsSync(join(pkgDir, 'readme.markdown')));
});

test('keeps a doc-named module that carries a runtime extension', () => {
  // The doc match keys off doc-shaped names, so it must not fire on
  // `history.js` or `changes.json`. Those are ordinary modules that a package
  // requires internally — never a declared entry point, so nothing else here
  // would protect them — and deleting one is a MODULE_NOT_FOUND in the browser,
  // at runtime, long after the build.
  const pkgDir = installFakePackage(root, 'doc-shaped-runtime', {
    files: {
      'dist/index.js': "module.exports = require('./history.js');",
      'dist/history.js': 'module.exports = [];',
      'dist/changes.json': '[]',
      'lib/authors.cjs': 'module.exports = {};',
    },
  });

  pruneNonRuntimeFiles(root);

  assert.ok(existsSync(join(pkgDir, 'dist/history.js')), 'history.js is a module, not a doc');
  assert.ok(existsSync(join(pkgDir, 'dist/changes.json')));
  assert.ok(existsSync(join(pkgDir, 'lib/authors.cjs')));
});

test('removes docs across every doc extension it recognises', () => {
  const pkgDir = installFakePackage(root, 'many-docs', {
    files: {
      'dist/index.js': 'module.exports = 1;',
      README: '# extensionless',
      'CHANGES.txt': 'changes',
      'HISTORY.rst': 'history',
      'contributing.markdown': 'how to contribute',
    },
  });

  pruneNonRuntimeFiles(root);

  for (const file of ['README', 'CHANGES.txt', 'HISTORY.rst', 'contributing.markdown']) {
    assert.ok(!existsSync(join(pkgDir, file)), `${file} is pruned`);
  }
});

test('keeps bundled runbooks, which are runtime data despite being markdown', () => {
  // @rundown-org/cli ships its bundled runbooks as .runbook.md under
  // dist/runbooks/. A blanket markdown prune would break `rundown ls --all` and
  // every `rundown run <bundled-name>` in the demo, silently and only at runtime.
  const pkgDir = installFakePackage(root, 'cli', {
    files: {
      'dist/cli.js': '#!/usr/bin/env node',
      'dist/runbooks/planning/write-plan.runbook.md': '# Write plan',
      'dist/runbooks/README.md': 'index of bundled runbooks',
    },
  });

  pruneNonRuntimeFiles(root);

  assert.ok(existsSync(join(pkgDir, 'dist/runbooks/planning/write-plan.runbook.md')));
  assert.ok(
    existsSync(join(pkgDir, 'dist/runbooks/README.md')),
    'the runbooks tree is off limits entirely, not filtered by filename',
  );
});

test('keeps licence texts, which the snapshot redistributes under', () => {
  const pkgDir = installFakePackage(root, 'licensed', {
    files: {
      'dist/index.js': 'module.exports = 1;',
      LICENSE: 'MIT',
      'LICENCE.md': 'MIT',
      NOTICE: 'attribution',
    },
  });

  pruneNonRuntimeFiles(root);

  for (const file of ['LICENSE', 'LICENCE.md', 'NOTICE']) {
    assert.ok(existsSync(join(pkgDir, file)), `${file} survives`);
  }
});

test('keeps every file the runtime actually loads', () => {
  const pkgDir = installFakePackage(root, 'runtime', {
    files: {
      'dist/index.js': 'module.exports = 1;',
      'dist/index.cjs': 'module.exports = 1;',
      'dist/index.mjs': 'export default 1;',
      'dist/schema.json': '{}',
      'dist/sql-wasm.wasm': 'binary',
    },
  });

  pruneNonRuntimeFiles(root);

  for (const file of ['index.js', 'index.cjs', 'index.mjs', 'schema.json', 'sql-wasm.wasm']) {
    assert.ok(existsSync(join(pkgDir, 'dist', file)), `${file} survives`);
  }
});

test('prunes nested installs, not just the hoisted ones', () => {
  const nested = installFakePackage(join(root, 'outer', 'node_modules'), 'inner', {
    files: { 'dist/index.js': 'module.exports = 1;', 'dist/index.d.ts': 'declare const a: 1;' },
  });

  pruneNonRuntimeFiles(root);

  assert.ok(!existsSync(join(nested, 'dist/index.d.ts')));
});

test('reports what it reclaimed so a no-op prune is visible in the build log', () => {
  installFakePackage(root, 'measured', {
    files: { 'dist/index.js': 'module.exports = 1;', 'dist/index.d.ts': 'x'.repeat(1000) },
  });

  const result = pruneNonRuntimeFiles(root);

  assert.equal(result.bytesRemoved, 1000);
  assert.equal(result.filesRemoved, 1);
});
