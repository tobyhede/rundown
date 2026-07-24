#!/usr/bin/env node
/**
 * Preflight: assert the host toolchain running this build is the one the repo
 * declares.
 *
 * This guard exists because a toolchain mismatch is invisible to every other
 * gate. When the running pnpm predates the settings layout in
 * `pnpm-workspace.yaml`, `nodeOptions` is silently ignored, `NODE_OPTIONS` is
 * never set, and every Jest ESM suite in the monorepo dies at its first
 * `import` with "Cannot use import statement outside a module". The failure
 * arrives as thousands of unparseable test files rather than a failed
 * assertion — so the very tests that pin this configuration
 * (`scripts/__tests__/pnpm-workspace-config.test.mjs`) cannot run either. The
 * check has to happen before the suite, not inside it.
 *
 * Three declarations, three environment facts, checked pairwise:
 *
 * | Declared in                        | Observed in             |
 * | ---------------------------------- | ----------------------- |
 * | `package.json` `packageManager`    | `npm_config_user_agent` |
 * | `package.json` `engines.node`      | `process.version`       |
 * | `pnpm-workspace.yaml` `nodeOptions`| `NODE_OPTIONS`          |
 *
 * The pnpm and node checks compare MAJOR versions only. A major boundary is
 * where pnpm relocates its settings, changes lockfile handling, and flips
 * dependency-build defaults; minor and patch drift cannot. The `nodeOptions`
 * check is the direct observable — it catches a correct pnpm that nonetheless
 * failed to apply the setting.
 *
 * Every failure is collected before exiting, so one run reports the whole
 * mismatch rather than one layer at a time.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Read a repository-relative file as UTF-8 text, exiting with a clear message
 * when it cannot be read.
 *
 * @param relPath - repository-relative path
 * @returns the file contents
 */
