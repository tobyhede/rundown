import { describe, it, expect } from '@jest/globals';
import { compileRunbookToMachine } from '../../src/runbook/compiler.js';
import { createRunbook } from './fixtures.js';

// ---------------------------------------------------------------------------
// Compile-time type assertions for the transition-builder rewrite.
//
// These declarations produce no runtime output. They exist so `tsc --noEmit`
// fails loudly if XState v5.28's inference degrades the extracted types to
// `unknown`. Every `Assert*` helper is only used at the type level.
// ---------------------------------------------------------------------------
import type { runbookSetup, RunbookContext, RunbookEvent } from '../../src/runbook/compiler.js';
import type { ActionRef } from '../../src/runbook/compiler-actions.js';

type _RunbookStateConfig = Parameters<typeof runbookSetup.createStateConfig>[0];
type _OnMap = NonNullable<_RunbookStateConfig['on']>;
type _EventTransition = _OnMap[keyof _OnMap];
type _AlwaysField = NonNullable<_RunbookStateConfig['always']>;
type _AlwaysEntry = _AlwaysField extends readonly (infer E)[] ? E : _AlwaysField;

type AssertNotUnknown<T> = unknown extends T ? (T extends unknown ? false : true) : true;
type AssertExtends<T, U> = T extends U ? true : false;

const _assertOnMapIsRecord: AssertNotUnknown<_OnMap> = true;
const _assertEventTransitionIsObject: AssertNotUnknown<_EventTransition> = true;
const _assertAlwaysEntryIsObject: AssertNotUnknown<_AlwaysEntry> = true;

// A transition MUST accept a `target?: string` field and optional `actions`.
type _HasTargetField = AssertExtends<{ target: 'COMPLETE' }, _EventTransition | _AlwaysEntry>;
const _assertTransitionAcceptsTarget: _HasTargetField = true;

// The real builders return objects carrying an `actions` array of action refs
// plus an inline function guard. If XState's inferred `Actions<…>` union or
// its guard type rejects these shapes, Tasks 3–4 will explode on the first
// builder migration — not here. Fail the spike now instead.
type _BuilderTerminalShape = {
  readonly target: 'STOPPED';
  readonly actions: readonly [ActionRef<'setLastAction'>];
};
type _BuilderGuardedShape = {
  readonly target: string;
  readonly actions: readonly ActionRef<'setLastAction'>[];
  readonly guard: (args: { context: RunbookContext; event: RunbookEvent }) => boolean;
};

type _TerminalAssigns = AssertExtends<_BuilderTerminalShape, _EventTransition | _AlwaysEntry>;
type _GuardedAssigns = AssertExtends<_BuilderGuardedShape, _EventTransition | _AlwaysEntry>;

const _assertTerminalBuilderShapeAssigns: _TerminalAssigns = true;
const _assertGuardedBuilderShapeAssigns: _GuardedAssigns = true;

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

  it('context is initialized with zero retry counts', () => {
    const steps = createRunbook(`## 1. Only\n- PASS COMPLETE\n- FAIL STOP\n`);
    const machine = compileRunbookToMachine(steps);
    const ctx = machine.config.context as unknown as {
      retryCount?: number;
      parentRetryCount?: number;
    };
    expect(ctx.retryCount).toBe(0);
    expect(ctx.parentRetryCount).toBe(0);
  });

  it('produces a stable structural config for FOR loop with BREAK', () => {
    const steps = createRunbook(`## 1. Parent
- PASS CONTINUE
- FAIL STOP

### 1.1 First
- PASS CONTINUE
- FAIL CONTINUE

### 1.2 Last
- PASS CONTINUE
- FAIL STOP

## 2. Loop
- FOR i IN 1 TO 2
- PASS CONTINUE
- FAIL STOP

### 2.1 Inside
- PASS CONTINUE
- FAIL BREAK

## 3. Done
- PASS COMPLETE
- FAIL STOP
`);

    const machine = compileRunbookToMachine(steps);
    expect(snapshotConfig(machine)).toMatchSnapshot();
  });

  it('produces a stable structural config for DEFER transitions', () => {
    const steps = createRunbook(`## 1. Parent
- PASS CONTINUE
- FAIL STOP

### 1.1 Deferred
- PASS DEFER
- FAIL DEFER

## 2. Redirect
- PASS GOTO 4
- FAIL STOP

## 3. Skipped
- PASS CONTINUE
- FAIL STOP

## 4. Target
- PASS COMPLETE
- FAIL STOP
`);

    const machine = compileRunbookToMachine(steps);
    expect(snapshotConfig(machine)).toMatchSnapshot();
  });
});
