import { UNKNOWN_ACTOR_CONTEXT, type ActorContext } from './actor-context.js';
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
       * a bare transition is refused. This is the strict-core default for a caller
       * that passes no `actorContext`; the direct CLI maps its `direct_cli` caller
       * evidence to a trusted run controller upstream and never reaches it.
       * Returned (not thrown) so MCP/plugin/core adapters render the policy error
       * consistently.
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
    const actorContext = options.actorContext ?? UNKNOWN_ACTOR_CONTEXT;
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

/**
 * Manual terminal commands that force a run complete/stopped. Kept separate from
 * {@link TransitionCommandName} so the pass/fail exhaustiveness guards stay intact.
 */
export type TerminalCommandName = 'complete' | 'stop';

/**
 * Terminal (complete/stop) claim-target resolution.
 *
 * Shares `claim` / `stale_claim` with {@link CommandTargetResolution} and splits
 * the base `terminal_claim` into confirm/conflict against the requested command
 * (mirroring {@link TransitionTargetResolution} for pass/fail). There is no
 * `default` / `none` member: the bare terminal path does not resolve through here
 * (it uses `SessionService.resolveActiveInlineForceTerminalPlan`); only the
 * `--claim-id` path calls this resolver.
 */
export type TerminalTargetResolution =
  | {
      readonly kind: 'claim';
      readonly claimId: ClaimId;
      readonly claim: ClaimRecord;
      readonly state: RunbookState;
    }
  | { readonly kind: 'stale_claim'; readonly claimId: ClaimId; readonly message: string }
  | {
      readonly kind: 'terminal_claim_confirmed';
      readonly claimId: ClaimId;
      readonly claim: ClaimRecord;
      readonly state: RunbookState;
      readonly lifecycle: 'completed' | 'stopped';
      readonly command: TerminalCommandName;
    }
  | {
      readonly kind: 'terminal_claim_conflict';
      readonly claimId: ClaimId;
      readonly claim: ClaimRecord;
      readonly state: RunbookState;
      readonly lifecycle: 'completed' | 'stopped';
      readonly expectedCommand: TerminalCommandName;
      readonly requestedCommand: TerminalCommandName;
    };

/**
 * Resolve an explicit `--claim-id` target for a complete/stop command.
 *
 * Reuses the shared claim-id head ({@link resolveClaimTarget}) with
 * `includeStashed: false` (a write command must refuse a stashed child), then —
 * for a terminal claim — splits confirm vs conflict on lifecycle-vs-command:
 * `completed` expects `complete`, `stopped` expects `stop`.
 *
 * @param targetReader - Read-side dependency used to resolve the claim id.
 * @param options - Terminal command and explicit claim id.
 * @param options.command - The terminal command (`complete` / `stop`) requested.
 * @param options.claimId - Explicit claim id from `--claim-id`.
 * @returns Live-claim, stale-claim, or terminal confirm/conflict resolution.
 */
export async function resolveTerminalTarget(
  targetReader: CommandTargetReader,
  options: { readonly command: TerminalCommandName; readonly claimId: ClaimId },
): Promise<TerminalTargetResolution> {
  const claimed = await resolveClaimTarget(targetReader, options.claimId, {
    includeStashed: false,
  });
  if (claimed.kind !== 'terminal_claim') {
    // 'claim' and 'stale_claim' share identical shapes across both unions.
    return claimed;
  }
  const expectedCommand: TerminalCommandName =
    claimed.lifecycle === 'completed' ? 'complete' : 'stop';
  return expectedCommand === options.command
    ? {
        kind: 'terminal_claim_confirmed',
        claimId: claimed.claimId,
        claim: claimed.claim,
        state: claimed.state,
        lifecycle: claimed.lifecycle,
        command: expectedCommand,
      }
    : {
        kind: 'terminal_claim_conflict',
        claimId: claimed.claimId,
        claim: claimed.claim,
        state: claimed.state,
        lifecycle: claimed.lifecycle,
        expectedCommand,
        requestedCommand: options.command,
      };
}
