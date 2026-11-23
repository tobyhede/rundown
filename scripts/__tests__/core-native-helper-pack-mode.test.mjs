import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

// `pnpm pack` writes every file as 0644 unless it is a `bin` entry or is named
// in `publishConfig.executableFiles`. The rd-landlock sandbox helper is neither
// a bin nor a script, so without that list an installed @rundown-org/core holds
// a helper nothing can execute, and every sandboxed step command is refused
// with "Sandbox unavailable".

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const coreManifestPath = join(repoRoot, 'packages/core/package.json');
const buildNativePath = join(repoRoot, 'scripts/build-native.mjs');

/**
 * Read the output directory of every native target from scripts/build-native.mjs.
 *
 * @returns the directory names under dist/native, such as `linux-x64`
 */
async function nativeTargetDirs() {
  const source = await readFile(buildNativePath, 'utf-8');
  return [...source.matchAll(/\bout:\s*'([^']+)'/g)].map((match) => match[1]);
}

/**
 * List the regular files in a gzipped tarball with their permission bits.
 *
 * @param tarball - path of the .tgz file
 * @returns a map from entry path to mode
 */
async function tarballModes(tarball) {
  const data = gunzipSync(await readFile(tarball));
  const modes = new Map();
  let offset = 0;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) =>
      header
        .subarray(start, start + length)
        .toString('utf-8')
        .replace(/\0.*$/s, '');
    const prefix = field(345, 155);
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const size = Number.parseInt(field(124, 12).trim(), 8);
    const type = field(156, 1);
    if (type === '0' || type === '') modes.set(name, Number.parseInt(field(100, 8).trim(), 8));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return modes;
}

/**
 * Pack a stand-in for @rundown-org/core: the real manifest's packing fields
 * and a stub helper for each native target, executable on disk as
 * scripts/build-native.mjs leaves the real ones.
 *
 * @param t - the test context, used to remove the scratch directory
 * @returns the mode of every file in the tarball `pnpm pack` wrote
 */
async function packStandIn(t) {
  const manifest = JSON.parse(await readFile(coreManifestPath, 'utf-8'));
  const scratch = await mkdtemp(join(tmpdir(), 'core-pack-mode-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const packageDir = join(scratch, 'package');
  const outDir = join(scratch, 'out');
  await mkdir(outDir, { recursive: true });

  for (const dir of await nativeTargetDirs()) {
    const helperDir = join(packageDir, 'dist/native', dir);
    await mkdir(helperDir, { recursive: true });
    await writeFile(join(helperDir, 'rd-landlock'), 'stub\n');
    await chmod(join(helperDir, 'rd-landlock'), 0o755);
  }
  await writeFile(join(packageDir, 'dist/index.js'), 'export {};\n');
  await writeFile(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      files: manifest.files,
      publishConfig: manifest.publishConfig,
    }),
  );

  const packed = spawnSync('pnpm', ['pack', '--pack-destination', outDir], {
    cwd: packageDir,
    encoding: 'utf-8',
  });
  assert.equal(packed.status, 0, `pnpm pack failed:\n${packed.stdout}\n${packed.stderr}`);
  const tarballs = (await readdir(outDir)).filter((name) => name.endsWith('.tgz'));
  assert.equal(tarballs.length, 1, `expected one tarball, found: ${tarballs.join(', ')}`);
  return tarballModes(join(outDir, tarballs[0]));
}

test('scripts/build-native.mjs names at least one native target', async () => {
  const dirs = await nativeTargetDirs();
  assert.ok(dirs.length > 0, 'no `out:` entries found in scripts/build-native.mjs');
});

test('the packed core package keeps every rd-landlock helper executable', async (t) => {
  const modes = await packStandIn(t);
  for (const dir of await nativeTargetDirs()) {
    const entry = `package/dist/native/${dir}/rd-landlock`;
    const mode = modes.get(entry);
    assert.notEqual(mode, undefined, `${entry} is not in the tarball`);
    assert.equal(
      mode & 0o111,
      0o111,
      `${entry} is packed with mode ${mode.toString(8)}; it must be executable`,
    );
  }
});

test('the packed core package does not mark ordinary files executable', async (t) => {
  const modes = await packStandIn(t);
  const mode = modes.get('package/dist/index.js');
  assert.notEqual(mode, undefined, 'package/dist/index.js is not in the tarball');
  assert.equal(mode & 0o111, 0, `dist/index.js is packed with mode ${mode.toString(8)}`);
});
