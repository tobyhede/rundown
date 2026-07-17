import { describe, expect, it } from '@jest/globals';
import {
  claimActivity,
  isClaimProgressUnreadable,
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
function claimAt(lastProgressAt: string): ClaimRecord {
  return makeClaimRecord({ lastProgressAt });
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
    expect(activity.lastProgressAt).toBe('2026-07-16T00:00:00.000Z');
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

  it('clamps a future lastProgressAt to zero idle rather than reporting negative', () => {
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

  it('reports zero idle when now EQUALS lastProgressAt', () => {
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
    // for a claim whose progress is this instant.
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
    // `lastProgressAt` is `z.string().min(1)` on disk — nothing constrains it to
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
    expect(record.lastProgressAt).toBe('2026-07-16T00:00:00.000Z');
  });

  it('throws CLAIM_PROGRESS_UNREADABLE on an unparseable lastProgressAt rather than reporting not-idle (AC6)', () => {
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
    expect(isClaimProgressUnreadable(thrown)).toBe(true);
    // The code literal is pinned HERE and nowhere else in the codebase: production
    // asks `isClaimProgressUnreadable`. This line is the deliberate place a
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

  it('rejects an Invalid Date `now` as a CALLER error, not as an unreadable record', () => {
    // A broken clock is a code bug, not corrupt persisted data. Two things must
    // hold, and both are load-bearing:
    //  1. It must NOT be CLAIM_PROGRESS_UNREADABLE — that would blame this child's
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
    expect(isClaimProgressUnreadable(thrown)).toBe(false);
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

  it('isClaimProgressUnreadable rejects unrelated errors', () => {
    // Guards the guard: it must not swallow an assertDurationMs RangeError or a
    // plain Error, or the read boundaries would contain bugs as though they were
    // corrupt data.
    expect(
      isClaimProgressUnreadable(new RangeError('DurationMs must be a non-negative finite number')),
    ).toBe(false);
    expect(isClaimProgressUnreadable(new Error('unrelated'))).toBe(false);
    expect(isClaimProgressUnreadable(undefined)).toBe(false);
  });

  it('is a RundownError with a DIFFERENT code, and the predicate still says no', () => {
    // The predicate must discriminate on the CODE, not merely on `instanceof
    // RundownError`. Without this case, `error instanceof RundownError && <code
    // check>` -> `error instanceof RundownError` survives: every RundownError would
    // report as claim-progress-unreadable, and plan 3's read boundary would contain
    // unrelated failures as though a child's record were corrupt.
    expect(isClaimProgressUnreadable(Errors.noActiveRunbook())).toBe(false);
  });

  it('defaults the idle threshold to one hour', () => {
    expect(DEFAULT_IDLE_AFTER_MS).toBe(3_600_000);
  });
});
