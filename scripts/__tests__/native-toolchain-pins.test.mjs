import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findNativeToolchainPinDrift } from '../lib/native-toolchain-pins.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Build the text of a mise.toml that pins the given tools.
 *
 * @param pins - the versions to pin; leave a tool out to omit its pin
 * @returns the mise.toml text
 */
function miseToml({ zig, cargoZigbuild }) {
  const lines = ['# Native build tools.', '', '[tools]'];
  if (zig !== undefined) lines.push(`zig = "${zig}"`);
  if (cargoZigbuild !== undefined) lines.push(`"cargo:cargo-zigbuild" = "${cargoZigbuild}"`);
  return `${lines.join('\n')}\n`;
}

/**
 * Build the text of a composite action that installs the given tools.
 *
 * @param pins - the versions to install; leave a tool out to omit its install
 * @returns the action.yml text
 */
function actionYml({ zig, cargoZigbuild }) {
  const lines = [
    'runs:',
    '  using: composite',
    '  steps:',
    '    - name: Install Zig + cargo-zigbuild',
    '      shell: bash',
    '      run: |',
    '        set -euo pipefail',
  ];
  if (zig !== undefined) {
    lines.push(`        pipx install ziglang==${zig} || pip install --user ziglang==${zig}`);
  }
  if (cargoZigbuild !== undefined) {
    lines.push(`        cargo install --locked cargo-zigbuild@${cargoZigbuild}`);
  }
  return `${lines.join('\n')}\n`;
}

test('files that pin the same zig and cargo-zigbuild versions have no drift', () => {
  const drift = findNativeToolchainPinDrift({
    miseToml: miseToml({ zig: '0.13.0', cargoZigbuild: '0.19.8' }),
    actionYml: actionYml({ zig: '0.13.0', cargoZigbuild: '0.19.8' }),
  });

  assert.deepEqual(drift, []);
});

test('a zig version that differs between the files is reported', () => {
  const drift = findNativeToolchainPinDrift({
    miseToml: miseToml({ zig: '0.14.0', cargoZigbuild: '0.19.8' }),
    actionYml: actionYml({ zig: '0.13.0', cargoZigbuild: '0.19.8' }),
  });

  assert.deepEqual(drift, ['zig: mise.toml pins 0.14.0 but the CI action installs 0.13.0']);
});

test('a cargo-zigbuild version that differs between the files is reported', () => {
  const drift = findNativeToolchainPinDrift({
    miseToml: miseToml({ zig: '0.13.0', cargoZigbuild: '0.19.8' }),
    actionYml: actionYml({ zig: '0.13.0', cargoZigbuild: '0.23.0' }),
  });

  assert.deepEqual(drift, [
    'cargo-zigbuild: mise.toml pins 0.19.8 but the CI action installs 0.23.0',
  ]);
});

test('a pin missing from mise.toml is reported', () => {
  const drift = findNativeToolchainPinDrift({
    miseToml: miseToml({ cargoZigbuild: '0.19.8' }),
    actionYml: actionYml({ zig: '0.13.0', cargoZigbuild: '0.19.8' }),
  });

  assert.deepEqual(drift, ['zig: mise.toml has no pin']);
});

test('a pin missing from the CI action is reported', () => {
  const drift = findNativeToolchainPinDrift({
    miseToml: miseToml({ zig: '0.13.0', cargoZigbuild: '0.19.8' }),
    actionYml: actionYml({ zig: '0.13.0' }),
  });

  assert.deepEqual(drift, ['cargo-zigbuild: the CI action has no pin']);
});

test('files with no readable pins report every pin as missing', () => {
  const drift = findNativeToolchainPinDrift({
    miseToml: '<<<<<<< not toml',
    actionYml: '',
  });

  assert.deepEqual(drift, [
    'zig: mise.toml has no pin',
    'zig: the CI action has no pin',
    'cargo-zigbuild: mise.toml has no pin',
    'cargo-zigbuild: the CI action has no pin',
  ]);
});

test('a pin that is commented out does not count', () => {
  const drift = findNativeToolchainPinDrift({
    miseToml: '[tools]\n# zig = "0.13.0"\n"cargo:cargo-zigbuild" = "0.19.8"\n',
    actionYml: [
      '      run: |',
      '        pipx install ziglang==0.13.0',
      '        # cargo install --locked cargo-zigbuild@0.19.8',
      '',
    ].join('\n'),
  });

  assert.deepEqual(drift, [
    'zig: mise.toml has no pin',
    'cargo-zigbuild: the CI action has no pin',
  ]);
});

test('a pin outside the [tools] table of mise.toml does not count', () => {
  const drift = findNativeToolchainPinDrift({
    miseToml: '[env]\nzig = "0.13.0"\n\n[tools]\n"cargo:cargo-zigbuild" = "0.19.8"\n',
    actionYml: actionYml({ zig: '0.13.0', cargoZigbuild: '0.19.8' }),
  });

  assert.deepEqual(drift, ['zig: mise.toml has no pin']);
});

test('a CI action that installs two versions of one tool is reported', () => {
  const drift = findNativeToolchainPinDrift({
    miseToml: miseToml({ zig: '0.13.0', cargoZigbuild: '0.19.8' }),
    actionYml: [
      '      run: |',
      '        pipx install ziglang==0.13.0 || pip install --user ziglang==0.12.0',
      '        cargo install --locked cargo-zigbuild@0.19.8',
      '',
    ].join('\n'),
  });

  assert.deepEqual(drift, ['zig: the CI action installs more than one version: 0.13.0, 0.12.0']);
});

test('a mise.toml that pins two versions of one tool is reported', () => {
  const drift = findNativeToolchainPinDrift({
    miseToml: '[tools]\nzig = "0.13.0"\nzig = "0.14.0"\n"cargo:cargo-zigbuild" = "0.19.8"\n',
    actionYml: actionYml({ zig: '0.13.0', cargoZigbuild: '0.19.8' }),
  });

  assert.deepEqual(drift, ['zig: mise.toml pins more than one version: 0.13.0, 0.14.0']);
});

test('mise.toml and the CI action pin the same zig and cargo-zigbuild versions', async () => {
  const drift = findNativeToolchainPinDrift({
    miseToml: await readFile(join(repoRoot, 'mise.toml'), 'utf-8'),
    actionYml: await readFile(
      join(repoRoot, '.github/actions/setup-rust-zigbuild/action.yml'),
      'utf-8',
    ),
  });

  assert.deepEqual(drift, []);
});
