/**
 * Parent-aggregation retry hook for DELEGATE steps.
 *
 * Extracted from `compiler.ts` so the compiler module carries only the XState
 * wiring and leaves delegation-domain logic — substep state inspection,
 * `retryDelegation` orchestration, frontier assembly — in its own unit. The
 * hook is invoked from XState `assign` callbacks inside the parent-aggregation
 * retry and FOR-iteration retry transitions.
 *
 * @module
 */

import type { DelegateFrontierEntry } from '../events/types.js';
import type {
  ResolvedStep,
  ResolvedStepHavingSubsteps,
  RunbookState,
  Substep,
  SubstepState,
  TemplateVarValue,
} from './types.js';
import type { RunbookContext } from './compiler.js';
import type { OutputVars } from './output-evaluator.js';
import { retryDelegation, type RetryDelegationResult } from './delegation-service.js';
import { findSubstepState, type FrameKey } from './targeting.js';
import { brandInitialTemplateVars, brandStoredOutputs } from './effective-vars.js';
import { Errors } from '../errors/factory.js';
import { logger } from '../logger.js';

/**
 * Narrow `OutputVars` (context-side map, `JsonValue` entries — permits
 * `boolean | null`) to a `TemplateVarValue` map (state-side map — forbids
 * `boolean | null`).
 *
 * The `flattenTemplateVars` pipeline upstream guarantees this narrowing is
 * safe: booleans are stringified at routing time, nulls never enter the
 * template-var channel. This helper documents the invariant at the boundary
 * and filters (with a warning) any rogue values that slip through from
 * untyped callers — preferable to a blanket cast that would let a `null` or
 * `boolean` reach a state-machine consumer unchecked.
 *
 * @param vars - Output-evaluator frame with `JsonValue` entries
 * @returns Map restricted to `TemplateVarValue` — unsafe values dropped
 */
export function asTemplateVars(vars: OutputVars): Readonly<Record<string, TemplateVarValue>> {
  const result: Record<string, TemplateVarValue> = {};
  for (const [key, value] of Object.entries(vars)) {
    if (value === null || typeof value === 'boolean') {
      void logger.warn('asTemplateVars: dropping unsupported value at boundary', {
        name: key,
        kind: value === null ? 'null' : 'boolean',
      });
      continue;
    }
    // string | number | JsonArray | JsonObject — all valid TemplateVarValue
    // subtypes. (TemplateVarValue also permits JsonArrayStream, which cannot
    // appear here: OutputVars is already a flattened output frame.)
    result[key] = value;
  }
  return result;
}

/**
 * Discriminated success variant of {@link RetryHookResult}.
 *
 * `frontier` carries one entry per successfully re-issued delegation; empty
 * when the parent has no DELEGATE substeps (the benign case that must leave
 * pre-existing retry semantics unchanged).
 */
export interface RetryHookSuccess {
  readonly status: 'success';
  readonly frontier: ReadonlyArray<DelegateFrontierEntry>;
  readonly substepStates: readonly SubstepState[];
}

/**
 * Discriminated error variant of {@link RetryHookResult}.
 *
 * Surfaces a retry-hook failure as a structured record: either the
 * `RundownError` returned by `retryDelegation`'s `error` variant (itself a
 * translation of an inner `createDelegation` variant), or a retry-hook
 * invariant violation (RD-902 `RETRY_HOOK_NO_FRAME`,
 * RD-904 `RETRY_HOOK_MISSING_CANONICAL_AT`,
 * RD-905 `RETRY_HOOK_STALE_SUBSTEP`). Returned with the *original*
 * `substepStates` so the caller can publish a rollback-clean assignment
 * (no partial writes).
 */
export interface RetryHookError {
  readonly status: 'error';
  readonly code: string;
  readonly message: string;
  /** Substep states unchanged; rollback on error. */
  readonly substepStates: readonly SubstepState[];
}

/**
 * Outcome of the parent-aggregation retry hook.
 *
 * Discriminated union so XState `assign` callbacks can branch on success vs.
 * error without try/catch — the hook itself never throws.
 */
export type RetryHookResult = RetryHookSuccess | RetryHookError;

