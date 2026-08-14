import { resolvedStepHasSubsteps } from '@rundown-org/parser';
import { verifiedClaimContext, type CallerEvidence } from './actor-context.js';
import { claimCanReportDelegationResult } from './claim-id.js';
import type { ClaimId, ClaimRecord, VerifiedClaim, VerifiedClaimAuthority } from './claim-id.js';
import type { RunbookActorService } from './actor-service.js';
import type { CollectionWorkflowResult, DelegationPolicyOutcome } from './command-policy.js';
import { resolveCommandIntent } from './command-policy.js';
import type {
  CapturedActorMutationRun,
  EffectfulActorMutationRunner,
} from './effectful-actor-mutation-runner.js';
import {
  propagateTerminalChildUpward,
  type AdvanceInlineParent,
  type InlineUpwardPropagationResult,
  type TerminalUpwardPropagationResult,
} from './inline-parent-advance.js';
import { resolveMutationAuthority, type CommandTargetReader } from './command-target-resolver.js';
import type { AppliedResolvedCompletion } from './completion-service.js';
import type { RunbookCompletionService } from './completion-service.js';
import { isPostDelegateAggregationCursor } from './delegation-inference.js';
import type { ExecutionLifecycleService } from './execution-lifecycle-service.js';
import type { RunbookStateManager } from './state.js';
import {
  prepareReEntryFrontierConsume,
  type PreparedReEntryProjection,
} from './re-entry-frontier.js';
import type { Frame, FrameKey } from './targeting.js';
import {
  buildStepPosition,
  classifyCompletionReachability,
  findSubstepState,
  resolvedSubstepIdsInFrame,
} from './targeting.js';
import { deriveActiveCompletionFrame } from './frame-entry.js';
import { countNumberedSteps } from './step-utils.js';
import type { ClaimSeenRecordResult, ReleaseRunbookResult } from './session-service.js';
import type { SessionMutationResult } from './storage/runbook-store.js';
import type { ResolvedStep, RunbookState, RunId } from './types.js';
import {
  delegationRuntimeCapabilities,
  type DelegationRuntimeCapabilities,
} from './delegation-credential.js';
import { ErrorCodes } from '../errors/codes.js';
import { getErrorMessage } from '../errors.js';
import { logger } from '../logger.js';
import type { StepEntryMetadata } from '../events/execution-observation.js';
import {
  deriveTransitionObservation,
  type TransitionObservationEvent,
} from '../events/transition-observation.js';

/** Session reader plus the single write used by terminal release. */
export interface CollectionSessionService extends CommandTargetReader {
  /**
   * Release a run from all session targeting structures on terminal.
   *
   * @param runbookId - Terminal run id to release.
   * @param options - Release options.
   * @param options.retainClaimsAsTerminal - Keep claim tombstones so a later
   *   `--claim-id` confirm/conflict still resolves `terminal` rather than
   *   `missing`.
   * @returns Structured release result (not consumed by the collection seam).
   */
  releaseRunbook(
    runbookId: RunId,
    options?: { readonly retainClaimsAsTerminal?: boolean },
  ): Promise<SessionMutationResult<ReleaseRunbookResult>>;

  /**
   * Record best-effort liveness for a presented bearer claim after collection
   * authorization and before the operation. Never throws (#519).
   *
   * @param claimId - Bearer claim id the caller presented.
   * @returns Typed recording outcome, not consumed by the collection seam.
   */
  recordClaimSeen(claimId: ClaimId): Promise<ClaimSeenRecordResult>;
}

/** Dependencies used by the core collection operation. */
export interface RunbookCollectionServiceDependencies {
  /** Session/target reader used to verify bearer claims and resolve implicit authority. */
  readonly sessionService: CollectionSessionService;
  /** State manager used to reload and persist target runs. */
  readonly manager: RunbookStateManager;
  /** Actor service used to apply collected delegation outcomes through the state machine. */
  readonly actorService: RunbookActorService;
  /** Lifecycle service used to consume persisted delegation outcomes. */
  readonly lifecycleService: ExecutionLifecycleService;
  /** Completion service used to drain resolved delegation outcomes. */
  readonly completionService: RunbookCompletionService;
  /**
   * Core-owned execution fence the whole collection commits through.
   *
   * Collect was the sole delegation seam still committing a sequence of
   * separately fenced writes; routing it through the same aggregate runner as
   * the seven lifecycle seams is what gives it commit-time claim revalidation
   * and an all-or-none boundary.
   */
  readonly actorMutationRunner: EffectfulActorMutationRunner;
  /**
   * CLI-supplied inline parent-advance callable (Category C). Used when a
   * collected run reaches terminal and carries INLINE linkage: the seam drives
   * the composing parent's execution loop through this callable. Delegation
   * targets never invoke it (report-only).
   */
  readonly advanceInlineParent: AdvanceInlineParent;
  /**
   * Derive the parsed steps of an OWNED aggregate member other than the collect
   * target, from that run's own in-memory state.
   *
   * Required whenever a collect can name a delegating parent — that is, whenever
   * the target may carry `parentLinkage.kind === 'delegation'`. The aggregate
   * runner opens an execution attempt for EVERY member of the set, and an
   * ambiguous post-boundary failure moves all of them to `recovery_pending` and
   * then asks this seam's `makeRecoveryActor` to rehydrate each one. A member
   * with no steps cannot be rehydrated: the factory throws, and `runAll`
   * downgrades that throw to `logger.warn('aggregate member recovery failed;
   * attempt left pending')` and continues — so without this loader the
   * delegating parent is the one member a collect can never recover, silently.
   *
   * The collect target's steps are NOT taken from here: the caller already
   * resolved them into {@link CollectDelegationOutcomesInput.steps}, and the
   * parent is a different runbook whose graph must not be rebuilt from them.
   *
   * Category A, and the same DI shape as
   * `LifecycleCommandServiceDependencies.loadSteps`: deriving steps is parsing
   * plus an environment-bound helper registry and render context, which core
   * does not own. REQUIRED, not optional: a collect target's delegating parent
   * is discovered from persisted linkage at fire time, so no construction site
   * can prove up front that it will never need one. Optionality here would move
   * that proof obligation onto every frontend and reintroduce the silent
   * unrecoverable-parent gap the moment one of them got it wrong.
   */
  readonly loadSteps: (
    state: RunbookState,
  ) => readonly ResolvedStep[] | Promise<readonly ResolvedStep[]>;
}

