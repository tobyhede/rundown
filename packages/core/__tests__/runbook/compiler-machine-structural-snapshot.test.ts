import { describe, it, expect } from '@jest/globals';
import { compileRunbookToMachine } from '../../src/runbook/compiler.js';
import { createRunbook } from './fixtures.js';

// ---------------------------------------------------------------------------
// Compile-time type assertions for the transition-builder rewrite.
//
// These `declare const` declarations produce no runtime output. They exist so
// `tsc --noEmit` fails loudly if XState v5.28's inference degrades the
// extracted types to `unknown`. Every `Assert*` helper is only used at the
// type level.
// ---------------------------------------------------------------------------
import type { runbookSetup, RunbookContext, RunbookEvent } from '../../src/runbook/compiler.js';
import type { ActionRef } from '../../src/runbook/compiler-actions.js';

type _RunbookStateConfig = Parameters<typeof runbookSetup.createStateConfig>[0];
type _OnMap = NonNullable<_RunbookStateConfig['on']>;
type _EventTransition = _OnMap[keyof _OnMap];
type _AlwaysField = NonNullable<_RunbookStateConfig['always']>;
type _AlwaysEntry = _AlwaysField extends readonly (infer E)[] ? E : _AlwaysField;

type IsAny<T> = 0 extends 1 & T ? true : false;
type IsNever<T> = [T] extends [never] ? true : false;
type AssertKnown<T> =
  IsAny<T> extends true
    ? false
    : IsNever<T> extends true
      ? false
      : unknown extends T
        ? false
        : true;
type AssertTrue<T extends true> = T;
type AssertExtends<T, U> = T extends U ? true : false;

declare const _assertOnMapIsRecord: AssertTrue<AssertKnown<_OnMap>>;
declare const _assertEventTransitionIsObject: AssertTrue<AssertKnown<_EventTransition>>;
declare const _assertAlwaysEntryIsObject: AssertTrue<AssertKnown<_AlwaysEntry>>;

// A transition MUST accept a `target?: string` field and optional `actions`.
type _HasTargetField = AssertExtends<{ target: 'COMPLETE' }, _EventTransition | _AlwaysEntry>;
declare const _assertTransitionAcceptsTarget: AssertTrue<_HasTargetField>;

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

declare const _assertTerminalBuilderShapeAssigns: AssertTrue<_TerminalAssigns>;
declare const _assertGuardedBuilderShapeAssigns: AssertTrue<_GuardedAssigns>;

function getState(machine: ReturnType<typeof compileRunbookToMachine>, id: string): any {
  return (machine.config.states as Record<string, unknown>)[id] as any;
}

describe('compileRunbookToMachine structural invariants', () => {
  it('wraps leaf states in idle and output-capture substates', () => {
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
    const leaf = getState(machine, 'step::1::1');

    expect(leaf.initial).toBe('idle');
    expect(leaf.on.COMMAND_RESULT.target).toBe('.__capture');
    expect(leaf.states.idle).toEqual({});
    expect(leaf.states.__capture.tags).toEqual(['pending-machine-effect']);
    expect(leaf.states.__capture.invoke.src).toBe('outputCaptureActor');
    expect(leaf.states.__capture.invoke.onError.target).toBe('#STOPPED');
  });

  it('keeps root forced terminal transitions as relative terminal targets', () => {
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
    const rootOn = machine.config.on as Record<string, { target?: string; actions?: unknown }>;

    expect(rootOn.FORCE_COMPLETE.target).toBe('.COMPLETE');
    expect(rootOn.FORCE_STOP.target).toBe('.STOPPED');
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

  it('preserves FOR loop BREAK routing without whole-machine snapshots', () => {
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
    const loopSubstep = getState(machine, 'step::2::1');

    expect(loopSubstep.initial).toBe('idle');
    expect(loopSubstep.on.FAIL.target).toBe('step::2');
    expect(loopSubstep.states.__capture.invoke.onError.target).toBe('#STOPPED');
  });

  it('preserves DEFER routing without whole-machine snapshots', () => {
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
    const deferredSubstep = getState(machine, 'step::1::1');
    const parentAlways = getState(machine, 'step::1').always as readonly { target?: string }[];

    expect(deferredSubstep.initial).toBe('idle');
    expect(deferredSubstep.on.PASS.target).toBe('step::1');
    expect(deferredSubstep.on.FAIL.target).toBe('step::1');
    expect(parentAlways.some((entry) => entry.target === 'step::2')).toBe(true);
  });
});
