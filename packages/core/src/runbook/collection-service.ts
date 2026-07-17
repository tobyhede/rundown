import { resolvedStepHasSubsteps } from '@rundown-org/parser';
import { verifiedClaimContext, type CallerEvidence } from './actor-context.js';
import { claimCanReportDelegationResult } from './claim-id.js';
import type { ClaimRecord, VerifiedClaim } from './claim-id.js';
import type { RunbookActorService } from './actor-service.js';
import type { DelegationPolicyOutcome } from './command-policy.js';
import { resolveCommandIntent } from './command-policy.js';
import {
  propagateTerminalChildUpward,
  type AdvanceInlineParent,
  type OnLinkageCycle,
  type TerminalUpwardPropagationResult,
} from './inline-parent-advance.js';
import { resolveMutationAuthority, type CommandTargetReader } from './command-target-resolver.js';
import type { AppliedResolvedCompletion } from './completion-service.js';
import type { RunbookCompletionService } from './completion-service.js';
import { isPostDelegateAggregationCursor } from './delegation-inference.js';
import type { ExecutionLifecycleService } from './execution-lifecycle-service.js';
import type { RunbookStateManager } from './state.js';
import { InvalidRunbookStateError } from './state.js';
import type { Frame, FrameKey } from './targeting.js';
import {
  activeFrame,
  buildStepPosition,
  completionEntryForFrame,
  deriveActiveFrame,
  findSubstepState,
  SENTINEL_ENTRY,
} from './targeting.js';
import { countNumberedSteps } from './step-utils.js';
import type { ReleaseRunbookResult } from './session-service.js';
import type { ResolvedStep, RunbookState, RunId } from './types.js';
import type { DelegateFrontierEntry } from '../events/types.js';
import type { ExecutionObservationEffect } from '../events/execution-observation.js';
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
  ): Promise<ReleaseRunbookResult>;
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
   * CLI-supplied inline parent-advance callable (Category C). Used when a
   * collected run reaches terminal and carries INLINE linkage: the seam drives
   * the composing parent's execution loop through this callable. Delegation
   * targets never invoke it (report-only).
   */
  readonly advanceInlineParent: AdvanceInlineParent;
  /**
   * Frontend-supplied diagnostic sink invoked when the upward-propagation guard
   * trips on a corrupt linkage graph (#602). Required for the same reason
   * `advanceInlineParent` is: the collect path can drive the seam, so it must be
   * able to name the offending run to the operator.
   */
  readonly onLinkageCycle: OnLinkageCycle;
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
  ): Promise<DelegationPolicyOutcome> {
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

function defaultCollectionFrame(state: RunbookState): Frame {
  return activeFrame(activeFrameKeyOf(state), state.activeEntry ?? 1);
}

/**
 * Single fallback for the target run's active frame key. Factored out of the
 * two prior call sites (`defaultCollectionFrame` and the missing-outcome scan),
 * which both inlined `state.activeFrameKey ?? deriveActiveFrame(state).frameKey`.
 *
 * @param state - Target run state to read the active frame key from.
 * @returns The persisted active frame key, or the one derived from the cursor.
 */
function activeFrameKeyOf(state: RunbookState): FrameKey {
  return state.activeFrameKey ?? deriveActiveFrame(state).frameKey;
}

// Set of delegate substep ids that have a LIVE resolved-completion row in the
// target frame (active or sentinel entry). This is the authoritative
// 'outcome available to collect' signal; `substepState.status` is only a
// mirror and can go stale across a retry.
function resolvedSubstepIdsInFrame(
  state: RunbookState,
  frameKey: FrameKey,
  entry: number,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const completion of Object.values(state.resolvedCompletions ?? {})) {
    if (
      completion.targetSubstep !== undefined &&
      completion.targetFrameKey === frameKey &&
      (completion.targetEntry === entry || completion.targetEntry === SENTINEL_ENTRY)
    ) {
      ids.add(completion.targetSubstep);
    }
  }
  return ids;
}

function missingDelegationOutcomeIds(args: {
  readonly targetState: RunbookState;
  readonly stepName: string;
  readonly delegateSubsteps: readonly string[];
  readonly frameKey: FrameKey;
  readonly entry: number;
}): readonly string[] {
  const frameKey = args.frameKey;
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
  const resolved = resolvedSubstepIdsInFrame(args.targetState, frameKey, args.entry);
  return args.delegateSubsteps
    .filter((substepId) => {
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
    })
    .map((substepId) => `${args.stepName}.${substepId}`);
}

/**
 * Collect reported delegation outcomes into one target delegating run scope.
 *
 * @param input - Target run, services, caller evidence, and optional scope.
 * @returns Core-owned typed policy outcome.
 */
