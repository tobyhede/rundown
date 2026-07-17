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
 * result. A claim leaves `idle` simply by its holder running a command that
 * advances the run.
 */
export interface ClaimActivity {
  /** ISO timestamp of the claim's last recorded progress. */
  readonly lastProgressAt: string;
  /** Milliseconds elapsed since that progress. */
  readonly idleFor: DurationMs;
  /** Advisory: no progress recorded for longer than the idle threshold. */
  readonly idle: boolean;
}

/**
 * Classify a claim's activity at an injected point in time.
 *
 * Pure: no I/O and no clock read — `now` is injected, so this cannot drift with
 * wall-clock behaviour in tests. Idle is strictly `idleFor > idleAfter`; exactly
 * at the threshold is still not idle. A `lastProgressAt` in the future
 * (writer/reader clock skew) clamps to zero rather than reporting a negative
 * duration.
 *
 * @param record - Persisted claim record carrying `lastProgressAt`.
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
 * @throws {RundownError} `CLAIM_PROGRESS_UNREADABLE` when `record.lastProgressAt`
 *   is not a parseable ISO timestamp. Deliberate: `Date.parse` yields `NaN`, every
 *   `NaN` comparison is false, so `idleFor > idleAfter` would be false and a DEAD
 *   claim would silently classify as progressing — a safety signal failing OPEN in
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
  // reported as CLAIM_PROGRESS_UNREADABLE either: that would blame this child's
  // record for the caller's broken clock. A RangeError is right — this is a code
  // bug (every call site injects `new Date()`), and the read boundaries
  // deliberately rethrow it rather than labelling a child `unreadable`.
  if (Number.isNaN(now.getTime())) {
    throw new RangeError('claimActivity requires a valid `now`; received an Invalid Date');
  }
  const lastProgress = Date.parse(record.lastProgressAt);
  if (Number.isNaN(lastProgress)) {
    // Via the factory, never `new RundownError`. The factory is also where the
    // render-visible context keys are chosen, so the key-list trap is solved in
    // exactly one place.
    throw Errors.claimProgressUnreadable(record.claimKey, record.lastProgressAt);
  }
  const idleFor = assertDurationMs(Math.max(0, now.getTime() - lastProgress));
  return {
    lastProgressAt: record.lastProgressAt,
    idleFor,
    idle: idleFor > idleAfter,
  };
}

/**
 * Narrow an unknown error to the "claim progress unreadable" case (#519).
 *
 * The read boundaries (plan 3) contain THIS and rethrow everything else, so they
 * need one predicate rather than a hand-rolled `instanceof` plus a literal code
 * comparison at each site. Exported for exactly that reason: this design argues
 * that discrimination must not hinge on a re-wordable message, and a code literal
 * copied into every caller is the same defect one level down — `'RD-824'` is
 * re-numberable, and a renumber would silently turn contained corruption back into
 * an unhandled throw out of a read-only command. The code lives in ONE place
 * (`ErrorCodes.CLAIM_PROGRESS_UNREADABLE`) and callers ask this question instead.
 *
 * Built on the generic {@link isRundownErrorCode} rather than hand-rolling the
 * `instanceof` + code comparison, so the "discriminate on the code, never on a
 * message" guarantee has ONE implementation for RD-824 and every code after it.
 *
 * @param error - Any thrown value.
 * @returns True when `error` is the typed CLAIM_PROGRESS_UNREADABLE RundownError.
 */
export function isClaimProgressUnreadable(error: unknown): error is RundownError {
  return isRundownErrorCode(error, ErrorCodes.CLAIM_PROGRESS_UNREADABLE.code);
}
