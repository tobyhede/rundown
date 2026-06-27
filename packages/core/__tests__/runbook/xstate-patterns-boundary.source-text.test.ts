import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';

describe('XState compiler pattern boundaries', () => {
  it('uses setup-bound helpers and typed invoke events for output capture', () => {
    const source = readFileSync('src/runbook/compiler.ts', 'utf8');

    expect(source).not.toContain("import { setup, assign, assertEvent, raise } from 'xstate'");
    expect(source).not.toContain('as unknown as InvokeBlock');
    expect(source).not.toContain('event as unknown as DoneEvent');
    expect(source).not.toContain('event as unknown as { error?: unknown }');
    expect(source).not.toContain('raise(({ event })');
    expect(source).toContain("baseRunbookSetup.raise({ type: 'PASS' })");
    expect(source).toContain("baseRunbookSetup.raise({ type: 'FAIL' })");
  });

  it('does not snapshot the whole XState machine config', () => {
    const source = readFileSync(
      '__tests__/runbook/compiler-machine-structural-snapshot.test.ts',
      'utf8',
    );

    expect(source).not.toContain('snapshotConfig(machine)');
    expect(source).not.toContain('toMatchSnapshot()');
  });
});
