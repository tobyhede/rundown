import {
  UNKNOWN_ACTOR_CONTEXT,
  trustedRunControllerContext,
  type ActorContext,
  type ActorContextSource,
} from './actor-context.js';
import type { ClaimId, ClaimIdResolution, ClaimRecord } from './claim-id.js';
import { resolveCommandIntent } from './command-policy.js';
import type { DELEGATION_COLLECTION_PENDING_MESSAGE } from './delegation-lifecycle-read-model.js';
import type { RunId } from './run-id.js';
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
    }
  | {
      readonly kind: 'delegation_collection_pending';
      readonly parentRunId: RunId;
      readonly outcomeCompletionKeys: readonly string[];
      readonly message: typeof DELEGATION_COLLECTION_PENDING_MESSAGE;
    }
  | {
      /**
       * The caller supplied no trusted actor evidence for the resolved target, so
       * a bare transition is refused. This is the strict-core default for callers
       * that pass neither an `actorContext` nor `directCliCompatibility`; the
       * direct CLI never reaches it. Returned (not thrown) so MCP/plugin/core
       * adapters render the policy error consistently.
       */
      readonly kind: 'actor_context_required';
      /** Target run the refused transition would have advanced. */
      readonly targetRunId: RunId;
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
  /** Actor context supplied by the frontend adapter; strict core default is unknown. */
  readonly actorContext?: ActorContext;
  /**
   * Provenance source tag refining the direct-CLI compatibility lane.
   *
   * When supplied (and no explicit `actorContext` is given), the resolver tags
   * the constructed `trusted_run_controller` with this source instead of the
   * hardcoded `direct-cli`. Provenance only — it does not change role derivation
   * or the collection-pending guard.
   */
  readonly actorContextSource?: ActorContextSource;
  /**
   * Compatibility adapter for direct local CLI calls.
   *
   * When true and no explicit `actorContext` was supplied, the resolver maps the
   * resolved target run to `trusted_run_controller` with source `direct-cli`.
   * Strict domain callers leave this false/undefined and therefore evaluate as
   * unknown unless they pass actor context explicitly.
   */
  readonly directCliCompatibility?: boolean;
}

/**
 * Read-side dependency required to resolve command targets.
 *
 * This is intentionally narrower than {@link SessionService}: target resolution
 * only needs to inspect the active default runbook, explicit claim-id targets,
 * and open delegated children for the active parent. Keeping this boundary
 * structural lets resolver tests exercise targeting decisions without creating
 * real session files or taking filesystem locks.
 */
export interface CommandTargetReader {
  /**
   * Return the current default-stack target.
   *
   * @returns Active runbook state, or `null` when no default target exists
   */
  getActive(): Promise<RunbookState | null>;

  /**
   * Resolve an explicit claim id to its child runbook state or failure status.
   *
   * @param claimId - Claim id requested by the caller
   * @param options - Read visibility flags
   * @param options.includeStashed - Whether stashed claimed children are visible
   * @returns Claim id resolution status
   */
  getActiveForClaimId(
    claimId: ClaimId,
    options: { readonly includeStashed: boolean },
  ): Promise<ClaimIdResolution>;

  /**
   * List unresolved delegated child claims for a parent runbook.
   *
   * @param parentRunId - Parent runbook id to inspect
   * @returns Open delegated child claim records
   */
  listOpenClaimsForParent(parentRunId: RunId): Promise<readonly ClaimRecord[]>;
}

/**
 * Single source of truth for resolving an explicit claim id to a target.
 *
 * Both public resolvers funnel claim-id targeting through here, so the mapping
 * from `getActiveForClaimId` statuses to user-facing outcomes is defined exactly
 * once.
 *
 * @param targetReader - Read-side dependency used to resolve the claim id
 * @param claimId - Explicit claim id from `--claim-id`
 * @param options - Resolution flags
 * @param options.includeStashed - Forwarded to `getActiveForClaimId`; when true a
 *   stashed child resolves as `claim` rather than `stale_claim`.
 * @returns Claim, terminal-claim, or stale-claim outcome
 */
