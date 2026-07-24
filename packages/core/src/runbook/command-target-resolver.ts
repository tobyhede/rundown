import { UNKNOWN_ACTOR_CONTEXT, type ActorContext } from './actor-context.js';
import {
  authorizeClaim,
  redactClaimId,
  type ClaimAuthorizationRequest,
  type ClaimId,
  type ClaimIdResolution,
  type ClaimRecord,
  type ClaimVerificationResult,
  type VerifiedClaim,
  type VerifiedClaimAuthority,
} from './claim-id.js';
import { resolveCommandIntent, type CommandTargetSelector } from './command-policy.js';
import type { DELEGATION_COLLECTION_PENDING_MESSAGE } from './delegation-lifecycle-read-model.js';
import type { RunId } from './run-id.js';
import type { RunningStackMemberResolution } from './session-service.js';
import type { RunbookState } from './types.js';

/** Manual transition commands subject to the open-delegated-children guard. */
export type TransitionCommandName = 'pass' | 'fail';

/**
 * Refusal: the named `--run` id is not a running member of this session's
 * default stack (unknown id, missing state file, or terminal lifecycle).
 *
 * The single structural declaration of this refusal. Every union that can carry
 * a `--run` refusal — target resolution, transition targets, delegation
 * issuance, the lifecycle outcomes — references this type rather than
 * re-declaring the shape, so the members cannot drift apart. {@link
 * unknownRunRefusal} is the matching single source of truth for the messages.
 */
export type UnknownRunRefusal = {
  /** Discriminant. */
  readonly kind: 'unknown_run';
  /** Run id named by the caller. */
  readonly runId: RunId;
  /** Operator-facing refusal message. */
  readonly message: string;
};

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
      readonly claim: VerifiedClaim;
      readonly state: RunbookState;
    }
  | {
      readonly kind: 'terminal_claim';
      readonly claimId: ClaimId;
      readonly claim: VerifiedClaim;
      readonly state: RunbookState;
      readonly lifecycle: 'completed' | 'stopped';
      readonly message: string;
    }
  | { readonly kind: 'default'; readonly state: RunbookState }
  | { readonly kind: 'none' }
  | { readonly kind: 'stale_claim'; readonly claimId: ClaimId; readonly message: string }
  | {
      /** Ready resolution for an explicit `--run` target on the session stack. */
      readonly kind: 'run';
      /** Run id named by the caller. */
      readonly runId: RunId;
      /** Resolved running state of the named run. */
      readonly state: RunbookState;
    }
  | UnknownRunRefusal;

/**
 * Claim-targeting outcomes only (no default-stack / open-children cases).
 *
 * Exhaustive for a presented bearer claim: {@link resolveClaimTarget} maps all
 * six raw claim statuses onto exactly these three kinds. Consumers that resolve
 * a claim and nothing else should depend on this narrow union rather than the
 * wide {@link CommandTargetResolution}, so a `never` check makes forgetting a
 * kind a compile error instead of a silent fall-through.
 */
