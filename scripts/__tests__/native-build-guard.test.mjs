import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const library = join(repoRoot, 'scripts/lib/native-build.sh');

// What `cargo zigbuild --version` prints with cargo-zigbuild 0.19.8 (the
// version CI pins) and 0.23.0: the `zigbuild` subcommand has no `--version`.
const CARGO_WITH_ZIGBUILD = `#!/bin/bash
if [ "$1" = zigbuild ] && [ "$2" = --version ]; then
  echo "error: unexpected argument '--version' found" >&2
  exit 2
fi
exit 0
`;

// What cargo does when the `zigbuild` subcommand is not installed.
const CARGO_WITHOUT_ZIGBUILD = `#!/bin/bash
if [ "$1" = zigbuild ]; then
  echo "error: no such command: \`zigbuild\`" >&2
  exit 101
fi
exit 0
`;

/**
 * Call `build_native_binaries` from scripts/lib/native-build.sh with a PATH
 * that holds only the given stubs, plus a `pnpm` stub that records its
 * arguments in place of running the native build.
 *
 * @param cargoStub - source of the `cargo` stub, or undefined for no cargo
 * @returns the exit status, the combined output, and the recorded pnpm
 *   arguments (undefined when pnpm was not called)
 */
async function runGuard(cargoStub) {
  const work = await mkdtemp(join(tmpdir(), 'native-build-guard-'));
  try {
    const binDir = join(work, 'bin');
    const pnpmCalls = join(work, 'pnpm-calls');
    await mkdir(binDir);
    await writeFile(join(binDir, 'pnpm'), `#!/bin/bash\necho "$*" >> "${pnpmCalls}"\n`);
    await chmod(join(binDir, 'pnpm'), 0o755);
    if (cargoStub !== undefined) {
      await writeFile(join(binDir, 'cargo'), cargoStub);
      await chmod(join(binDir, 'cargo'), 0o755);
    }

    const result = spawnSync(
      '/bin/bash',
      [
        '-c',
        'log() { echo "$*"; }; . "$1"; build_native_binaries "the fallback hint"',
        '_',
        library,
      ],
      { env: { PATH: binDir }, encoding: 'utf-8' },
    );
    const pnpmArgs = await readFile(pnpmCalls, 'utf-8').catch(() => undefined);
    return { status: result.status, output: `${result.stdout}${result.stderr}`, pnpmArgs };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

test('the guard accepts a cargo-zigbuild whose zigbuild subcommand has no --version', async () => {
  const { status, output, pnpmArgs } = await runGuard(CARGO_WITH_ZIGBUILD);

  assert.equal(status, 0, output);
  assert.equal(pnpmArgs, '--filter @rundown-org/core run build:native\n');
});

test('the guard refuses when cargo has no zigbuild subcommand', async () => {
  const { status, output, pnpmArgs } = await runGuard(CARGO_WITHOUT_ZIGBUILD);

  assert.equal(status, 1);
  assert.match(output, /requires the Rust toolchain/);
  assert.match(output, /the fallback hint/);
  assert.equal(pnpmArgs, undefined);
});

test('the guard refuses when cargo is not on PATH', async () => {
  const { status, output, pnpmArgs } = await runGuard(undefined);

  assert.equal(status, 1);
  assert.match(output, /requires the Rust toolchain/);
  assert.equal(pnpmArgs, undefined);
});
