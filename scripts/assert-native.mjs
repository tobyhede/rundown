#!/usr/bin/env node
// Pack-time guard: fail the publish unless both bundled rd-landlock binaries are
// plausible STATIC ELF64 executables of the expected architecture. A shell
// script, a wrong-arch binary, a header-only file, or a dynamically linked
// binary (PT_INTERP/PT_DYNAMIC present) is rejected. In CI/release,
// RD_ASSERT_NATIVE_RUN=1 also runs the host-arch binary with --version.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const distRoot =
  process.env.RD_NATIVE_DIST_ROOT ??
  join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'core', 'dist');

const EM_X86_64 = 0x3e;
const EM_AARCH64 = 0xb7;
const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const PT_INTERP = 3;
const TARGETS = [
  { dir: 'linux-x64', machine: EM_X86_64, nodeArch: 'x64' },
  { dir: 'linux-arm64', machine: EM_AARCH64, nodeArch: 'arm64' },
];

/** Return an error string if `buf` is not a plausible static ELF64 executable, else null. */
function checkStaticElf(buf, machine) {
  if (buf.length < 64) return 'too short to be ELF64';
  if (!(buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46)) {
    return 'missing ELF magic (not a script or arbitrary file)';
  }
  if (buf[4] !== 2) return 'not ELFCLASS64';
  if (buf[5] !== 1) return 'not little-endian';
  const eType = buf.readUInt16LE(16);
  if (eType !== 2 && eType !== 3) return `unexpected e_type ${eType} (want ET_EXEC/ET_DYN)`;
  const eMachine = buf.readUInt16LE(18);
  if (eMachine !== machine) return `wrong e_machine 0x${eMachine.toString(16)} (want 0x${machine.toString(16)})`;
  const entry = buf.readBigUInt64LE(0x18);
  if (entry === 0n) return 'zero e_entry (not a runnable executable)';
  const phoff = Number(buf.readBigUInt64LE(0x20));
  const phentsize = buf.readUInt16LE(0x36);
  const phnum = buf.readUInt16LE(0x38);
  if (phnum === 0) return 'no program headers (not a runnable executable)';
  if (phentsize < 56) return `program header size ${phentsize} too small for ELF64`;
  if (phoff < 64 || phoff + phentsize * phnum > buf.length) {
    return 'program header table outside file bounds';
  }
  let sawLoad = false;
  for (let i = 0; i < phnum; i++) {
    const off = phoff + i * phentsize;
    const kind = buf.readUInt32LE(off);
    if (kind === PT_LOAD) sawLoad = true;
    if (kind === PT_INTERP) return 'dynamically linked (PT_INTERP present)';
    if (kind === PT_DYNAMIC) return 'dynamically linked (PT_DYNAMIC present)';
  }
  if (!sawLoad) return 'no PT_LOAD segment';
  return null;
}

function checkHostVersion() {
  if (process.env.RD_ASSERT_NATIVE_RUN !== '1' || process.platform !== 'linux') return null;
  const target = TARGETS.find((t) => t.nodeArch === process.arch);
  if (!target) return `unsupported host arch for runtime assertion: ${process.arch}`;
  const bin = join(distRoot, 'native', target.dir, 'rd-landlock');
  const res = spawnSync(bin, ['--version'], {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.status !== 0) {
    return `${bin} --version failed: status=${res.status} error=${res.error?.message ?? res.stderr}`;
  }
  if (!res.stdout.startsWith('rd-landlock ')) {
    return `${bin} --version returned unexpected stdout: ${res.stdout}`;
  }
  return null;
}

let ok = true;
for (const t of TARGETS) {
  const bin = join(distRoot, 'native', t.dir, 'rd-landlock');
  let buf;
  try {
    buf = readFileSync(bin);
  } catch {
    console.error(`assert-native: missing: ${bin}`);
    ok = false;
    continue;
  }
  const err = checkStaticElf(buf, t.machine);
  if (err) {
    console.error(`assert-native: ${bin}: ${err}`);
    ok = false;
  }
}
const hostErr = checkHostVersion();
if (hostErr) {
  console.error(`assert-native: ${hostErr}`);
  ok = false;
}
if (!ok) {
  console.error('assert-native: refusing to pack core without both valid static ELF binaries.');
  process.exit(1);
}
console.log('assert-native: both rd-landlock binaries are plausible static ELF64 executables of the expected arch.');