export async function collectDelegationOutcomes(
  input: CollectDelegationOutcomesOperationInput,
): Promise<DelegationPolicyOutcome> {
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
  const frame = input.frame ?? defaultCollectionFrame(input.targetState);
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

  const missingSubsteps = missingDelegationOutcomeIds({
    targetState: input.targetState,
    stepName,
    delegateSubsteps,
    frameKey,
    entry: completionEntryForFrame(frame),
  });
  if (missingSubsteps.length > 0) {
    return {
      kind: 'missing_outcomes',
      targetRunId: input.targetState.id,
      step: stepName,
      missingSubsteps,
    };
  }

  return applyCollection(input, { stepName, frame, frameKey, claim: authority.claim });
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

type ReEntryProjection =
  | { readonly status: 'none' }
  | { readonly status: 'projected'; readonly observations: readonly ExecutionObservationEffect[] }
  | { readonly status: 'consume_failed' };

/**
 * Runtime guard for a single persisted delegate-frontier entry.
 *
 * `RunbookState.snapshot` is typed `unknown`, so a frontier read out of it cannot
 * be trusted to match {@link DelegateFrontierEntry} on type alone — the persisted
 * blob may be malformed. Validate each entry's shape before use.
 *
 * @param value - Candidate frontier entry read from the persisted snapshot.
 * @returns A type predicate narrowing `value` to {@link DelegateFrontierEntry}.
 */
function isDelegateFrontierEntry(value: unknown): value is DelegateFrontierEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.runbook === 'string' &&
    typeof entry.token === 'string'
  );
}

async function projectAndConsumeReEntryFrontier(
  input: CollectDelegationOutcomesOperationInput,
  advanced: RunbookState,
): Promise<ReEntryProjection> {
  const context = (advanced.snapshot as { readonly context?: Record<string, unknown> } | undefined)
    ?.context;
  const rawFrontier = context?.delegateFrontier;
  // No frontier persisted: nothing to re-enter.
  if (rawFrontier === undefined) {
    return { status: 'none' };
  }
  // `snapshot` is `unknown`: a non-array or structurally invalid frontier is a
  // corrupt/incompatible persisted snapshot. Per the no-migration rule, reject it
  // (the CLI maps InvalidRunbookStateError to finish/stop/prune/restart) rather
  // than trusting malformed data or crashing mid-collection.
  if (!Array.isArray(rawFrontier) || !rawFrontier.every(isDelegateFrontierEntry)) {
    throw new InvalidRunbookStateError(
      `Run ${advanced.id} carries a malformed delegateFrontier in its persisted snapshot`,
    );
  }
  const frontier: readonly DelegateFrontierEntry[] = rawFrontier;
  if (frontier.length === 0 || advanced.substep === undefined) {
    return { status: 'none' };
  }

  const position = buildStepPosition(
    advanced.step,
    countNumberedSteps(input.steps),
    advanced.substep,
    advanced.forStack,
  );
  const observations = await input.actorService.observeExecutionUnitEntry(
    input.targetState.id,
    [...input.steps],
    {
      stepId: advanced.step,
      substepId: advanced.substep,
      position,
      stepName: advanced.substep,
      isSubstep: true,
      prompted: !!advanced.prompted,
      delegateFrontier: frontier,
    },
  );

  const consumed = await input.actorService.sendAndSync(input.targetState.id, [...input.steps], {
    type: 'DELEGATE_FRONTIER_CONSUMED',
  });
  if (!consumed) {
    return { status: 'consume_failed' };
  }

  return { status: 'projected', observations };
}

