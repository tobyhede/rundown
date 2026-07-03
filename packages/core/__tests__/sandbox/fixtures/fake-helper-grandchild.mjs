#!/usr/bin/env node
// Fake helper that spawns a long-lived grandchild FIRST (so it is already a
// member of the helper's process group), THEN emits a protocol-violating
// status and closes fd 4 (so the parent's fd-4 'end' fires promptly, mirroring
// FD_CLOEXEC closing at exec), then HANGS — proving teardown reaps the whole
// group without waiting for this process to exit.
//
// Ordering matters: if the bad status were written before the grandchild was
// spawned, the parent could send the group SIGTERM in the window between fd-4
// closing and the grandchild's fork completing, so the grandchild would join
// the group too late to receive it (and terminateGroup's SIGKILL backstop is
// cancelled once the direct child exits) — a race that made this test flaky.
// Spawning the grandchild first and confirming it (fd 5 write) before ever
// signalling the violation guarantees it is already in the group when the
// parent reacts, making the reap deterministic.
import { writeFileSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';

// getAvailability() runs `--probe` first; honour it like the main fake helper.
if (process.argv.slice(2).includes('--probe')) {
  process.stdout.write((process.env.FAKE_PROBE_JSON ?? '{"available":false,"abi":0}') + '\n');
  process.exit(0);
}

// Long-lived grandchild in the helper's process group: sleeps 30s. Spawned
// before the violation is signalled so group membership is established first.
const grandchild = spawn('sleep', ['30'], { stdio: 'ignore' });
try {
  writeFileSync(5, String(grandchild.pid));
  closeSync(5);
} catch {
  /* fd 5 not wired */
}

// Emit a protocol violation, then close fd 4 so the parent sees EOF immediately
// (do NOT wait for this process to exit — that is the whole point of the test).
writeFileSync(4, '{"status":"error","message":"synthetic violation"}\n');
closeSync(4);

// Simulate a command that hangs after the bad status. Teardown must fire off the
// fd-4 'end' event and kill the group long before this timer.
setTimeout(() => process.exit(0), 30000);