/**
 * Narrow view of RunbookState used by the retry hook — only fields that
 * `retryDelegation` and its composition actually read.
 *
 * Exported for unit tests of {@link retrySingleSubstep}; not a public
 * contract. It is a shape-shim to avoid a full RunbookState construction
 * inside an assign callback.
 *
 * @internal
 */
export type RetryWorkingState = Pick<
  RunbookState,
  'step' | 'substepStates' | 'templateVars' | 'forStack' | 'activeFrameKey' | 'variables'
>;

/**
 * Per-substep iteration of the retry hook. Side-effect free: returns a
 * discriminated union describing the outcome. The caller composes multiple
 * calls to build the final {@link RetryHookResult}.
 *
 * Rollback discipline: the `error` variant MUST NOT carry `substepStates`.
 * The caller ({@link runRetryHook}) owns the original `substepStates`
 * snapshot and applies rollback by returning that snapshot in its own
 * error path. See retry-semantics spec §3.1 (rollback invariant on retry
 * error).
 *
 * Behavior map:
 * - `skipped` — the substep has no state entry in `working.substepStates`,
 *   or the entry has no `delegation` record. Cursor re-entry machinery
 *   handles re-execution of non-delegated substeps elsewhere.
 * - `retried` — `retryDelegation` returned `status: 'retried'` and the fresh
 *   delegation carries a canonical `contextSnapshot.at`. Caller receives an
 *   updated `working` (with the retried substep reset to
 *   `{ status: 'pending', result: undefined }`) and a frontier entry.
 * - `error` — surface codes:
 *   - Wrapped `RundownError` from `retryDelegation` returning
 *     `not_found` / `not_current` (e.g. RD-801 / RD-802) propagated
 *     verbatim — state and delegation-service views have diverged.
 *   - `RD-904` from a fresh retried delegation missing
 *     `contextSnapshot.at` (frontier id would lose FOR-iteration context).
 *   - Otherwise the code + message from `result.error` are propagated.
 *
 * Exported for unit testing only; not a public contract.
 *
 * @internal
 *
 * @param working - Current working retry state (updated across iterations in the caller).
 * @param substep - The parent's substep definition.
 * @param activeFrameKey - Frame key for the active parent frame.
 * @param _parentName - Parent step name. Retained for signature stability; not
 *   consumed — frontier id comes from `delegation.contextSnapshot.at`.
 * @param steps - Resolved steps of the active runbook.
 * @returns Discriminated union: `retried` (updates working + frontier entry),
 *   `skipped` (no state or no delegation record), or `error`
 *   (rollback discipline: caller supplies its original snapshot).
 */
export function retrySingleSubstep(
  working: RetryWorkingState,
  substep: Substep,
  activeFrameKey: FrameKey,
  _parentName: string,
  steps: readonly ResolvedStep[],
):
  | { status: 'retried'; working: RetryWorkingState; frontierEntry: DelegateFrontierEntry }
  | { status: 'skipped' }
  | { status: 'error'; code: string; message: string } {
  const ss = findSubstepState(working.substepStates ?? [], substep.id, activeFrameKey);
  if (!ss) return { status: 'skipped' };
  // Uniform re-delegation (docs/spec/language.md §4.2, §5; retry-semantics spec §3 step 3,
  // §3.1 invariant, §4.4): every substep with a delegation record re-issues on
  // retry, regardless of prior `result`. Substeps without a delegation are
  // skipped here — the cursor-re-entry machinery handles their re-execution.
  if (!ss.delegation) return { status: 'skipped' };

  const result: RetryDelegationResult = retryDelegation(
    {
      state: working as RunbookState,
      substepId: substep.id,
      frameKey: activeFrameKey,
    },
    steps,
  );

  if (result.status === 'retried') {
    // Reset the retried substep's state: status -> 'pending', prior result
    // cleared. The fresh subagent's rd pass/rd fail will overlay onto this
    // clean entry (retry-semantics spec §3 step 3, §3.1 invariant).
    const resetSubstepStates = result.updatedSubstepStates.map((entry) =>
      entry.id === substep.id && entry.frameKey === activeFrameKey
        ? { ...entry, status: 'pending' as const, result: undefined }
        : entry,
    );
    // Use the delegation's canonical `at` so FOR-iteration context survives.
    // deriveExecutionAt always populates this for fresh delegations created
    // through the current path, so a missing value here is an upstream
    // invariant violation. Rollback rather than emit a degraded frontier id
    // (e.g. "1.1" in place of "1.2.1") that would mis-target the re-entry.
    const frontierAt = result.delegation.contextSnapshot.at;
    if (!frontierAt) {
      return {
        status: 'error',
        code: 'RD-904',
        message: `Retry hook aborted: fresh delegation for substep "${substep.id}" has no contextSnapshot.at value (frontier id would lose FOR-iteration context).`,
      };
    }
    return {
      status: 'retried',
      working: { ...working, substepStates: resetSubstepStates },
      frontierEntry: {
        id: frontierAt,
        runbook: result.delegation.childRunbookPath,
        token: result.token,
      },
    };
  }

  if (result.status === 'error') {
    return {
      status: 'error',
      code: result.error.code,
      message: result.error.message,
    };
  }

  // not_found / not_current: the delegation-service view and the substep
  // state have diverged. The caller already filtered on `ss.delegation`
  // being present and `activeFrameKey` matching, so silent skip would
  // consume the retry transition without re-issuing a token. Both variants
  // now carry a `RundownError` (parallel to CreateDelegation), so the hook
  // surfaces the structured code/message verbatim and rolls back.
  return {
    status: 'error',
    code: result.error.code,
    message: result.error.message,
  };
}

