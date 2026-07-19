import { describe, expect, it } from '@jest/globals';
import {
  claimActivity,
  isClaimSeenUnreadable,
  DEFAULT_IDLE_AFTER_MS,
} from '../../src/runbook/claim-activity.js';
import { assertDurationMs } from '../../src/runbook/duration.js';
import { getErrorMessage } from '../../src/errors.js';
import { Errors } from '../../src/errors/factory.js';
import { RundownError } from '../../src/errors/rundown-error.js';
import type { ClaimRecord } from '../../src/runbook/claim-id.js';
import { makeClaimRecord } from '../../src/testing/claim-fixtures.js';

// Reuses the shared factory rather than spelling the record shape out again —
// this suite would otherwise be a thirteenth hand-maintained fixture, i.e.
// exactly the problem that factory exists to end.
function claimAt(lastSeenAt: string): ClaimRecord {
  return makeClaimRecord({ lastSeenAt });
}

const ONE_HOUR = assertDurationMs(60 * 60 * 1000);

describe('claimActivity (#519)', () => {
  it('reports not-idle before the threshold', () => {
    const activity = claimActivity(
      claimAt('2026-07-16T00:00:00.000Z'),
      new Date('2026-07-16T00:59:59.999Z'),
      ONE_HOUR,
    );
    expect(activity.idle).toBe(false);
    expect(activity.idleFor).toBe(3_599_999);
    expect(activity.lastSeenAt).toBe('2026-07-16T00:00:00.000Z');
  });

  it('reports not-idle EXACTLY at the threshold', () => {
    // The boundary is strict: idle iff idleFor > idleAfter. Exactly at the
    // threshold is still not idle. This case kills the `>` -> `>=` mutant.
    const activity = claimActivity(
      claimAt('2026-07-16T00:00:00.000Z'),
      new Date('2026-07-16T01:00:00.000Z'),
      ONE_HOUR,
    );
    expect(activity.idle).toBe(false);
    expect(activity.idleFor).toBe(3_600_000);
  });

  it('reports idle one millisecond past the threshold', () => {
    const activity = claimActivity(
      claimAt('2026-07-16T00:00:00.000Z'),
      new Date('2026-07-16T01:00:00.001Z'),
      ONE_HOUR,
    );
    expect(activity.idle).toBe(true);
    expect(activity.idleFor).toBe(3_600_001);
  });

  it('clamps a future lastSeenAt to zero idle rather than reporting negative', () => {
    // Clock skew between the writer and the reader must not produce a negative
    // duration; the holder cannot be "less than zero" idle.
    const activity = claimActivity(
      claimAt('2026-07-16T02:00:00.000Z'),
      new Date('2026-07-16T01:00:00.000Z'),
      ONE_HOUR,
    );
    expect(activity.idle).toBe(false);
    expect(activity.idleFor).toBe(0);
  });

  it('reports zero idle when now EQUALS lastSeenAt', () => {
    // Distinct from the skew clamp above: that one exercises Math.max's negative
    // branch, this one its identity path. Together they pin both sides of the clamp.
    const activity = claimActivity(
      claimAt('2026-07-16T00:00:00.000Z'),
      new Date('2026-07-16T00:00:00.000Z'),
      ONE_HOUR,
    );
    expect(activity.idle).toBe(false);
    expect(activity.idleFor).toBe(0);
  });

  it('treats every non-zero elapsed as idle when idleAfter is zero', () => {
    // `assertDurationMs(0)` is legal, so a zero threshold is a reachable input. This is a
    // SECOND, independent killer of `>` -> `>=`: at zero, the mutant reports idle
    // for a claim whose observation is this instant.
    const zero = assertDurationMs(0);
    expect(
      claimActivity(claimAt('2026-07-16T00:00:00.000Z'), new Date('2026-07-16T00:00:00.000Z'), zero)
        .idle,
    ).toBe(false);
    expect(
      claimActivity(claimAt('2026-07-16T00:00:00.000Z'), new Date('2026-07-16T00:00:00.001Z'), zero)
        .idle,
    ).toBe(true);
  });

  it('parses a non-Zulu ISO offset rather than treating it as unreadable', () => {
    // `lastSeenAt` is `z.string().min(1)` on disk — nothing constrains it to
    // Zulu, and `Date.parse` accepts offsets. The property suite generates ONLY
    // Zulu (it builds via `.toISOString()`), so this input class is unreachable
    // there. A lexical comparison, or a parser that rejected offsets, would send a
    // healthy claim down the RD-824 path and report it `unreadable` — the fail-open's
    // mirror image: a live claim libelled as corrupt.
    // 2026-07-16T10:00:00+10:00 IS 2026-07-16T00:00:00Z — exactly at the threshold
    // from 2026-07-16T01:00:00Z, so a broken parse cannot coincidentally pass.
    const activity = claimActivity(
      claimAt('2026-07-16T10:00:00.000+10:00'),
      new Date('2026-07-16T01:00:00.000Z'),
      ONE_HOUR,
    );
    expect(activity.idle).toBe(false);
    expect(activity.idleFor).toBe(3_600_000);
  });

  it('behaves at the boundary of DEFAULT_IDLE_AFTER_MS itself, not just a local ONE_HOUR', () => {
    // Every other case drives the local `ONE_HOUR` literal; the default is only
    // asserted equal to 3_600_000 elsewhere. If the default were re-pointed at a
    // different value, no test would exercise the SHIPPED threshold at its own
    // boundary — the one an operator actually gets.
    expect(
      claimActivity(
        claimAt('2026-07-16T00:00:00.000Z'),
        new Date('2026-07-16T01:00:00.000Z'),
        DEFAULT_IDLE_AFTER_MS,
      ).idle,
    ).toBe(false);
    expect(
      claimActivity(
        claimAt('2026-07-16T00:00:00.000Z'),
        new Date('2026-07-16T01:00:00.001Z'),
        DEFAULT_IDLE_AFTER_MS,
      ).idle,
    ).toBe(true);
  });

  it('is pure: the same inputs always yield the same output and the record is untouched', () => {
    const record = claimAt('2026-07-16T00:00:00.000Z');
    const now = new Date('2026-07-16T00:30:00.000Z');
    expect(claimActivity(record, now, ONE_HOUR)).toEqual(claimActivity(record, now, ONE_HOUR));
    expect(record.lastSeenAt).toBe('2026-07-16T00:00:00.000Z');
  });

  it('throws CLAIM_SEEN_UNREADABLE on an unparseable lastSeenAt rather than reporting not-idle (AC6)', () => {
    // THE fail-open case. `Date.parse` yields NaN on a corrupt timestamp, and every
    // NaN comparison is false — so `idleFor > idleAfter` would be false and a DEAD
    // claim would silently classify as not-idle. That is a safety signal failing
    // open, quietly, in exactly the case it exists to catch. Corrupt persisted state
    // is rejected, never interpreted.
    //
    // Asserted on the CODE, not a message substring: `assertDurationMs` throws out
    // of this same function, so a substring match is the only thing separating them
    // — and a harmless reword would gut this test while it stays green.
    let thrown: unknown;
    try {
      claimActivity(claimAt('not-a-date'), new Date(), ONE_HOUR);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RundownError);
    // The predicate the read boundaries actually use — pinned on the same throw
    // they contain, so the guard and the containment cannot drift apart.
    expect(isClaimSeenUnreadable(thrown)).toBe(true);
    // The code literal is pinned HERE and nowhere else in the codebase: production
    // asks `isClaimSeenUnreadable`. This line is the deliberate place a
    // renumber has to be acknowledged.
    expect((thrown as RundownError).code).toBe('RD-824');
  });

  it('renders the corrupt value and the claim key INTO the error message (AC6 loudness)', () => {
    // Not a duplicate of the case above, and not cosmetic. `RundownError.formatMessage`
    // renders a FIXED twelve-key list (rundown-error.ts:99-134); any other context key
    // lands in `context`, reachable only via toJSON(), and is invisible in `.message`.
    // `ErrorContext`'s index signature means TypeScript will NOT catch the mistake —
    // so nothing but this assertion stands between a "loud" error and one whose
    // message is the bare title with no corrupt value and nothing to correlate.
    //
    // Note `value` and `childId` alone are NOT enough: formatMessage's primary
    // identifier is `value ?? scenario ?? argName ?? childId ?? agentId` — only ONE
    // wins, so `childId` renders only when `value` is absent. The claim key reaches
    // the message through the `message` key; `childId` remains the structured
    // correlation slot in `context`/`toJSON()`.
    let thrown: unknown;
    try {
      claimActivity(claimAt('not-a-date'), new Date(), ONE_HOUR);
    } catch (error) {
      thrown = error;
    }
    const message = getErrorMessage(thrown);
    expect(message).toContain('not-a-date');
    expect(message).toContain(makeClaimRecord().claimKey);
  });

  it('rejects a CALENDAR-INVALID lastSeenAt rather than silently normalizing it (AC6)', () => {
    // `Date.parse` does NOT reject impossible dates — it NORMALIZES them. Verified
    // on Node 24: '2026-02-30T00:00:00.000Z' parses to 2026-03-02, and
    // '2026-02-31' to 2026-03-03. So a corrupt record silently becomes a real
    // instant up to two days away, and `idleFor` is computed from a date that was
    // never written. That is the AC6 fail-open arriving through parser leniency
    // instead of NaN: a dead claim can read not-idle. Corrupt persisted state is
    // rejected, never interpreted — including when the parser is willing to guess.
    for (const corrupt of [
      '2026-02-30T00:00:00.000Z',
      '2026-02-31T00:00:00.000Z',
      '2026-04-31T00:00:00.000Z',
      '2026-00-10T00:00:00.000Z',
      '2026-01-32T00:00:00.000Z',
    ]) {
      expect(() => claimActivity(claimAt(corrupt), new Date(), ONE_HOUR)).toThrow(RundownError);
    }
  });

  it('rejects OUT-OF-RANGE time-of-day and offset fields rather than normalizing them (AC6)', () => {
    // Distinct from the calendar-invalid case above, which covers only impossible
    // month/day. These pin the time-of-day and offset field checks, and the split
    // between them is load-bearing, not decorative:
    //
    //  - `2026-07-16T24:00:00.000Z` is the one that MATTERS. `Date.parse` does NOT
    //    reject hour 24 — verified on Node 24, it NORMALIZES it to next-day
    //    midnight and returns a valid instant. So the `hour > 23` field check is
    //    the SOLE guard against this AC6 fail-open; without it a corrupt hour reads
    //    as a real instant a day away and a dead claim can read not-idle. Drop the
    //    clause and only this assertion goes red.
    //  - `:00:00:60` (leap second) and the out-of-range offsets are already caught
    //    by the trailing `Number.isNaN(Date.parse(...))` gate today, so their field
    //    checks are defense-in-depth. Pinned here so the layered rejection is
    //    intentional rather than incidental to `Date.parse`'s current behaviour.
    for (const corrupt of [
      '2026-07-16T24:00:00.000Z', // hour 24 — the load-bearing case
      '2026-07-16T00:60:00.000Z', // minute 60
      '2026-07-16T00:00:60.000Z', // second 60 (leap second)
      '2026-07-16T00:00:00.000+00:60', // offset minute 60
      '2026-07-16T00:00:00.000+99:00', // offset hour 99
    ]) {
      expect(() => claimActivity(claimAt(corrupt), new Date(), ONE_HOUR)).toThrow(RundownError);
    }
  });

  it('rejects a lastSeenAt with NO offset, which would be host-timezone dependent (AC6)', () => {
    // `Date.parse('2026-07-16T00:00:00.000')` (no Z, no offset) is interpreted in
    // the HOST timezone per ECMA-262, so the same persisted record would yield a
    // different `idleFor` on two machines — an environment-dependent safety signal.
    // The writer always emits `toISOString()` (Zulu), so an offsetless value is by
    // definition not something this system wrote: reject it.
    expect(() => claimActivity(claimAt('2026-07-16T00:00:00.000'), new Date(), ONE_HOUR)).toThrow(
      RundownError,
    );
  });

  it('rejects a non-ISO but Date.parse-able lastSeenAt (AC6)', () => {
    // `Date.parse('March 5 2026')` succeeds via legacy fallback parsing, which is
    // implementation-defined. `lastSeenAt` is an ISO timestamp by contract; a
    // value only a lenient parser accepts is corrupt, not merely unusual.
    for (const corrupt of ['March 5 2026', '07/16/2026', '2026-07-16 00:00:00']) {
      expect(() => claimActivity(claimAt(corrupt), new Date(), ONE_HOUR)).toThrow(RundownError);
    }
  });

  it('rejects an Invalid Date `now` as a CALLER error, not as an unreadable record', () => {
    // A broken clock is a code bug, not corrupt persisted data. Two things must
    // hold, and both are load-bearing:
    //  1. It must NOT be CLAIM_SEEN_UNREADABLE — that would blame this child's
    //     record for the caller's bug and send the reader to the wrong place (and
    //     the read boundaries would silently swallow it as `unreadable`).
    //  2. It must be discriminable BY TYPE, not by message. `RangeError` is the
    //     repo's precedent for a caller precondition (assertPositiveEntry,
    //     targeting.ts:44-48), and it is what lets plan 3's read boundary sort the
    //     three throws — RundownError (contain), RangeError (rethrow), other
    //     (rethrow) — with no substring matching anywhere.
    let thrown: unknown;
    try {
      claimActivity(claimAt('2026-07-16T00:00:00.000Z'), new Date('nonsense'), ONE_HOUR);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RangeError);
    expect(isClaimSeenUnreadable(thrown)).toBe(false);
    //  3. It must blame `now`. Type alone is NOT enough to pin this guard: delete
    //     the guard entirely and an Invalid Date still throws a RangeError — from
    //     `assertDurationMs`, because Math.max(0, NaN) is NaN — so the two
    //     assertions above pass with the guard GONE. That is exactly the mutant
    //     (`if (false)`) this case exists to kill, and only the message
    //     distinguishes "your clock is broken" from "the duration is negative",
    //     which is the whole reason the guard is separate. Asserting a message
    //     here is not the message-substring discrimination this design bans:
    //     that ban is on PRODUCTION control flow, and the ban is precisely why
    //     the two throws must stay distinguishable to a human reader.
    expect(getErrorMessage(thrown)).toContain('now');
  });

  it('isClaimSeenUnreadable rejects unrelated errors', () => {
    // Guards the guard: it must not swallow an assertDurationMs RangeError or a
    // plain Error, or the read boundaries would contain bugs as though they were
    // corrupt data.
    expect(
      isClaimSeenUnreadable(new RangeError('DurationMs must be a non-negative finite number')),
    ).toBe(false);
    expect(isClaimSeenUnreadable(new Error('unrelated'))).toBe(false);
    expect(isClaimSeenUnreadable(undefined)).toBe(false);
  });

  it('is a RundownError with a DIFFERENT code, and the predicate still says no', () => {
    // The predicate must discriminate on the CODE, not merely on `instanceof
    // RundownError`. Without this case, `error instanceof RundownError && <code
    // check>` -> `error instanceof RundownError` survives: every RundownError would
    // report as claim-seen-unreadable, and plan 3's read boundary would contain
    // unrelated failures as though a child's record were corrupt.
    expect(isClaimSeenUnreadable(Errors.noActiveRunbook())).toBe(false);
  });

  it('defaults the idle threshold to one hour', () => {
    expect(DEFAULT_IDLE_AFTER_MS).toBe(3_600_000);
  });
});
