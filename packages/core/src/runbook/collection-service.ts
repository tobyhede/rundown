import { resolvedStepHasSubsteps } from '@rundown-org/parser';
import type { ActorContext } from './actor-context.js';
import type { RunbookActorService } from './actor-service.js';
import type { DelegationPolicyOutcome } from './command-policy.js';
import { resolveCommandIntent } from './command-policy.js';
import { lifecycleToDelegationOutcome } from './completion-service.js';
import type { RunbookCompletionService } from './completion-service.js';
import { isPostDelegateAggregationCursor } from './delegation-inference.js';
import type { ExecutionLifecycleService } from './execution-lifecycle-service.js';
import type { RunbookStateManager } from './state.js';
import type { Frame, FrameKey } from './targeting.js';
import { activeFrame, deriveActiveFrame, findSubstepState } from './targeting.js';
import type { ResolvedStep, RunbookState } from './types.js';

/** Dependencies used by the core collection operation. */
export interface RunbookCollectionServiceDependencies {
  /** State manager used to reload and persist target runs. */
  readonly manager: RunbookStateManager;
  /** Actor service used to apply collected delegation outcomes through the state machine. */
  readonly actorService: RunbookActorService;
  /** Lifecycle service used to consume persisted delegation outcomes. */
  readonly lifecycleService: ExecutionLifecycleService;
  /** Completion service used to drain resolved delegation outcomes. */
  readonly completionService: RunbookCompletionService;
}

/** Explicit collection target resolved by a frontend adapter or another core service. */
export interface CollectDelegationOutcomesInput {
  /** Persisted target run receiving collected delegation outcomes. */
  readonly targetState: RunbookState;
  /** Parsed runbook steps for the target run. */
  readonly steps: readonly ResolvedStep[];
  /** Caller evidence for target-relative role derivation. */
  readonly actorContext: ActorContext;
  /** Optional explicit step name. Defaults to the target run cursor. */
  readonly stepName?: string;
  /** Optional frame override for targeted FOR collection. */
  readonly frame?: Frame;
}

/** Core-owned service for applying reported delegation outcomes to a target run. */
export class RunbookCollectionService {
  readonly #deps: RunbookCollectionServiceDependencies;

  /**
   * @param deps - Core services needed to apply collection through the state machine.
   */
  constructor(deps: RunbookCollectionServiceDependencies) {
    this.#deps = deps;
  }