/**
 * Run the retry hook over a parent step's delegated substeps.
 *
 * Inspects `context.substepStates` for the active frame; for each substep with
 * a delegation record — regardless of prior `result` — calls `retryDelegation`.
 * Uniform re-delegation per `docs/spec/language.md` §4.2, §5 (RETRY is universal):
 * every delegation in the frame is cancelled and re-issued with a fresh token
 * on retry, not just failed ones. Each retried substep's state is reset to
 * `{ status: 'pending', result: undefined }` so the fresh subagent's
 * `rd pass`/`rd fail` overlays onto a clean entry. Threads the updated
 * substepStates through successive calls so a single retry transition can
 * re-issue multiple delegations atomically.
 *
 * Returns a discriminated union so the caller (XState `assign`) can branch on
 * success vs. error without try/catch. The hook never throws: `retryDelegation`
 * is Result-based specifically so failures propagate as `{ status: 'error' }`
 * rather than exceptions that would corrupt actor atomicity.
 *
 * On error the original substepStates are returned (not a partial mutation) so
 * the caller can apply a clean rollback.
 *
 * @param context - Current RunbookContext with mirrored substepStates
 * @param parentStep - Parent step carrying the DELEGATE substeps
 * @param steps - All resolved steps (needed for createDelegation inside retryDelegation)
 * @returns Success (new frontier + substepStates) or error (code + message, states unchanged)
 */
