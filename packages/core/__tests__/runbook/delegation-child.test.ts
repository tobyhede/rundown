import { describe, expect, it } from '@jest/globals';
import {
  activeEntryDelegations,
  countsDelegation,
  delegatedRunbookOf,
  findTicketReservation,
  recordClaimTickets,
  reserveDelegationChildren,
} from '../../src/runbook/delegation-child.js';
import { brandEffectiveVars } from '../../src/runbook/effective-vars.js';
import { assertRunId, type RunId } from '../../src/runbook/run-id.js';
import { generateClaimTicket, hashRunSecret } from '../../src/runbook/run-secrets.js';
import type { FrameKey } from '../../src/runbook/targeting.js';
import type { ContextSnapshot, RunbookState, SubstepState } from '../../src/runbook/types.js';
import { createRunbook } from './fixtures.js';

// A Delegation's Current Children (#904) as pure computation: which substeps
// delegate, what an entry reserves, which reservations the parent counts, and
// how issued tickets are recorded.

const [MIXED] = createRunbook(`## 1. Fan out
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 First
- DELEGATE
- a.runbook.md

### 1.2 By hand
- PASS CONTINUE

Do it.

### 1.3 Last
- DELEGATE
- b.runbook.md
`);

const FRAME = '1|' as FrameKey;

function ids(): () => RunId {
  let next = 0;
  return () => assertRunId(`rd_${String(++next).padStart(32, '0')}`);
}

function snapshot(substep: string): ContextSnapshot {
  return { vars: brandEffectiveVars({}), ancestors: [], step: '1', substep };
}

function reserve(substepStates: readonly SubstepState[], substepId: string, entry: number) {
  return reserveDelegationChildren({
    substepStates,
    step: MIXED,
    substepId,
    frameKey: FRAME,
    entry,
    mintRunId: ids(),
    contextFor: snapshot,
  });
}

function view(substepStates: readonly SubstepState[], entry = 1) {
  return { substepStates, activeFrameKey: FRAME, activeEntry: entry };
}

describe('delegatedRunbookOf', () => {
  it('names the runbook of a DELEGATE substep only', () => {
    expect(delegatedRunbookOf(MIXED, '1')).toBe('a.runbook.md');
    expect(delegatedRunbookOf(MIXED, '2')).toBeUndefined();
    expect(delegatedRunbookOf(MIXED, '3')).toBe('b.runbook.md');
  });
});

describe('reserveDelegationChildren', () => {
  it('reserves the entered delegated substep and every later one, each with its own context', () => {
    const reserved = reserve([], '1', 1);
    expect(reserved.map((substepState) => [substepState.id, substepState.child?.kind])).toEqual([
      ['1', 'delegation'],
      ['3', 'delegation'],
    ]);
    const [first, last] = activeEntryDelegations(view(reserved));
    expect(first.reservation).toMatchObject({ runbook: 'a.runbook.md', ticketHash: null });
    expect(last.reservation.contextSnapshot.substep).toBe('3');
  });

  it('leaves an entry’s reservations alone when the cursor moves on within it', () => {
    const reserved = reserve([], '1', 1);
    expect(reserve(reserved, '3', 1)).toEqual(reserved);
  });

  it('reserves afresh on a later entry, replacing the stale reservations', () => {
    const first = reserve([], '1', 1);
    const second = reserve(first, '1', 2);
    expect(activeEntryDelegations(view(second, 1))).toEqual([]);
    expect(activeEntryDelegations(view(second, 2))).toHaveLength(2);
  });
});

describe('countsDelegation', () => {
  it('counts the cursor’s substep and later ones, not one the cursor has passed', () => {
    const delegations = activeEntryDelegations(view(reserve([], '1', 1)));
    const at = (substep: string) => ({ substep }) as Pick<RunbookState, 'substep'>;
    expect(delegations.map((d) => countsDelegation(at('1'), MIXED, d))).toEqual([true, true]);
    expect(delegations.map((d) => countsDelegation(at('2'), MIXED, d))).toEqual([false, true]);
  });
});

describe('recordClaimTickets', () => {
  it('records the hash on each unissued reservation, all or nothing', () => {
    const reserved = reserve([], '1', 1);
    const [first, last] = activeEntryDelegations(view(reserved));
    const ticketHash = hashRunSecret(generateClaimTicket());

    const issued = recordClaimTickets(view(reserved), [
      { childRunId: first.reservation.runId, ticketHash },
    ]);
    expect(issued).toBeDefined();
    expect(findTicketReservation({ substepStates: issued }, ticketHash)?.id).toBe('1');

    // A ticket for a reservation already issued, or for no reservation of the
    // active entry, records nothing at all.
    expect(
      recordClaimTickets(view(issued ?? []), [
        { childRunId: first.reservation.runId, ticketHash },
        { childRunId: last.reservation.runId, ticketHash },
      ]),
    ).toBeUndefined();
    expect(
      recordClaimTickets(view(reserved, 2), [{ childRunId: last.reservation.runId, ticketHash }]),
    ).toBeUndefined();
  });
});
