import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { EventEmitter } from 'node:events';
import type * as ChildProcess from 'node:child_process';

// Capture the arguments passed to `spawn` so we can assert how shell commands
// are invoked. A fake child process emits `close` with exit code 0 on the next
// tick so `runCommandWithTee` resolves.
const spawnCalls: Array<{ command: string; args: readonly string[] }> = [];

function createFakeChild(): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setImmediate(() => child.emit('close', 0));
  return child;
}

const mockSpawn = jest.fn((command: string, args: readonly string[]) => {
  spawnCalls.push({ command, args });
  return createFakeChild();
});

const actualChildProcess = jest.requireActual<typeof ChildProcess>('node:child_process');

jest.unstable_mockModule('node:child_process', () => ({
  ...actualChildProcess,
  spawn: mockSpawn,
}));

const { executeCommandSequence } = await import('../../src/helpers/command-sequence.js');

describe('shell command spawning', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    mockSpawn.mockClear();
  });

  // Regression: shell commands MUST be spawned with a non-login shell (`-c`),
  // never a login shell (`-lc`). A login shell sources /etc/profile, which on
  // Debian-based Linux (the CI image) hard-overwrites PATH and discards the
  // workspace bin directory the scenario harness prepends — breaking any shell
  // command that resolves `rd` (or any staged tool) by name on PATH. macOS's
  // path_helper preserves the inherited PATH, which is why the regression only
  // surfaced in CI. See command-sequence.ts runCommandWithTee.
  it('spawns shell commands with a non-login shell', async () => {
    await executeCommandSequence({
      commands: ['echo hello'],
      cwd: process.cwd(),
      cliPath: '/unused/cli.js',
      quiet: true,
    });

    const shellCall = spawnCalls.find((call) => call.args.includes('echo hello'));
    expect(shellCall).toBeDefined();
    expect(shellCall?.args[0]).toBe('-c');
    expect(shellCall?.args).not.toContain('-lc');
  });
});
