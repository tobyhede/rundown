import type { ClaimId, ClaimRecord } from './claim-id.js';
import type { RunId } from './run-id.js';
import type { SessionService } from './session-service.js';
import type { RunbookState } from './types.js';

/** Manual transition commands subject to the open-delegated-children guard. */
export type TransitionCommandName = 'pass' | 'fail';

/**
 * Resolved target for any command that acts on the active or an explicitly
 * claimed runbook (goto, stop, complete, stash, status, artifact, collect).
 *
 * This is the base contract, formerly the CLI-only `ActiveRunbookResolution`.
 * Pass/fail use the richer {@link TransitionTargetResolution}.
 */
export type CommandTargetResolution =
  | {
      readonly kind: 'claim';
      readonly claimId: ClaimId;
      readonly claim: ClaimRecord;
      readonly state: RunbookState;
    }
  | {
      readonly kind: 'terminal_claim';
      readonly claimId: ClaimId;
      readonly claim: ClaimRecord;
      readonly state: RunbookState;
      readonly lifecycle: 'completed' | 'stopped';
      readonly message: string;
    }
  | { readonly kind: 'default'; readonly state: RunbookState }
  | { readonly kind: 'none' }
  | { readonly kind: 'stale_claim'; readonly claimId: ClaimId; readonly message: string };

/** Claim-targeting outcomes only (no default-stack / open-children cases). */
type ClaimTargetResolution = Extract<
  CommandTargetResolution,
  { kind: 'claim' | 'terminal_claim' | 'stale_claim' }
>;

/**
 * Pass/fail target resolution: a superset of {@link CommandTargetResolution}.
 *
 * It shares `claim` / `default` / `none` / `stale_claim` with the base union,
 * splits the base `terminal_claim` into confirm/conflict against the requested
 * result, and adds the `open_delegated_children` refusal.
 */
export type TransitionTargetResolution =
  | {
      readonly kind: 'claim';
      readonly claimId: ClaimId;
      readonly claim: ClaimRecord;
      readonly state: RunbookState;
    }
  | { readonly kind: 'default'; readonly state: RunbookState }
  | { readonly kind: 'none' }
  | { readonly kind: 'stale_claim'; readonly claimId: ClaimId; readonly message: string }
  | {
      readonly kind: 'terminal_claim_confirmed';
      readonly claimId: ClaimId;
      readonly claim: ClaimRecord;
      readonly state: RunbookState;
      readonly lifecycle: 'completed' | 'stopped';
      readonly result: TransitionCommandName;
    }
  | {
      readonly kind: 'terminal_claim_conflict';
      readonly claimId: ClaimId;
      readonly claim: ClaimRecord;
      readonly state: RunbookState;
      readonly lifecycle: 'completed' | 'stopped';
      readonly expectedResult: TransitionCommandName;
      readonly requestedResult: TransitionCommandName;
    }
  | {
      readonly kind: 'open_delegated_children';
      readonly parentRunId: RunId;
      readonly claims: readonly ClaimRecord[];
    };

/** Options for {@link resolveCommandTarget}. */
export interface ResolveCommandTargetOptions {
  /** Explicit claim id to target instead of the default stack. */
  readonly claimId?: ClaimId;
  /**
   * When true, a stashed claimed child resolves as `claim` (read-only
   * inspection paths set this); when false (default) it resolves as
   * `stale_claim` so write commands refuse to act on a parked runbook.
   */
  readonly allowStashed?: boolean;
}

/** Options for {@link resolveTransitionTarget}. */
export interface ResolveTransitionTargetOptions {
  /** The manual transition being attempted. */
  readonly command: TransitionCommandName;
  /** Explicit claim id to target instead of the default stack. */
  readonly claimId?: ClaimId;
  /**
   * True when the caller supplied an explicit `--step` target. The
   * open-delegated-children refusal guards only *bare* pass/fail (an accidental
   * parent advance); an explicit target is deliberate, so the refusal is skipped
   * and the default parent resolves normally.
   */
  readonly targeted?: boolean;
}

/**
 * Single source of truth for resolving an explicit claim id to a target.
 *
 * Both public resolvers funnel claim-id targeting through here, so the mapping
 * from `getActiveForClaimId` statuses to user-facing outcomes is defined exactly
 * once.
 *
 * @param sessionService - Session service used to resolve the claim id
 * @param claimId - Explicit claim id from `--claim-id`
 * @param options - Resolution flags
 * @param options.includeStashed - Forwarded to `getActiveForClaimId`; when true a
 *   stashed child resolves as `claim` rather than `stale_claim`.
 * @returns Claim, terminal-claim, or stale-claim outcome
 */
