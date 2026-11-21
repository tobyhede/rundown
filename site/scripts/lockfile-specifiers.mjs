/**
 * Check that a workspace package's manifest agrees with its importer entry in
 * `pnpm-lock.yaml` before the snapshot build deploys it.
 *
 * `pnpm deploy --frozen-lockfile` (pnpm 11.7.0) does not compare the deployed
 * package's dependency specifiers with its importer in the lockfile: a manifest
 * bumped to `commander@^16` against a lockfile still pinning `^15` deploys
 * 15.x and exits 0. `pnpm install --frozen-lockfile` catches it in CI, but a
 * local build with dist/ already present skips that install.
 *
 * Inputs are already-parsed objects (the manifest JSON and the lockfile YAML),
 * so this module stays pure and does no I/O.
 *
 * @module site/scripts/lockfile-specifiers
 */

/**
 * Dependency fields `pnpm deploy --prod` installs, in the order they are
 * reported.
 */
export const PROD_DEPENDENCY_FIELDS = Object.freeze(['dependencies', 'optionalDependencies']);

/**
 * One disagreement between the manifest and the lockfile importer.
 *
 * @typedef {object} SpecifierMismatch
 * @property {string} field - Dependency field, one of {@link PROD_DEPENDENCY_FIELDS}.
 * @property {string} name - Dependency name.
 * @property {string | undefined} manifestSpecifier - Range in package.json; `undefined` when absent there.
 * @property {string | undefined} lockfileSpecifier - `specifier` recorded in the importer; `undefined` when absent there.
 */

/**
 * List every production dependency whose specifier differs between the
 * manifest and the lockfile importer, including a dependency present on one
 * side only.
 *
 * @param {object} options
 * @param {Record<string, unknown>} options.manifest - Parsed package.json of the deployed package.
 * @param {Record<string, unknown>} options.lockfile - Parsed pnpm-lock.yaml.
 * @param {string} options.importer - Importer key in the lockfile, e.g. `packages/cli`.
 * @returns {SpecifierMismatch[]} Mismatches; empty when the two agree.
 */
export function findSpecifierMismatches({ manifest, lockfile, importer }) {
  const entry = importerEntry(lockfile, importer);
  /** @type {SpecifierMismatch[]} */
  const mismatches = [];
  for (const field of PROD_DEPENDENCY_FIELDS) {
    const manifestDeps = asRecord(manifest?.[field]);
    const lockfileDeps = asRecord(entry?.[field]);
    const names = [...new Set([...Object.keys(manifestDeps), ...Object.keys(lockfileDeps)])].sort();
    for (const name of names) {
      const manifestSpecifier = specifierOf(manifestDeps[name]);
      const lockfileSpecifier = specifierOf(asRecord(lockfileDeps[name]).specifier);
      if (manifestSpecifier !== lockfileSpecifier) {
        mismatches.push({ field, name, manifestSpecifier, lockfileSpecifier });
      }
    }
  }
  return mismatches;
}

/**
 * Narrow an unknown value to a plain object, or an empty one.
 *
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function specifierOf(value) {
  return typeof value === 'string' ? value : undefined;
}

/**
 * The importer's entry in the lockfile, or `undefined` when absent.
 *
 * @param {Record<string, unknown>} lockfile
 * @param {string} importer
 * @returns {Record<string, unknown> | undefined}
 */
function importerEntry(lockfile, importer) {
  const importers = asRecord(lockfile?.importers);
  return Object.hasOwn(importers, importer) ? asRecord(importers[importer]) : undefined;
}

/**
 * Refuse to deploy when the manifest and the lockfile importer disagree.
 *
 * @param {object} options - Same as {@link findSpecifierMismatches}.
 * @param {Record<string, unknown>} options.manifest - Parsed package.json of the deployed package.
 * @param {Record<string, unknown>} options.lockfile - Parsed pnpm-lock.yaml.
 * @param {string} options.importer - Importer key in the lockfile, e.g. `packages/cli`.
 * @returns {void}
 * @throws {Error} When any production dependency specifier differs, or the
 *   importer is missing from the lockfile; the message names each mismatch.
 */
export function assertLockfileMatchesManifest(options) {
  const { lockfile, importer } = options;
  if (importerEntry(lockfile, importer) === undefined) {
    throw new Error(
      `pnpm-lock.yaml has no importer for ${importer}. Run \`pnpm install\` to update the lockfile.`,
    );
  }
  const mismatches = findSpecifierMismatches(options);
  if (mismatches.length === 0) return;
  const show = (/** @type {string | undefined} */ s) => (s === undefined ? '(absent)' : s);
  const lines = mismatches.map(
    (m) =>
      `  ${m.field}.${m.name}: package.json ${show(m.manifestSpecifier)}, pnpm-lock.yaml ${show(m.lockfileSpecifier)}`,
  );
  throw new Error(
    [
      `${importer}/package.json does not match its importer in pnpm-lock.yaml:`,
      ...lines,
      'pnpm deploy --frozen-lockfile would ship the locked versions. Run `pnpm install` to update the lockfile.',
    ].join('\n'),
  );
}
