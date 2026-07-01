import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';

const stopSourceUrl = new URL('../../src/commands/stop.ts', import.meta.url);
const completeSourceUrl = new URL('../../src/commands/complete.ts', import.meta.url);

// Architecture boundary guard. `complete` / `stop` are thin front ends: they route
// through the core terminal seam (`runSeamTerminal` → `runTerminal`), which owns
// the FORCE dispatch, and must NOT hand-write terminal lifecycle/state. These
// source assertions fail closed if the CLI ever grows a shadow terminal mutation.

describe('forced terminal command boundaries', () => {
  it('stop command routes through the core terminal seam and does not mutate terminal lifecycle directly', () => {
    const source = readFileSync(stopSourceUrl, 'utf8');

    // Routes through the seam rather than dispatching / mutating lifecycle itself.
    expect(source).toContain('runSeamTerminal');
    // Must NOT contain a direct FORCE dispatch or hand-written terminal state
    // (those live in the core seam now).
    expect(source).not.toContain('sendAndSync');
    expect(source).not.toContain("type: 'FORCE_STOP'");
    expect(source).not.toContain("lifecycle: 'stopped'");
    expect(source).not.toContain("lastAction: { type: 'STOP' }");
    expect(source).not.toContain("lastResult: 'fail'");
  });

  it('complete command routes through the core terminal seam and does not mutate terminal lifecycle directly', () => {
    const source = readFileSync(completeSourceUrl, 'utf8');

    expect(source).toContain('runSeamTerminal');
    expect(source).not.toContain('sendAndSync');
    expect(source).not.toContain("type: 'FORCE_COMPLETE'");
    expect(source).not.toContain("lifecycle: 'completed'");
    expect(source).not.toContain("lastAction: { type: 'COMPLETE' }");
    expect(source).not.toContain('steps[steps.length - 1].name');
  });
});