function readRepoFile(relPath) {
  const abs = resolve(repoRoot, relPath);
  try {
    return readFileSync(abs, 'utf8');
  } catch (err) {
    console.error(`error: failed to read ${abs}: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Extract the leading major version number from a semver-ish string.
 *
 * @param version - a version string such as `11.7.0` or `24.18.0`
 * @returns the major version as a number, or null when unparseable
 */
function majorOf(version) {
  const match = /^(\d+)\./.exec(version);
  return match ? Number(match[1]) : null;
}

/**
 * Read the top-level `nodeOptions:` value from pnpm-workspace.yaml.
 *
 * A deliberately minimal parse, matching the house style of
 * `scripts/__tests__/pnpm-workspace-config.test.mjs`: the strict pnpm layout
 * gives this script no YAML dependency to import, and one top-level scalar does
 * not justify one.
 *
 * @param yaml - the full pnpm-workspace.yaml text
 * @returns the declared value, or null when the key is absent
 */
function readDeclaredNodeOptions(yaml) {
  const match = /^nodeOptions:[ \t]*(.*)$/m.exec(yaml);
  if (!match) return null;
  // Strip a trailing comment, then surrounding quotes.
  const value = match[1]
    .replace(/\s+#.*$/, '')
    .trim()
    .replace(/^["'](.*)["']$/, '$1');
  return value === '' ? null : value;
}

/**
 * Parse the pnpm version out of an npm-style user agent string.
 *
 * pnpm sets `npm_config_user_agent` for every script it runs, in the form
 * `pnpm/11.7.0 npm/? node/v24.18.0 darwin arm64`. This reflects the pnpm that
 * actually invoked this script, which is the fact under test — unlike shelling
 * out to `pnpm --version`, which would re-resolve it from PATH.
 *
 * @param userAgent - the raw `npm_config_user_agent` value
 * @returns the pnpm version string, or null when absent
 */
function readRunningPnpmVersion(userAgent) {
  const match = /(?:^|\s)pnpm\/(\S+)/.exec(userAgent ?? '');
  return match ? match[1] : null;
}

/**
 * Parse a `packageManager` field into its name and version.
 *
 * Corepack permits an optional `+sha…` integrity suffix, which is stripped.
 *
 * @param field - the raw `packageManager` value, e.g. `pnpm@11.7.0`
 * @returns `{ name, version }`, or null when the field is malformed
 */
function parsePackageManager(field) {
  const match = /^([^@\s]+)@([^+\s]+)/.exec(field ?? '');
  return match ? { name: match[1], version: match[2] } : null;
}

/**
 * Run every toolchain check and collect the failures.
 *
 * Every input is a parameter rather than a direct `process` or filesystem read,
 * so tests can drive each dimension: the node version without spawning a
 * different node, the declarations without corrupting the repo's own files.
 *
 * @param env - the environment to inspect
 * @param nodeVersion - the running node version, e.g. `v24.18.0`
 * @param pkg - the parsed `package.json`
 * @param workspaceYaml - the raw `pnpm-workspace.yaml` text
 * @returns an array of human-readable failure messages, empty when all pass
 */
export function checkToolchain(env, nodeVersion, pkg, workspaceYaml) {
  const failures = [];

  // --- pnpm: packageManager vs the pnpm actually running this script ---------
  const declared = parsePackageManager(pkg.packageManager);
  const runningVersion = readRunningPnpmVersion(env.npm_config_user_agent);

  if (!declared) {
    failures.push(
      `package.json has no parseable "packageManager" field (found: ${JSON.stringify(pkg.packageManager)}).`,
    );
  } else if (runningVersion === null) {
    failures.push(
      'no pnpm found in npm_config_user_agent — this preflight must run through pnpm ' +
        '(`pnpm run check:toolchain`), not bare `node scripts/check-toolchain.mjs`.',
    );
  } else if (declared.name !== 'pnpm') {
    failures.push(
      `package.json declares packageManager "${declared.name}", but this repo is built with pnpm.`,
    );
  } else {
    const declaredMajor = majorOf(declared.version);
    const runningMajor = majorOf(runningVersion);
    if (declaredMajor === null || runningMajor === null) {
      failures.push(
        `could not compare pnpm versions (declared "${declared.version}", running "${runningVersion}").`,
      );
    } else if (declaredMajor !== runningMajor) {
      failures.push(
        `pnpm major mismatch: package.json declares pnpm@${declared.version} but pnpm ${runningVersion} is running.\n` +
          '  pnpm majors relocate settings, change lockfile handling, and flip dependency-build\n' +
          '  defaults, so this build would not be the one the repo describes.\n' +
          '  Fix: enable corepack so pnpm follows the packageManager field —\n' +
          '    corepack enable --install-directory ~/.local/bin\n' +
          '  and make sure no version manager (mise, asdf, nvm, volta) puts its own pnpm\n' +
          `  earlier on PATH. Check with: which -a pnpm`,
      );
    }
  }

  // --- node: engines.node vs the running interpreter -------------------------
  // Only the simple `>=<major>` form is enforced; a more elaborate range is left
  // to pnpm's own engine checking rather than reimplemented here. An absent
  // field is a different case: it is not a range this script declines to parse,
  // it is no lower bound at all, so it fails rather than passing silently.
  const enginesNode = pkg.engines?.node;
  const minMajorMatch = /^>=\s*(\d+)/.exec(enginesNode ?? '');
  if (minMajorMatch) {
    const required = Number(minMajorMatch[1]);
    const running = majorOf(nodeVersion.replace(/^v/, ''));
    if (running !== null && running < required) {
      failures.push(
        `node too old: package.json requires node ${enginesNode} but ${nodeVersion} is running.`,
      );
    }
  } else if (!enginesNode) {
    failures.push(
      'package.json declares no "engines.node" — there is no node lower bound to check the running interpreter against.',
    );
  }

  // --- nodeOptions: declared in pnpm-workspace.yaml vs applied to the env ----
  // The direct observable. A correct pnpm that failed to apply the setting fails
  // here even though the version check passed.
  const declaredNodeOptions = readDeclaredNodeOptions(workspaceYaml);
  if (declaredNodeOptions === null) {
    failures.push(
      'pnpm-workspace.yaml declares no top-level "nodeOptions:" — Jest ESM support depends on it.',
    );
  } else {
    const applied = env.NODE_OPTIONS ?? '';
    const missing = declaredNodeOptions
      .split(/\s+/)
      .filter((flag) => !applied.split(/\s+/).includes(flag));
    if (missing.length > 0) {
      failures.push(
        `pnpm-workspace.yaml declares nodeOptions "${declaredNodeOptions}" but NODE_OPTIONS is "${applied}" ` +
          `(missing: ${missing.join(' ')}).\n` +
          '  Without these flags every Jest ESM suite fails to parse. The usual cause is a pnpm\n' +
          '  older than the settings layout in pnpm-workspace.yaml silently ignoring the key.',
      );
    }
  }

  return failures;
}

// Only run when invoked as a script; importing this module (from its tests)
// must not execute the checks or call process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const failures = checkToolchain(
    process.env,
    process.version,
    JSON.parse(readRepoFile('package.json')),
    readRepoFile('pnpm-workspace.yaml'),
  );

  if (failures.length > 0) {
    console.error("error: toolchain does not match this repository's declarations.\n");
    for (const failure of failures) {
      console.error(`  - ${failure}\n`);
    }
    console.error('See CONTRIBUTING.md § Prerequisites.');
    process.exit(1);
  }

  const running = readRunningPnpmVersion(process.env.npm_config_user_agent);
  console.log(`toolchain ok: pnpm ${running}, node ${process.version}, NODE_OPTIONS applied`);
}