export type ClaimTargetResolution = Extract<
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
      readonly claim: VerifiedClaim;
      readonly state: RunbookState;
    }
  | { readonly kind: 'default'; readonly state: RunbookState }
  | { readonly kind: 'none' }
  | { readonly kind: 'stale_claim'; readonly claimId: ClaimId; readonly message: string }
  | {
      readonly kind: 'terminal_claim_confirmed';
      readonly claimId: ClaimId;
      readonly claim: VerifiedClaim;
      readonly state: RunbookState;
      readonly lifecycle: 'completed' | 'stopped';
      readonly result: TransitionCommandName;
    }
  | {
      readonly kind: 'terminal_claim_conflict';
      readonly claimId: ClaimId;
      readonly claim: VerifiedClaim;
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
       * The caller supplied no trusted actor evidence for the resolved target,
       * so the transition is refused — targeted (`--step`) and bare alike: a
       * step name is a completion target, not authority. Deliberately carries
       * NO run id: echoing the target id would hand a lingering child agent a
       * copy-paste bypass of the accident barrier (run ids are natively
       * available from `rundown run` output and every event's `runbookId`).
       * Returned (not thrown) so MCP/plugin/core adapters render the policy
       * error consistently.
       */
      readonly kind: 'actor_context_required';
    }
  | {
      readonly kind: 'claim_grant_required';
      readonly claimId: ClaimId;
      readonly runId: RunId;
    }
  | {
      /** Ready resolution for an explicit `--run` target on the session stack. */
      readonly kind: 'run';
      /** Run id named by the caller. */
      readonly runId: RunId;
      /** Resolved running state of the named run. */
      readonly state: RunbookState;
    }
  | UnknownRunRefusal;

/** Options for {@link resolveCommandTarget}. */
export interface ResolveCommandTargetOptions {
  /** Explicit claim id to target instead of the default stack. */
  readonly claimId?: ClaimId;
  /**
   * Explicit run id to target from `--run`. Mutually exclusive with `claimId`;
   * the CLI enforces exclusivity — the resolver gives `claimId` precedence and
   * never sees both.
   */
  readonly runId?: RunId;
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
   * Explicit run id to target from `--run`. Mutually exclusive with `claimId`;
   * the CLI enforces exclusivity — the resolver gives `claimId` precedence and
   * never sees both.
   */
  readonly runId?: RunId;
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
   * Resolve an explicit `--run` target to a running session-stack member.
   *
   * Resolves only ids present on the session default stack — `--run` names
   * authority over a run this session is orchestrating; cross-session work
   * stays claim-based.
   *
   * @param runId - Run id supplied by the caller via `--run`
   * @returns Typed outcome splitting "not on stack" from "not running"
   */
  resolveRunningStackMember(runId: RunId): Promise<RunningStackMemberResolution>;

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
   * Verify an explicit bearer claim id against session proof data.
   *
   * @param claimId - Bearer claim id presented by the caller.
   * @returns Verification status.
   */
  verifyClaimId(claimId: ClaimId): Promise<ClaimVerificationResult>;

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
 * once. Callers that resolve only a claim (no `--run`, no default stack) should
 * call this directly instead of {@link resolveCommandTarget}: it is the same
 * seam, but its narrow {@link ClaimTargetResolution} return type lets them
 * dispatch exhaustively.
 *
 * @param targetReader - Read-side dependency used to resolve the claim id
 * @param claimId - Explicit claim id from `--claim-id`
 * @param options - Resolution flags
 * @param options.includeStashed - Forwarded to `getActiveForClaimId`; when true a
 *   stashed child resolves as `claim` rather than `stale_claim`.
 * @returns Claim, terminal-claim, or stale-claim outcome
 */
export async function resolveClaimTarget(
  targetReader: CommandTargetReader,
  claimId: ClaimId,
  options: { readonly includeStashed: boolean },
): Promise<ClaimTargetResolution> {
  const claimed = await targetReader.getActiveForClaimId(claimId, {
    includeStashed: options.includeStashed,
  });
  // Refusal messages are user- and log-facing, so they must never echo the
  // bearer `claimId` (it carries the live secret segment). Route it through the
  // single redaction seam; the returned `claimId` discriminant stays the bearer
  // for any follow-up mutation the caller may re-issue.
  const claimKey = redactClaimId(claimId);
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
        message: `Claim id ${claimKey} points at a ${claimed.lifecycle} child runbook.`,
      };
    case 'missing':
      return { kind: 'stale_claim', claimId, message: `Claim id ${claimKey} does not exist.` };
    case 'invalid-secret':
      return {
        kind: 'stale_claim',
        claimId,
        message: `Claim id ${claimKey} is not valid for this session.`,
      };
    case 'unlinked':
      return {
        kind: 'stale_claim',
        claimId,
        message:
          claimed.reason === 'stashed'
            ? `Claim id ${claimKey} is currently stashed. Run \`rundown pop\` with its claim id to resume.`
            : `Claim id ${claimKey} is no longer linked to an active delegation (${claimed.reason}).`,
      };
    default: {
      const _exhaustive: never = claimed;
      return _exhaustive;
    }
  }
}

/** Mutation authority verified from an explicit bearer claim id. */
export type MutationAuthorityResolution =
  | {
      /** Mutation authority was verified. */
      readonly kind: 'verified';
      /** How authority was proven, without changing the verified claim payload. */
      readonly authority: VerifiedClaimAuthority;
      /** Shared verified claim data for both explicit and implicit authority. */
      readonly claim: VerifiedClaim;
    }
  | {
      /** Mutation authority was refused. */
      readonly kind: 'refused';
      /** Refusal reason. */
      readonly reason: 'missing' | 'invalid-secret' | 'ambiguous' | 'no-authorizing-claim';
    };

/**
 * Resolve mutation authority from a presented bearer claim id.
 *
 * @param input - Reader, optional presented bearer, target, and authorization request.
 * @param input.targetReader - Read-side dependency for claim proof.
 * @param input.presentedClaimId - Optional explicit bearer claim id.
 * @param input.targetState - Mutation target state.
 * @param input.request - Exact grant authorization request.
 * @returns Verified authority or a typed refusal.
 */
