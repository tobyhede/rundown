#!/usr/bin/env node
// Fake helper for the fd-4 buffer-cap and startup-timeout tests.
//   --probe            → prints FAKE_PROBE_JSON
//   FAKE_MODE=oversize → writes >8 KiB to fd 4 with NO newline, then lingers
//   FAKE_MODE=silent   → writes nothing to fd 4, then lingers
// Either way it keeps fd 4 open (does not exit promptly), so the parent must
// rely on its buffer cap / startup timeout, not on EOF.
import { writeSync } from 'node:fs';

if (process.argv.slice(2).includes('--probe')) {
  process.stdout.write((process.env.FAKE_PROBE_JSON ?? '{"available":false,"abi":0}') + '\n');
  process.exit(0);
}

if (process.env.FAKE_MODE === 'oversize') {
  writeSync(4, 'x'.repeat(9216)); // 9 KiB, no newline → exceeds the 8 KiB cap
}
// Linger long enough that the parent's cap/timeout fires first, then self-exit
// (Task 17's handleViolation does not yet kill the group — that is Task 19).
setTimeout(() => process.exit(0), 2000);
