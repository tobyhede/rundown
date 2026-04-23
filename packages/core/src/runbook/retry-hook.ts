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
  SubstepState,
  TemplateVarValue,
} from './types.js';
import type { RunbookContext } from './compiler.js';
import type { OutputVars } from './output-evaluator.js';
import { retryDelegation, type RetryDelegationResult } from './delegation-service.js';
import { findSubstepState } from './targeting.js';
import { logger } from '../logger.js';
import { getErrorMessage } from '../errors.js';

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
    result[key] = value as TemplateVarValue;
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
 * Wraps the `RundownError` raised by `createDelegation` inside `retryDelegation`.
 * Returned with the *original* substepStates so the caller can publish a
 * rollback-clean assignment (no partial writes).
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
 * Run the retry hook over a parent step's delegated substeps.
 *
 * Inspects `context.substepStates` for the active frame; for each substep with
 * a delegation record — regardless of prior `result` — calls `retryDelegation`.
 * Uniform re-delegation per `docs/SPEC.md` §4.2, §5 (RETRY is universal):
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
  let working: Pick<
    RunbookState,
    'step' | 'substepStates' | 'templateVars' | 'forStack' | 'activeFrameKey' | 'variables'
  > = {
    step: parentStep.name,
    substepStates,
    templateVars: asTemplateVars(context.templateVars),
    forStack: context.forStack,
    activeFrameKey,
    variables: context.variables,
  };

  for (const substep of parentStep.substeps) {
    const ss = findSubstepState(working.substepStates ?? [], substep.id, activeFrameKey);
    if (!ss) continue;
    // Uniform re-delegation (docs/SPEC.md §4.2, §5; retry-semantics spec §3 step 3,
    // §3.1 invariant, §4.4): every substep with a delegation record re-issues on
    // retry, regardless of prior `result`. Substeps without a delegation are
    // skipped here — the cursor-re-entry machinery handles their re-execution.
    if (!ss.delegation) continue;

    let result: RetryDelegationResult;
    try {
      result = retryDelegation(
        {
          state: working as RunbookState,
          substepId: substep.id,
          frameKey: activeFrameKey,
        },
        steps,
      );
    } catch (err) {
      // Retain actor atomicity: an uncaught throw inside the XState `assign`
      // callback would leave the actor in an indeterminate state. Route the
      // error through the RETRY_ERROR path instead. Rollback uses the
      // original `substepStates`, not `working.substepStates`.
      const message = getErrorMessage(err);
      return {
        status: 'error',
        code: 'RD-901',
        message,
        substepStates,
      };
    }

    if (result.status === 'retried') {
      // Reset the retried substep's state: status -> 'pending', prior result
      // cleared. The fresh subagent's rd pass/rd fail will overlay onto this
      // clean entry (retry-semantics spec §3 step 3, §3.1 invariant).
      const resetSubstepStates = result.updatedSubstepStates.map((entry) =>
        entry.id === substep.id && entry.frameKey === activeFrameKey
          ? { ...entry, status: 'pending' as const, result: undefined }
          : entry,
      );
      working = { ...working, substepStates: resetSubstepStates };
      // Use the delegation's canonical `at` so FOR-iteration context survives:
      // `${parentStep.name}.${substep.id}` loses the iteration segment for
      // FOR-scoped retries (e.g. `"1.1"` instead of `"1.2.1"`). `contextSnapshot.at`
      // is produced by deriveExecutionAt (delegation-context.ts) and always
      // carries the iteration when one is in scope. The ContextSnapshot type
      // still declares `at?: string`, so we fall back to the legacy
      // concatenation if a persisted/older snapshot happens to omit it.
      const frontierAt =
        result.delegation.contextSnapshot.at ?? `${parentStep.name}.${substep.id}`;
      frontier.push({
        id: frontierAt,
        runbook: result.delegation.childRunbookPath,
        token: result.token,
      });
      continue;
    }

    if (result.status === 'error') {
      // Rollback: return original substepStates, not the partially-mutated ones.
      return {
        status: 'error',
        code: result.error.code,
        message: result.error.message,
        substepStates,
      };
    }

    // not_found / not_current: skip this substep (defensive; shouldn't occur
    // on the retry path since we filtered on `delegation` present and frameKey
    // matches context).
  }

  return { status: 'success', frontier, substepStates: working.substepStates ?? [] };
}