export async function resolveMutationAuthority(input: {
  readonly targetReader: CommandTargetReader;
  readonly presentedClaimId?: ClaimId;
  readonly targetState: RunbookState;
  readonly request: ClaimAuthorizationRequest;
}): Promise<MutationAuthorityResolution> {
  if (input.presentedClaimId === undefined) {
    return { kind: 'refused', reason: 'missing' };
  }

  const verified = await input.targetReader.verifyClaimId(input.presentedClaimId);
  if (verified.status !== 'verified') {
    return {
      kind: 'refused',
      reason: verified.status === 'invalid-secret' ? 'invalid-secret' : 'missing',
    };
  }
  return authorizeClaim(verified.claim, input.request).kind === 'allowed'
    ? {
        kind: 'verified',
        authority: {
          kind: 'bearer',
          claimId: input.presentedClaimId,
          claimKey: verified.claim.claimKey,
        },
        claim: verified.claim,
      }
    : { kind: 'refused', reason: 'no-authorizing-claim' };
}

function claimAuthorizesRunMutation(claim: VerifiedClaim, state: RunbookState): boolean {
  return authorizeClaim(claim, { action: 'mutate-run', runId: state.id }).kind === 'allowed';
}

/**
 * Map a refusing {@link RunningStackMemberResolution} to the shared
 * `unknown_run` refusal shape.
 *
 * Single source of truth for the operator-facing `--run` refusal messages:
 * `not_on_stack` (unknown id or missing state file) and `not_running`
 * (terminal lifecycle) render distinct causes, and every consumer — target
 * resolution, run-targeted terminals, delegation-issuance anchoring — refuses
 * with the identical wording.
 *
 * @param runId - Run id named by the caller via `--run`
 * @param member - The refusing stack-member resolution
 * @returns The `unknown_run` refusal member shared across the outcome unions
 */
export function unknownRunRefusal(
  runId: RunId,
  member: Exclude<RunningStackMemberResolution, { kind: 'running' }>,
): UnknownRunRefusal {
  switch (member.kind) {
    case 'not_on_stack':
      return {
        kind: 'unknown_run',
        runId,
        message: `Run ${runId} is not part of this session's active stack.`,
      };
    case 'not_running':
      return {
        kind: 'unknown_run',
        runId,
        message: `Run ${runId} is ${member.lifecycle ?? 'not running'}.`,
      };
    default: {
      const _exhaustive: never = member;
      return _exhaustive;
    }
  }
}

/**
 * Shared head for resolving an explicit `--run` target for both resolvers.
 *
 * Delegates the running-stack-member decision to the reader's
 * {@link CommandTargetReader.resolveRunningStackMember} and maps a refusing
 * outcome to `unknown_run` via {@link unknownRunRefusal}; a running state
 * resolves ready.
 *
 * @param targetReader - Read-side dependency used to resolve the run id
 * @param runId - Explicit run id from `--run`
 * @returns Ready `run` resolution or `unknown_run` refusal
 */
async function resolveRunTarget(
  targetReader: CommandTargetReader,
  runId: RunId,
): Promise<
  { readonly kind: 'run'; readonly runId: RunId; readonly state: RunbookState } | UnknownRunRefusal
> {
  const member = await targetReader.resolveRunningStackMember(runId);
  if (member.kind !== 'running') {
    return unknownRunRefusal(runId, member);
  }
  return { kind: 'run', runId, state: member.state };
}

