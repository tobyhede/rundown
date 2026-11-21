import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PROD_DEPENDENCY_FIELDS,
  assertLockfileMatchesManifest,
  findSpecifierMismatches,
} from '../../site/scripts/lockfile-specifiers.mjs';

// `pnpm deploy --frozen-lockfile` (pnpm 11.7.0) does not compare the deployed
// package's specifiers with its lockfile importer: bump commander to ^16 in
// packages/cli/package.json without touching pnpm-lock.yaml and the snapshot
// build exits 0 shipping commander 15. The snapshot build must refuse instead.
// See https://github.com/tobyhede/rundown/pull/941#discussion_r4638687497.

const IMPORTER = 'packages/cli';

/** A CLI manifest shaped like packages/cli/package.json. */
function cliManifest(overrides = {}) {
  return {
    name: '@rundown-org/cli',
    dependencies: {
      '@rundown-org/core': '*',
      '@rundown-org/parser': '*',
      commander: '^15.0.0',
      zod: '^4.4.3',
    },
    devDependencies: { jest: '^30.4.2' },
    ...overrides,
  };
}

/** A parsed pnpm-lock.yaml whose packages/cli importer matches {@link cliManifest}. */
function lockfile(importerOverrides = {}) {
  return {
    lockfileVersion: '9.0',
    importers: {
      [IMPORTER]: {
        dependencies: {
          '@rundown-org/core': { specifier: '*', version: 'link:../core' },
          '@rundown-org/parser': { specifier: '*', version: 'link:../parser' },
          commander: { specifier: '^15.0.0', version: '15.0.0' },
          zod: { specifier: '^4.4.3', version: '4.4.3' },
        },
        devDependencies: { jest: { specifier: '^30.4.2', version: '30.4.2' } },
        ...importerOverrides,
      },
    },
  };
}

test('deploy --prod installs dependencies and optionalDependencies', () => {
  assert.deepEqual([...PROD_DEPENDENCY_FIELDS], ['dependencies', 'optionalDependencies']);
});

test('a manifest matching its importer has no mismatches and deploys', () => {
  const options = { manifest: cliManifest(), lockfile: lockfile(), importer: IMPORTER };
  assert.deepEqual(findSpecifierMismatches(options), []);
  assert.doesNotThrow(() => assertLockfileMatchesManifest(options));
});

test('reports a specifier bumped in the manifest but not the lockfile', () => {
  // The exact failure scenario: commander ^15.0.0 -> ^16.0.0, lockfile stale.
  const manifest = cliManifest();
  manifest.dependencies = { ...manifest.dependencies, commander: '^16.0.0' };
  assert.deepEqual(
    findSpecifierMismatches({ manifest, lockfile: lockfile(), importer: IMPORTER }),
    [
      {
        field: 'dependencies',
        name: 'commander',
        manifestSpecifier: '^16.0.0',
        lockfileSpecifier: '^15.0.0',
      },
    ],
  );
});

test('refuses to deploy a bumped specifier, naming the dependency and both ranges', () => {
  const manifest = cliManifest();
  manifest.dependencies = { ...manifest.dependencies, commander: '^16.0.0' };
  assert.throws(
    () => assertLockfileMatchesManifest({ manifest, lockfile: lockfile(), importer: IMPORTER }),
    (error) => {
      assert.match(error.message, /commander/);
      assert.match(error.message, /\^16\.0\.0/);
      assert.match(error.message, /\^15\.0\.0/);
      assert.match(error.message, /packages\/cli/);
      return true;
    },
  );
});

test('reports a dependency added to the manifest but absent from the lockfile', () => {
  const manifest = cliManifest();
  manifest.dependencies = { ...manifest.dependencies, 'left-pad': '^1.3.0' };
  assert.deepEqual(
    findSpecifierMismatches({ manifest, lockfile: lockfile(), importer: IMPORTER }),
    [
      {
        field: 'dependencies',
        name: 'left-pad',
        manifestSpecifier: '^1.3.0',
        lockfileSpecifier: undefined,
      },
    ],
  );
});

test('reports a dependency removed from the manifest but still in the lockfile', () => {
  const manifest = cliManifest();
  const { zod: _removed, ...rest } = manifest.dependencies;
  manifest.dependencies = rest;
  assert.deepEqual(
    findSpecifierMismatches({ manifest, lockfile: lockfile(), importer: IMPORTER }),
    [
      {
        field: 'dependencies',
        name: 'zod',
        manifestSpecifier: undefined,
        lockfileSpecifier: '^4.4.3',
      },
    ],
  );
});

test('checks optionalDependencies, which deploy --prod also installs', () => {
  const manifest = cliManifest({ optionalDependencies: { fsevents: '^2.3.3' } });
  const lock = lockfile({
    optionalDependencies: { fsevents: { specifier: '^2.3.2', version: '2.3.3' } },
  });
  assert.deepEqual(findSpecifierMismatches({ manifest, lockfile: lock, importer: IMPORTER }), [
    {
      field: 'optionalDependencies',
      name: 'fsevents',
      manifestSpecifier: '^2.3.3',
      lockfileSpecifier: '^2.3.2',
    },
  ]);
});

test('ignores devDependencies, which deploy --prod does not install', () => {
  const manifest = cliManifest({ devDependencies: { jest: '^31.0.0' } });
  assert.deepEqual(
    findSpecifierMismatches({ manifest, lockfile: lockfile(), importer: IMPORTER }),
    [],
  );
});

test('refuses when the importer is missing from the lockfile', () => {
  assert.throws(
    () =>
      assertLockfileMatchesManifest({
        manifest: cliManifest(),
        lockfile: { lockfileVersion: '9.0', importers: {} },
        importer: IMPORTER,
      }),
    /packages\/cli/,
  );
});