export function runRetryHook(
  context: RunbookContext,
  parentStep: ResolvedStepHavingSubsteps,
  steps: readonly ResolvedStep[],
): RetryHookResult {
  const substepStates = context.substepStates ?? [];
  const activeFrameKey = context.activeFrameKey;
  if (!activeFrameKey) {
    // Without an active frame key the hook cannot resolve any substep
    // state. For non-DELEGATE parent retries (no delegations in flight),
    // that is harmless: there is nothing to re-issue, so the hook reports
    // an empty frontier and the parent re-entry machinery re-runs
    // commands via the cursor.
    //
    // For DELEGATE parents with live delegations, a missing frame key is
    // an invariant violation: the retry hook only fires from
    // drainResolvedCompletions, which requires all active-frame substeps
    // to be resolved (retry-semantics spec §3.1 "Aggregation-only
    // firing"). Silent success there would mimic the original
    // DELEGATE + RETRY bug — the retry budget would be consumed without
    // any delegation actually being re-issued. Route through the
    // RETRY_ERROR lastAction variant so the failure surfaces as
    // ERROR_OCCURRED + lifecycle: 'stopped'.
    const hasDelegations = substepStates.some((ss) => ss.delegation !== undefined);
    if (hasDelegations) {
      return {
        status: 'error',
        code: 'RD-902',
        message: 'Retry hook invoked without an active frame key — invariant violation',
        substepStates,
      };
    }
    return { status: 'success', frontier: [], substepStates };
  }

  const frontier: DelegateFrontierEntry[] = [];
  // Narrowed input for retryDelegation — only the fields it actually reads
  // (step, substepStates, templateVars, forStack, activeFrameKey, variables).
  // Casting a structurally-sufficient partial to RunbookState at the call site
  // avoids a full RunbookState construction while documenting the subset used.
  //
  // The templateVars cast widens from RunbookState's `TemplateVarValue` to
  // context's `OutputValue` (which additionally permits `null`). In the
  // delegation path the value is only spread into contextSnapshot.vars — the
  // actual runtime values originate from `flattenTemplateVars` at hydration
  // and are always TemplateVarValue-compatible.
  let working: RetryWorkingState = {
    step: parentStep.name,
    substepStates,
    templateVars: brandInitialTemplateVars(asTemplateVars(context.templateVars)),
    forStack: context.forStack,
    activeFrameKey,
    variables: brandStoredOutputs(context.variables),
  };

  // Stale-substep guard: an active-frame delegation references a substep id
  // that the resolved parent step no longer declares. The per-substep loop
  // below walks parentStep.substeps only, so the orphan would be silently
  // missed and the retry transition would be consumed without re-issuing
  // any token. Surface as a typed error (RD-905) so the operator can
  // detect schema drift and restart cleanly. Per the project's "never
  // migrate persisted state" principle, the only safe recovery is to
  // complete or stop the running runbook and start fresh.
  const declaredSubstepIds = new Set(parentStep.substeps.map((substep) => substep.id));
  const orphanActiveDelegation = substepStates.find(
    (ss) =>
      ss.frameKey === activeFrameKey &&
      ss.delegation !== undefined &&
      !declaredSubstepIds.has(ss.id),
  );
  if (orphanActiveDelegation !== undefined) {
    const error = Errors.retryHookStaleSubstep(orphanActiveDelegation.id, parentStep.name);
    return {
      status: 'error',
      code: error.code,
      message: error.message,
      substepStates,
    };
  }

  for (const substep of parentStep.substeps) {
    const outcome = retrySingleSubstep(working, substep, activeFrameKey, parentStep.name, steps);
    switch (outcome.status) {
      case 'skipped':
        continue;
      case 'retried':
        working = outcome.working;
        frontier.push(outcome.frontierEntry);
        continue;
      case 'error':
        // Rollback: the helper's error variant intentionally omits
        // substepStates. The caller owns the original snapshot (captured
        // at the top of this function before the loop) and attaches it
        // here so downstream RetryHookError consumers see a clean
        // pre-retry state (retry-semantics spec §3.1 rollback invariant).
        return {
          status: 'error',
          code: outcome.code,
          message: outcome.message,
          substepStates,
        };
      default: {
        // Compile-time exhaustiveness: a new outcome.status variant in
        // retrySingleSubstep must add an arm above or this assignment
        // fails type-check. Intentionally no runtime throw — the hook's
        // JSDoc contract guarantees this function never throws, and the
        // TypeScript `never` assignment already gates new variants at
        // build time.
        const _exhaustive: never = outcome;
        void _exhaustive;
      }
    }
  }

  // Frame-aware invariant mirror of the `!activeFrameKey` branch above.
  // The per-substep loop filters by `activeFrameKey` via `findSubstepState`
  // (see `targeting.ts`), so delegations recorded under stale frame keys
  // (from a previous FOR iteration or post-GOTO state) are skipped
  // silently. If every delegation in the state lives under a stale frame,
  // the loop produces an empty frontier and the pre-fix code returned
  // `{ status: 'success', frontier: [] }` — consuming the retry budget
  // without re-issuing any token. Same class of bug the `!activeFrameKey`
  // branch already guards against. Route through RETRY_ERROR with RD-902.
  if (frontier.length === 0) {
    const hasActiveFrameDelegations = substepStates.some(
      (ss) => ss.delegation !== undefined && ss.frameKey === activeFrameKey,
    );
    const hasStaleFrameDelegations = substepStates.some(
      (ss) => ss.delegation !== undefined && ss.frameKey !== activeFrameKey,
    );
    if (hasStaleFrameDelegations && !hasActiveFrameDelegations) {
      return {
        status: 'error',
        code: 'RD-902',
        message:
          'Retry hook produced no frontier: all delegations are under stale frame keys — invariant violation',
        substepStates,
      };
    }
  }

  return { status: 'success', frontier, substepStates: working.substepStates ?? [] };
}