/** Explicit collection target resolved by a frontend adapter or another core service. */
export interface CollectDelegationOutcomesInput {
  /** Persisted target run receiving collected delegation outcomes. */
  readonly targetState: RunbookState;
  /** Parsed runbook steps for the target run. */
  readonly steps: readonly ResolvedStep[];
  /** Typed caller evidence supplied by the frontend. Core verifies bearer claim authority. */
  readonly callerEvidence: CallerEvidence;
  /**
   * Open claimed children for the target run, when the caller already read
   * them. Feeds the delegation-exposure classification for `direct_cli`
   * evidence; defaults to none — a collect target authors DELEGATE, so the
   * static document clause classifies it `delegating` regardless.
   */
  readonly openClaims?: readonly ClaimRecord[];
  /** Optional explicit step name. Defaults to the target run cursor. */
  readonly stepName?: string;
  /** Optional frame override for targeted FOR collection. */
  readonly frame?: Frame;
}

/** Core-owned service for applying reported delegation outcomes to a target run. */
export class RunbookCollectionService {
  readonly #deps: RunbookCollectionServiceDependencies;

  /**
   * Construct a collection service bound to a set of core dependencies.
   *
   * @param deps - Core services needed to apply collection through the state machine.
   */
  constructor(deps: RunbookCollectionServiceDependencies) {
    this.#deps = deps;
  }

