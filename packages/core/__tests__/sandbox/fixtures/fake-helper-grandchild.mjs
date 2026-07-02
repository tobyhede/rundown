#!/usr/bin/env node
// Fake helper that emits a protocol-violating status, closes fd 4 (so the
// parent's fd-4 'end' fires promptly, mirroring FD_CLOEXEC closing at exec),
// spawns a long-lived grandchild in its own process group, then HANGS — proving
// teardown reaps the whole group without waiting for this process to exit.
// The grandchild PID is written to fd 5 so the test can assert it is dead.
import { writeFileSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';

// getAvailability() runs `--probe` first; honour it like the main fake helper.
if (process.argv.slice(2).includes('--probe')) {
  process.stdout.write((process.env.FAKE_PROBE_JSON ?? '{"available":false,"abi":0}') + '\n');
  process.exit(0);
}

// Emit a protocol violation, then close fd 4 so the parent sees EOF immediately
// (do NOT wait for this process to exit — that is the whole point of the test).
writeFileSync(4, '{"status":"error","message":"synthetic violation"}\n');
closeSync(4);

// Long-lived grandchild in the helper's process group: sleeps 30s.
const grandchild = spawn('sleep', ['30'], { stdio: 'ignore' });
try {
  writeFileSync(5, String(grandchild.pid));
  closeSync(5);
} catch {
  /* fd 5 not wired */
}

// Simulate a command that hangs after the bad status. Teardown must fire off the
// fd-4 'end' event and kill the group long before this timer.
setTimeout(() => process.exit(0), 30000);
