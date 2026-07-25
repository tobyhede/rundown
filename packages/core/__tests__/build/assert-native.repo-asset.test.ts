import { describe, it, expect } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = fileURLToPath(new URL('../../../../scripts/assert-native.mjs', import.meta.url));

const EM_X86_64 = 0x3e;
const EM_AARCH64 = 0xb7;

/** Build a plausible static ELF64: non-zero entry + one PT_LOAD header. */
function staticElf(machine: number, eType = 2): Buffer {
  const b = Buffer.concat([Buffer.alloc(64), Buffer.alloc(56)]);
  b[0] = 0x7f;
  b.write('ELF', 1, 'ascii');
  b[4] = 2; // ELFCLASS64
  b[5] = 1; // little-endian
  b[6] = 1; // EV_CURRENT
  b.writeUInt16LE(eType, 16); // e_type (2 = ET_EXEC)
  b.writeUInt16LE(machine, 18); // e_machine
  b.writeBigUInt64LE(0x400000n, 0x18); // e_entry
  b.writeBigUInt64LE(64n, 0x20); // e_phoff
  b.writeUInt16LE(56, 0x36); // e_phentsize
  b.writeUInt16LE(1, 0x38); // e_phnum
  b.writeUInt32LE(1, 64); // p_type = PT_LOAD
  return b;
}

function runAssert(distRoot: string) {
  return spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, RD_NATIVE_DIST_ROOT: distRoot },
    encoding: 'utf8',
  });
}

function place(root: string, arch: string, bytes: Buffer | string) {
  const dir = join(root, 'native', arch);
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, 'rd-landlock');
  writeFileSync(bin, bytes);
  chmodSync(bin, 0o755);
}

describe('assert-native', () => {
  it('exits non-zero when binaries are missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'native-'));
    expect(runAssert(root).status).not.toBe(0);
  });

  it('exits 0 for plausible static ELF64 executables of the expected arch', () => {
    const root = mkdtempSync(join(tmpdir(), 'native-'));
    place(root, 'linux-x64', staticElf(EM_X86_64));
    place(root, 'linux-arm64', staticElf(EM_AARCH64));
    expect(runAssert(root).status).toBe(0);
  });

  it('REJECTS a shell script masquerading as a binary', () => {
    const root = mkdtempSync(join(tmpdir(), 'native-'));
    place(root, 'linux-x64', '#!/bin/sh\ntrue\n');
    place(root, 'linux-arm64', staticElf(EM_AARCH64));
    expect(runAssert(root).status).not.toBe(0);
  });

  it('REJECTS a wrong-architecture ELF header', () => {
    const root = mkdtempSync(join(tmpdir(), 'native-'));
    place(root, 'linux-x64', staticElf(EM_AARCH64)); // arm64 header in the x64 slot
    place(root, 'linux-arm64', staticElf(EM_AARCH64));
    expect(runAssert(root).status).not.toBe(0);
  });

  it('REJECTS a dynamically linked ELF (PT_INTERP present)', () => {
    const root = mkdtempSync(join(tmpdir(), 'native-'));
    const b = staticElf(EM_X86_64);
    b.writeUInt32LE(3, 64); // program header p_type = PT_INTERP
    place(root, 'linux-x64', b);
    place(root, 'linux-arm64', staticElf(EM_AARCH64));
    expect(runAssert(root).status).not.toBe(0);
  });

  it('REJECTS a dynamically linked ELF (PT_DYNAMIC present)', () => {
    const root = mkdtempSync(join(tmpdir(), 'native-'));
    const b = staticElf(EM_X86_64);
    b.writeUInt32LE(2, 64); // program header p_type = PT_DYNAMIC
    place(root, 'linux-x64', b);
    place(root, 'linux-arm64', staticElf(EM_AARCH64));
    expect(runAssert(root).status).not.toBe(0);
  });
});