async function applyCollection(
  input: CollectDelegationOutcomesOperationInput,
  scope: {
    readonly stepName: string;
    readonly frame: Frame;
    readonly frameKey?: FrameKey;
    readonly claim: VerifiedClaim;
  },
): Promise<DelegationPolicyOutcome> {
  const drained = await input.completionService.drainResolvedCompletions({
    runbookId: input.targetState.id,
    steps: [...input.steps],
    currentState: input.targetState,
    frameOverride: scope.frame,
  });

  if (drained.status === 'failed') {
    // `drained.reason` is `'target_mismatch'` — drain's ONLY failure reason
    // (CompletionTargetMismatch). Core attaches the user-facing code so the CLI
    // renders a flat passthrough.
    return {
      kind: 'collection_failed',
      targetRunId: input.targetState.id,
      reason: drained.reason,
      code: 'COLLECT_OPERATION_FAILED',
      message: drained.message,
    };
  }

  // Frame requested by the caller is not the cursor's active frame: drain is
  // observation-only and applied nothing. This is a DISTINCT outcome from the
  // idempotent no-op: the CLI must render the existing `not-active` payload
  // (status `not-active`, carrying `frameKey`/`activeFrameKey`/`unresolved`), so
  // do NOT fold it into `already_collected`. Pass drain's observed frame keys
  // through unchanged.
  if (drained.status === 'not_active') {
    return {
      kind: 'collection_frame_not_active',
      targetRunId: input.targetState.id,
      step: scope.stepName,
      frameKey: drained.frameKey,
      activeFrameKey: drained.activeFrameKey,
      unresolved: drained.unresolved,
    };
  }

  const applied = drained.applied.length;
  const transitionObservations = deriveCollectionTransitionObservations(input, drained.applied);

  // Terminal: the drained outcomes advanced the target run to a terminal
  // lifecycle. Reload the persisted terminal state so single-level reporting
  // observes the committed lifecycle, then (single-level) report one outcome
  // upward — never collect the ancestor.
  if (drained.status === 'done' || drained.status === 'stopped') {
    // Equivalent mutants on the fallback below: `manager.load` cannot return
    // undefined for a run the drain above just persisted, so the first `??` always
    // short-circuits and this `.at(-1)` selection (and its optional chain) is never
    // evaluated. (The LogicalOperator collapse of this `??`-chain IS pinned — see
    // the "reports upward using the reloaded terminal lifecycle" stale-reload test.)
    // Stryker disable OptionalChaining,UnaryOperator: equivalent — unreachable defensive fallback (manager.load never undefined here); the LogicalOperator collapse of this chain stays pinned
    const fresh =
      (await input.manager.load(input.targetState.id)) ??
      drained.applied.at(-1)?.stateAfter ??
      input.targetState;
    // Stryker restore OptionalChaining,UnaryOperator
    // Terminal release lives in the seam, not in whichever CLI path drives the
    // collect: the drain above persisted the terminal lifecycle, and this release
    // removes the run from session targeting in the same seam call — so a collect
    // that reaches terminal (and skips the CLI execution loop) does not leave the
    // completed run on the session default stack (#556). Two sequential awaits, not
    // one transaction; safe because releaseRunbook is idempotent and
    // PID-stale-reclaimable. `retainClaimsAsTerminal: true` keeps claim tombstones so
    // a later `--claim-id` confirm/conflict still resolves `terminal`.
    //
    // Best-effort: the terminal lifecycle is already committed above, and a failed
    // release only leaks a self-healing session-stack entry (reclaimed by the next
    // acquirer via PID-aware stale detection). Swallow its rejection rather than let
    // cleanup mask the committed collection_applied outcome (RD-102).
    try {
      await input.sessionService.releaseRunbook(input.targetState.id, {
        retainClaimsAsTerminal: true,
      });
    } catch {
      // Intentionally ignored — see best-effort note above.
    }
    const upward = await propagateCollectTerminalUpward(input, fresh, scope.claim);
    return {
      kind: 'collection_applied',
      targetRunId: input.targetState.id,
      step: scope.stepName,
      applied,
      unresolved: drained.unresolved,
      lifecycle: drained.status === 'done' ? 'completed' : 'stopped',
      reportedTerminalOutcome: upward.reportedTerminalOutcome,
      ...(upward.terminalInlineAdvance !== undefined
        ? { terminalInlineAdvance: upward.terminalInlineAdvance }
        : {}),
      transitionObservations,
    };
  }

  // status === 'continue': the run is still active. The drain may have advanced
  // the cursor onto a step whose entry carries a retry re-entry frontier; project
  // + consume it so the CLI can surface fresh delegation tokens without
  // synthesizing events. This runs even when `applied === 0`: a PRIOR collect can
  // have applied outcomes but failed to consume the frontier (a transient
  // sendAndSync race), leaving it persisted. Re-projecting here on a later no-op
  // collect is what keeps frontier consumption retryable rather than stranded.
  // Mirror the terminal-path reload fallback: if `manager.load` returns
  // undefined, fall back to the last applied post-transition snapshot before the
  // pre-collect state, so a drained continue advance keeps its cursor/lifecycle
  // and the `delegateFrontier` projection below stays aligned.
  // Stryker disable OptionalChaining,UnaryOperator: equivalent — unreachable defensive fallback (manager.load never undefined for a run the drain just persisted)
  const advanced =
    (await input.manager.load(input.targetState.id)) ??
    drained.applied.at(-1)?.stateAfter ??
    input.targetState;
  // Stryker restore OptionalChaining,UnaryOperator
  const reentry = await projectAndConsumeReEntryFrontier(input, advanced);
  if (reentry.status === 'consume_failed') {
    // Transient: the frontier is still persisted and no observations were
    // surfaced (their fresh tokens would be orphaned by a retry). Surface a
    // retryable error; the next `rd collect` re-projects + consumes the frontier
    // via this same path (it reaches here even with `applied === 0`).
    return {
      kind: 'collection_failed',
      targetRunId: input.targetState.id,
      reason: 'frontier_consume_failed',
      code: 'COLLECT_OPERATION_FAILED',
      message: 'Failed to consume delegation frontier after collect re-entry; retry collect',
    };
  }

  // Idempotent no-op ONLY when nothing drained AND no pending frontier remained
  // to consume. With a freshly consumed frontier we must fall through to a
  // `collection_applied` result so its re-entry observations reach the CLI.
  if (applied === 0 && reentry.status === 'none') {
    return {
      kind: 'already_collected',
      targetRunId: input.targetState.id,
      step: scope.stepName,
    };
  }

  return {
    kind: 'collection_applied',
    targetRunId: input.targetState.id,
    step: scope.stepName,
    applied,
    unresolved: drained.unresolved,
    // Equivalent mutants: this branch runs only when `applied > 0` (the
    // `applied === 0` case returned above), so `.at(-1)` is always defined (optional
    // chain dead); and a `continue`-status drain leaves every applied state
    // `running` (the sole non-terminal `Lifecycle`), so `.at(-1)` and `.at(+1)` read
    // the same `.lifecycle`.
    // Stryker disable OptionalChaining,UnaryOperator: equivalent — applied is non-empty and all applied lifecycles are `running` here
    lifecycle: (drained.applied.at(-1)?.stateAfter ?? input.targetState).lifecycle,
    // Stryker restore OptionalChaining,UnaryOperator
    reportedTerminalOutcome: false,
    transitionObservations,
    ...(reentry.status === 'projected' ? { reEntryObservations: reentry.observations } : {}),
  };
}

