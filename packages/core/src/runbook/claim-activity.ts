import { ErrorCodes } from '../errors/codes.js';
import { Errors } from '../errors/factory.js';
import type { RundownError } from '../errors/rundown-error.js';
import { isRundownErrorCode } from '../errors.js';
import type { ClaimRecord } from './claim-id.js';
import { assertDurationMs, type DurationMs } from './duration.js';

/**
 * Threshold after which a claim is reported idle: one hour.
 *
 * Deliberately six times more generous than Kubernetes' 10-minute
 * `progressDeadlineSeconds` default, because a delegated agent step legitimately
 * runs far longer than a rollout. The asymmetry is intentional: reporting idle
 * too late costs a delayed check, while reporting it too early trains the reader
 * to ignore an advisory label — the one failure mode that cannot be corrected by
 * acting on it. There is deliberately no configuration surface (YAGNI); adding
 * one later is purely additive.
 */
export const DEFAULT_IDLE_AFTER_MS: DurationMs = assertDurationMs(60 * 60 * 1000);

/**
 * Derived, advisory activity of a claim at a point in time.
 *
 * A readonly interface, deliberately NOT a discriminated union. Type-driven
 * dispatch calls for unions whose variants carry DIFFERENT data and so force
 * callers to narrow; a two-member union with identical fields forces nothing —
 * every consumer flattens it straight back to a boolean, which is what this
 * already is. The union that earns its keep in this design is `ChildActivity`
 * at the read boundary (`known` | `unreadable`), whose members genuinely differ.
 *
 * Purely advisory — `idle` expires nothing, reclaims nothing, and synthesizes no
 * result. A claim leaves `idle` simply by its holder presenting its bearer as
 * authority and passing bearer verification plus relevant grant authorization.
 */
export interface ClaimActivity {
  /** ISO timestamp of the claim holder's last authorized bearer presentation. */
  readonly lastSeenAt: string;
  /** Milliseconds elapsed since that observation. */
  readonly idleFor: DurationMs;
  /** Advisory: the holder has not been seen for longer than the idle threshold. */
  readonly idle: boolean;
}

/**
 * Strict RFC 3339 / ISO 8601 instant: `YYYY-MM-DDThh:mm:ss[.frac](Z|±hh:mm)`.
 *
 * An OFFSET IS MANDATORY. `Date.parse` reads a date-time with no offset in the
 * HOST timezone (ECMA-262), so the same persisted record would derive a different
 * `idleFor` on two machines — an environment-dependent safety signal. Every value
 * this system writes comes from `toISOString()`, so an offsetless value is by
 * definition not one it wrote.
 */
const ISO_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

/**
 * Parse a claim timestamp, rejecting anything the contract does not permit.
 *
 * `Date.parse` ALONE IS NOT ENOUGH, and the gap is not theoretical — verified on
 * Node 24:
 * - It NORMALIZES impossible calendar dates rather than rejecting them:
 *   `2026-02-30T00:00:00.000Z` becomes 2026-03-02, `2026-02-31` becomes 2026-03-03.
 *   A corrupt record silently becomes a real instant up to two days from what was
 *   written, and `idleFor` is then computed from a date nothing ever recorded — so a
 *   DEAD claim can read not-idle. That is the AC6 fail-open arriving through parser
 *   leniency instead of `NaN`, and it is the failure this module exists to prevent.
 * - It accepts implementation-defined legacy forms (`March 5 2026`, `07/16/2026`).
 * - It reads offsetless date-times in the host timezone (see {@link ISO_INSTANT_PATTERN}).
 *
 * Calendar validity is checked from the LITERAL fields, never by round-tripping the
 * parsed instant: with an offset such as `+10:00` the UTC date legitimately differs
 * from the written date, so comparing normalized output would reject healthy records
 * — the mirror-image failure of libelling a live claim as corrupt.
 *
 * @param value - Raw persisted `lastSeenAt`.
 * @returns Milliseconds since the epoch, or `undefined` when `value` is not a valid
 *   strict ISO instant.
 */
