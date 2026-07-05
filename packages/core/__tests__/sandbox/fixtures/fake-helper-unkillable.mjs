#!/usr/bin/env node
// Fake helper for the teardown-timeout path: emits a bad status, closes fd 4,
// then IGNORES SIGTERM so terminateGroup cannot confirm a reap within a short
// teardownReapMs. It self-exits after 3s so no process truly leaks past the test.
import { writeFileSync, closeSync } from 'node:fs';

if (process.argv.slice(2).includes('--probe')) {
  process.stdout.write(`${process.env.FAKE_PROBE_JSON ?? '{"available":false,"abi":0}'}\n`);
  process.exit(0);
}

process.on('SIGTERM', () => {
  /* deliberately ignore, so 'exit' does not fire on SIGTERM */
});

writeFileSync(4, '{"status":"error","message":"synthetic violation"}\n');
closeSync(4);
setTimeout(() => process.exit(0), 3000);