/**
 * Propagate a terminal collect target's outcome upward through the unified seam.
 *
 * Both linkage kinds flow through {@link propagateTerminalChildUpward}: the
 * kind-dispatch that used to live here (delegation-only) now lives in the seam.
 * The claim-authorization gate for delegation reporting is a collect-local
 * PRECONDITION — it is not the linkage dispatch AC #2 removes, and the shared
 * seam must not impose a claim check on the CLI close path (which never had one).
 *
 * @param input - Collection operation input (services + target).
 * @param terminalState - The reloaded terminal target state.
 * @param claim - Verified claim authorizing the collect.
 * @returns `reportedTerminalOutcome` (true iff a delegation outcome row was
 *   recorded upward) and, for INLINE targets, the collapsed `terminalInlineAdvance`.
 */
async function propagateCollectTerminalUpward(
  input: CollectDelegationOutcomesOperationInput,
  terminalState: RunbookState,
  claim: VerifiedClaim,
): Promise<{
  readonly reportedTerminalOutcome: boolean;
  readonly terminalInlineAdvance?: 'handled' | 'stopped' | 'blocked' | 'not-applicable';
}> {
  const linkage = terminalState.parentLinkage;
  // Delegation reporting requires claim authorization; skip entirely if denied,
  // preserving the pre-unification gate.
  if (linkage?.kind === 'delegation' && !claimCanReportDelegationResult(claim, terminalState)) {
    return { reportedTerminalOutcome: false };
  }
  const outcome: TerminalUpwardPropagationResult = await propagateTerminalChildUpward(
    {
      manager: input.manager,
      sessionService: input.sessionService,
      completionService: input.completionService,
      advanceInlineParent: input.advanceInlineParent,
      onLinkageCycle: input.onLinkageCycle,
    },
    terminalState,
    undefined,
  );
  if (linkage?.kind === 'inline') {
    // Inline seam yields 'handled' | 'stopped' | 'blocked' | 'linkage-cycle' |
    // 'not-applicable'; narrow away the delegation-only 'reported' / 'duplicate'
    // without a cast. `terminalInlineAdvance` has no 'linkage-cycle' member (it
    // feeds the CLI's exit mapping only), so collapse the trip onto 'blocked' —
    // the deliberate, fail-closed disposition documented on
    // TerminalUpwardPropagationResult (#602).
    const inlineOutcome =
      outcome === 'reported' || outcome === 'duplicate'
        ? 'not-applicable'
        : outcome === 'linkage-cycle'
          ? 'blocked'
          : outcome;
    return { reportedTerminalOutcome: false, terminalInlineAdvance: inlineOutcome };
  }
  // 'recorded' → reported (true); 'duplicate'/'cancelled' → false. Preserves the
  // mutation-pinned 'recorded'-only contract (finding 2).
  return { reportedTerminalOutcome: outcome === 'reported' };
}
