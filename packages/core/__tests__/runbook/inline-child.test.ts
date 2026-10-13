import { describe, expect, it } from '@jest/globals';
import {
  childResultOf,
  currentInlineReservation,
  inlineRunbookOf,
  reserveInlineChild,
} from '../../src/runbook/inline-child.js';
import { brandInitialTemplateVars } from '../../src/runbook/effective-vars.js';
import { assertRunId } from '../../src/runbook/run-id.js';
import type { FrameKey } from '../../src/runbook/targeting.js';
import type {
  InlineChildReservation,
  RunbookState,
  SubstepState,
} from '../../src/runbook/types.js';
import { createRunbook } from './fixtures.js';

// The Current Child reservation (#903) as pure computation: which substeps
// launch an Inline Child, what a reservation records, which reservation the
// cursor counts, and how a child's lifecycle reads as its Child Result.

const CHILD = assertRunId(`rd_${'c'.repeat(32)}`);
const OTHER = assertRunId(`rd_${'d'.repeat(32)}`);

const STEPS = createRunbook(`## 1. Compose
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Plain
- PASS CONTINUE

Do it by hand.

### 1.2 Inline
- child.runbook.md

### 1.3 Delegated
- DELEGATE
- other.runbook.md

## 2. Plain step
- PASS COMPLETE

Done.
`);

function reservation(overrides: Partial<InlineChildReservation> = {}): InlineChildReservation {
  return {
    kind: 'inline',
    runId: CHILD,
    entry: 2,
    runbook: 'child.runbook.md',
    contextSnapshot: { vars: {} as never, ancestors: [] },
    ...overrides,
  };
}

/** A run resting on `1.2` at frame `1|` entry 2, with the given substep states. */
function stateAt(substepStates: readonly SubstepState[], overrides: Partial<RunbookState> = {}) {
  return {
    step: '1',
    substep: '2',
    activeEntry: 2,
    forStack: [],
    substepStates,
    ...overrides,
  } as unknown as RunbookState;
}

describe('inlineRunbookOf', () => {
  it('names the one runbook of an inline substep, and nothing for any other unit', () => {
    const [compose, plain] = STEPS;
    expect(inlineRunbookOf(compose, '2')).toBe('child.runbook.md');
    expect(inlineRunbookOf(compose, '1')).toBeUndefined();
    expect(inlineRunbookOf(compose, '3')).toBeUndefined();
    expect(inlineRunbookOf(compose, '9')).toBeUndefined();
    expect(inlineRunbookOf(plain, '1')).toBeUndefined();
  });

  it('launches nothing for a substep listing two runbooks', () => {
    const [compose] = createRunbook(`## 1. Compose
### 1.1 Pair
- a.runbook.md
- b.runbook.md
`);
    expect(inlineRunbookOf(compose, '1')).toBeUndefined();
  });
});

describe('reserveInlineChild', () => {
  it('records the reservation on the frame’s substep state, replacing an earlier one', () => {
    const frameKey = '1|' as FrameKey;
    const earlier: SubstepState = {
      id: '2',
      frameKey,
      status: 'pending',
      child: reservation({ runId: OTHER, entry: 1 }),
    };
    const sibling: SubstepState = { id: '1', frameKey, status: 'pending' };

    const reserved = reserveInlineChild({
      substepStates: [sibling, earlier],
      stepName: '1',
      substepId: '2',
      runbook: 'child.runbook.md',
      frameKey,
      entry: 2,
      templateVars: brandInitialTemplateVars({ Who: 'parent' }),
      variables: { Out: 'v' },
      forStack: [],
      runId: CHILD,
    });

    expect(reserved).toEqual([
      sibling,
      {
        id: '2',
        frameKey,
        status: 'pending',
        child: {
          kind: 'inline',
          runId: CHILD,
          entry: 2,
          runbook: 'child.runbook.md',
          contextSnapshot: {
            vars: { Who: 'parent', Out: 'v' },
            ancestors: [],
            step: '1',
            substep: '2',
            at: '1.2',
          },
        },
      },
    ]);
  });

  it('appends a pending substep state when the frame has none yet', () => {
    const reserved = reserveInlineChild({
      substepStates: [],
      stepName: '1',
      substepId: '2',
      runbook: 'child.runbook.md',
      frameKey: '1|2' as FrameKey,
      entry: 3,
      templateVars: brandInitialTemplateVars({}),
      variables: {},
      forStack: [],
      runId: CHILD,
    });
    expect(reserved).toEqual([
      expect.objectContaining({ id: '2', frameKey: '1|2', status: 'pending' }),
    ]);
    expect(reserved[0]?.child?.entry).toBe(3);
  });
});

describe('currentInlineReservation', () => {
  const frameKey = '1|' as FrameKey;

  it('counts the reservation of the cursor’s substep, frame and active entry', () => {
    const states: SubstepState[] = [
      { id: '1', frameKey, status: 'pending', child: reservation({ runId: OTHER }) },
      {
        id: '2',
        frameKey: '1|7' as FrameKey,
        status: 'pending',
        child: reservation({ runId: OTHER }),
      },
      { id: '2', frameKey, status: 'pending', child: reservation() },
    ];
    expect(currentInlineReservation(stateAt(states))?.runId).toBe(CHILD);
  });

  it('counts nothing from an earlier entry: that child is stale', () => {
    const states: SubstepState[] = [
      { id: '2', frameKey, status: 'pending', child: reservation({ entry: 1 }) },
    ];
    expect(currentInlineReservation(stateAt(states))).toBeUndefined();
  });

  it('counts nothing off a substep, before any entry, or without substep states', () => {
    const states: SubstepState[] = [{ id: '2', frameKey, status: 'pending', child: reservation() }];
    expect(currentInlineReservation(stateAt(states, { substep: undefined }))).toBeUndefined();
    expect(currentInlineReservation(stateAt(states, { activeEntry: undefined }))).toBeUndefined();
    expect(currentInlineReservation(stateAt([], { substepStates: undefined }))).toBeUndefined();
    expect(
      currentInlineReservation(stateAt([{ id: '2', frameKey, status: 'pending' }])),
    ).toBeUndefined();
  });
});

describe('childResultOf', () => {
  it('reads completed as pass, stopped and abandoned as fail, and running as no result', () => {
    expect(childResultOf('completed')).toBe('pass');
    expect(childResultOf('stopped')).toBe('fail');
    expect(childResultOf('abandoned')).toBe('fail');
    expect(childResultOf('running')).toBeUndefined();
    expect(childResultOf(undefined)).toBeUndefined();
  });
});