  /**
   * Collect reported delegation outcomes into one target delegating run scope.
   *
   * @param input - Target run, runbook steps, actor context, and optional scope.
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

function defaultCollectionFrame(state: RunbookState): Frame {
  return activeFrame(activeFrameKeyOf(state), state.activeEntry ?? 1);
}

/**
 * Single fallback for the target run's active frame key. Factored out of the
 * two prior call sites (`defaultCollectionFrame` and the missing-outcome scan),
 * which both inlined `state.activeFrameKey ?? deriveActiveFrame(state).frameKey`.
 */
function activeFrameKeyOf(state: RunbookState): FrameKey {
  return state.activeFrameKey ?? deriveActiveFrame(state).frameKey;
}

function missingDelegationOutcomeIds(args: {
  readonly targetState: RunbookState;
  readonly stepName: string;
  readonly delegateSubsteps: readonly string[];
  readonly frameKey: FrameKey;
}): readonly string[] {
  const frameKey = args.frameKey;
  // Per-frame `status === 'done'` is the merged collect.ts contract (collect.ts
  // lines 311-317): a delegate substep counts as resolved iff its persisted
  // substep state IN THE TARGET FRAME is `done`. The `findSubstepState` lookup
  // is keyed by `(id, frameKey)`, so it is already frame-aware — a substep
  // marked done in a DIFFERENT FOR iteration is not credited to this frame.
  // The "done but no recorded outcome to drain" case is NOT a missing-outcome
  // refusal: it is the idempotent no-op the drain reports as already-collected,
  // so the gate must NOT additionally require a persisted completion here (doing
  // so would turn `already-aggregated`/`not-active` into spurious
  // SUBSTEPS_NOT_RESOLVED errors).
  return args.delegateSubsteps
    .filter((substepId) => {
      const substepState = findSubstepState(
        args.targetState.substepStates ?? [],
        substepId,
        frameKey,
      );
      return substepState?.status !== 'done';
    })
    .map((substepId) => `${args.stepName}.${substepId}`);
}

/**
 * Collect reported delegation outcomes into one target delegating run scope.
 *
 * @param input - Target run, services, actor context, and optional scope.
 * @returns Core-owned typed policy outcome.
 */
export async function collectDelegationOutcomes(
  input: CollectDelegationOutcomesOperationInput,
): Promise<DelegationPolicyOutcome> {
  // NOTE: the merged `resolveCommandIntent` input field is `targetSelector`
  // (not `target`), and its selector kinds are `default` | `claim` |
  // `explicit-step` — there is NO `run` selector kind. The resolved target run
  // is passed separately as `targetState`. For collection the frontend has
  // already resolved `--claim-id` (or the default stack) to a concrete run, so
  // the selector is `default` and role derivation keys off `targetState`.
  const policy = resolveCommandIntent({
    intent: { kind: 'delegation-collection' },
    targetSelector: { kind: 'default' },
    targetState: input.targetState,
    actorContext: input.actorContext,
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
      message: `Step ${stepName} is not a DELEGATE step. rd collect requires a step with - DELEGATE substeps.`,
    };
  }

  const missingSubsteps = missingDelegationOutcomeIds({
    targetState: input.targetState,
    stepName,
    delegateSubsteps,
    frameKey,
  });
  if (missingSubsteps.length > 0) {
    return {
      kind: 'missing_outcomes',
      targetRunId: input.targetState.id,
      step: stepName,
      missingSubsteps,
    };
  }

  return applyCollection(input, { stepName, frame, frameKey });
}

async function applyCollection(
  input: CollectDelegationOutcomesOperationInput,
  scope: { readonly stepName: string; readonly frame: Frame; readonly frameKey?: FrameKey },
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

  // Terminal: the drained outcomes advanced the target run to a terminal
  // lifecycle. Reload the persisted terminal state so single-level reporting
  // observes the committed lifecycle, then (single-level) report one outcome
  // upward — never collect the ancestor.
  if (drained.status === 'done' || drained.status === 'stopped') {
    const fresh =
      (await input.manager.load(input.targetState.id)) ??
      drained.applied.at(-1)?.stateAfter ??
      input.targetState;
    return {
      kind: 'collection_applied',
      targetRunId: input.targetState.id,
      step: scope.stepName,
      applied,
      unresolved: drained.unresolved,
      lifecycle: drained.status === 'done' ? 'completed' : 'stopped',
      reportedTerminalOutcome: await reportTerminalOutcomeToDelegatingRun(input, fresh),
    };
  }

  // status === 'continue': nothing applied means no unapplied outcomes for the
  // scope (idempotent no-op); otherwise outcomes were consumed but the run is
  // still active.
  if (applied === 0) {
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
    lifecycle: (drained.applied.at(-1)?.stateAfter ?? input.targetState).lifecycle,
    reportedTerminalOutcome: false,
  };
}

async function reportTerminalOutcomeToDelegatingRun(
  input: CollectDelegationOutcomesOperationInput,
  terminalState: RunbookState,
): Promise<boolean> {
  if (!terminalState.parentLinkage) return false;
  // Reuse the canonical lifecycle→outcome mapping instead of hand-rolling
  // `lifecycle === 'completed' ? 'pass' : 'fail'`. It returns `undefined` for
  // non-terminal lifecycles, which also serves as the terminal guard.
  const result = lifecycleToDelegationOutcome(terminalState.lifecycle);
  if (!result) return false;
  const recorded = await input.completionService.recordChildCompletion({
    childState: terminalState,
    result,
  });
  return recorded === 'recorded';
}