/**
 * Resolve the runbook a targeting command should act on.
 *
 * Replaces the former CLI-only `resolveActiveRunbook`. Used by every command
 * that targets the active or an explicitly-claimed runbook EXCEPT the pass/fail
 * guard, which uses {@link resolveTransitionTarget}.
 *
 * @param targetReader - Read-side dependency used to read claim and default targets
 * @param options - Optional explicit claim id / run id and stashed-visibility flag
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
  if (options.runId !== undefined) {
    return resolveRunTarget(targetReader, options.runId);
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
    if (claimed.kind === 'stale_claim') {
      return claimed;
    }
    if (!claimAuthorizesRunMutation(claimed.claim, claimed.state)) {
      return {
        kind: 'claim_grant_required',
        claimId: claimed.claimId,
        runId: claimed.state.id,
      };
    }
    if (claimed.kind !== 'terminal_claim') {
      const refusal = await evaluateTransitionPolicy(
        targetReader,
        options,
        claimed.state,
        {
          kind: 'claim',
          claimId: claimed.claimId,
        },
        { skipOpenClaims: claimed.claim.delegation !== undefined },
      );
      if (refusal) return refusal;
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

  if (options.runId !== undefined) {
    const run = await resolveRunTarget(targetReader, options.runId);
    if (run.kind === 'unknown_run') {
      return run;
    }
    // A run-shaped target flows through the SAME policy block as the default
    // path — `--run` selects a target, but never authorizes mutation.
    const refusal = await evaluateTransitionPolicy(targetReader, options, run.state, {
      kind: 'run',
      runId: run.runId,
    });
    if (refusal) return refusal;
    return run;
  }

  const active = await targetReader.getActive();
  if (!active) {
    return { kind: 'none' };
  }

  // The role gate applies to targeted (`--step`) and bare transitions alike —
  // "everyone names their authority": a step name is a completion target, not
  // authority. Only the collection guards inside resolveCommandIntent key on
  // `targeted` (a deliberate targeted completion keeps its exemption).
  const refusal = await evaluateTransitionPolicy(targetReader, options, active, {
    kind: 'default',
  });
  if (refusal) return refusal;

  return { kind: 'default', state: active };
}

/**
 * Shared transition policy block for the default and run-targeted paths.
 *
 * Always runs `resolveCommandIntent` for a `delegating-run-advance` over the
 * resolved target — the role gate applies to targeted and bare transitions
 * alike, while `targeted: true` continues to exempt only the
 * collection-pending / open-claims guards. Maps refusing policy outcomes to
 * their transition resolution members; returns `undefined` when allowed.
 *
 * @param targetReader - Read-side dependency used to list open claims
 * @param options - Transition options carrying command, targeting, and actor context
 * @param target - Resolved target run state (default active or `--run`-named)
 * @param targetSelector - Selector shape describing how the target was named
 * @param policyOptions - Extra policy switches for claim-targeted transitions
 * @param policyOptions.skipOpenClaims - Skip parent open-claim reads for delegated child claims
 * @returns A refusing resolution, or `undefined` when allowed
 * @throws {Error} On policy outcomes unreachable for a transition intent
 */
async function evaluateTransitionPolicy(
  targetReader: CommandTargetReader,
  options: ResolveTransitionTargetOptions,
  target: RunbookState,
  targetSelector: CommandTargetSelector,
  policyOptions: { readonly skipOpenClaims?: boolean } = {},
): Promise<TransitionTargetResolution | undefined> {
  const targeted = options.targeted === true;
  // Open claims feed only the bare-shaped open-children guard; a targeted
  // transition is exempt from it, so the read is skipped (and reader fakes
  // asserting "no open-claim read for targeted" stay valid).
  const openClaims =
    targeted || policyOptions.skipOpenClaims === true
      ? []
      : await targetReader.listOpenClaimsForParent(target.id);
  const actorContext = options.actorContext ?? UNKNOWN_ACTOR_CONTEXT;
  const policy = resolveCommandIntent({
    actorContext,
    intent: { kind: 'delegating-run-advance', command: options.command, targeted },
    targetSelector,
    targetState: target,
    openClaims,
  });
  switch (policy.kind) {
    case 'allowed':
      return undefined;
    case 'delegation_collection_pending':
      return {
        kind: 'delegation_collection_pending',
        parentRunId: policy.parentRunId,
        outcomeCompletionKeys: policy.outcomeCompletionKeys,
        message: policy.message,
      };
    case 'open_claims':
      return { kind: 'open_delegated_children', parentRunId: target.id, claims: policy.claims };
    case 'actor_context_required':
      return { kind: 'actor_context_required' };
    case 'claim_grant_required':
      // Verified-claim authority is bearer-only, so the bearer claimId is always
      // present once narrowed; an unknown actor context has no bearer to name.
      return actorContext.kind === 'verified_claim'
        ? {
            kind: 'claim_grant_required',
            claimId: actorContext.authority.claimId,
            runId: target.id,
          }
        : { kind: 'actor_context_required' };
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
      readonly claim: VerifiedClaim;
      readonly state: RunbookState;
    }
  | { readonly kind: 'stale_claim'; readonly claimId: ClaimId; readonly message: string }
  | {
      readonly kind: 'terminal_claim_confirmed';
      readonly claimId: ClaimId;
      readonly claim: VerifiedClaim;
      readonly state: RunbookState;
      readonly lifecycle: 'completed' | 'stopped';
      readonly command: TerminalCommandName;
    }
  | {
      readonly kind: 'terminal_claim_conflict';
      readonly claimId: ClaimId;
      readonly claim: VerifiedClaim;
      readonly state: RunbookState;
      readonly lifecycle: 'completed' | 'stopped';
      readonly expectedCommand: TerminalCommandName;
      readonly requestedCommand: TerminalCommandName;
    }
  | {
      readonly kind: 'claim_grant_required';
      readonly claimId: ClaimId;
      readonly runId: RunId;
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
  if (claimed.kind === 'stale_claim') {
    return claimed;
  }
  if (!claimAuthorizesRunMutation(claimed.claim, claimed.state)) {
    return {
      kind: 'claim_grant_required',
      claimId: claimed.claimId,
      runId: claimed.state.id,
    };
  }
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
