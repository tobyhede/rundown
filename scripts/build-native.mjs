#!/usr/bin/env node
// Build (default) or verify+copy (--from-artifacts <dir>) the rd-landlock
// binaries into packages/core/dist/native/linux-<arch>/rd-landlock.
//
// Default: cross-compile both musl targets with cargo-zigbuild (a REAL musl
// cross-linker — the glibc aarch64-linux-gnu-gcc is the wrong linker for a
// static musl target) using --locked, then write a provenance manifest.json.
//
// --from-artifacts <dir>: verify each binary's SHA-256 + triple against
// <dir>/manifest.json (and, when RD_RELEASE_COMMIT is set, the manifest commit)
// BEFORE copying — filenames alone are not trusted.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const crateDir = join(repoRoot, 'native', 'rd-landlock');
const distNative = join(repoRoot, 'packages', 'core', 'dist', 'native');

const TARGETS = [
  { rust: 'x86_64-unknown-linux-musl', out: 'linux-x64' },
  { rust: 'aarch64-unknown-linux-musl', out: 'linux-arm64' },
];

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function copyInto(srcBinary, outDir) {
  const dir = join(distNative, outDir);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, 'rd-landlock');
  cpSync(srcBinary, dest);
  chmodSync(dest, 0o755);
  console.log(`build-native: placed ${dest}`);
}

function fail(msg) {
  console.error(`build-native: ${msg}`);
  process.exit(1);
}

const fromIdx = process.argv.indexOf('--from-artifacts');
if (fromIdx !== -1) {
  const artifactRoot = process.argv[fromIdx + 1];
  const manifestPath = join(artifactRoot, 'manifest.json');
  if (!existsSync(manifestPath)) fail(`provenance manifest missing: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  const expectedCommit = process.env.RD_RELEASE_COMMIT;
  if (expectedCommit && manifest.commit !== expectedCommit) {
    fail(`manifest commit ${manifest.commit} != release commit ${expectedCommit}`);
  }
  for (const t of TARGETS) {
    const src = join(artifactRoot, t.out, 'rd-landlock');
    const entry = manifest.binaries?.[t.out];
    if (!existsSync(src)) fail(`artifact missing: ${src}`);
    if (!entry) fail(`manifest has no entry for ${t.out}`);
    if (entry.triple !== t.rust) fail(`${t.out}: triple ${entry.triple} != ${t.rust}`);
    const actual = sha256(src);
    if (actual !== entry.sha256) {
      fail(`${t.out}: sha256 ${actual} != manifest ${entry.sha256}`);
    }
    copyInto(src, t.out);
  }
  console.log('build-native: artifacts verified against manifest and copied.');
  process.exit(0);
}

// Default: build with cargo-zigbuild + write a provenance manifest.
const commit =
  process.env.GITHUB_SHA ??
  (spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout || '').trim();
const cargoLockSha256 = sha256(join(crateDir, 'Cargo.lock'));
const manifest = { commit, cargoLockSha256, binaries: {} };

for (const t of TARGETS) {
  const res = spawnSync(
    'cargo',
    ['zigbuild', '--locked', '--release', '--target', t.rust],
    { cwd: crateDir, stdio: 'inherit' },
  );
  if (res.status !== 0) fail(`cargo zigbuild failed for ${t.rust}`);
  const built = join(crateDir, 'target', t.rust, 'release', 'rd-landlock');
  copyInto(built, t.out);
  manifest.binaries[t.out] = {
    triple: t.rust,
    sha256: sha256(join(distNative, t.out, 'rd-landlock')),
  };
}
mkdirSync(distNative, { recursive: true });
writeFileSync(join(distNative, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`build-native: wrote ${join(distNative, 'manifest.json')} (commit ${commit}).`);