async function resolveClaimTarget(
  sessionService: SessionService,
  claimId: ClaimId,
  options: { readonly includeStashed: boolean },
): Promise<ClaimTargetResolution> {
  const claimed = await sessionService.getActiveForClaimId(claimId, {
    includeStashed: options.includeStashed,
  });
  switch (claimed.status) {
    case 'claimed':
      return { kind: 'claim', claimId, claim: claimed.claim, state: claimed.state };
    case 'terminal':
      return {
        kind: 'terminal_claim',
        claimId,
        claim: claimed.claim,
        state: claimed.state,
        lifecycle: claimed.lifecycle,
        message: `Claim id ${claimId} points at a ${claimed.lifecycle} child runbook.`,
      };
    case 'missing':
      return { kind: 'stale_claim', claimId, message: `Claim id ${claimId} does not exist.` };
    case 'stale':
      return {
        kind: 'stale_claim',
        claimId,
        message: `Claim id ${claimId} points at missing child state (${claimed.reason}).`,
      };
    case 'unlinked':
      return {
        kind: 'stale_claim',
        claimId,
        message:
          claimed.reason === 'stashed'
            ? `Claim id ${claimId} is currently stashed. Run \`rd pop --claim-id ${claimId}\` to resume.`
            : `Claim id ${claimId} is no longer linked to an active delegation (${claimed.reason}).`,
      };
    default: {
      const _exhaustive: never = claimed;
      return _exhaustive;
    }
  }
}

/**
 * Resolve the runbook a targeting command should act on.
 *
 * Replaces the former CLI-only `resolveActiveRunbook`. Used by every command
 * that targets the active or an explicitly-claimed runbook EXCEPT the pass/fail
 * guard, which uses {@link resolveTransitionTarget}.
 *
 * @param sessionService - Session service used to read claim and default targets
 * @param options - Optional explicit claim id and stashed-visibility flag
 * @returns Discriminated target resolution
 */
export async function resolveCommandTarget(
  sessionService: SessionService,
  options: ResolveCommandTargetOptions = {},
): Promise<CommandTargetResolution> {
  if (options.claimId !== undefined) {
    return resolveClaimTarget(sessionService, options.claimId, {
      includeStashed: options.allowStashed === true,
    });
  }
  const state = await sessionService.getActive();
  return state ? { kind: 'default', state } : { kind: 'none' };
}

/**
 * Resolve the runbook that may receive a manual pass/fail transition.
 *
 * The authoritative targeting boundary for manual transitions. Shares claim-id
 * resolution with {@link resolveCommandTarget} via the private claim head, then
 * adds the two pass/fail-specific outcomes: terminal-claim confirm/conflict and
 * the open-delegated-children refusal. Callers consume this typed result
 * instead of re-deriving any of it.
 *
 * @param sessionService - Session service used to inspect claimed/active runbooks
 * @param options - Transition command and optional explicit claim target
 * @returns Typed target resolution or refusal reason
 */
export async function resolveTransitionTarget(
  sessionService: SessionService,
  options: ResolveTransitionTargetOptions,
): Promise<TransitionTargetResolution> {
  if (options.claimId !== undefined) {
    // Write command: a stashed child must resolve to stale_claim, so the head is
    // called with includeStashed: false.
    const claimed = await resolveClaimTarget(sessionService, options.claimId, {
      includeStashed: false,
    });
    if (claimed.kind !== 'terminal_claim') {
      // 'claim' and 'stale_claim' have identical shapes in both unions; TS
      // narrows `claimed` to exactly those two here.
      return claimed;
    }
    // Split the base terminal_claim into confirm vs conflict. `claimed.lifecycle`
    // is already 'completed' | 'stopped', so derive the result inline as a
    // non-optional 'pass' | 'fail' (avoids lifecycleToResult, which widens to
    // include `undefined`).
    const expectedResult: TransitionCommandName =
      claimed.lifecycle === 'completed' ? 'pass' : 'fail';
    return expectedResult === options.command
      ? {
          kind: 'terminal_claim_confirmed',
          claimId: claimed.claimId,
          claim: claimed.claim,
          state: claimed.state,
          lifecycle: claimed.lifecycle,
          result: expectedResult,
        }
      : {
          kind: 'terminal_claim_conflict',
          claimId: claimed.claimId,
          claim: claimed.claim,
          state: claimed.state,
          lifecycle: claimed.lifecycle,
          expectedResult,
          requestedResult: options.command,
        };
  }

  const active = await sessionService.getActive();
  if (!active) {
    return { kind: 'none' };
  }

  // Targeted (`--step`) transitions are deliberate and exempt from the
  // bare-only open-delegated-children refusal.
  if (!options.targeted) {
    const openClaims = await sessionService.listOpenClaimsForParent(active.id);
    if (openClaims.length > 0) {
      return { kind: 'open_delegated_children', parentRunId: active.id, claims: openClaims };
    }
  }

  return { kind: 'default', state: active };
}
