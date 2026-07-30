// packages/cli/src/helpers/claim-refusal.ts
//
// The single CLI mapping of the refusal arms `stashForClaimId` and
// `unstashForClaimId` return identically.
//
// `stash --claim-id` and `pop --claim-id` present the same bearer to two
// mirrored core methods, and six of their refusal arms — `missing-claim`,
// `missing-child`, `terminal-child`, `child-linkage-mismatch`,
// `parent-missing`, `superseded` — describe the same condition in the same
// words under the same code. Core's own `SessionService.describeSupersession`
// states the reason that mapping lives in exactly one place: "Two copies of
// this mapping would be two places for the taxonomy to drift." It had already
// drifted once — `pop.ts` reaches `child-linkage-mismatch` from a
// `!claim.delegation` guard that `stash.ts` does not have, because `stash
// --claim-id` also accepts a run-control bearer.
//
// Each command keeps its own mapper for its command-specific arms (`pop`'s
// `not-stashed`; `stash`'s `already-stashed` and `slot-occupied`) and delegates
// the shared six here. Both mappers keep their `default: const _exhaustive:
// never = result` arm, so an arm core adds to either union is still a compile
// error at both call sites rather than something this helper silently absorbs.
//
// Unlike `session-mutation-result.ts`, this module imports runtime VALUES from
// `@rundown-org/core` (`describeSupersededClaim`, `redactClaimId`), which is
// why it is its own module rather than an addition to that one. It is reachable
// only from `stash.ts` and `pop.ts`, and both already import those same values
// directly, so it adds no core-barrel dependency to a suite that did not have
// one.

import {
  describeSupersededClaim,
  redactClaimId,
  type ClaimId,
  type StaleClaimRefusalCode,
  type StashForClaimIdResult,
  type UnstashForClaimIdResult,
} from '@rundown-org/core';

/** Message and symbolic code a claim refusal is emitted under. */
export interface ClaimRefusalEnvelope {
  /** Human-readable explanation, naming the claim by its redacted lookup key. */
  readonly message: string;
  /** Registered symbolic code for `OutputEmitter.error`. */
  readonly code: StaleClaimRefusalCode;
}

/** Refusal statuses `stashForClaimId` and `unstashForClaimId` both produce. */
type SharedClaimRefusalStatus =
  | 'missing-claim'
  | 'missing-child'
  | 'terminal-child'
  | 'child-linkage-mismatch'
  | 'parent-missing'
  | 'superseded';

/**
 * The refusal arms both claim-targeted session mutations share.
 *
 * Derived from core's two unions rather than restated, so a field added to (or
 * removed from) one of these arms reaches this mapping without a second
 * declaration to keep in step. A *status* core adds is deliberately not picked
 * up — the literal list above is the whole shared taxonomy, and anything
 * outside it lands on each command mapper's own exhaustiveness guard, where the
 * command author decides whether it is shared or command-specific.
 */
export type SharedClaimRefusal = Extract<
  StashForClaimIdResult | UnstashForClaimIdResult,
  { readonly status: SharedClaimRefusalStatus }
>;

/**
 * Envelope a claim refusal under the generic unavailable code.
 *
 * Shared with the command-specific arms (`not-stashed`, `already-stashed`),
 * which carry the same code and differ only in wording.
 *
 * @param message - Human-readable explanation naming the redacted claim key.
 * @returns The refusal envelope under `CLAIMED_RUNBOOK_UNAVAILABLE`.
 */
export function claimUnavailable(message: string): ClaimRefusalEnvelope {
  return { message, code: 'CLAIMED_RUNBOOK_UNAVAILABLE' };
}

/**
 * Map a refusal arm shared by `stashForClaimId` and `unstashForClaimId`.
 *
 * RD-825 handling lives here for both commands: core owns the superseded
 * wording and code, so a superseded bearer carries the no-retry signal rather
 * than a generic unavailable envelope.
 *
 * @param claimId - Bearer the caller presented; only its redacted key is shown.
 * @param result - One of the shared refusal arms returned by either method.
 * @returns Message and symbolic code for `OutputEmitter.error`.
 */
export function sharedClaimRefusal(
  claimId: ClaimId,
  result: SharedClaimRefusal,
): ClaimRefusalEnvelope {
  // User- and log-facing refusal: identify the claim by its non-secret lookup
  // key, never the bearer `claimId` (which carries the live secret segment).
  const claimKey = redactClaimId(claimId);
  switch (result.status) {
    case 'missing-claim':
      return claimUnavailable(`Claim id ${claimKey} does not exist.`);
    case 'missing-child':
      return claimUnavailable(
        `Claim id ${claimKey} no longer has readable child runbook state. Recover with \`rundown prune\` and restart from source.`,
      );
    case 'terminal-child':
      return claimUnavailable(
        `Claim id ${claimKey} points at a ${result.lifecycle} child runbook.`,
      );
    case 'child-linkage-mismatch':
      return claimUnavailable(`Claim id ${claimKey} is no longer linked to its child runbook.`);
    case 'parent-missing':
      return claimUnavailable(`Claim id ${claimKey} parent runbook is missing.`);
    case 'superseded':
      return describeSupersededClaim(claimKey, result.reason);
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}
