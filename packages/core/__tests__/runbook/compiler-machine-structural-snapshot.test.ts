import { describe, it, expect } from '@jest/globals';
import { compileRunbookToMachine } from '../../src/runbook/compiler.js';
import { createRunbook } from './fixtures.js';

function snapshotConfig(machine: ReturnType<typeof compileRunbookToMachine>): unknown {
  return JSON.parse(
    JSON.stringify(machine.config, (_key, value) => {
      if (typeof value === 'function') return '[fn]';
      return value;
    }),
  );
}

describe('compileRunbookToMachine (lifecycle cleanup structural snapshot)', () => {
  it('produces a stable structural config for a representative runbook', () => {
    const steps = createRunbook(`## 1. Parent
- PASS CONTINUE
- FAIL STOP

### 1.1 First
- PASS CONTINUE
- FAIL CONTINUE

### 1.2 Last
- PASS CONTINUE
- FAIL STOP

## 2. Done
- PASS COMPLETE
- FAIL STOP
`);

    const machine = compileRunbookToMachine(steps);
    expect(snapshotConfig(machine)).toMatchSnapshot();
  });

  it('produces a stable structural config for GOTO construct', () => {
    const steps = createRunbook(`## 1. Redirect
- PASS GOTO 3
- FAIL STOP

## 2. Skipped
- PASS CONTINUE
- FAIL STOP

## 3. Target
- PASS COMPLETE
- FAIL STOP
`);

    const machine = compileRunbookToMachine(steps);
    expect(snapshotConfig(machine)).toMatchSnapshot();
  });

  it('lifecycle is initialized in the machine context', () => {
    const steps = createRunbook(`## 1. Only\n- PASS COMPLETE\n- FAIL STOP\n`);
    const machine = compileRunbookToMachine(steps);
    const ctx = machine.config.context as unknown as { lifecycle?: string };
    expect(ctx.lifecycle).toBe('running');
  });
});