async function resolveClaimTarget(
  targetReader: CommandTargetReader,
  claimId: ClaimId,
  options: { readonly includeStashed: boolean },
): Promise<ClaimTargetResolution> {
  const claimed = await targetReader.getActiveForClaimId(claimId, {
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
 * @param targetReader - Read-side dependency used to read claim and default targets
 * @param options - Optional explicit claim id and stashed-visibility flag
 * @returns Discriminated target resolution
 */
export async function resolveCommandTarget(
  targetReader: CommandTargetReader,
  options: ResolveCommandTargetOptions = {},
): Promise<CommandTargetResolution> {
  if (options.claimId !== undefined) {
    return resolveClaimTarget(targetReader, options.claimId, {
      includeStashed: options.allowStashed === true,
    });
  }
  const state = await targetReader.getActive();
  return state ? { kind: 'default', state } : { kind: 'none' };
}

/**
 * Build the actor context a default-target transition presents to policy.
 *
 * Provenance-only refinement of the direct-CLI compatibility lane: an explicit
 * `actorContextSource` tags the trusted run controller; otherwise
 * `directCliCompatibility` yields the `direct-cli` tag; neither yields unknown.
 *
 * @param activeId - Resolved default-target run id
 * @param options - Source tag / compatibility / explicit-context flags
 * @param options.actorContext - Explicit actor context that wins outright when supplied
 * @param options.actorContextSource - Provenance tag refining the trusted-controller source
 * @param options.directCliCompatibility - Direct-CLI compatibility fallback yielding the `direct-cli` tag
 * @returns The actor context for the bare-advance policy check
 */
export function buildTransitionActorContext(
  activeId: RunId,
  options: {
    readonly actorContext?: ActorContext;
    readonly actorContextSource?: ActorContextSource;
    readonly directCliCompatibility?: boolean;
  },
): ActorContext {
  if (options.actorContext) return options.actorContext;
  if (options.actorContextSource) {
    return trustedRunControllerContext(activeId, options.actorContextSource);
  }
  if (options.directCliCompatibility) {
    return trustedRunControllerContext(activeId, 'direct-cli');
  }
  return UNKNOWN_ACTOR_CONTEXT;
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
 * @param targetReader - Read-side dependency used to inspect claimed/active runbooks
 * @param options - Transition command and optional explicit claim target
 * @returns Typed target resolution or refusal reason
 */
export async function resolveTransitionTarget(
  targetReader: CommandTargetReader,
  options: ResolveTransitionTargetOptions,
): Promise<TransitionTargetResolution> {
  if (options.claimId !== undefined) {
    // Write command: a stashed child must resolve to stale_claim, so the head is
    // called with includeStashed: false.
    const claimed = await resolveClaimTarget(targetReader, options.claimId, {
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

  const active = await targetReader.getActive();
  if (!active) {
    return { kind: 'none' };
  }

  // Targeted (`--step`) transitions are deliberate and exempt from the
  // bare-only open-delegated-children refusal.
  if (!options.targeted) {
    const openClaims = await targetReader.listOpenClaimsForParent(active.id);
    const actorContext = buildTransitionActorContext(active.id, options);
    const policy = resolveCommandIntent({
      actorContext,
      intent: { kind: 'delegating-run-advance', command: options.command, targeted: false },
      targetSelector: { kind: 'default' },
      targetState: active,
      openClaims,
    });
    switch (policy.kind) {
      case 'allowed':
        break;
      case 'delegation_collection_pending':
        return {
          kind: 'delegation_collection_pending',
          parentRunId: policy.parentRunId,
          outcomeCompletionKeys: policy.outcomeCompletionKeys,
          message: policy.message,
        };
      case 'open_claims':
        return { kind: 'open_delegated_children', parentRunId: active.id, claims: policy.claims };
      case 'actor_context_required':
        return { kind: 'actor_context_required', targetRunId: active.id };
      case 'collect_requires_orchestrator':
      case 'missing_outcomes':
      case 'already_collected':
      case 'collection_frame_not_active':
      case 'collection_applied':
      case 'collection_failed':
        // Unreachable for a delegating-run-advance intent: the orchestrator gate
        // and the collection-operation outcomes belong to the collection path
        // only (emitted by collectDelegationOutcomes, never resolveCommandIntent).
        // A real occurrence is an invariant violation, not an expected refusal,
        // so it stays a throw.
        throw new Error(`Unexpected transition policy outcome: ${policy.kind}`);
      default: {
        const _exhaustive: never = policy;
        return _exhaustive;
      }
    }
  }

  return { kind: 'default', state: active };
}
