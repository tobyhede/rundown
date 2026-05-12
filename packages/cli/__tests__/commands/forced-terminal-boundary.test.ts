import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';

const stopSourceUrl = new URL('../../src/commands/stop.ts', import.meta.url);
const completeSourceUrl = new URL('../../src/commands/complete.ts', import.meta.url);

describe('forced terminal command boundaries', () => {
  it('stop command dispatches FORCE_STOP and does not mutate terminal lifecycle directly', () => {
    const source = readFileSync(stopSourceUrl, 'utf8');

    expect(source).toContain("type: 'FORCE_STOP'");
    expect(source).toContain('sendAndSync');
    expect(source).not.toContain("lifecycle: 'stopped'");
    expect(source).not.toContain("lastAction: { type: 'STOP' }");
    expect(source).not.toContain("lastResult: 'fail'");
  });

  it('complete command dispatches FORCE_COMPLETE and does not mutate terminal lifecycle directly', () => {
    const source = readFileSync(completeSourceUrl, 'utf8');

    expect(source).toContain("type: 'FORCE_COMPLETE'");
    expect(source).toContain('sendAndSync');
    expect(source).not.toContain("lifecycle: 'completed'");
    expect(source).not.toContain("lastAction: { type: 'COMPLETE' }");
    expect(source).not.toContain('steps[steps.length - 1].name');
  });
});