  /**
   * Collect reported delegation outcomes into one target delegating run scope.
   *
   * @param input - Target run, runbook steps, caller evidence, and optional scope.
   * @returns Core-owned typed policy outcome for frontend adapters.
   */
  async collectDelegationOutcomes(
    input: CollectDelegationOutcomesInput,
  ): Promise<CollectionWorkflowResult> {
    return collectDelegationOutcomes({ ...input, ...this.#deps });
  }
}

/** Dependencies accepted by the functional collection entrypoint. */
export type CollectDelegationOutcomesOperationInput = CollectDelegationOutcomesInput &
  RunbookCollectionServiceDependencies;

function findCollectionStep(
  steps: readonly ResolvedStep[],
  stepName: string,
): ResolvedStep | undefined {
  return steps.find((step) => step.name === stepName);
}

function delegateSubstepIds(step: ResolvedStep | undefined): readonly string[] {
  // `resolvedStepHasSubsteps` (from `@rundown-org/parser`, already used across
  // core — see actor-service.ts, delegation-service.ts) is the canonical guard;
  // it narrows `step.substeps` so the filter below is type-safe. Prefer it over
  // a hand-rolled `'substeps' in step && step.substeps` check.
  if (!step || !resolvedStepHasSubsteps(step)) return [];
  return step.substeps.filter((substep) => substep.delegate).map((substep) => substep.id);
}

function findStepOrThrow(steps: readonly ResolvedStep[], stepName: string): ResolvedStep {
  const step = steps.find((candidate) => candidate.name === stepName);
  if (!step) throw new Error(`Step "${stepName}" not found`);
  return step;
}

/**
 * Whether a substep's outcome was reported under an entry this scope has left.
 *
 * The distinction that turns the missing-outcome refusal from a wall into an
 * instruction (#749). A substep with no row anywhere is waiting on its child; a
 * substep whose only rows sit on this frame at another entry was reported and
 * then stranded by a RETRY/GOTO re-entry, and no amount of waiting resolves it —
 * the drain cannot reach the row, so `rundown delegate --retry` is the remedy.
 *
 * `superseded` is exactly `classifyCompletionReachability`'s middle arm, so this
 * asks the shared classifier rather than restating the frame-and-entry test that
 * defines it (#766).
 *
 * @param state - Target run state whose completion rows are inspected.
 * @param frame - Collection scope the readiness scan ran against.
 * @param substepId - Delegate substep already established as missing.
 * @returns Whether a row for this substep exists on the frame at another entry.
 */
function outcomeSupersededByReEntry(state: RunbookState, frame: Frame, substepId: string): boolean {
  return Object.values(state.resolvedCompletions ?? {}).some(
    (completion) =>
      completion.targetSubstep === substepId &&
      classifyCompletionReachability(frame, completion) === 'superseded',
  );
}

/** The missing-outcome verdict for one collection scope, split by remedy. */
interface MissingDelegationOutcomes {
  /** Qualified ids (`step.substep`) of delegate substeps with no live outcome. */
  readonly missingSubsteps: readonly string[];
  /** The subset of those whose outcome was reported at a superseded entry. */
  readonly supersededSubsteps: readonly string[];
}

function missingDelegationOutcomes(args: {
  readonly targetState: RunbookState;
  readonly stepName: string;
  readonly delegateSubsteps: readonly string[];
  readonly frame: Frame;
}): MissingDelegationOutcomes {
  const frameKey = args.frame.frameKey;
  // A live resolved-completion row is the authoritative 'outcome available to
  // collect' signal. `substepState.status` is only a mirror of a prior drain and
  // can go stale across a manual retry (which resets the substep to `pending` and
  // consumes the prior row). So a delegate substep is ready-to-collect iff it has
  // a LIVE row in the target frame OR its persisted status is already `done` (the
  // already-collected / idempotent no-op case where the row was already drained).
  // It is 'missing' iff NEITHER holds — genuinely never reported, or superseded by
  // a retry. Narrowing readiness onto live rows narrows but does not fully close
  // the collect race: a retry is not atomic against a concurrent `rd collect`
  // (full lock-span atomicity is deferred).
  const resolved = resolvedSubstepIdsInFrame(args.targetState, args.frame);
  const missing = args.delegateSubsteps.filter((substepId) => {
    if (resolved.has(substepId)) return false;
    // Equivalent mutant: the `?? []` fallback is only reached when
    // `substepStates` is nullish (no persisted states), and `findSubstepState`
    // returns `undefined` for any element whose `id`/`frameKey` does not match —
    // so an empty array and a non-empty garbage array are observationally
    // identical here (both yield "not found" → not done).
    // Stryker disable ArrayDeclaration: equivalent — empty vs garbage fallback both resolve "not found"
    const substepState = findSubstepState(
      args.targetState.substepStates ?? [],
      substepId,
      frameKey,
    );
    // Stryker restore ArrayDeclaration
    return substepState?.status !== 'done';
  });
  const qualify = (substepId: string): string => `${args.stepName}.${substepId}`;
  return {
    missingSubsteps: missing.map(qualify),
    supersededSubsteps: missing
      .filter((substepId) => outcomeSupersededByReEntry(args.targetState, args.frame, substepId))
      .map(qualify),
  };
}

/**
 * Collect reported delegation outcomes into one target delegating run scope.
 *
 * @param input - Target run, services, caller evidence, and optional scope.
 * @returns Core-owned typed policy outcome.
 */
export async function collectDelegationOutcomes(
  input: CollectDelegationOutcomesOperationInput,
): Promise<CollectionWorkflowResult> {
  const request = { action: 'collect-for-run', runId: input.targetState.id } as const;
  const presentedClaimId =
    input.callerEvidence.kind === 'claim_bearer' ? input.callerEvidence.claimId : undefined;
  const authority = await resolveMutationAuthority({
    targetReader: input.sessionService,
    ...(presentedClaimId !== undefined ? { presentedClaimId } : {}),
    targetState: input.targetState,
    request,
  });
  if (authority.kind !== 'verified') {
    return presentedClaimId !== undefined && authority.reason === 'no-authorizing-claim'
      ? {
          kind: 'claim_grant_required',
          intent: 'delegation-collection',
          targetRunId: input.targetState.id,
        }
      : { kind: 'actor_context_required', intent: 'delegation-collection' };
  }
  const actorContext = verifiedClaimContext({
    authority: authority.authority,
    claim: authority.claim,
  });
  // NOTE: the merged `resolveCommandIntent` input field is `targetSelector`
  // (not `target`). The resolved target run is passed separately as
  // `targetState`. For collection the frontend has already resolved
  // `--claim-id`, `--run`, or the default stack to a concrete run before this
  // call, so the selector here is always `default` and role derivation keys
  // off `targetState` (a `run` selector kind exists on the union but is
  // consumed upstream by the target resolver, never on this path).
  const policy = resolveCommandIntent({
    intent: { kind: 'delegation-collection' },
    // Equivalent mutants: `resolveCommandIntent` does not read `targetSelector` on
    // the `delegation-collection` path — it derives the role from `actorContext` +
    // `targetState` and only runs the orchestrator gate — so this selector's shape
    // and its `kind` value are never observed.
    // Stryker disable ObjectLiteral,StringLiteral: equivalent — targetSelector unused on the delegation-collection path
    targetSelector: { kind: 'default' },
    // Stryker restore ObjectLiteral,StringLiteral
    targetState: input.targetState,
    actorContext,
  });
  if (policy.kind !== 'allowed') return policy;

  // The orchestrator's presented bearer and collect grant are now authorized.
  // Observe that holder before validation, no-op detection, or dispatch: each is
  // later than the liveness proof. The recorder commits its own short session
  // transaction — no lock is held here and none is waited on — and it is total,
  // so it cannot block or mask the collection outcome (RD-102).
  await recordPresenterLiveness(input);

  const stepName = input.stepName ?? input.targetState.step;
  const step = findCollectionStep(input.steps, stepName);

  // Stale/corrupted state: the selected step is not in the loaded runbook. This
  // is never a valid idempotent no-op (mirrors the merged CLI's STEP_NOT_FOUND
  // fast-fail). Surface a typed failure the CLI renders as STEP_NOT_FOUND.
  if (!step) {
    return {
      kind: 'collection_failed',
      targetRunId: input.targetState.id,
      reason: 'step_not_found',
      code: 'STEP_NOT_FOUND',
      message: `Step ${stepName} not found in the loaded runbook; state may be stale or corrupted.`,
    };
  }

  const delegateSubsteps = delegateSubstepIds(step);
  const frame = input.frame ?? deriveActiveCompletionFrame(input.targetState);
  const frameKey = frame.frameKey; // every Frame variant carries frameKey

  if (delegateSubsteps.length === 0) {
    if (!input.stepName && isPostDelegateAggregationCursor(input.targetState, input.steps)) {
      return {
        kind: 'already_collected',
        targetRunId: input.targetState.id,
        step: stepName,
      };
    }
    // Per spec/Plan 3: `target_not_delegating_scope` is intentionally NOT a
    // policy variant (an upward-delegating run is still a valid collect
    // target; the orchestrator gate is the only role check). A non-DELEGATE
    // step that is also not a post-aggregation cursor is genuine misuse —
    // surface it as a `collection_failed` with reason `not_delegate_step` so the
    // CLI renders the existing `NOT_DELEGATE_STEP` error (no new variant, no
    // contract change). Do NOT return `target_not_delegating_scope`.
    return {
      kind: 'collection_failed',
      targetRunId: input.targetState.id,
      reason: 'not_delegate_step',
      code: 'NOT_DELEGATE_STEP',
      message: `Step ${stepName} is not a DELEGATE step. rundown collect requires a step with - DELEGATE substeps.`,
    };
  }

  const { missingSubsteps, supersededSubsteps } = missingDelegationOutcomes({
    targetState: input.targetState,
    stepName,
    delegateSubsteps,
    frame,
  });
  if (missingSubsteps.length > 0) {
    return {
      kind: 'missing_outcomes',
      targetRunId: input.targetState.id,
      step: stepName,
      missingSubsteps,
      supersededSubsteps,
    };
  }

  return applyCollection(input, {
    stepName,
    frame,
    frameKey,
    claim: authority.claim,
    authority: authority.authority,
  });
}

function deriveCollectionTransitionObservations(
  input: CollectDelegationOutcomesOperationInput,
  applied: readonly AppliedResolvedCompletion[],
): readonly TransitionObservationEvent[] {
  return applied.flatMap((entry) => {
    const currentStep = findStepOrThrow(input.steps, entry.stateBefore.step);
    return deriveTransitionObservation({
      steps: input.steps,
      currentStep,
      previousState: entry.stateBefore,
      updatedState: entry.stateAfter,
      snapshot: entry.snapshot,
      result: entry.completion.result,
    }).events;
  });
}

/**
 * Drive the FENCED half of the shared re-entry frontier seam for a collect.
 *
 * The seam itself lives in `re-entry-frontier.ts` and shares its disclosure
 * boundary verbatim with the CLI execution loop (F6): both entry points reach
 * the same persisted data under the same conditions, so both classify it with
 * the same arms and report each arm under the same code. All this wrapper
 * contributes is the rendered entry metadata for the collect cursor and the
 * verified deriver.
 *
 * @param input - Collection operation input (services + target + steps).
 * @param advanced - Prepared post-drain state whose snapshot carries the frontier.
 * @param delegationRuntime - Collector-bound issuer/deriver pair.
 * @returns The prepared re-entry outcome.
 * @throws {InvalidRunbookStateError} When the persisted `delegateFrontier` is malformed.
 */
async function prepareCollectReEntryFrontier(
  input: CollectDelegationOutcomesOperationInput,
  advanced: RunbookState,
  delegationRuntime: DelegationRuntimeCapabilities,
): Promise<PreparedReEntryProjection> {
  const position = buildStepPosition(
    advanced.step,
    countNumberedSteps(input.steps),
    advanced.substep,
    advanced.forStack,
  );
  const substep = advanced.substep;
  // A cursor that has advanced off the substeps cannot carry a frontier, and the
  // seam short-circuits on `isSubstep: false` without observing. Spelled as two
  // complete literals rather than one with `??` fallbacks so neither variant
  // carries a field it could never have.
  // Equivalent mutants on the non-substep arm below: the seam short-circuits to
  // `status: 'none'` on `isSubstep: false` and never observes that entry, so
  // every field of it EXCEPT `isSubstep` is unobservable — and collapsing the
  // whole literal to `{}` leaves `isSubstep` undefined, which is falsy, so it
  // reaches the same arm. `isSubstep: false` itself stays mutated: flipping it to
  // `true` IS killed, by the "treats a present frontier with an undefined cursor
  // substep as no re-entry" test. The arm is spelled out rather than
  // short-circuited here so the malformed-snapshot guard inside the seam still
  // runs for an off-substep cursor.
  const entry =
    substep === undefined
      ? // Stryker disable ObjectLiteral,StringLiteral: equivalent — this entry is never observed
        {
          stepId: advanced.step,
          position,
          stepName: advanced.step,
          isSubstep: false,
          // Stryker disable next-line BooleanLiteral: equivalent — never observed (see above)
          prompted: !!advanced.prompted,
        }
      : // Stryker restore ObjectLiteral,StringLiteral
        {
          stepId: advanced.step,
          substepId: substep,
          position,
          stepName: substep,
          isSubstep: true,
          prompted: !!advanced.prompted,
        };

  return await prepareReEntryFrontierConsume({
    actorService: input.actorService,
    steps: input.steps,
    state: advanced,
    deriveToken: delegationRuntime.deriveDelegationToken,
    entry,
  });
}

/**
 * Record the ORCHESTRATOR's own presented bearer after authorization and NEVER
 * the children's: a parent cannot vouch for a child's liveness (#519 AC5).
 * Best-effort and total, so failure cannot mask the later collection (RD-102).
 *
 * Called outside any open store transaction: `recordClaimSeen` opens its OWN
 * session transaction (`mutateSession`), and SQLite transactions do not nest.
 *
 * The hazard this note originally recorded was real but no longer reachable in
 * that shape. Under the deleted session file lock, re-entering the lock from
 * inside its own scope blocked for the whole 5s acquisition deadline before
 * throwing — a stall, not an error. Under `mutateSession` the equivalent
 * violation cannot be written: transaction work is synchronous by type
 * (`SyncWork`) and by runtime check (`assertSyncWorkResult`), so this `await`
 * is unreachable from inside a transaction, and a fire-and-forget attempt
 * fails immediately on `BEGIN IMMEDIATE` rather than waiting. The live
 * constraint is therefore separation, not deadlock avoidance: the liveness
 * write commits in its own transaction, so it is never rolled back with the
 * collection and can never roll the collection back.
 *
 * @param input - The collect operation input carrying the caller's evidence.
 */
async function recordPresenterLiveness(
  input: CollectDelegationOutcomesOperationInput,
): Promise<void> {
  if (input.callerEvidence.kind !== 'claim_bearer') return;
  await input.sessionService.recordClaimSeen(input.callerEvidence.claimId);
}

/**
 * Everything the collection transaction derives before it commits.
 *
 * Held in one value so the `compute` callback can return the prepared state set
 * and the command-facing outcome together, and so the post-commit disclosure
 * (frontier observations) has a single carrier rather than a set of parallel
 * mutable bindings.
 */
interface PreparedCollection {
  /** The collect target's prepared state, or absent when nothing is written. */
  readonly target?: RunbookState;
  /** A delegating grandparent's prepared state, when a terminal report was derived. */
  readonly parent?: RunbookState;
  /** Whether the prepared parent write was a FRESH upward report. */
  readonly reportedTerminalOutcome: boolean;
  /** Post-commit frontier disclosure, withheld until the commit lands. */
  readonly frontierEntry?: StepEntryMetadata;
  /** The collection outcome to return once the commit succeeds. */
  readonly value: DelegationPolicyOutcome;
  /** Whether the prepared target state is terminal (drives release + upward walk). */
  readonly terminal?: 'done' | 'stopped';
}

/**
 * Derive and commit a whole collection as ONE fenced aggregate transaction.
 *
 * WHAT CHANGED AND WHY. Collect used to authorize, then drain through one
 * `sendAndSync` transaction per completion, then release the session, then
 * propagate upward — four or more separately committed writes, none of which
 * re-checked the collector's captured `claim_generation`. `writeStateAtVersion`
 * guards on `state_version` and its own docstring states that callers "MUST NOT
 * treat a `committed` result as evidence that their authority was still valid at
 * commit time"; the generation check lives in `classifyCommitRow`, which the old
 * path never reached. A bearer removed or replaced after the authorization gate
 * could therefore still land every one of those writes.
 *
 * Now the whole workflow derives in memory from the state captured under the
 * lease and commits once through `commitOwnedRunSet`, which re-checks the
 * captured authority. Two consequences follow directly:
 *
 * - Commit-time supersession is REPORTABLE. A claim retired between
 *   authorization and commit surfaces as `claim_superseded` (`STALE_CLAIM`)
 *   rather than committing under stale authority.
 * - Partial collection is UNREPRESENTABLE. Applies, frontier consumption, the
 *   terminal session release, and a delegating parent's outcome row either all
 *   land or none do.
 *
 * WHAT STAYS OUTSIDE THE TRANSACTION, and why that is not a gap:
 * - The INLINE upward walk. `advanceInlineParent` is a CLI callable that spawns
 *   the composing parent's execution loop — Category A, an external effect that
 *   cannot be re-run inside a fence. It runs after the commit exactly as before,
 *   and its own writes remain owned by the loop it drives.
 * - The frontier OBSERVATION. Deriving it needs committed state, so it is taken
 *   after the commit. Disclosure ordering is strengthened rather than weakened:
 *   the old seam committed the consume first so a failed consume disclosed no
 *   bearers, which left a consume that committed while the surrounding collect
 *   did not; here a refused transaction consumes nothing and discloses nothing.
 *
 * @param input - Collection operation input (services + target + steps).
 * @param scope - Resolved step/frame scope and the verified collecting authority.
 * @param scope.stepName - Step selected for collection.
 * @param scope.frame - Frame the collection targets.
 * @param scope.frameKey - Frame key of {@link scope.frame}, when already derived.
 * @param scope.claim - Verified claim authorizing the collect.
 * @param scope.authority - Verified authority the capabilities bind to.
 * @returns The collection outcome, or a typed transactional refusal.
 */
async function applyCollection(
  input: CollectDelegationOutcomesOperationInput,
  scope: {
    readonly stepName: string;
    readonly frame: Frame;
    readonly frameKey?: FrameKey;
    readonly claim: VerifiedClaim;
    readonly authority: VerifiedClaimAuthority;
  },
): Promise<CollectionWorkflowResult> {
  // Bound ONCE, from the authority `collectDelegationOutcomes` verified for
  // `collect-for-run` on this exact target. Only `createRunControlGrants` mints
  // `collect-for-run`, and it mints `delegate-from-run` for the same run in the
  // same set — so the bearer that may collect this run is by construction the
  // bearer that may delegate from it. The drain issues under it, and the
  // `continue` return below hands the same capability to the continuation.
  const delegationRuntime = delegationRuntimeCapabilities(scope.authority);
  const targetRunId = input.targetState.id;

  // The delegating grandparent, when this collect target is itself a delegated
  // child. Named as an OPPORTUNISTIC aggregate target: a delegating parent
  // legitimately has no controlling claim of its own (released or pruned while
  // its delegation is still live), and a bare capture refuses exactly that with
  // `claim_superseded`. Treating it as required would let a released parent veto
  // the collect and strand the child with no way to close.
  //
  // A SELF-LINKED target names itself as its own delegating parent. That is
  // corrupt persisted linkage, and it must not become an aggregate target:
  // `runAll` rejects a repeated run by THROWING ('Aggregate actor mutation
  // repeats a target run'), which would replace a typed refusal with an opaque
  // crash. Excluding it here keeps the pre-existing disposition intact — the
  // collect-local claim gate in `prepareTerminalCollection` refuses first,
  // because `grantAllows`' `report-delegation-result` arm matches
  // `grant.parentRunId` exactly, so the very corruption that would trip a cycle
  // guard is what stops the grant matching (#603).
  const linkedParentRunId =
    input.targetState.parentLinkage?.kind === 'delegation'
      ? input.targetState.parentLinkage.parentRunId
      : undefined;
  const delegationParentRunId = linkedParentRunId === targetRunId ? undefined : linkedParentRunId;

  let prepared: PreparedCollection | undefined;
  const stepsByRun = new Map<RunId, readonly ResolvedStep[]>([[targetRunId, input.steps]]);

  const aggregate = await input.actorMutationRunner.runAll<DelegationPolicyOutcome>({
    targets: [
      ...(delegationParentRunId === undefined
        ? []
        : [{ runId: delegationParentRunId, optionalWhenClaimSuperseded: true }]),
      { runId: targetRunId, claimKey: scope.authority.claimKey },
    ],
    makeRecoveryActor: (runId, recoveryState) => {
      const recoverySteps = stepsByRun.get(runId);
      // Unreachable: recovery only runs for an attempt that crossed the effect
      // boundary, which is strictly after `beforeEffect` populated this map for
      // the whole captured set, and `loadSteps` is a required dependency so no
      // member can be missed. It stays a throw rather than a guess because
      // rehydrating a run from ANOTHER runbook's graph is worse than not
      // rehydrating it — and because `runAll` DOWNGRADES this throw to a warn
      // and leaves the attempt pending, the message has to be actionable on its
      // own in a log with no stack.
      if (!recoverySteps) {
        throw new Error(
          `Missing recovery steps for collect run ${runId}; it was captured as an ` +
            'aggregate member but `beforeEffect` derived no steps for it, so it cannot ' +
            'be rehydrated.',
        );
      }
      return input.actorService.createRecoveryActor(recoveryState, recoverySteps);
    },
    beforeEffect: async (captured) => {
      // Cache one step set per OWNED member, BEFORE the effect boundary and
      // therefore before any attempt can need recovery. The collect target's
      // steps came from the caller; every other member is a different runbook,
      // so its graph is derived from its own state through the injected loader.
      // Mirrors `LifecycleCommandService`'s per-run steps memo, which pre-loads
      // for exactly the same reason.
      for (const member of captured) {
        if (stepsByRun.has(member.state.id)) continue;
        stepsByRun.set(member.state.id, await input.loadSteps(member.state));
      }
      const target = captured.find(({ state }) => state.id === targetRunId);
      if (!target) throw new Error('Collection did not capture its target run.');
      const parent = captured.find(({ state }) => state.id === delegationParentRunId);
      prepared = await prepareCollection(input, scope, delegationRuntime, target.state, parent);
      // Every no-write outcome returns HERE, before the fence acquires a lease
      // or crosses an effect boundary. `runAll` still revalidates the captured
      // set for a `return`, so even a refusal reports commit-time supersession
      // rather than answering from a stale read.
      return prepared.target === undefined
        ? { kind: 'return', value: prepared.value }
        : { kind: 'continue' };
    },
    compute: (captured) => {
      const exact = prepared;
      if (!exact?.target) throw new Error('Collection lost its prepared mutation.');
      const target = exact.target;
      const parentState = exact.parent;
      // One prepared state per captured target, in captured order. A parent
      // dropped between `beforeEffect` and acquisition (its claim retired in
      // that window) is absent from `captured`, so its prepared row is dropped
      // with it rather than committed against a run this transaction no longer
      // owns.
      return Promise.resolve({
        members: captured.map(({ state }) =>
          state.id === targetRunId
            ? { runId: targetRunId, nextState: target }
            : { runId: state.id, nextState: parentState ?? state },
        ),
        value: exact.value,
      });
    },
    // Terminal release is folded into the SAME transaction as the terminal
    // state, replacing the old best-effort `releaseRunbook` that ran after the
    // lifecycle had already committed. A collect that reaches terminal can no
    // longer leave the completed run on the session default stack (#556)
    // because the two cannot land separately. `when: 'terminal'` is required
    // rather than cosmetic: whether this collect reaches terminal is decided by
    // the drain inside `beforeEffect`, long after this input is built, and an
    // unconditional release would drop a still-running target off session
    // targeting on every ordinary collect. `retainClaimsAsTerminal: true` keeps
    // claim tombstones so a later `--claim-id` confirm/conflict still resolves
    // `terminal` rather than `missing`.
    releases: [{ runId: targetRunId, retainClaimsAsTerminal: true, when: 'terminal' }],
  });
  if (aggregate.kind !== 'committed') return aggregate;

  const committed = prepared;
  if (!committed) throw new Error('Collection committed without a prepared outcome.');
  return await finishCollection(input, committed);
}

/**
 * Derive the whole collection against the exact captured state, writing nothing.
 *
 * Every arm that used to be produced after one or more committed writes is
 * produced here instead, from one captured version: the drain, the frontier
 * projection and consume, the terminal decision, and a delegating grandparent's
 * outcome row. A `prepared.target` of `undefined` means the collection writes
 * nothing at all, which lets the caller answer from the write-free
 * `beforeEffect` return rather than acquiring a lease it does not need.
 *
 * @param input - Collection operation input (services + target + steps).
 * @param scope - Resolved step/frame scope and the verified collecting authority.
 * @param scope.stepName - Step selected for collection.
 * @param scope.frame - Frame the collection targets.
 * @param scope.claim - Verified claim authorizing the collect.
 * @param scope.authority - Verified authority the capabilities bind to.
 * @param delegationRuntime - Collector-bound issuer/deriver pair.
 * @param captured - The exact target state captured under the lease.
 * @param capturedParent - The delegating grandparent's captured state, when present.
 * @returns The prepared state set, post-commit disclosure, and command outcome.
 * @throws {InvalidRunbookStateError} When the captured snapshot carries a
 *   malformed `delegateFrontier` (no-migration rule: corrupt persisted state).
 */
async function prepareCollection(
  input: CollectDelegationOutcomesOperationInput,
  scope: {
    readonly stepName: string;
    readonly frame: Frame;
    readonly claim: VerifiedClaim;
    readonly authority: VerifiedClaimAuthority;
  },
  delegationRuntime: DelegationRuntimeCapabilities,
  captured: RunbookState,
  capturedParent: CapturedActorMutationRun | undefined,
): Promise<PreparedCollection> {
  const targetRunId = captured.id;
  const drained = await input.completionService.prepareResolvedCompletionDrain({
    runbookId: targetRunId,
    steps: input.steps,
    capturedState: captured,
    frameOverride: scope.frame,
    issueDelegationCredential: delegationRuntime.issueDelegationCredential,
  });

  if (drained.status === 'failed') {
    // `drained.reason` is `'target_mismatch'` — the drain's ONLY failure reason
    // (CompletionTargetMismatch). Core attaches the user-facing code so the CLI
    // renders a flat passthrough.
    return {
      reportedTerminalOutcome: false,
      value: {
        kind: 'collection_failed',
        targetRunId,
        reason: drained.reason,
        code: 'COLLECT_OPERATION_FAILED',
        message: drained.message,
      },
    };
  }

  // Frame requested by the caller is not the cursor's active frame: the drain is
  // observation-only and derived nothing. A DISTINCT outcome from the idempotent
  // no-op — the CLI must render the existing `not-active` payload (status
  // `not-active`, carrying `frameKey`/`activeFrameKey`/`unresolved`) — so do NOT
  // fold it into `already_collected`. Pass the observed frame keys through
  // unchanged.
  if (drained.status === 'not_active') {
    return {
      reportedTerminalOutcome: false,
      value: {
        kind: 'collection_frame_not_active',
        targetRunId,
        step: scope.stepName,
        frameKey: drained.frameKey,
        activeFrameKey: drained.activeFrameKey,
        unresolved: drained.unresolved,
      },
    };
  }

  const applied = drained.applied.length;
  const transitionObservations = deriveCollectionTransitionObservations(input, drained.applied);

  if (drained.status === 'done' || drained.status === 'stopped') {
    return prepareTerminalCollection(input, scope, {
      terminal: drained.status,
      terminalState: drained.state,
      applied,
      unresolved: drained.unresolved,
      transitionObservations,
      capturedParent,
    });
  }

  // status === 'continue': the run is still active. The drain may have advanced
  // the cursor onto a step whose entry carries a retry re-entry frontier; project
  // and derive its consume so the CLI can surface fresh delegation tokens without
  // synthesizing events. This runs even when `applied === 0`: a PRIOR collect can
  // have applied outcomes but left the frontier persisted, and re-projecting on a
  // later no-op collect is what keeps consumption retryable rather than stranded.
  const reentry = await prepareCollectReEntryFrontier(input, drained.state, delegationRuntime);
  if (reentry.status === 'projection_refused') {
    // A credential DISCLOSURE-boundary refusal — the condition RD-821 names and
    // the CLI execution loop already reports under it. The code follows the
    // condition, never the command that happened to drive the seam, so an agent
    // branching on `code` reads one fact whichever entry point produced it.
    // Deliberately NOT `COLLECT_OPERATION_FAILED`: that code's contract is
    // "collection failed while applying delegation outcomes", and nothing was
    // applied here.
    //
    // Refusing here abandons any drain the same pass derived, which is correct
    // and is the point of the transaction: the old seam had already committed
    // those applies before it could discover the refusal.
    return {
      reportedTerminalOutcome: false,
      value: {
        kind: 'collection_failed',
        targetRunId,
        reason: 'frontier_projection_refused',
        code: ErrorCodes.DELEGATION_INVARIANT_VIOLATED.code,
        message: reentry.message,
      },
    };
  }

  // Idempotent no-op ONLY when nothing drained AND no pending frontier remained
  // to consume. With a freshly derived frontier consume we must fall through to a
  // `collection_applied` result so its re-entry observations reach the CLI.
  //
  // `target: undefined` is what makes this a genuine no-op: the write-free
  // `beforeEffect` return commits nothing, where the old path had already
  // performed an `ensureActiveEntry` write to reach the same conclusion.
  if (applied === 0 && reentry.status === 'none') {
    return {
      reportedTerminalOutcome: false,
      value: { kind: 'already_collected', targetRunId, step: scope.stepName },
    };
  }

  return {
    target: reentry.status === 'projected' ? reentry.nextState : drained.state,
    reportedTerminalOutcome: false,
    ...(reentry.status === 'projected' ? { frontierEntry: reentry.entry } : {}),
    value: {
      kind: 'collection_applied',
      targetRunId,
      step: scope.stepName,
      applied,
      unresolved: drained.unresolved,
      lifecycle: drained.state.lifecycle,
      reportedTerminalOutcome: false,
      transitionObservations,
      // Placeholder: the real observations can only be derived from committed
      // state, so `finishCollection` fills this in after the commit lands.
      ...(reentry.status === 'projected' ? { reEntryObservations: [] } : {}),
      // The target is still running, so the frontend drives a continuation for
      // it. That continuation can step INTO a DELEGATE frontier, where
      // machine-owned issuance needs a verified issuer, and the turn after needs
      // the same-issuer deriver. Both are this collector's verified authority
      // over THIS run — runtime-only closures, never persisted, and carried only
      // on the non-terminal arm (a terminal target drives no continuation).
      delegationRuntime,
    },
  };
}

/**
 * Derive the terminal half of a collection: the delegating grandparent's report.
 *
 * Only the DELEGATION arm is prepared here. Delegation reporting is a pure state
 * projection ({@link RunbookCompletionService.prepareChildCompletion}), so the
 * outcome row commits in the same transaction as the terminal lifecycle that
 * earned it — closing the window where a child could be terminal while its
 * parent held no record of it. INLINE linkage is deliberately excluded: its
 * advance spawns the composing parent's execution loop, an external effect a
 * fence cannot own, so it runs post-commit in {@link finishCollection} exactly as
 * before.
 *
 * @param input - Collection operation input (services + target).
 * @param scope - Resolved scope and the verified collecting authority.
 * @param scope.stepName - Step selected for collection.
 * @param scope.claim - Verified claim authorizing the collect.
 * @param terminal - The prepared terminal state and its collection counters.
 * @param terminal.terminal - Which terminal status the drain reached.
 * @param terminal.terminalState - The prepared terminal state to commit.
 * @param terminal.applied - Number of outcomes the drain consumed.
 * @param terminal.unresolved - Outcomes still unresolved after this collection.
 * @param terminal.transitionObservations - Observations projected from the applied transitions.
 * @param terminal.capturedParent - The delegating grandparent's captured state, when present.
 * @returns The prepared state set and the terminal collection outcome.
 */
function prepareTerminalCollection(
  input: CollectDelegationOutcomesOperationInput,
  scope: { readonly stepName: string; readonly claim: VerifiedClaim },
  terminal: {
    readonly terminal: 'done' | 'stopped';
    readonly terminalState: RunbookState;
    readonly applied: number;
    readonly unresolved: number;
    readonly transitionObservations: readonly TransitionObservationEvent[];
    readonly capturedParent: CapturedActorMutationRun | undefined;
  },
): PreparedCollection {
  const terminalState = terminal.terminalState;
  const linkage = terminalState.parentLinkage;
  const lifecycle = terminal.terminal === 'done' ? 'completed' : 'stopped';

  // The claim gate is a collect-local PRECONDITION, strictly prior to the
  // linkage dispatch, and it stays exactly where it was. Only the WRITE moved
  // into the transaction. Spelled as one expression rather than a boolean
  // followed by a lookup so `capturedParent` is narrowed by the guard that
  // requires it, instead of re-asserted afterwards.
  const capturedParent = terminal.capturedParent;
  const prepared =
    linkage?.kind === 'delegation' &&
    capturedParent !== undefined &&
    claimCanReportDelegationResult(scope.claim, terminalState)
      ? input.completionService.prepareChildCompletion(
          { childState: terminalState },
          capturedParent.state,
        )
      : undefined;

  return {
    target: terminalState,
    terminal: terminal.terminal,
    ...(prepared?.kind === 'recorded' ? { parent: prepared.nextParentState } : {}),
    // 'recorded' → reported (true); every other disposition → false. Preserves
    // the mutation-pinned 'recorded'-only contract (finding 2).
    reportedTerminalOutcome: prepared?.kind === 'recorded',
    value: {
      kind: 'collection_applied',
      targetRunId: terminalState.id,
      step: scope.stepName,
      applied: terminal.applied,
      unresolved: terminal.unresolved,
      lifecycle,
      reportedTerminalOutcome: prepared?.kind === 'recorded',
      transitionObservations: terminal.transitionObservations,
    },
  };
}

/**
 * Complete a committed collection: disclose the frontier and walk INLINE upward.
 *
 * Everything here is strictly post-commit, and each item is here for a reason
 * that a fence cannot accommodate:
 *
 * - The frontier OBSERVATION reads committed state, and disclosing bearers is
 *   only sound once the consume that retired them has actually landed.
 * - The INLINE upward advance spawns the composing parent's execution loop
 *   (Category A). A fenced transaction cannot own a subprocess.
 *
 * A FAILED post-commit disclosure REJECTS, deliberately. Being post-commit, the
 * failure arrives after the aggregate landed and after the frontier entry was
 * consumed, so neither disposition can recover the bearers — the consume is
 * durable and the next collect re-projects nothing. What the two dispositions
 * differ on is whether anyone is told:
 *
 * - Swallowing would return `collection_applied` with `reEntryObservations: []`.
 *   That array is not "no news": the frontend reads its PRESENCE as "the
 *   frontier was consumed, do not re-enter this DELEGATE step", so an empty one
 *   reports a successful collection with nothing left to delegate. The
 *   delegations are stranded and no surface says so — a warning-only adapter of
 *   exactly the kind this project rules out.
 * - Rejecting misreports a committed collect as failed, which would be the worse
 *   trade if it invited an unsafe repeat. It does not: a retried collect finds
 *   the outcomes drained and the frontier gone, and answers the idempotent
 *   `already_collected` no-op. Both halves are pinned by the
 *   "post-commit re-entry disclosure" tests.
 *
 * So the rejection costs an inaccurate command status and buys an operator-
 * visible fact; the silence costs a stranded delegation and buys nothing.
 *
 * @param input - Collection operation input (services + target + steps).
 * @param prepared - The prepared collection whose commit has landed.
 * @returns The final collection outcome with post-commit data folded in.
 * @throws {unknown} The observation failure, unchanged, when a committed
 *   collection cannot render its re-entry disclosure (see above).
 */
async function finishCollection(
  input: CollectDelegationOutcomesOperationInput,
  prepared: PreparedCollection,
): Promise<DelegationPolicyOutcome> {
  const value = prepared.value;
  if (value.kind !== 'collection_applied') return value;

  if (prepared.frontierEntry !== undefined && prepared.target !== undefined) {
    try {
      const observations = await input.actorService.observeExecutionUnitEntry(
        prepared.target.id,
        [...input.steps],
        prepared.frontierEntry,
      );
      return { ...value, reEntryObservations: observations };
    } catch (observationError) {
      // Attribute, then RE-THROW unchanged. The rejection is the outcome; this
      // log exists because the rejection alone cannot say that the collection
      // COMMITTED — which is the fact an operator needs and the only fact the
      // error's own message will not carry. Re-throwing the original preserves
      // its class, so the CLI's `InvalidRunbookStateError` → finish/stop/prune
      // mapping still fires for a corrupt persisted snapshot.
      void logger.error('collection committed but its re-entry disclosure could not be observed', {
        runId: prepared.target.id,
        error: getErrorMessage(observationError),
      });
      throw observationError;
    }
  }

  if (prepared.terminal === undefined || prepared.target === undefined) return value;

  // INLINE only. The delegation report already committed with the terminal
  // state, so re-running the shared seam for it would attempt a duplicate write;
  // the inline advance is the one arm whose effect is external.
  if (prepared.target.parentLinkage?.kind !== 'inline') return value;
  const terminalInlineAdvance = await advanceInlineParentAfterCommit(input, prepared.target);
  return {
    ...value,
    ...(terminalInlineAdvance !== undefined ? { terminalInlineAdvance } : {}),
  };
}

/**
 * Narrow the shared upward-propagation union to its INLINE subset.
 *
 * WHY THIS IS NOT A REMAP. `reported` and `duplicate` are DELEGATION
 * dispositions whose distinction {@link TerminalUpwardPropagationResult}
 * documents as load-bearing. Collapsing either onto `not-applicable` — "there
 * was no parent to propagate to" — would state something the walk never
 * observed, which is the silent mapping CLAUDE.md forbids. So this narrowing
 * refuses them instead, and the refusal costs nothing because they are
 * UNREACHABLE from here. Two independent facts make that so:
 *
 * 1. {@link finishCollection} only reaches this walk for a target whose
 *    `parentLinkage.kind === 'inline'`, and the seam's TOP level dispatches on
 *    that same linkage — so the delegation arm that mints `reported` /
 *    `duplicate` cannot run at level 1.
 * 2. The walk RECURSES upward, and an ancestor above an inline parent may well
 *    carry delegation linkage, so `reported` genuinely is produced one level
 *    up. It never escapes: `propagateTerminalChildUpwardInner`'s severity
 *    collapse returns only `linkage-cycle` and `blocked` unchanged, maps a
 *    `stopped` advance to `stopped`, and folds everything else — `reported`
 *    included — into `handled`. Pinned by "collapses a delegation-linked
 *    grandparent report INSIDE the seam, not at this boundary".
 *
 * Spelled as an exhaustive switch rather than a conditional so the compiler,
 * not a reviewer, is what forces this boundary to be revisited when a member is
 * added to either union: a new arm reaches the `never` assignment and fails to
 * build, where the old `?:` would have widened the declared return type in
 * silence. Enumerating the two refused members (rather than a bare
 * `default: throw`) is what preserves that exhaustiveness — the same shape
 * `lifecycle-command-service`'s terminal policy switch uses for its own
 * invariant-violation arms.
 *
 * Exported for the unit tests that pin the refusal, and deliberately NOT
 * re-exported from the package index: it is not a public contract.
 *
 * @param outcome - The disposition the shared seam returned.
 * @returns The same value, narrowed to the inline subset.
 * @throws {Error} When the seam yields a delegation-only disposition, which the
 *   inline-linkage precondition makes impossible; a real occurrence means the
 *   seam's contract changed and must not be reported as `not-applicable`.
 * @internal
 */
export function narrowInlineUpwardPropagation(
  outcome: TerminalUpwardPropagationResult,
): InlineUpwardPropagationResult {
  switch (outcome.kind) {
    case 'handled':
    case 'stopped':
    case 'blocked':
    case 'not-applicable':
    case 'linkage-cycle':
      // Returned AS IT CAME BACK, never rebuilt: the `linkage-cycle` arm carries
      // the trip naming the run to prune (#603).
      return outcome;
    case 'reported':
    case 'duplicate':
      throw new Error(
        `Inline upward propagation yielded the delegation-only disposition "${outcome.kind}"; ` +
          'an inline-linked child cannot produce one, so this is a seam-contract violation.',
      );
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

/**
 * Drive the INLINE upward walk for a collect target that committed terminal.
 *
 * Delegates to the shared {@link propagateTerminalChildUpward} seam so the
 * cycle/depth guards, release disposition, and one-level recursion stay in one
 * owner. Narrows the seam's union to the inline subset without a cast (see
 * {@link narrowInlineUpwardPropagation}), keeping the `linkage-cycle` arm INTACT
 * (#603): core holds no emitter, so the trip has to reach the frontend as data
 * and the CLI performs the fail-closed collapse.
 *
 * @param input - Collection operation input (services).
 * @param terminalState - The committed terminal collect target.
 * @returns The narrowed inline advance outcome.
 * @throws {Error} When the seam yields a delegation-only disposition — see
 *   {@link narrowInlineUpwardPropagation} for why that cannot happen here.
 */
async function advanceInlineParentAfterCommit(
  input: CollectDelegationOutcomesOperationInput,
  terminalState: RunbookState,
): Promise<InlineUpwardPropagationResult | undefined> {
  const outcome: TerminalUpwardPropagationResult = await propagateTerminalChildUpward(
    {
      manager: input.manager,
      sessionService: input.sessionService,
      completionService: input.completionService,
      advanceInlineParent: input.advanceInlineParent,
    },
    terminalState,
    undefined,
  );
  return narrowInlineUpwardPropagation(outcome);
}
