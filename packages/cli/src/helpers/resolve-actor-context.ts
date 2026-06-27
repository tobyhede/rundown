// packages/cli/src/helpers/resolve-actor-context.ts

import {
  type ActorContext,
  type ActorContextSource,
  type ClaimId,
  type DelegationTokenHash,
  type RunId,
  type RunbookState,
  UNKNOWN_ACTOR_CONTEXT,
  claimControllerContext,
  trustedRunControllerContext,
} from '@rundown-org/core';

// Exhaustiveness anchor: a `Record<ActorContextSource, true>` forces this object
// to enumerate EVERY variant of the union — adding a variant to
// `ActorContextSource` fails to type-check here until the new key is added. This
// Record is the single source of truth; ACTOR_SOURCE_VALUES is DERIVED from its
// keys below, so a new variant flows into the runtime array automatically rather
// than relying on a hand-maintained array (a too-short `readonly
// ActorContextSource[]` literal would still compile — only the Record guard is
// load-bearing).
const ACTOR_SOURCE_PRESENCE: Record<ActorContextSource, true> = {
  'direct-cli': true,
  plugin: true,
  mcp: true,
};

/**
 * The valid actor-context source tags, in declaration order.
 *
 * This is the single source of truth for `--actor-source` / `RD_ACTOR_SOURCE`
 * validation, derived from {@link ACTOR_SOURCE_PRESENCE} so it stays exhaustive
 * against {@link ActorContextSource} by construction (`Object.keys` preserves the
 * literal insertion order, so the order pinned by the runtime test is stable).
 *
 * Frozen so the `readonly` type contract is enforced at runtime too: the exported
 * array backs `parseActorSource` validation, and an unfrozen array could be
 * mutated by a consumer and silently widen or narrow the accepted source set.
 */
export const ACTOR_SOURCE_VALUES = Object.freeze(
  Object.keys(ACTOR_SOURCE_PRESENCE),
) as readonly ActorContextSource[];

/**
 * Hard error raised when an `--actor-source` / `RD_ACTOR_SOURCE` value is not a
 * recognized {@link ActorContextSource}.
 *
 * Type-driven dispatch forbids a silent default: an unknown source must fail
 * loudly so a mis-tagged frontend is caught at ingress, not silently downgraded.
 */
export class InvalidActorSourceError extends Error {
  /** Stable machine-readable error code for the CLI error envelope. */
  readonly code = 'INVALID_ACTOR_SOURCE' as const;
  /** The rejected raw value, echoed back for diagnostics. */
  readonly value: string;

  /**
   * Construct the error with the rejected raw value.
   *
   * @param value - The rejected raw source string
   */
  constructor(value: string) {
    super(
      `Invalid --actor-source value "${value}". Expected one of: ${ACTOR_SOURCE_VALUES.join(', ')}.`,
    );
    this.name = 'InvalidActorSourceError';
    this.value = value;
  }
}

/**
 * Validate a raw source string against the frozen source set.
 *
 * @param raw - Raw value from `--actor-source` or `RD_ACTOR_SOURCE`
 * @returns The validated {@link ActorContextSource}
 * @throws {InvalidActorSourceError} when `raw` is not a recognized source
 */
export function parseActorSource(raw: string): ActorContextSource {
  if ((ACTOR_SOURCE_VALUES as readonly string[]).includes(raw)) {
    return raw as ActorContextSource;
  }
  throw new InvalidActorSourceError(raw);
}

/**
 * Caller evidence assembled by a CLI command before constructing actor context.
 *
 * All fields are optional: a bare workspace invocation supplies none and is
 * mapped to a trusted `direct-cli` run controller (the compatibility lane).
 */
export interface ActorIngress {
  /** Provenance tag from `--actor-source` / `RD_ACTOR_SOURCE`; defaults to `direct-cli`. */
  readonly source?: ActorContextSource;
  /** Claim id from `--claim-id`, when targeting a claimed delegated run. */
  readonly claimId?: ClaimId;
  /** Token hash bound to the claim, from existing claim-evidence plumbing. */
  readonly tokenHash?: DelegationTokenHash;
  /** Resolved claimed run id; defaults to the resolved target `state.id`. */
  readonly controlledRunId?: RunId;
}

/**
 * Map caller ingress + a resolved target run to a core {@link ActorContext}.
 *
 * Implements the frozen trust-mapping table:
 * - complete claim evidence (`claimId` AND `tokenHash`) => `claim_controller`,
 *   with `controlledRunId` defaulting to `state.id` (the resolved claimed run).
 *   `source` is provenance only and does not change the claim mapping.
 * - otherwise, a source tag (or the unset compatibility default) => a trusted
 *   run controller for `state.id`, tagged with the resolved source.
 * - partial/contradictory claim evidence with no resolvable controlled run =>
 *   `unknown` (reserved inspect-only fallback; type-reachable, never a default
 *   local path).
 *
 * Role derivation against a target stays in core (`deriveEffectiveRole`); this
 * adapter only records evidence.
 *
 * @param ingress - Caller evidence (source tag and optional claim evidence)
 * @param state - Resolved target run the caller is acting on
 * @returns The constructed actor context
 */
export function resolveActorContext(ingress: ActorIngress, state: RunbookState): ActorContext {
  const hasClaimId = ingress.claimId !== undefined;
  const hasTokenHash = ingress.tokenHash !== undefined;

  if (hasClaimId && hasTokenHash) {
    return claimControllerContext({
      claimId: ingress.claimId,
      tokenHash: ingress.tokenHash,
      controlledRunId: ingress.controlledRunId ?? state.id,
    });
  }

  // Exactly one of claimId/tokenHash present is contradictory evidence with no
  // resolvable controlled run: fall to the reserved inspect-only context.
  if (hasClaimId || hasTokenHash) {
    return UNKNOWN_ACTOR_CONTEXT;
  }

  return trustedRunControllerContext(state.id, ingress.source ?? 'direct-cli');
}
