#!/usr/bin/env node
// Parametrised fake rd-landlock helper for core unit tests. Behaviour is
// driven entirely by env vars so a single fixture covers every protocol path.
//
//   FAKE_PROBE_JSON       — JSON printed to stdout for `--probe` (default unavailable)
//   FAKE_PROBE_EXIT       — exit code for `--probe` (default 0)
//   FAKE_STATUS_LINE      — exact fd-4 status line (no trailing newline needed)
//   FAKE_NO_STATUS=1      — write nothing to fd-4 (missing-status protocol violation)
//   FAKE_EXIT             — exit code after writing status (default 0)
//   FAKE_ECHO_SPEC_FD5=1  — copy the fd-3 spec back to fd 5 (spec-inspection tests)
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('--probe')) {
  process.stdout.write((process.env.FAKE_PROBE_JSON ?? '{"available":false,"abi":0}') + '\n');
  process.exit(Number(process.env.FAKE_PROBE_EXIT ?? '0'));
}

// Read the spec from fd 3 (best-effort; tests that don't write it still run).
let spec = '';
try {
  spec = readFileSync(3, 'utf8');
} catch {
  /* no spec wired */
}
if (process.env.FAKE_ECHO_SPEC_FD5 === '1') {
  try {
    writeFileSync(5, spec);
  } catch {
    /* fd 5 not wired */
  }
}

if (process.env.FAKE_NO_STATUS !== '1') {
  const line = process.env.FAKE_STATUS_LINE ?? '{"status":"applied","abi":3,"downgraded":false}';
  try {
    writeFileSync(4, line + '\n');
  } catch {
    /* fd 4 not wired */
  }
}

process.exit(Number(process.env.FAKE_EXIT ?? '0'));
