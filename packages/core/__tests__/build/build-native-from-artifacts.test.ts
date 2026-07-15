import { describe, it, expect, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isNodeError } from '../../src/errors.js';

const SCRIPT = fileURLToPath(new URL('../../../../scripts/build-native.mjs', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const CARGO_LOCK = join(REPO_ROOT, 'native', 'rd-landlock', 'Cargo.lock');

const TARGETS = [
  { out: 'linux-x64', triple: 'x86_64-unknown-linux-musl' },
  { out: 'linux-arm64', triple: 'aarch64-unknown-linux-musl' },
] as const;

const COMMIT = 'a'.repeat(40);

interface ManifestEntry {
  triple: string;
  sha256: string;
}
interface Manifest {
  commit: string;
  cargoLockSha256: string;
  binaries: Record<string, ManifestEntry>;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Build a well-formed artifact root: two target binaries + a matching manifest.json. */
function buildArtifactRoot(commit: string): string {
  const root = mkdtempSync(join(tmpdir(), 'rd-artifacts-'));
  const cargoLockSha256 = sha256(readFileSync(CARGO_LOCK));
  const manifest: Manifest = { commit, cargoLockSha256, binaries: {} };
  for (const t of TARGETS) {
    const dir = join(root, t.out);
    mkdirSync(dir, { recursive: true });
    const bin = join(dir, 'rd-landlock');
    const bytes = Buffer.from(`fake-rd-landlock-binary-${t.out}`);
    writeFileSync(bin, bytes);
    manifest.binaries[t.out] = { triple: t.triple, sha256: sha256(bytes) };
  }
  writeManifest(root, manifest);
  return root;
}

function readManifest(root: string): Manifest {
  return JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as Manifest;
}

function writeManifest(root: string, manifest: Manifest): void {
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

// Scratch destinations handed to build-native.mjs via RD_NATIVE_DEST, cleaned
// up after each test. The script's default destination is the REAL
// packages/core/dist/native; the release job builds those binaries BEFORE it
// runs this suite, so a test writing to (or, worse, deleting) the default path
// would destroy the artifact the later upload step packages. Redirecting every
// run to a temp dir keeps this suite from touching the real build output.
const scratchDestinations: string[] = [];

function runFromArtifacts(
  root: string,
  commit: string,
): { result: ReturnType<typeof spawnSync>; dest: string } {
  const dest = mkdtempSync(join(tmpdir(), 'rd-native-dest-'));
  scratchDestinations.push(dest);
  const result = spawnSync(process.execPath, [SCRIPT, '--from-artifacts', root], {
    env: { ...process.env, RD_RELEASE_COMMIT: commit, RD_NATIVE_DEST: dest },
    encoding: 'utf8',
  });
  return { result, dest };
}

describe('build-native.mjs --from-artifacts', () => {
  afterEach(() => {
    while (scratchDestinations.length > 0) {
      const dest = scratchDestinations.pop();
      if (dest) rmSync(dest, { recursive: true, force: true });
    }
  });

  it('exits 0 and copies both targets for a well-formed artifact set', () => {
    const root = buildArtifactRoot(COMMIT);
    const { result, dest } = runFromArtifacts(root, COMMIT);
    expect(result.status).toBe(0);
    for (const t of TARGETS) {
      expect(existsSync(join(dest, t.out, 'rd-landlock'))).toBe(true);
    }
  });

  it('rejects when the provenance manifest is missing', () => {
    const root = buildArtifactRoot(COMMIT);
    rmSync(join(root, 'manifest.json'));
    const { result } = runFromArtifacts(root, COMMIT);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('provenance manifest missing');
  });

  it('rejects when RD_RELEASE_COMMIT does not match manifest.commit', () => {
    const root = buildArtifactRoot(COMMIT);
    const otherCommit = 'b'.repeat(40);
    const { result } = runFromArtifacts(root, otherCommit);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`manifest commit ${COMMIT} != release commit ${otherCommit}`);
  });

  it('rejects when manifest cargoLockSha256 does not match the checkout Cargo.lock', () => {
    const root = buildArtifactRoot(COMMIT);
    const manifest = readManifest(root);
    manifest.cargoLockSha256 = 'f'.repeat(64);
    writeManifest(root, manifest);
    const { result } = runFromArtifacts(root, COMMIT);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('manifest cargoLockSha256 ffff');
    expect(result.stderr).toContain('!= checkout Cargo.lock');
  });

  it('rejects when a target sha256 is flipped in the manifest', () => {
    const root = buildArtifactRoot(COMMIT);
    const manifest = readManifest(root);
    manifest.binaries['linux-x64'].sha256 = 'f'.repeat(64);
    writeManifest(root, manifest);
    const { result } = runFromArtifacts(root, COMMIT);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('linux-x64: sha256');
    expect(result.stderr).toContain('!= manifest ffff');
  });

  it('rejects when a target triple is changed in the manifest', () => {
    const root = buildArtifactRoot(COMMIT);
    const manifest = readManifest(root);
    manifest.binaries['linux-x64'].triple = 'x86_64-unknown-linux-gnu';
    writeManifest(root, manifest);
    const { result } = runFromArtifacts(root, COMMIT);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'linux-x64: triple x86_64-unknown-linux-gnu != x86_64-unknown-linux-musl',
    );
  });

  it('rejects when a target binary is missing from the artifact root', () => {
    const root = buildArtifactRoot(COMMIT);
    rmSync(join(root, 'linux-x64', 'rd-landlock'));
    const { result } = runFromArtifacts(root, COMMIT);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`artifact missing: ${join(root, 'linux-x64', 'rd-landlock')}`);
  });

  it('rejects when a target has no manifest entry', () => {
    const root = buildArtifactRoot(COMMIT);
    const manifest = readManifest(root);
    delete manifest.binaries['linux-x64'];
    writeManifest(root, manifest);
    const { result } = runFromArtifacts(root, COMMIT);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('manifest has no entry for linux-x64');
  });

  // Release-safety regression: with RD_NATIVE_DEST set, a successful verify+copy
  // must leave the real packages/core/dist/native untouched. The release job
  // builds those binaries BEFORE running the test suite, so a test that wrote to
  // or deleted the default path destroyed the artifact the upload step needed,
  // failing every release run (the `rd-landlock-binaries` artifact went missing).
  it('leaves the real packages/core/dist/native untouched', () => {
    const REAL_DIST_NATIVE = join(REPO_ROOT, 'packages', 'core', 'dist', 'native');
    // Snapshot each entry's path AND file content hash so an in-place overwrite
    // of manifest.json or a binary (same filename, different bytes) is detected,
    // not just additions/deletions. Returns null when the directory is absent
    // (the common dev/CI state), so before === after === null still passes.
    //
    // Every filesystem access is attempt-then-handle (no exists/stat "check"
    // before the read) so there is no check-then-use TOCTOU window: a missing
    // directory or a directory entry both surface as caught errno codes.
    const snapshot = (): string | null => {
      let names: string[];
      try {
        names = readdirSync(REAL_DIST_NATIVE, { recursive: true }).map(String).sort();
      } catch (err) {
        if (isNodeError(err) && err.code === 'ENOENT') return null;
        throw err;
      }
      const entries = names.map((rel) => {
        const abs = join(REAL_DIST_NATIVE, rel);
        try {
          return [rel, sha256(readFileSync(abs))];
        } catch (err) {
          if (isNodeError(err) && err.code === 'EISDIR') return [rel, 'dir'];
          throw err;
        }
      });
      return JSON.stringify(entries);
    };

    const before = snapshot();
    const root = buildArtifactRoot(COMMIT);
    const { result } = runFromArtifacts(root, COMMIT);
    expect(result.status).toBe(0);
    expect(snapshot()).toEqual(before);
  });
});