function parseIsoInstant(value: string): number | undefined {
  const match = ISO_INSTANT_PATTERN.exec(value);
  if (!match) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return undefined;
  }
  // Day 0 of the NEXT month is the last day of this one, so this is leap-year
  // correct without a special case.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Classify a claim's activity at an injected point in time.
 *
 * Pure: no I/O and no clock read — `now` is injected, so this cannot drift with
 * wall-clock behaviour in tests. Idle is strictly `idleFor > idleAfter`; exactly
 * at the threshold is still not idle. A `lastSeenAt` in the future
 * (writer/reader clock skew) clamps to zero rather than reporting a negative
 * duration.
 *
 * @param record - Persisted claim record carrying `lastSeenAt`.
 * @param now - Injected observation time. MUST be a valid Date.
 * @param idleAfter - Threshold past which the claim is reported idle.
 * @returns The derived advisory activity.
 * @throws {RangeError} When `now` is an Invalid Date — a caller precondition
 *   failure, deliberately NOT contained by the read boundaries. Reporting a broken
 *   clock as this child's record being `unreadable` would blame the data for a code
 *   bug and send the reader to the wrong place. A `RangeError` per
 *   `assertPositiveEntry` (`targeting.ts:44-48`), so plan 3's read boundary
 *   discriminates the three throws BY TYPE — `RundownError` (contain), `RangeError`
 *   (rethrow, caller bug), anything else (rethrow) — with no message substring
 *   anywhere.
 * @throws {RundownError} `CLAIM_SEEN_UNREADABLE` when `record.lastSeenAt`
 *   is not a strict ISO instant — unparseable, calendar-invalid (`2026-02-30`),
 *   offsetless, or a legacy form only a lenient parser accepts. See
 *   {@link parseIsoInstant}: `Date.parse` normalizes impossible dates rather than
 *   rejecting them, which is the same fail-open one door down. Deliberate: every
 *   `NaN` comparison is false, so `idleFor > idleAfter` would be false and a DEAD
 *   claim would silently classify as live — a safety signal failing OPEN in
 *   exactly the case it exists to catch. Corrupt persisted state is rejected, never
 *   interpreted. TYPED rather than a bare `Error` because `assertDurationMs` throws
 *   from this same function: with both untyped, only a message substring would tell
 *   them apart, and a harmless reword would silently gut AC6 with every test still
 *   green. Callers contain this PER CHILD (never around a whole list).
 */
export function claimActivity(
  record: ClaimRecord,
  now: Date,
  idleAfter: DurationMs,
): ClaimActivity {
  // `now` is a CALLER precondition, not persisted data, so it is checked first and
  // separately. An Invalid Date yields NaN from getTime(), and Math.max(0, NaN) is
  // NaN, so without this guard the failure surfaces from `assertDurationMs` as
  // "DurationMs must be a non-negative finite number" — a message that blames the
  // duration and sends the reader hunting in the wrong place. It must NOT be
  // reported as CLAIM_SEEN_UNREADABLE either: that would blame this child's
  // record for the caller's broken clock. A RangeError is right — this is a code
  // bug (every call site injects `new Date()`), and the read boundaries
  // deliberately rethrow it rather than labelling a child `unreadable`.
  if (Number.isNaN(now.getTime())) {
    throw new RangeError('claimActivity requires a valid `now`; received an Invalid Date');
  }
  const lastSeen = parseIsoInstant(record.lastSeenAt);
  if (lastSeen === undefined) {
    // Via the factory, never `new RundownError`. The factory is also where the
    // render-visible context keys are chosen, so the key-list trap is solved in
    // exactly one place.
    throw Errors.claimSeenUnreadable(record.claimKey, record.lastSeenAt);
  }
  const idleFor = assertDurationMs(Math.max(0, now.getTime() - lastSeen));
  return {
    lastSeenAt: record.lastSeenAt,
    idleFor,
    idle: idleFor > idleAfter,
  };
}

/**
 * Narrow an unknown error to the "claim seen timestamp unreadable" case (#519).
 *
 * The read boundaries (plan 3) contain THIS and rethrow everything else, so they
 * need one predicate rather than a hand-rolled `instanceof` plus a literal code
 * comparison at each site. Exported for exactly that reason: this design argues
 * that discrimination must not hinge on a message someone may reword, and a code literal
 * copied into every caller is the same defect one level down — `'RD-824'` is
 * re-numberable, and a renumber would silently turn contained corruption back into
 * an unhandled throw out of a read-only command. The code lives in ONE place
 * (`ErrorCodes.CLAIM_SEEN_UNREADABLE`) and callers ask this question instead.
 *
 * Built on the generic {@link isRundownErrorCode} rather than hand-rolling the
 * `instanceof` + code comparison, so the "discriminate on the code, never on a
 * message" guarantee has ONE implementation for RD-824 and every code after it.
 *
 * @param error - Any thrown value.
 * @returns True when `error` is the typed CLAIM_SEEN_UNREADABLE RundownError.
 */
export function isClaimSeenUnreadable(error: unknown): error is RundownError {
  return isRundownErrorCode(error, ErrorCodes.CLAIM_SEEN_UNREADABLE.code);
}
