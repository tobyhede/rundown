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

/**
 * Structural view of a compiled state config used by the snapshot
 * assertions. The runtime type returned by `compileRunbookToMachine` is the
 * full XState `StateNodeConfig` envelope; we lift out the surfaces tested
 * here. Field accesses return permissive `{ target?: string; ... }` shapes
 * so existing `.on.PASS.target`-style assertions remain ergonomic, without
 * the `as any` smuggling that previously hid type drift at this boundary.
 */
type TransitionShape = { readonly target?: string; readonly actions?: unknown };
type EventMapShape = Record<string, TransitionShape>;
type InvokeShape = {
  readonly src?: string;
  readonly onDone?: TransitionShape | readonly TransitionShape[];
  readonly onError?: TransitionShape;
};
type TestStateConfigSnapshot = {
  readonly initial?: string;
  readonly on: EventMapShape;
  readonly states: Record<string, TestStateConfigSnapshot>;
  readonly tags?: readonly unknown[];
  readonly always?: readonly TransitionShape[];
  readonly invoke?: InvokeShape;
};

function getState(
  machine: ReturnType<typeof compileRunbookToMachine>,
  id: string,
): TestStateConfigSnapshot {
  const states = machine.config.states as Record<string, TestStateConfigSnapshot> | undefined;
  const state = states?.[id];
  if (state === undefined) {
    throw new Error(`getState: missing state "${id}"`);
  }
  return state;
}

describe('compileRunbookToMachine structural invariants', () => {
  it('wraps leaf states in idle and output-capture child states', () => {
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
    expect(leaf.on.COMMAND_RESULT).toBeUndefined();
    expect(leaf.states.idle.on.COMMAND_RESULT.target).toBe('#step::1::1.__capture');
    expect(leaf.states.idle.on.EXECUTE_COMMAND.target).toBe('#step::1::1.__execute-command');
    expect(leaf.states.idle.on.APPLY_CURRENT_RESOLVED_COMPLETION).toBeDefined();
    expect(leaf.states.__capture.tags).toEqual(['pending-machine-effect']);
    const captureInvoke = leaf.states.__capture.invoke;
    expect(captureInvoke).toBeDefined();
    expect(captureInvoke?.src).toBe('outputCaptureActor');
    expect(captureInvoke?.onError?.target).toBe('#STOPPED');
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
    expect(loopSubstep.states.__capture.invoke?.onError?.target).toBe('#STOPPED');
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

describe('interrupted-execution recovery machine shape', () => {
  const RECOVERY_RUNBOOK = `## 1. First
- PASS CONTINUE
- FAIL STOP

## 2. Second
- PASS CONTINUE
- FAIL STOP

## 3. Third
- PASS COMPLETE
- FAIL STOP
`;

  it('adds a non-final recoveryRequired state carrying the recovery tag', () => {
    const machine = compileRunbookToMachine(createRunbook(RECOVERY_RUNBOOK));
    const recovery = getState(machine, 'recoveryRequired');
    // Non-final: a final state has no outgoing transitions and is typed 'final'.
    expect((recovery as { type?: string }).type).not.toBe('final');
    expect(recovery.tags).toEqual(['recovery']);
    // Reconcile/retry transitions leave the state via GOTO.
    expect(recovery.on.GOTO).toBeDefined();
  });

  it('routes EXECUTION_OUTCOME_UNKNOWN through a single root-level handler', () => {
    const machine = compileRunbookToMachine(createRunbook(RECOVERY_RUNBOOK));
    const rootOn = machine.config.on as Record<string, { target?: string }>;
    expect(rootOn.EXECUTION_OUTCOME_UNKNOWN.target).toBe('.recoveryRequired');

    // The handler is root-level only; no generated leaf carries it.
    const leaf = getState(machine, 'step::1');
    expect(leaf.on.EXECUTION_OUTCOME_UNKNOWN).toBeUndefined();
    expect(leaf.states.idle.on.EXECUTION_OUTCOME_UNKNOWN).toBeUndefined();
  });

  it('initializes the interrupted-recovery context fields as undefined', () => {
    const machine = compileRunbookToMachine(createRunbook(RECOVERY_RUNBOOK));
    const ctx = machine.config.context as unknown as {
      interruptedEpoch?: number;
      interruptedReason?: string;
      interruptedStepId?: string;
    };
    expect(ctx.interruptedEpoch).toBeUndefined();
    expect(ctx.interruptedReason).toBeUndefined();
    expect(ctx.interruptedStepId).toBeUndefined();
  });
});
